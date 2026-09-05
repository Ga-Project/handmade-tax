// workflows.test.mjs — CI のゲートに穴が開いていないことを検査する。
//
// 背景（実害）: 検査を workflow ごとに書き写していたため、経路によって通るゲートが
// 違っていた。秘密スキャンは push(main) 側にしか無く、PR で平文の認証情報を入れても
// 緑のまま main に入れられた。依存監査は PR 側にしか無く、main への直接 push は
// 監査を通らずに公開できた。成果物検査は out/ が無いと静かにスキップされ、
// 「安全網があるつもり」で緑になった。
//
// もう1つの穴が手動起動だった。workflow_dispatch は「選んだ ref」に対して、しかも
// 「その ref にある workflow 定義」で走る。公開 workflow を feature ブランチやタグで
// 起動すれば main に入っていないコードを公開でき、PR 用 workflow を手動起動すれば
// マージ結果を一度も検査しないまま必須ステータスチェックに載る名前の check を
// head の SHA に緑で付けられた。
//
// これを workflow の中の ref 検査 job で塞ごうとしたが、塞げない。検査する側の
// 定義が、検査される側の ref から読み込まれるからで、その job を削ったコピーを
// push したブランチを選べば検査ごと消える。同じ理由で「environment を要求する」
// 宣言も、その ref 側の YAML でしかない。信頼境界の内側に置けないものを内側に
// 置こうとしていたので、手動起動そのものを外した。
//
// 対策として検査は .github/workflows/verify.yml に一本化し、main に到達する全経路
// （PR / main への直接 push）から呼ぶ。公開の起動経路は main への push だけにし、
// ref は GitHub 側のトリガ定義（branches: [main]）で固定する。
// このテストはその構造を固定する。
//
// 読み取りは YAML パーサに任せる。以前はここで正規表現で YAML を読んでいたが、
// 「job 名を引用符で囲む」「値を次の行に置く」「フロー形式で書く」「ブロックスカラの
// 見出しに行末コメントを付ける」のいずれでも読み落として、書き込み権限を持つ公開 job
// や式のシェル直展開を素通りさせた。ゲートを守るための検査が書き方ひとつで無力化
// されるので、YAML の解釈を自前で持たない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
// 使ってはいけないトリガ。pull_request_target と workflow_run は fork の PR が触った
// 内容を base リポジトリの権限とシークレットを持った文脈で走らせる。repository_dispatch は
// API から任意の payload で起動でき、workflow の起動条件がリポジトリの外に出る。
const FORBIDDEN_TRIGGERS = ["pull_request_target", "workflow_run", "repository_dispatch"];
// 公開に使う action。これを持つ job が「公開する job」。
const PUBLISH_ACTIONS = /deploy-pages|upload-pages-artifact/;
// 起動 ref を workflow の外側で固定するトリガ。公開する workflow はこれだけで動く。
// workflow_dispatch のように起動側が ref を選べるトリガは、その ref にある定義で
// 走るため、workflow の中に書いた検査ごと差し替えられる。
const PUBLISH_TRIGGERS = ["push"];
// 公開先の environment。deployment branch policy が乗る多層防御。
const PUBLISH_ENVIRONMENT = "github-pages";

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
 * on: の中身。YAML 1.1 として解釈する実装では on が真偽値キーになるので両方を見る
 * （取りこぼすと「トリガの無い workflow」と誤判定して空振りする）。読み方の分岐を
 * ここ1箇所に閉じ込める。写しを増やすと、片方だけ undefined を見て緑になる。
 */
function onOf(name) {
  const on = doc(name).on ?? doc(name)[true];
  assert.ok(on !== undefined && on !== null, `${name}: on: が見つからない`);
  return on;
}

/** on: のトリガ名。 */
function triggers(name) {
  const on = onOf(name);
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

/** job の uses: が指すローカル workflow のファイル名。ローカル参照でなければ null。 */
function localWorkflowOf(job) {
  const match = /^\.\/\.github\/workflows\/([^@]+?)(?:@.*)?$/.exec(String(job?.uses ?? ""));
  return match ? match[1] : null;
}

/** その workflow が公開 step を持つか。 */
const publishes = (name) =>
  Object.values(jobsOf(name)).some((job) => publishStepsOf(job).length > 0);

/**
 * 公開経路から（間接でも）呼ばれるローカル workflow。
 * 呼び出し元の job にいくら制約を掛けても、その1段下は別ファイルなので素通りする。
 * 呼ばれる側の中身も丸ごとゲートの一部として扱う。
 */
const GATE_WORKFLOWS = (() => {
  const out = new Set();
  const walk = (name) => {
    for (const job of Object.values(jobsOf(name))) {
      const local = localWorkflowOf(job);
      if (!local || !names.includes(local) || out.has(local)) continue;
      out.add(local);
      walk(local);
    }
  };
  for (const name of names) if (publishes(name)) walk(name);
  return out;
})();

/**
 * ゲートの連鎖に乗っている job。
 * 公開する workflow と、そこから呼ばれるローカル workflow は全 job が対象。
 * needs で検査の後段に置いても `if: always()` を付ければ検査の結果と無関係に走るので、
 * 「前段をたどれるか」だけでは足りない。失敗通知を置きたい場合は、公開経路から
 * 切り離した workflow 側に置く。
 * それ以外の workflow では「共有検査を呼ぶ job・公開する job」と、それらが needs で
 * たどる先だけを対象にする。後片付けや通知まで縛ると、通知の目的そのものを禁じてしまう。
 */
function protectedJobs(name) {
  const jobs = jobsOf(name);
  if (GATE_WORKFLOWS.has(name) || publishes(name)) {
    return new Set(Object.keys(jobs)); // 公開経路。job を1つ足すだけで外に出られる
  }
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
 * YAML のアンカーは自分自身を指せる。たどっている経路上に同じ値が出てきたら
 * そこで打ち切る（スタックを溢れさせると、何が悪いのか読めない形で赤くなる）。
 * 経路から外れたら解除するので、循環でない使い回しは今までどおり全部出る。
 */
function render(node) {
  const out = [];
  const path = new Set();
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      if (path.has(value)) {
        out.push("<循環参照>");
        return;
      }
      path.add(value);
      walkInto(value);
      path.delete(value);
      return;
    }
    out.push(String(value));
  };
  const walkInto = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (child !== null && typeof child === "object") {
        out.push(`${key}:`);
        walk(child);
      } else {
        out.push(`${key}: ${child}`);
      }
    }
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
  ["公開検査（basePath 付きビルド＋成果物検査）", /pnpm run test:publish/],
  ["型検査", /pnpm typecheck/],
  ["lint", /pnpm lint/],
  ["依存監査", /pnpm audit --audit-level high/],
];

// シェルの連結・分岐・バックグラウンド実行。ゲートのコマンドにこれが混ざると、
// 「コマンドは書いてあるが落ちない」状態を作れる（`|| true` `; fi` `&` など）。
const SHELL_CHAINING = /\|\||&&|[;|&`]|\$\(/;

/**
 * run: が1コマンドだけの step のとき、その本文。複数行なら null。
 * コメント行は実行されないので落とす（`# pnpm lint` だけの run: を
 * 「lint を実行している」と読まないため）。
 */
function soleCommandOf(step) {
  if (typeof step?.run !== "string") return null;
  const lines = String(step.run)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.length === 1 ? lines[0] : null;
}

/** 全コマンド（単独 run: step の本文）。 */
const soleCommandsOf = (jobs) =>
  jobs.flatMap((job) => runStepsOf(job).map(soleCommandOf)).filter((cmd) => cmd !== null);

/**
 * そのコマンドで「始まる」単独 run: step だけを返す。
 * 途中一致にすると `echo pnpm lint` や `! gitleaks detect ...` が通ってしまう
 * （前者は何も検査せず、後者は検出したときに 0 で返る）。
 */
function commandsStartingWith(jobs, re) {
  const anchored = new RegExp(`^(?:${re.source})`, re.flags.replace(/g/g, ""));
  return soleCommandsOf(jobs).filter((cmd) => anchored.test(cmd));
}

for (const [label, re] of GATES) {
  test(`共有 workflow が ${label} を単独で実行している`, () => {
    // 「ファイルのどこかにコマンドが書いてある」では足りない。`|| true` を足す、
    // `if ! cmd; then echo; fi` で包む、`&` で投げっぱなしにする、コメントアウトする、
    // `echo` を前に付ける、のいずれでも字面は残ったまま検査されなくなる。
    // ゲートは「それだけを、先頭から実行する run: step」であることまで固定すれば、
    // 包み方を1つずつ潰さなくてもまとめて塞げる。
    const jobs = Object.values(jobsOf("verify.yml"));
    assert.ok(
      soleCommandsOf(jobs).length > 0,
      "verify.yml から実行内容を1つも読めていない（空振りで緑）",
    );
    const matched = commandsStartingWith(jobs, re);
    assert.ok(
      matched.length > 0,
      `verify.yml で ${label} が単独のコマンドとして実行されていない` +
        `（消えたか、失敗を握りつぶす形に包まれている。全経路のゲートが同時に外れる）`,
    );
    for (const cmd of matched) {
      assert.doesNotMatch(
        cmd,
        SHELL_CHAINING,
        `${label} が他のコマンドと連結されている（失敗を握りつぶせる）: ${cmd}`,
      );
    }
  });
}

test("ゲートが条件付き・失敗許容になっていない", () => {
  // コマンドが書いてあるだけでは足りない。落ちたら止まること、常に走ることまで固定する。
  // 値は解析結果から読む。行をなぞると `continue-on-error:` の値を次の行に置くだけで
  // 素通りするし、`${{ ... }}` を書けば true という字面も消せる。
  const offenders = [];
  const tolerates = (value) =>
    value !== undefined && String(value).trim() !== "false";
  let scanned = 0;
  for (const name of names) {
    const guarded = protectedJobs(name);
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!guarded.has(id)) continue; // 失敗通知・後片付けはここの対象外
      scanned += 1;
      // ゲートの連鎖上では if: を一切許さない。always() 系は前段が落ちても走らせるし、
      // 逆に false になる条件は job を skip する。skip した job は失敗ではないので
      // 後続もろとも静かに飛び、run 全体は緑で終わる（＝検査も公開もされていないのに
      // 気づけない）。条件で外れるゲートはゲートではない。
      if (job?.if !== undefined) {
        offenders.push(`${name} の ${id}: if: ${job.if}（条件でゲートが外れる）`);
      }
      for (const [i, step] of stepsOf(job).entries()) {
        if (step?.if !== undefined) {
          offenders.push(`${name} の ${id} の step[${i}]: if:（条件でゲートが外れる）`);
        }
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
  assert.deepEqual(offenders, [], `ゲートに抜け道があります:\n${offenders.join("\n")}`);
});

test("秘密スキャンが全履歴を見ている", () => {
  // 「どこかに fetch-depth: 0 と書いてある」では足りない。浅いクローンのまま
  // gitleaks を走らせると、過去のコミットに入った鍵を見ずに緑で通る。
  // 検査するのは gitleaks を実際に走らせる job の checkout そのもの。
  let scanners = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!runStepsOf(job).some((step) => /gitleaks detect/.test(step.run))) continue;
      scanners += 1;
      const checkouts = stepsOf(job).filter((step) =>
        /^actions\/checkout(@|$)/.test(String(step?.uses ?? "")),
      );
      assert.ok(checkouts.length > 0, `${name} の ${id} が checkout していない`);
      // checkout が全履歴を取っていても、gitleaks 側で走査範囲や検出結果を絞れば同じこと。
      // 走査範囲(--no-git / --log-opts)・除外(--baseline-path / --gitleaks-ignore-path)・
      // ルール差し替え(-c) はどれも「走ったが何も出ない」を作れる。禁止リストにすると
      // フラグが増えるたびに漏れるので、出力の見た目を変えるだけのものだけを許可する。
      const ALLOWED_GITLEAKS_FLAGS = new Set([
        "--no-banner",
        "--redact",
        "-v",
        "--verbose",
        "--report-format",
        "--report-path",
      ]);
      // 見るのは実際に走る gitleaks の行だけ。run: の本文をまるごと切り刻むと、
      // コメントや別のコマンドの引数まで「フラグ」として拾ってしまう。
      const invocations = commandsStartingWith([job], /gitleaks detect/);
      assert.ok(
        invocations.length > 0,
        `${name} の ${id} が gitleaks を単独のコマンドとして実行していない`,
      );
      for (const cmd of invocations) {
        for (const token of cmd.split(/\s+/)) {
          if (!token.startsWith("-")) continue;
          const flag = token.split("=")[0];
          assert.ok(
            ALLOWED_GITLEAKS_FLAGS.has(flag),
            `${name} の ${id} の gitleaks に許可していないフラグがあります: ${flag}` +
              `（走査範囲や検出結果を絞れる。必要ならこのファイルの許可リストに理由付きで足すこと）`,
          );
        }
      }
      for (const checkout of checkouts) {
        assert.equal(
          String(checkout.with?.["fetch-depth"]),
          "0",
          `${name} の ${id} の checkout が全履歴を取っていない（過去のコミットの鍵を見ない）`,
        );
      }
    }
  }
  assert.ok(scanners > 0, "gitleaks を走らせる job が無い（空振りで緑）");
});

test("ゲートがシェル側で失敗を握りつぶしていない", () => {
  // continue-on-error / if: を使わなくても、`|| true` を1つ足すだけでゲートは
  // 「走ったが落ちない」状態にできる。コマンドの字面を見る検査は素通りするので、
  // 失敗を握りつぶす書き方そのものをゲートの連鎖上から禁止する。
  const SUPPRESSORS = [
    [
      /\|\|\s*(?:\/(?:usr\/)?bin\/)?(?:true|:|exit\s+0|echo\b)/,
      "|| true 相当（失敗しても成功扱いになる）",
    ],
    [/;\s*(?:true|:|exit\s+0)\s*$/m, "; true 相当（失敗しても成功扱いになる）"],
    [/\bset\s+\+[A-Za-z]*e/, "set +e 相当（以降の失敗で止まらなくなる）"],
    [/\bset\s+\+o\s+(?:errexit|pipefail)\b/, "set +o errexit（失敗で止まらなくなる）"],
    [/--exit-code[=\s]+0\b/, "--exit-code 0（検出しても 0 で返る）"],
  ];
  const offenders = [];
  let scanned = 0;
  for (const name of names) {
    const guarded = protectedJobs(name);
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!guarded.has(id)) continue;
      for (const step of runStepsOf(job)) {
        scanned += 1;
        for (const [re, why] of SUPPRESSORS) {
          if (re.test(step.run)) offenders.push(`${name} の ${id}: ${why}`);
        }
      }
    }
  }
  assert.ok(scanned > 0, "ゲートの連鎖上の run: を1つも読めていない（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `ゲートの失敗が握りつぶされています:\n${offenders.join("\n")}`,
  );
});

test("reusable workflow の呼び出しがローカル限定で、シークレットを渡していない", () => {
  // 呼び出す側の job にいくら制約を掛けても、呼ばれる側が別リポジトリなら中身は追えない。
  // ゲートの連鎖上で呼べるのはこのリポジトリの workflow だけにする。
  // secrets: inherit（や入力経由の受け渡し）も同じで、検査の実行文脈——依存の
  // インストールやビルドが走る場所——からシークレットが読めるようになる。渡さない。
  const offenders = [];
  const remote = [];
  let callers = 0;
  for (const name of names) {
    const guarded = protectedJobs(name);
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (typeof job?.uses !== "string") continue;
      callers += 1;
      if (guarded.has(id) && localWorkflowOf(job) === null) {
        remote.push(`${name} の ${id}: uses: ${job.uses}`);
      }
      if (job.secrets !== undefined) {
        offenders.push(`${name} の ${id}: secrets: ${render(job.secrets)}`);
      }
      // secrets: を使わなくても、入力を1つ生やして with: で渡せば同じことができる。
      if (/secrets\./.test(render(job.with))) {
        offenders.push(`${name} の ${id}: with: がシークレットを渡している`);
      }
    }
  }
  assert.ok(callers > 0, "reusable workflow を呼ぶ job が1つも無い（空振りで緑）");
  assert.deepEqual(
    remote,
    [],
    `ゲートの連鎖から他リポジトリの workflow を呼んでいます（中身を追えない）:\n${remote.join("\n")}`,
  );
  assert.deepEqual(
    offenders,
    [],
    `reusable workflow の呼び出しにシークレットを渡しています:\n${offenders.join("\n")}`,
  );
});

test("成果物検査をスキップしうる素の実行に置き換えられていない", () => {
  // out/ が無いと成果物検査を静かにスキップする実行系を CI に置かない。
  // 回してよいのはスキップを許さない test:publish のみ。
  // 呼び出し方（pnpm / npx / pnpm exec / .bin の直叩き）を変えただけで抜けられないよう、
  // 「next build を素で起動する形」をまとめて拾う。build:publish は $ 止めなので当たらない。
  const BARE = [
    /^(pnpm|npm|yarn)( run)? test$/,
    /^node\s+--test\b/,
    /^(pnpm|npm|yarn|npx)(\s+(run|exec|dlx))?\s+next\s+build\b/,
    /^[.\/]*(node_modules\/\.bin\/)?next\s+build\b/,
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
  // 検査した out/ と公開する out/ が別物になる経路は「別のコマンドでビルドする」だけでは
  // ない。upload step をもう1つ足して後勝ちさせる、artifact に別名を付けて deploy 側で
  // それを指す、のどちらでも同じことができる。step 単位で数え、名前も既定に固定する。
  let uploaders = 0;
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      const uploads = stepsOf(job).filter((step) =>
        /upload-pages-artifact/.test(String(step?.uses ?? "")),
      );
      if (uploads.length === 0) continue;
      uploaders += uploads.length;
      const builds = commandsStartingWith([job], /pnpm run build:publish/);
      assert.ok(
        builds.length > 0,
        `${name} の ${id} が build:publish 以外でビルドしている（公開先で 404 になる）`,
      );
      for (const cmd of builds) {
        assert.doesNotMatch(
          cmd,
          SHELL_CHAINING,
          `${name} の ${id} のビルドが他のコマンドと連結されている: ${cmd}`,
        );
      }
      // ビルドと upload の間に step を挟めると、検査済みの out/ を別物に置き換えてから
      // 公開できる（download-artifact / cache の復元など）。隣り合っていることを固定する。
      const steps = stepsOf(job);
      const buildIndex = steps.findIndex((step) => {
        const cmd = soleCommandOf(step);
        return cmd !== null && /^pnpm run build:publish/.test(cmd);
      });
      for (const upload of uploads) {
        assert.equal(
          steps.indexOf(upload),
          buildIndex + 1,
          `${name} の ${id} の upload が build:publish の直後ではない` +
            `（間の step が out/ を差し替えられる）`,
        );
        assert.equal(
          upload.with?.path,
          "out",
          `${name} の ${id} がアップロードするのが out/ ではない`,
        );
        assert.equal(
          upload.with?.name ?? "github-pages",
          "github-pages",
          `${name} の ${id} が既定と違う名前で artifact を上げている（公開されるものがずれる）`,
        );
      }
    }
  }
  assert.equal(uploaders, 1, "Pages に成果物を上げる step はちょうど1つであるべき");
  // deploy 側で別名の artifact を指されると、上で固定した成果物とは別のものが公開される。
  for (const name of names) {
    for (const [id, job] of Object.entries(jobsOf(name))) {
      for (const step of stepsOf(job)) {
        if (!/deploy-pages/.test(String(step?.uses ?? ""))) continue;
        assert.equal(
          step.with?.artifact_name ?? "github-pages",
          "github-pages",
          `${name} の ${id} が既定と違う artifact を公開している`,
        );
      }
    }
  }
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
  // ゲートが「書いてあるだけ」になり、全部緑で通る。
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

test("ゲートの実行環境が差し替えられていない", () => {
  // コマンドの字面を変えなくても、どこで走るかを変えれば結果は変えられる。
  // working-directory を足せば別の package.json の scripts が走り、container / services を
  // 足せばタグ差し替え可能な第三者イメージの中で走り、self-hosted ランナーを指せば
  // 誰かの管理下のマシンで走る。この file が action や取得物を SHA で固定しているのと
  // 同じ理由で、実行環境も固定する。
  // コマンドの解決先や実行方法そのものを差し替える環境変数。値が何であれ置かせない。
  // （PATH で gitleaks を偽物に、NODE_OPTIONS で lint/型/テストの中身を差し替えられる）
  const ENV_THAT_CHANGES_EXECUTION =
    /^(PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|SHELL|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NPM_CONFIG_.*|npm_config_.*|PNPM_.*|COREPACK_.*)$/;
  const checkEnv = (where, env) => {
    for (const key of Object.keys(env ?? {})) {
      if (ENV_THAT_CHANGES_EXECUTION.test(key)) offenders.push(`${where}: env: ${key}`);
    }
  };
  const offenders = [];
  let scanned = 0;
  for (const name of names) {
    const guarded = protectedJobs(name);
    // ゲートを1つも持たない workflow（docs のサブディレクトリビルド等）まで縛らない。
    const workflowDefault = doc(name)?.defaults?.run?.["working-directory"];
    if (guarded.size > 0 && workflowDefault !== undefined) {
      offenders.push(`${name} (既定): working-directory: ${workflowDefault}`);
    }
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!guarded.has(id)) continue;
      scanned += 1;
      for (const [key, value] of [
        ["working-directory", job?.defaults?.run?.["working-directory"]],
        ["container", job?.container],
        ["services", job?.services],
      ]) {
        if (value !== undefined) offenders.push(`${name} の ${id}: ${key}:`);
      }
      checkEnv(`${name} の ${id}`, job?.env);
      if (guarded.size > 0) checkEnv(`${name} (既定)`, doc(name)?.env);
      for (const [i, step] of stepsOf(job).entries()) {
        if (step?.["working-directory"] !== undefined) {
          offenders.push(`${name} の ${id} の step[${i}]: working-directory:`);
        }
        checkEnv(`${name} の ${id} の step[${i}]`, step?.env);
      }
      // env: を使わなくても、$GITHUB_ENV / $GITHUB_PATH に書けば後続の step に効く。
      for (const step of runStepsOf(job)) {
        if (/GITHUB_ENV|GITHUB_PATH/.test(step.run)) {
          offenders.push(`${name} の ${id}: run: が GITHUB_ENV / GITHUB_PATH に書いている`);
        }
      }
      const runsOn = job?.["runs-on"];
      if (runsOn === undefined) continue; // 呼び出し(uses:)側には付けられない
      // matrix でランナーを振るのは普通の書き方なので、`${{ matrix.x }}` は
      // strategy.matrix の実際の値まで解決してから判定する。読み取れない書き方
      // （マップ形式の runs-on＝ランナーグループ指定、他の式、解決先の無い matrix 参照）は
      // 「どこで走るか分からない」ので通さない。落とす側に倒す。
      const labels = [];
      let unresolved = false;
      const seenKeys = new Set();
      const collect = (value, depth = 0) => {
        if (value === undefined) return;
        if (depth > 10) return void (unresolved = true);
        if (Array.isArray(value)) return value.forEach((item) => collect(item, depth + 1));
        // マップ形式（group: / labels:）はランナーグループの指定。グループ名は
        // ランナーのラベルではないので、名前で GitHub ホストかどうかは判断できない。
        if (value === null || typeof value === "object") return void (unresolved = true);
        const text = String(value).trim();
        const ref = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(text);
        if (ref) return resolveMatrix(ref[1], depth + 1);
        if (text === "" || text.includes("${{")) return void (unresolved = true);
        labels.push(text);
      };
      // 実際に展開される組み合わせは matrix の基底だけでは決まらない。include は
      // 組み合わせを足せるので、そこに書かれた値も同じ強さで見る。
      // （exclude は組み合わせを減らすだけなので、値の許否には影響しない）
      const resolveMatrix = (key, depth) => {
        const matrix = job?.strategy?.matrix;
        if (matrix === null || typeof matrix !== "object" || Array.isArray(matrix)) {
          return void (unresolved = true);
        }
        if (seenKeys.has(key)) return void (unresolved = true); // 自己参照
        seenKeys.add(key);
        const values = [matrix[key]];
        if (Array.isArray(matrix.include)) {
          for (const entry of matrix.include) values.push(entry?.[key]);
        } else if (matrix.include !== undefined) {
          unresolved = true;
        }
        if (values.every((value) => value === undefined)) return void (unresolved = true);
        for (const value of values) collect(value, depth);
      };
      collect(runsOn);
      if (unresolved || labels.length === 0) {
        offenders.push(`${name} の ${id}: runs-on: ${render(runsOn)}（どこで走るか読み取れない）`);
      }
      for (const label of labels) {
        if (!/^(ubuntu|macos|windows)-/.test(label)) {
          offenders.push(`${name} の ${id}: runs-on: ${label}（GitHub ホストのランナーではない）`);
        }
      }
    }
  }
  assert.ok(scanned > 0, "ゲートの連鎖に乗る job を1つも走査していない（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `ゲートの実行環境が既定から動かされています:\n${offenders.join("\n")}`,
  );
});

test("checkout が起動 ref 以外を取ってこない", () => {
  // 検査した木と公開する木が同じであることは、checkout が既定（起動した ref・
  // このリポジトリ）のままであることに依存している。ref: や repository: を足すと、
  // ゲートを通った内容とビルドされる内容が別物になる。
  const offenders = [];
  let scanned = 0;
  for (const name of names) {
    const guarded = protectedJobs(name);
    for (const [id, job] of Object.entries(jobsOf(name))) {
      if (!guarded.has(id)) continue;
      for (const step of stepsOf(job)) {
        if (!/^actions\/checkout(@|$)/.test(String(step?.uses ?? ""))) continue;
        scanned += 1;
        for (const key of ["ref", "repository"]) {
          if (step.with?.[key] !== undefined) {
            offenders.push(`${name} の ${id}: checkout の ${key}: ${step.with[key]}`);
          }
        }
      }
    }
  }
  assert.ok(scanned > 0, "checkout を1つも読めていない（空振りで緑）");
  assert.deepEqual(
    offenders,
    [],
    `checkout が起動 ref 以外を取ってきています:\n${offenders.join("\n")}`,
  );
});

test("PR も main への直接 push も、同じ検査を通る", () => {
  assert.ok(triggeredBy("ci.yml", "pull_request"), "ci.yml が PR で走らない");
  assert.ok(callsShared("ci.yml"), "ci.yml が共有検査を呼んでいない");

  // push トリガの絞り込み（branches のみ・main のみ）は
  // 「公開する workflow は ref が外側で固定されたトリガでしか起動しない」が厳密に見る。
  // ここで書き写すと、片方だけ緩めたときに食い違いが残る。
  assert.ok(triggeredBy("pages.yml", "push"), "pages.yml が push で走らない");
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

test("起動時に ref を選べるトリガを持つ workflow が無い", () => {
  assert.ok(names.length > 0, "workflow が1つも無い（空振りで緑）");
  // workflow_dispatch は「選んだ ref」に対して、しかも「その ref にある workflow 定義」
  // で走る。したがって workflow の中に何を書いても防御にならない。ref を検査する job も、
  // environment を要求する宣言も、起動する側のブランチにある YAML なので削れる。
  // 公開経路に置けば main に入っていないコードを公開でき、PR 用 workflow に置けば
  // マージ結果を検査しないまま必須ステータスチェックに載る名前の check を
  // head の SHA に緑で付けられる。
  // 取り消された公開のやり直しは、main への push で作られた run を GitHub の re-run で
  // 走らせ直す。re-run は元の run の ref と workflow 定義を使うので、ブランチ側から
  // 差し替えられない。
  assert.deepEqual(
    names.filter((n) => triggeredBy(n, "workflow_dispatch")),
    [],
    "手動起動できる workflow があります。手動起動は選んだ ref の workflow 定義で走るので、" +
      "workflow の中のガードでは塞げません。トリガを外し、main の run の re-run を使うこと",
  );
});

test("公開する workflow は ref が外側で固定されたトリガでしか起動しない", () => {
  // 起動 ref を決めているのが GitHub のトリガ定義（push の branches:）だけ、という状態を
  // 固定する。ここにブランチ側から選べるトリガが1つでも混ざると、公開経路の ref を
  // workflow の中で守るしかなくなり、その時点で守れなくなる。
  let publishers = 0;
  for (const name of names) {
    if (!Object.values(jobsOf(name)).some((job) => publishStepsOf(job).length > 0)) {
      continue;
    }
    publishers += 1;
    assert.deepEqual(
      triggers(name),
      PUBLISH_TRIGGERS,
      `${name}: 公開する workflow のトリガが push だけになっていない`,
    );
    const push = onOf(name).push;
    // push の絞り込みは branches だけ、という形まで固定する。branches の中身しか
    // 見ないと tags: を1行足すだけで抜けられる（タグは任意のコミットに打てるので、
    // main に入っていないコードをそのまま公開できる）。逆に paths-ignore: を足すと
    // main が更新されても公開されなくなり、それも緑のまま気づけない。
    assert.deepEqual(
      Object.keys(push ?? {}).sort(),
      ["branches"],
      `${name}: push トリガの絞り込みが branches 以外を持っている` +
        `（tags: は任意のコミットを、paths 系は公開そのものを、静かに変える）`,
    );
    assert.ok(
      Array.isArray(push?.branches),
      `${name}: push の branches が配列で書かれていない（GitHub は配列を要求する）`,
    );
    assert.deepEqual(
      push.branches.map(String),
      ["main"],
      `${name}: 公開する workflow の push トリガが main だけを対象にしていない`,
    );
  }
  assert.ok(publishers > 0, "公開する workflow が1つも無い（空振りで緑）");
});

test("公開する workflow の全 job が共有検査を needs で通る", () => {
  // job 名を並べて確かめるだけだと、独立した job を1つ足せば検査の外に出られる。
  // その job は verify と並行に走るので、秘密スキャンも監査も通らないうちに
  // main のコードを実行できる。公開経路に置く job は例外なく検査の後段に置く。
  let publishers = 0;
  for (const name of names) {
    const jobs = jobsOf(name);
    if (!Object.values(jobs).some((job) => publishStepsOf(job).length > 0)) continue;
    publishers += 1;
    const gates = Object.entries(jobs)
      .filter(([, job]) => job?.uses === SHARED)
      .map(([id]) => id);
    assert.ok(gates.length > 0, `${name}: 共有検査を呼ぶ job が無い`);
    for (const id of Object.keys(jobs)) {
      assert.ok(
        gates.some((gate) => reachesVia(jobs, id, gate)),
        `${name} の ${id} が共有検査(${gates.join(" / ")})を needs で通らない` +
          `（検査を待たずに main のコードが走る）`,
      );
    }
  }
  assert.ok(publishers > 0, "公開する workflow が1つも無い（空振りで緑）");
});

test("公開する job が github-pages environment を要求している", () => {
  // environment 側の deployment branch policy（main のみ）は、deploy job が environment を
  // 要求した時点でサーバ側で評価される多層防御。ref を固定しているのは起動経路を
  // main への push だけにしてあることで、これはその上に重ねる2枚目。
  // 宣言が消えると2枚目が黙って外れるので、要求していることをここで固定する。
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
  // 公開を止め続ける。上限を全 job に義務づけて詰まりを短く切る。
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
