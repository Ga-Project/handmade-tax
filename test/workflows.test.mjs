// workflows.test.mjs — CI のゲートに穴が開いていないことを検査する。
//
// 背景（実害）: 検査を workflow ごとに書き写していたため、経路によって通るゲートが
// 違っていた。秘密スキャンは push(main) 側にしか無く、PR で平文の認証情報を入れても
// 緑のまま main に入れられた。依存監査は PR 側にしか無く、main への直接 push は
// 監査を通らずに公開できた。成果物検査は out/ が無いと静かにスキップされ、
// 「安全網があるつもり」で緑になった。
//
// もう1つの穴が手動起動だった。workflow_dispatch は「選んだ ref」に対して走るので、
// 公開 workflow を feature ブランチやタグで起動すれば main に入っていないコードを
// 公開でき、PR 用 workflow を手動起動すればマージ結果を一度も検査しないまま
// 必須ステータスチェックに載る名前の check を head の SHA に緑で付けられた。
//
// 対策として検査は .github/workflows/verify.yml に一本化し、main に到達する全経路
// （PR / main への直接 push）から呼ぶ。手動起動は ref を検査する公開経路だけに残し、
// その ref 検査を全 job が needs で通る。このテストはその構造を固定する。
//
// 読み取りは YAML パーサに任せる。以前はここで正規表現で YAML を読んでいたが、
// 「job 名を引用符で囲む」「値を次の行に置く」「フロー形式で書く」「ブロックスカラの
// 見出しに行末コメントを付ける」のいずれでも読み落として、書き込み権限を持つ公開 job
// や式のシェル直展開を素通りさせた。ゲートを守るための検査が書き方ひとつで無力化
// されるので、YAML の解釈を自前で持たない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { BASE_PATH } from "../lib/site.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = resolve(__dirname, "../.github/workflows");
const SHARED = "./.github/workflows/verify.yml";
// 検査を共有する側と、それを呼ぶ側。呼ぶ側が欠けたら経路に穴が開く。
const CALLERS = ["ci.yml", "pages.yml"];
// 書き込み権限を持ってよい job（Pages 公開に必要な分だけ）。
// 既定は「持たせない」。必要な job が増えたらここに理由を書いて足す。
const ALLOWED_WRITE_JOBS = { "pages.yml": { deploy: ["pages", "id-token"] } };
// 使ってはいけないトリガ。fork の PR が触った内容を、base リポジトリの権限と
// シークレットを持った文脈で走らせるため、公開リポジトリでは特に危ない。
const FORBIDDEN_TRIGGERS = ["pull_request_target", "workflow_run", "repository_dispatch"];
// 公開に使う action。これを持つ job が「公開する job」。
const PUBLISH_ACTIONS = /deploy-pages|upload-pages-artifact/;
// ref 検査が読んでよい、判断に影響しない Actions の書き出し先。
const INERT_ACTIONS_VARS = [
  "GITHUB_OUTPUT",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_STEP_SUMMARY",
  "RUNNER_TEMP",
];
// ref を検査する job。公開経路の全 job がここを通る。
const GUARD = "guard";
// 公開先の environment。ref を最終的に強制する deployment branch policy が乗る。
const PUBLISH_ENVIRONMENT = "github-pages";
// 起動 ref を表す式。ref 検査に渡してよいのはこれだけ。
const REF_EXPRESSION = /^\$\{\{\s*github\.ref\s*\}\}$/;

const names = existsSync(WORKFLOWS)
  ? readdirSync(WORKFLOWS)
      .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
      .sort()
  : [];
const read = (name) => readFileSync(resolve(WORKFLOWS, name), "utf8");

const docs = new Map();
/** workflow を解析済みオブジェクトで返す。読めなければ落とす（黙って緑にしない）。 */
function doc(name) {
  if (!docs.has(name)) {
    const parsed = parseYaml(read(name));
    assert.ok(
      parsed !== null && typeof parsed === "object",
      `${name}: workflow として読めない`,
    );
    docs.set(name, parsed);
  }
  return docs.get(name);
}

/**
 * on: のトリガ名。YAML 1.1 として解釈する実装では on が真偽値キーになるので
 * 両方を見る（取りこぼすと「トリガの無い workflow」と誤判定して空振りする）。
 */
function triggers(name) {
  const on = doc(name).on ?? doc(name)[true];
  assert.ok(on !== undefined && on !== null, `${name}: on: が見つからない`);
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}
const triggeredBy = (name, trigger) => triggers(name).includes(trigger);

/** job 名 -> job 定義。 */
function jobsOf(name) {
  const jobs = doc(name).jobs;
  assert.ok(
    jobs !== null && typeof jobs === "object" && Object.keys(jobs).length > 0,
    `${name}: job を1つも読めていない`,
  );
  return jobs;
}

/** job の needs（スカラ / 配列のどちらでも配列で返す）。 */
const needsOf = (job) => {
  const needs = job?.needs;
  if (needs === undefined || needs === null) return [];
  return (Array.isArray(needs) ? needs : [needs]).map(String);
};

const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
/** run: を持つ step だけ。ブロックスカラでもフロー形式でも同じように取れる。 */
const runStepsOf = (job) =>
  stepsOf(job).filter((step) => typeof step?.run === "string");

/**
 * permissions を [スコープ, 権限] の配列で返す。未宣言は null。
 * `permissions: read-all` のような1行形式は ["*", "read-all"]、
 * `permissions: {}` は空配列（＝権限なしの明示）。
 */
function permissionsOf(node) {
  const perms = node?.permissions;
  if (perms === undefined) return null;
  if (perms === null) return [];
  if (typeof perms === "string") return [["*", perms]];
  return Object.entries(perms).map(([scope, level]) => [scope, String(level)]);
}

const isWrite = (level) => /write/.test(level);

/** 公開（Pages への artifact 投入・deploy）を行う step。 */
const publishStepsOf = (job) =>
  stepsOf(job).filter((step) => PUBLISH_ACTIONS.test(String(step?.uses ?? "")));

/**
 * 実際に走る内容だけを文字列にする（step の name: や if: は含めない）。
 * name: まで対象にすると、`- name: pnpm audit --audit-level high` と書いて
 * 中身を `echo noop` に差し替えるだけでゲート検査が緑になる。
 */
const executableText = (job) =>
  stepsOf(job)
    .map((step) =>
      [step?.run, step?.uses, render(step?.with), render(step?.env)]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

/**
 * ゲートの連鎖に乗っている job。ここに乗っていない job（失敗通知や後片付け）に
 * まで「前段が落ちても走るな」を課すと、通知の目的そのものを禁じることになる。
 * 対象は「共有検査を呼ぶ job・公開する job」と、それらが needs でたどる先。
 */
function protectedJobs(name) {
  const jobs = jobsOf(name);
  if (name === "verify.yml") return new Set(Object.keys(jobs)); // 検査の実体そのもの
  const targets = Object.entries(jobs)
    .filter(([, job]) => job?.uses === SHARED || publishStepsOf(job).length > 0)
    .map(([id]) => id);
  const out = new Set();
  for (const target of targets) {
    for (const id of Object.keys(jobs)) if (reachesVia(jobs, target, id)) out.add(id);
  }
  return out;
}

/**
 * 解析済みの値を検索しやすい行の列にする。コメントは含まれないので、
 * 「コメントに書いてあるだけ」を実体と取り違えない。
 */
function render(node) {
  const out = [];
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (child !== null && typeof child === "object") {
          out.push(`${key}:`);
          walk(child);
        } else {
          out.push(`${key}: ${child}`);
        }
      }
      return;
    }
    out.push(String(value));
  };
  walk(node);
  return out.join("\n");
}

/**
 * job から target へ needs をたどって到達できるか（間接でもよい）。
 * 直接の needs だけを見ると、間に1つ job を挟むだけでゲートを迂回できてしまう。
 * 循環を書かれても止まらなくならないよう訪問済みを持つ。
 */
function reachesVia(jobs, job, target, seen = new Set()) {
  if (job === target) return true;
  if (seen.has(job)) return false;
  seen.add(job);
  if (!(job in jobs)) return false;
  return needsOf(jobs[job]).some((dep) => reachesVia(jobs, dep, target, seen));
}

/** シェルスクリプトが読む環境変数名（そのスクリプト内で代入したものは除く）。 */
function envReads(script) {
  const assigned = new Set(
    [...script.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]),
  );
  return [
    ...new Set(
      [...script.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)]
        .map((m) => m[1])
        .filter((varName) => !assigned.has(varName)),
    ),
  ];
}

test("走査対象の workflow が実在する", () => {
  assert.ok(existsSync(WORKFLOWS), ".github/workflows が無い");
  for (const required of ["verify.yml", ...CALLERS]) {
    assert.ok(
      names.includes(required),
      `${required} が無い（この検査が空振りで緑になる）`,
    );
  }
});

test("検査を共有する verify.yml が他から呼べる", () => {
  assert.ok(
    triggeredBy("verify.yml", "workflow_call"),
    "verify.yml が workflow_call で呼べない（共有されない）",
  );
});

/** その workflow が共有検査を job の uses: で呼んでいるか。 */
const callsShared = (name) =>
  Object.values(jobsOf(name)).some((job) => job?.uses === SHARED);

// 経路ごとに書き写すと片方だけ古くなる。ゲートの実体は verify.yml の1箇所だけ。
// どの job に置くかは自由（呼び出し元は1つでも落ちれば赤になる）。job を分割しても
// 落ちないよう、ファイル全体の「実際に走る内容」から探す。
// [ラベル, 正規表現]
const GATES = [
  ["秘密スキャン（gitleaks）", /gitleaks detect/],
  ["秘密スキャンが全履歴を見る", /fetch-depth:\s*0/],
  ["公開検査（basePath 付きビルド＋成果物検査）", /pnpm run test:publish/],
  ["型検査", /pnpm typecheck/],
  ["lint", /pnpm lint/],
  ["依存監査", /pnpm audit --audit-level high/],
];

for (const [label, re] of GATES) {
  test(`共有 workflow が ${label} を持っている`, () => {
    const text = Object.values(jobsOf("verify.yml")).map(executableText).join("\n");
    assert.ok(text.trim(), "verify.yml から実行内容を1つも読めていない（空振りで緑）");
    assert.match(
      text,
      re,
      `verify.yml から ${label} が消えている（全経路のゲートが同時に外れる）`,
    );
  });
}

test("ゲートが条件付き・失敗許容になっていない", () => {
  // コマンドが書いてあるだけでは足りない。落ちたら止まること、常に走ることまで固定する。
  // 値は解析結果から読む。行をなぞると `continue-on-error:` の値を次の行に置くだけで
  // 素通りするし、`${{ ... }}` を書けば true という字面も消せる。
  const offenders = [];
  const skipsPrevious = (value) =>
    /\balways\s*\(\)|\bfailure\s*\(\)|!\s*cancelled\s*\(\)/.test(String(value));
  const tolerates = (value) =>
    value !== undefined && String(value).trim() !== "false";
  let scanned = 0;
  for (const name of names) {
    const guarded = protectedJobs(name);
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!guarded.has(id)) continue; // 失敗通知・後片付けはここの対象外
      scanned += 1;
      // job の if: は needs を無視して走らせられる＝ゲートの迂回。
      if (job?.if !== undefined && skipsPrevious(job.if)) {
        offenders.push(`${name} の ${id}: if: ${job.if}（前段が落ちても実行される）`);
      }
      // continue-on-error は「落ちたのに成功として扱う」ので job/step どちらも許さない。
      for (const [where, node] of [
        [`${name} の ${id}`, job],
        ...stepsOf(job).map((step, i) => [
          `${name} の ${id} の step「${step?.name ?? step?.uses ?? step?.run}」`,
          step,
        ]),
      ]) {
        if (tolerates(node?.["continue-on-error"])) {
          offenders.push(
            `${where}: continue-on-error: ${node["continue-on-error"]}（失敗しても後続が走る）`,
          );
        }
      }
    }
  }
  assert.ok(scanned > 0, "ゲートの連鎖に乗る job を1つも走査していない（空振りで緑）");
  // 共有検査の中身は無条件で走ること。if: が付くと経路によって外れる。
  for (const [id, job] of Object.entries(jobsOf("verify.yml"))) {
    if (job?.if !== undefined) {
      offenders.push(`verify.yml の ${id}: if:（ゲートが条件付きになっている）`);
    }
    stepsOf(job).forEach((step, i) => {
      if (step?.if !== undefined) {
        offenders.push(
          `verify.yml の ${id} の step[${i}]: if:（ゲートが条件付きになっている）`,
        );
      }
    });
  }
  assert.deepEqual(offenders, [], `ゲートに抜け道があります:\n${offenders.join("\n")}`);
});

test("成果物検査をスキップしうる素の実行に置き換えられていない", () => {
  // out/ が無いと成果物検査を静かにスキップする実行系を CI に置かない。
  // 回してよいのはスキップを許さない test:publish のみ。
  const BARE = [
    /^(pnpm|npm|yarn)( run)? test$/,
    /^node\s+--test\b/,
    /^(pnpm|npx)\s+next\s+build$/,
    /^(pnpm|npm|yarn)( run)? build$/,
  ];
  const offenders = [];
  let scanned = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      for (const step of runStepsOf(job)) {
        scanned += 1;
        // 連結した先も見る。`rm -rf out && node --test` のように前に何か置くだけで
        // 行頭一致の検査は素通りしてしまう。
        for (const part of step.run.split(/\n|&&|\|\||;/)) {
          const cmd = part.trim();
          if (BARE.some((re) => re.test(cmd))) offenders.push(`${name} の ${id}: ${cmd}`);
        }
      }
    }
  }
  assert.ok(scanned > 0, "run: を1つも読めていない（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `basePath も成果物検査も伴わない実行が CI にあります。` +
      `検査は test:publish、公開ビルドは build:publish を使うこと:\n${offenders.join("\n")}`,
  );
});

test("Pages に上げる成果物は公開条件でビルドしたものだけ", () => {
  // 検査した out/ と公開する out/ が別物になると、CI が緑のまま
  // アセット全部 404 の状態を公開できる（この製品で実際に起きた）。
  let uploaders = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      const upload = stepsOf(job).find((step) =>
        /upload-pages-artifact/.test(String(step?.uses ?? "")),
      );
      if (!upload) continue;
      uploaders += 1;
      assert.ok(
        runStepsOf(job).some((step) => /pnpm run build:publish/.test(step.run)),
        `${name} の ${id} が build:publish 以外でビルドしている（公開先で 404 になる）`,
      );
      assert.equal(
        upload.with?.path,
        "out",
        `${name} の ${id} がアップロードするのが out/ ではない`,
      );
    }
  }
  assert.equal(uploaders, 1, "Pages に成果物を上げる job はちょうど1つであるべき");
});

test("公開する workflow は必ず共有検査を通る", () => {
  // 「検査を通さずに公開する経路」だけを禁じる。読み取り専用の解析 workflow まで
  // 巻き込むと、無関係な workflow を足しただけで赤くなり、この検査ごと消される。
  const offenders = [];
  let publishers = 0;
  for (const name of names) {
    if (!Object.values(jobsOf(name)).some((job) => publishStepsOf(job).length > 0)) {
      continue;
    }
    publishers += 1;
    if (!callsShared(name)) offenders.push(name);
  }
  assert.ok(publishers > 0, "公開する workflow が1つも無い（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `共有検査(${SHARED})を呼ばずに公開する workflow があります:\n${offenders.join("\n")}`,
  );
});

test("危険なトリガを使っていない", () => {
  // pull_request_target / workflow_run は、fork の PR が触った内容を base リポジトリの
  // 権限とシークレットを持った文脈で走らせる。公開リポジトリでは公開経路と同じ重さの穴になる。
  const offenders = [];
  for (const name of names) {
    for (const trigger of triggers(name)) {
      if (FORBIDDEN_TRIGGERS.includes(trigger)) offenders.push(`${name}: ${trigger}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `fork の内容を特権付きで走らせるトリガがあります:\n${offenders.join("\n")}`,
  );
});

test("run: が bash 以外のシェルに差し替えられていない", () => {
  // shell: cat {0} のように差し替えると、run: の本文は表示されるだけで実行されない。
  // 検査も ref 検査も「書いてあるだけ」になり、全部緑で通る。
  const offenders = new Set();
  for (const name of names) {
    const workflowShell = doc(name)?.defaults?.run?.shell;
    for (const [id, job] of Object.entries(jobsOf(name))) {
      const shells = [
        workflowShell,
        job?.defaults?.run?.shell,
        ...stepsOf(job).map((step) => step?.shell),
      ];
      for (const shell of shells) {
        if (shell === undefined || shell === null) continue; // 既定（Linux では bash）
        if (String(shell) !== "bash") offenders.add(`${name} の ${id}: shell: ${shell}`);
      }
    }
  }
  assert.deepEqual(
    [...offenders],
    [],
    `run: の本文を実行しないシェルが指定されています:\n${[...offenders].join("\n")}`,
  );
});

test("PR も main への直接 push も、同じ検査を通る", () => {
  assert.ok(triggeredBy("ci.yml", "pull_request"), "ci.yml が PR で走らない");
  assert.ok(callsShared("ci.yml"), "ci.yml が共有検査を呼んでいない");

  assert.ok(triggeredBy("pages.yml", "push"), "pages.yml が push で走らない");
  const push = (doc("pages.yml").on ?? doc("pages.yml")[true])?.push;
  const branches = Array.isArray(push?.branches) ? push.branches.map(String) : [];
  assert.deepEqual(
    branches,
    ["main"],
    "pages.yml の push トリガが main だけを対象にしていない",
  );
  assert.ok(callsShared("pages.yml"), "pages.yml が共有検査を呼んでいない");
});

test("公開はビルドに、ビルドは検査に依存している", () => {
  const jobs = jobsOf("pages.yml");
  for (const job of ["verify", "build", "deploy"]) {
    assert.ok(job in jobs, `pages.yml に ${job} job が無い`);
  }
  assert.equal(
    jobs.verify.uses,
    SHARED,
    "pages.yml の verify job が共有検査を呼んでいない",
  );
  assert.ok(
    needsOf(jobs.build).includes("verify"),
    "build が verify を needs にしていない（検査が落ちても成果物が作られる）",
  );
  assert.ok(
    needsOf(jobs.deploy).includes("build"),
    "deploy が build を needs にしていない（ビルドが落ちても公開される）",
  );
});

test("手動起動できるのは ref を検査する公開経路だけ", () => {
  assert.ok(names.length > 0, "workflow が1つも無い（空振りで緑）");
  const dispatchable = names.filter((n) => triggeredBy(n, "workflow_dispatch"));
  // 手動起動は選んだ ref に対して走る。push の branches: では絞れないので、
  // ref を機械的に検査する公開経路（pages.yml）以外には置かない。
  // PR 用 workflow に置くと、マージ結果を検査しないまま必須ステータスチェックに
  // 載る名前の check を head の SHA に緑で付けられる。
  assert.deepEqual(
    dispatchable,
    ["pages.yml"],
    "手動起動できる workflow が想定と違います。" +
      "手動起動を足すなら ref 検査を通す（pages.yml と同じ形にする）こと",
  );
});

test("公開の全 job が ref 検査を通る", () => {
  const jobs = jobsOf("pages.yml");
  assert.ok(
    GUARD in jobs,
    `pages.yml に ${GUARD} job が無い（手動起動で任意の ref を公開できる）。` +
      `job 名を変えたならこのファイルの GUARD も合わせること`,
  );
  assert.equal(
    jobs[GUARD].if,
    undefined,
    `${GUARD} が条件付きになっている（条件を外せば ref 検査ごと素通りする）`,
  );
  for (const job of Object.keys(jobs)) {
    assert.ok(
      reachesVia(jobs, job, GUARD),
      `pages.yml の ${job} が ${GUARD} を needs で通らない（ref 検査を迂回して公開できる）`,
    );
  }
});

test("ref 検査が起動 ref だけを見ている", () => {
  // 起動 ref 以外を判断材料にできると、そこに逃げ道を作れる。実際
  // `[ "$GITHUB_EVENT_NAME" = workflow_dispatch ] && exit 0` を足すと、
  // 手動起動だけ検査を飛ばす（＝この job の存在意義そのものを外す）ことができる。
  // 見るのは「実際に読んでいる変数」だけ。読まれない env まで縛ると、無関係な
  // NODE_OPTIONS を足しただけで赤くなる。
  const guard = jobsOf("pages.yml")[GUARD];
  const bound = new Map();
  for (const source of [doc("pages.yml").env, guard?.env, ...stepsOf(guard).map((s) => s?.env)]) {
    for (const [key, value] of Object.entries(source ?? {})) bound.set(key, String(value));
  }
  const reads = [...new Set(runStepsOf(guard).flatMap((step) => envReads(step.run)))];
  assert.ok(reads.length > 0, `${GUARD} が ref を1つも読んでいない（空振りで緑）`);
  for (const varName of reads) {
    if (INERT_ACTIONS_VARS.includes(varName)) continue; // 書き出し先。判断に影響しない
    if (bound.has(varName)) {
      assert.match(
        bound.get(varName),
        REF_EXPRESSION,
        `${GUARD} が起動 ref 以外の値を読んでいる: ${varName}: ${bound.get(varName)}`,
      );
      continue;
    }
    assert.equal(
      varName,
      "GITHUB_REF",
      `${GUARD} が起動 ref 以外の環境変数を読んでいる: $${varName}`,
    );
  }
});

test("ref 検査が main 以外を実際に拒否する", () => {
  // 「それらしい文字列があるか」を正規表現で見るだけでは足りない。比較を反転させる
  // （!= を = にする）・無関係な分岐に exit 1 を置く、のどちらでも文字列検査は通り、
  // その状態で main 以外が公開できてしまう。そこで本文をそのまま実行して、
  // 終了コードで振る舞いを固定する。
  // 実行するのはこのリポジトリ自身の workflow に書かれた数行で、`pnpm test` が
  // 既にリポジトリのコードを実行しているのと同じ範囲。作業ディレクトリは使い捨てにする。
  const scripts = runStepsOf(jobsOf("pages.yml")[GUARD]).map((step) => step.run);
  assert.ok(scripts.length > 0, `pages.yml の ${GUARD} に run: が無い`);
  assert.ok(
    scripts.every((script) => script.trim()),
    `${GUARD} に空の run: がある`,
  );

  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const files = scripts.map((script, i) => {
    const file = join(dir, `guard-${i}.sh`);
    writeFileSync(file, script);
    return file;
  });
  // Actions が実際に立てる環境変数を再現する。削りすぎると、GITHUB_OUTPUT を使う
  // だけの正当な guard が `set -u` で落ち、「main を拒否している」と嘘の警報が出る。
  const baseEnv = (ref) => ({
    PATH: process.env.PATH,
    HOME: dir,
    CI: "true",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: dir,
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SHA: "0".repeat(40),
    GITHUB_OUTPUT: join(dir, "gh-output"),
    GITHUB_ENV: join(dir, "gh-env"),
    GITHUB_PATH: join(dir, "gh-path"),
    GITHUB_STEP_SUMMARY: join(dir, "gh-summary"),
    GITHUB_REF: ref,
    GITHUB_REF_NAME: ref.replace(/^refs\/(heads|tags)\//, ""),
    REF: ref,
  });
  // 「ここを見れば素通りできる」変数を、素通りしたくなる値で全部立てておく。
  // $(printenv X) のように静的検査をすり抜ける読み方をしていても、これで露見する。
  const tempting = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "maintainer",
    GITHUB_TRIGGERING_ACTOR: "maintainer",
    GITHUB_BASE_REF: "main",
    GITHUB_HEAD_REF: "main",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_WORKFLOW: "Deploy to GitHub Pages",
    FORCE: "1",
    SKIP: "1",
    OVERRIDE: "1",
    ALLOW_PUBLISH: "1",
  };
  // job は step を順に実行し、1つでも落ちれば失敗する。それをそのまま再現する。
  const runAll = (ref, extra) => {
    for (const file of files) {
      const result = spawnSync("bash", [file], {
        cwd: dir,
        encoding: "utf8",
        env: { ...baseEnv(ref), ...extra },
      });
      assert.ok(!result.error, `${GUARD} を実行できない: ${result.error?.message}`);
      if (result.status !== 0) return { status: result.status, stderr: result.stderr };
    }
    return { status: 0, stderr: "" };
  };

  // 拒否されるべき ref。手で並べると「staging も通す」のような緩和を見逃すので、
  // 通してよい唯一の値以外を機械的に組み立てる。
  const refused = [];
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/pull/1/", ""]) {
    for (const leaf of [
      "main", "Main", "MAIN", "main-2", "main/x", "mainx", "notmain", "master",
      "develop", "staging", "production", "release", "release/1.0", "gh-pages",
      "feature/x", "hotfix", "merge", "head", "trunk", "next", "v1", "canary",
    ]) {
      const ref = `${prefix}${leaf}`;
      if (ref !== "refs/heads/main") refused.push(ref);
    }
  }
  refused.push("", " refs/heads/main", "refs/heads/main ", "refs/heads/main\n",
    "refs/remotes/origin/main", 'refs/heads/x"; touch injected; #');

  try {
    const ok = runAll("refs/heads/main", {});
    assert.equal(
      ok.status,
      0,
      `${GUARD} が main を拒否している（main の公開が全部止まる）: ${ok.stderr}`,
    );
    assert.equal(
      runAll("refs/heads/main", tempting).status,
      0,
      `${GUARD} が main を拒否している（環境変数で挙動が変わっている）`,
    );
    for (const ref of refused) {
      assert.notEqual(
        runAll(ref, {}).status,
        0,
        `${GUARD} が ${JSON.stringify(ref)} を拒否していない（未検証のコードを公開できる）`,
      );
      assert.notEqual(
        runAll(ref, tempting).status,
        0,
        `${GUARD} が ${JSON.stringify(ref)} を拒否していない（起動 ref 以外を判断材料にしている）`,
      );
    }
    assert.ok(
      !existsSync(join(dir, "injected")),
      `${GUARD} が ref をシェルに直接展開している（ブランチ名で任意コマンドが動く）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("公開する job が github-pages environment を要求している", () => {
  // 手動起動は「選んだ ref にある workflow 定義」で走るので、guard を削ったコピーを
  // push したブランチを選べば guard 自体が走らない。ref を最終的に強制しているのは
  // environment 側の deployment branch policy で、これは deploy job が environment を
  // 要求した時点でサーバ側で評価される。environment の宣言が消えると最終防衛線ごと外れる。
  let deployers = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!stepsOf(job).some((step) => /deploy-pages/.test(String(step?.uses ?? "")))) {
        continue;
      }
      deployers += 1;
      const environment =
        typeof job.environment === "string" ? job.environment : job.environment?.name;
      assert.equal(
        environment,
        PUBLISH_ENVIRONMENT,
        `${name} の ${id} が ${PUBLISH_ENVIRONMENT} environment を要求していない`,
      );
    }
  }
  assert.equal(deployers, 1, "Pages に公開する job はちょうど1つであるべき");
});

test("run: に式を直接展開している step が無い", () => {
  // ${{ }} は実行前にテキスト置換されるので、シェルに直接書くとブランチ名や
  // コミットメッセージから任意のコマンドを差し込める。env: 経由で渡すこと。
  const offenders = [];
  let scanned = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      for (const step of runStepsOf(job)) {
        scanned += 1;
        if (/\$\{\{/.test(step.run)) offenders.push(`${name} の ${id}: ${step.name ?? step.run}`);
      }
    }
  }
  assert.ok(scanned > 0, "run: を1つも読めていない（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `run: の中に式を直接展開しています（env: 経由で渡すこと）:\n${offenders.join("\n")}`,
  );
});

test("第三者の action は commit SHA で固定されている", () => {
  // タグは付け替えられる。gitleaks の取得物を SHA256 で固定しているのと同じ理由で、
  // 公開する成果物を作る側の action もすり替えられないようにする。
  // actions/* は GitHub 自身の組織で、ランナーや Actions サービスと同じ信頼境界。
  const offenders = [];
  let checked = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      for (const step of stepsOf(job)) {
        const uses = typeof step?.uses === "string" ? step.uses : null;
        if (!uses) continue;
        checked += 1;
        // リポジトリ内の composite action はこの検査の走査対象外なので、run: に課した
        // 制約（式の直接展開・素の実行・シェル差し替え）を全部そこへ逃がせてしまう。
        // 必要になったらこのテストを .github/actions まで広げてから足すこと。
        if (uses.startsWith("./")) {
          offenders.push(`${name} の ${id}: ${uses}（この検査の走査対象外）`);
          continue;
        }
        if (uses.startsWith("actions/")) continue;
        if (!/@[0-9a-f]{40}$/.test(uses)) offenders.push(`${name} の ${id}: ${uses}`);
      }
    }
  }
  assert.ok(checked > 0, "uses: を1つも読めていない（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `第三者の action がタグ参照のままです（commit SHA で固定すること）:\n${offenders.join("\n")}`,
  );
});

test("runs-on を持つ job は timeout-minutes を持つ", () => {
  // pages.yml は cancel-in-progress: false なので、固まった job は既定の6時間
  // その ref の公開を止め続ける。上限を全 job に義務づけて詰まりを短く切る。
  const offenders = [];
  let checked = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (job?.["runs-on"] === undefined) continue; // 呼び出し(uses:)側には付けられない
      checked += 1;
      // 引用符付き（"30"）も Actions は受け付ける。型の違いで「無い」と言わない。
      const limit = job["timeout-minutes"];
      if (!/^\d+$/.test(String(limit ?? "")) || Number(limit) <= 0) {
        offenders.push(`${name} の ${id}: ${limit === undefined ? "未設定" : limit}`);
      }
    }
  }
  assert.ok(checked > 0, "runs-on を持つ job が1つも無い（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `timeout-minutes の無い job があります:\n${offenders.join("\n")}`,
  );
});

test("書き込み権限は明示的に許可した job だけが持つ", () => {
  // 既定は「持たせない」。write を1つ足すのはレビューを伴う明示的な判断であるべきで、
  // 今は Pages 公開の deploy job だけが対象。bot などで必要になったら
  // ALLOWED_WRITE_JOBS に理由付きで足す（黙って広げない）。
  assert.ok(names.length > 0, "workflow が1つも無い（空振りで緑）");
  const offenders = [];
  for (const name of names) {
    const top = permissionsOf(doc(name));
    assert.notEqual(
      top,
      null,
      `${name}: workflow 既定の permissions が未宣言（既定が広い権限になる）`,
    );
    for (const [scope, level] of top) {
      if (isWrite(level)) offenders.push(`${name} (既定): ${scope}: ${level}`);
    }
    const allowed = ALLOWED_WRITE_JOBS[name] ?? {};
    for (const [id, job] of Object.entries(jobsOf(name))) {
      for (const [scope, level] of permissionsOf(job) ?? []) {
        if (!isWrite(level)) continue;
        if ((allowed[id] ?? []).includes(scope)) continue;
        offenders.push(`${name} の ${id}: ${scope}: ${level}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `想定外の書き込み権限があります。既定は「持たせない」で、必要なら理由を添えて\n` +
      `このファイルの ALLOWED_WRITE_JOBS に足すこと:\n${offenders.join("\n")}`,
  );
});

test("workflow が lib/site.ts と違う basePath を注入していない", () => {
  // 注入は package.json の build:publish / test:publish に一本化してある。
  // 新しい workflow が別の値（空文字を含む）を直接注入すると、検査したビルドと
  // 公開するビルドが別物になる。空も拾えるように書く。
  assert.ok(names.length > 0, "workflow が1つも無い（空振りで緑）");
  for (const name of names) {
    for (const m of render(doc(name)).matchAll(
      /NEXT_PUBLIC_BASE_PATH[^\S\n]*[:=][^\S\n]*(?:"([^"\n]*)"|'([^'\n]*)'|(\S*))/g,
    )) {
      assert.equal(
        m[1] ?? m[2] ?? m[3] ?? "",
        BASE_PATH,
        `${name} が注入する basePath が lib/site.ts の BASE_PATH と違う`,
      );
    }
  }
});
