// workflows.test.mjs — CI のゲートに穴が開いていないことを検査する。
//
// 背景（実害）: 検査を workflow ごとに書き写していたため、経路によって通るゲートが
// 違っていた。秘密スキャンは push(main) 側にしか無く、PR で平文の認証情報を入れても
// 緑のまま main に入れられた。依存監査は PR 側にしか無く、main への直接 push は
// 監査を通らずに公開できた。成果物検査は out/ が無いと静かにスキップされ、
// 「安全網があるつもり」で緑になった。
//
// 対策として検査は .github/workflows/verify.yml に一本化し、main に到達する全経路
// （PR / main への直接 push）から呼ぶ。このテストはその構造を固定する。
// ゲートを1つ外す・条件付きにする・verify.yml を経由しない公開経路を足す、
// のいずれをやっても落ちる。
//
// このテスト自身が「対象が無いから空振りで緑」にならないよう、走査対象が空でない
// ことを都度固定する（不在＝合格を作らない）。YAML の書き方が変わって読めなくなった
// 場合も、黙って通さず落とす方に倒す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BASE_PATH } from "../lib/site.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = resolve(__dirname, "../.github/workflows");
const SHARED = "./.github/workflows/verify.yml";
// 文字列がどこかに出てくるだけでは呼んだことにならない。job の uses: であること。
const CALLS_SHARED = /uses:\s*\.\/\.github\/workflows\/verify\.yml\s*$/m;
// 検査を共有する側と、それを呼ぶ側。呼ぶ側が欠けたら経路に穴が開く。
const CALLERS = ["ci.yml", "pages.yml"];
// 書き込み権限を持ってよい job（Pages 公開に必要な分だけ）。
const ALLOWED_WRITE_JOBS = { "pages.yml": { deploy: ["pages", "id-token"] } };

const names = existsSync(WORKFLOWS)
  ? readdirSync(WORKFLOWS)
      .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
      .sort()
  : [];
const read = (name) => readFileSync(resolve(WORKFLOWS, name), "utf8");

/** 行末コメントを落とす（`needs: verify # 説明` を値の一部として読まないため）。 */
const stripInline = (line) => line.replace(/\s+#.*$/, "");

/**
 * 行頭コメントを落とす。コメントアウトされた step はゲートではないので、
 * 「# - run: pnpm audit」を残したまま緑になるのを防ぐ。
 */
const uncommented = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * `on:` の宣言だけを返す。ブロック形式（on:\n  push:）もフロー形式
 * （on: [push, pull_request]）も同じように読む。ここを取りこぼすと
 * 「トリガの無い workflow」と誤判定して検査対象から外れ、空振りで緑になる。
 */
function onBlock(name) {
  const lines = uncommented(read(name)).split("\n");
  const at = lines.findIndex((l) => /^"?on"?\s*:/.test(l));
  assert.notEqual(at, -1, `${name}: on: が見つからない`);
  const out = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break; // 次のトップレベルキー
    out.push(line);
  }
  return out.join("\n");
}

/** on: にこのトリガが含まれているか（ブロック / フロー / スカラのいずれも）。 */
const triggeredBy = (name, trigger) =>
  new RegExp(`(^|[\\s[,:])${trigger}\\s*($|[:,\\]\\s])`, "m").test(onBlock(name));

/**
 * job 名 -> その job の本文（インデントは元のまま）。
 * GitHub Actions の慣習どおり job は2スペース、job のキーは4スペース前提。
 * 別のインデント幅に書き換えられたら読めずに落ちる（黙って緑にはしない）。
 */
const jobsCache = new Map();
function jobsOf(name) {
  if (jobsCache.has(name)) return jobsCache.get(name);
  const body = uncommented(read(name));
  const start = body.search(/^jobs:\s*$/m);
  assert.notEqual(start, -1, `${name}: jobs: が見つからない`);
  const jobs = new Map();
  let current = null;
  for (const line of body.slice(start).split("\n")) {
    const head = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (head) {
      current = head[1];
      jobs.set(current, []);
      continue;
    }
    if (current !== null) jobs.get(current).push(line);
  }
  assert.ok(jobs.size > 0, `${name}: job を1つも読めていない`);
  const parsed = new Map([...jobs].map(([k, v]) => [k, v.join("\n")]));
  jobsCache.set(name, parsed);
  return parsed;
}

/** job の needs: を配列で返す（スカラ / フロー配列 / ブロック配列のいずれも読む）。 */
function needsOf(jobBody) {
  const lines = jobBody.split("\n");
  const at = lines.findIndex((l) => /^ {4}needs:/.test(l));
  if (at === -1) return [];
  const unquote = (v) => v.replace(/^["']|["']$/g, "").trim();
  const inline = stripInline(lines[at]).replace(/^ {4}needs:/, "").trim();
  if (inline) {
    return inline
      .replace(/[[\]]/g, "")
      .split(",")
      .map((v) => unquote(v))
      .filter(Boolean);
  }
  // ブロック配列。ダッシュのインデントは書き手によって 4 でも 6 でもありうる。
  const out = [];
  for (const line of lines.slice(at + 1)) {
    const item = stripInline(line).match(/^ {4,}- *(.+?)\s*$/);
    if (!item) break;
    out.push(unquote(item[1]));
  }
  return out;
}

/**
 * `permissions:` ブロックを (スコープ, 権限) の配列で返す。
 * 見つからなければ null（＝未宣言）。`permissions: read-all` のような
 * 1行形式は ["*", "read-all"] として返す。
 */
function permissionsIn(text, indent) {
  const lines = text.split("\n");
  const head = new RegExp(`^ {${indent}}permissions:\\s*(.*)$`);
  const entry = new RegExp(`^ {${indent + 2}}([a-z-]+)\\s*:\\s*(\\S+)`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = stripInline(lines[i]).match(head);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) return inline === "{}" ? [] : [["*", inline]];
    const out = [];
    for (const line of lines.slice(i + 1)) {
      const e = stripInline(line).match(entry);
      if (!e) break;
      out.push([e[1], e[2]]);
    }
    return out;
  }
  return null;
}

const isWrite = (level) => /write/.test(level);

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
  assert.match(
    uncommented(read("verify.yml")),
    /^on:\s*\n\s+workflow_call:/m,
    "verify.yml が workflow_call で呼べない（共有されない）",
  );
});

// 経路ごとに書き写すと片方だけ古くなる。ゲートの実体は verify.yml の1箇所だけ。
// [ラベル, 対象 job, 正規表現]
const GATES = [
  ["秘密スキャン（gitleaks）", "secret-scan", /gitleaks detect/],
  ["秘密スキャンが全履歴を見る", "secret-scan", /fetch-depth:\s*0/],
  [
    "公開検査（basePath 付きビルド＋成果物検査）",
    "checks",
    /pnpm run test:publish/,
  ],
  ["型検査", "checks", /pnpm typecheck/],
  ["lint", "checks", /pnpm lint/],
  ["依存監査", "checks", /pnpm audit --audit-level high/],
];

for (const [label, job, re] of GATES) {
  test(`共有 workflow の ${job} が ${label} を持っている`, () => {
    const jobs = jobsOf("verify.yml");
    assert.ok(jobs.has(job), `verify.yml に ${job} job が無い`);
    assert.match(
      jobs.get(job),
      re,
      `verify.yml の ${job} から ${label} が消えている（全経路のゲートが同時に外れる）`,
    );
  });
}

test("ゲートが条件付き・失敗許容になっていない", () => {
  // コマンドが書いてあるだけでは足りない。落ちたら止まること、常に走ることまで固定する。
  const offenders = [];
  for (const name of names) {
    const body = uncommented(read(name));
    for (const raw of body.split("\n")) {
      const line = raw.trimEnd();
      if (/continue-on-error:\s*true/.test(line)) {
        offenders.push(`${name}: ${line.trim()}（失敗しても後続が走る）`);
      }
      if (/^\s+if:.*(\balways\s*\(\)|\bfailure\s*\(\)|!\s*cancelled\s*\(\))/.test(line)) {
        offenders.push(`${name}: ${line.trim()}（前段が落ちても実行される）`);
      }
    }
  }
  // 共有検査の中身は無条件で走ること。if: が付くと経路によって外れる。
  for (const [job, bodyText] of jobsOf("verify.yml")) {
    for (const raw of bodyText.split("\n")) {
      if (/^\s+if:/.test(raw)) {
        offenders.push(
          `verify.yml の ${job}: ${raw.trim()}（ゲートが条件付きになっている）`,
        );
      }
    }
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
  for (const name of names) {
    for (const raw of uncommented(read(name)).split("\n")) {
      // `- run: X` も `run: |` ブロック中の X も同じように見る。
      const cmd = stripInline(raw)
        .replace(/^\s*-?\s*(run:\s*)?/, "")
        .trim();
      if (BARE.some((re) => re.test(cmd))) offenders.push(`${name}: ${cmd}`);
    }
  }
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
    for (const [job, bodyText] of jobsOf(name)) {
      if (!/upload-pages-artifact/.test(bodyText)) continue;
      uploaders += 1;
      assert.match(
        bodyText,
        /run:\s*pnpm run build:publish/,
        `${name} の ${job} が build:publish 以外でビルドしている（公開先で 404 になる）`,
      );
      assert.match(
        bodyText,
        /path:\s*out\s*$/m,
        `${name} の ${job} がアップロードするのが out/ ではない`,
      );
    }
  }
  assert.equal(uploaders, 1, "Pages に成果物を上げる job はちょうど1つであるべき");
});

test("main に到達・公開する全経路が共有 workflow を通る", () => {
  const offenders = [];
  let checked = 0;
  for (const name of names) {
    if (name === "verify.yml") continue;
    const body = uncommented(read(name));
    // main への push / PR で走る、あるいは公開する workflow は共有検査を呼ぶ。
    const reachesMain = ["push", "pull_request", "merge_group"].some((t) =>
      triggeredBy(name, t),
    );
    const deploys =
      /deploy-pages|upload-pages-artifact|gh-pages|github-pages/i.test(body);
    if (!reachesMain && !deploys) continue;
    checked += 1;
    if (!CALLS_SHARED.test(body)) offenders.push(name);
  }
  assert.equal(
    checked,
    CALLERS.length,
    "main へ到達・公開する workflow の数が想定と違う（新しい経路を検査に載せること）",
  );
  assert.deepEqual(
    offenders,
    [],
    `共有検査(${SHARED})を呼ばずに main へ到達・公開する workflow があります:\n${offenders.join("\n")}`,
  );
});

test("PR も main への直接 push も、同じ検査を通る", () => {
  assert.ok(triggeredBy("ci.yml", "pull_request"), "ci.yml が PR で走らない");
  assert.match(
    uncommented(read("ci.yml")),
    CALLS_SHARED,
    "ci.yml が共有検査を呼んでいない",
  );

  assert.ok(triggeredBy("pages.yml", "push"), "pages.yml が push で走らない");
  const branches = onBlock("pages.yml").match(
    /branches:\s*(\[[^\]]*\]|(?:\n\s+- *\S+)+)/,
  )?.[1];
  assert.ok(branches, "pages.yml の push トリガに branches: が無い");
  assert.match(
    branches.replace(/["']/g, ""),
    /\bmain\b/,
    "pages.yml が main ブランチを対象にしていない",
  );
  assert.match(
    uncommented(read("pages.yml")),
    CALLS_SHARED,
    "pages.yml が共有検査を呼んでいない",
  );
});

test("公開はビルドに、ビルドは検査に依存している", () => {
  const jobs = jobsOf("pages.yml");
  for (const job of ["verify", "build", "deploy"]) {
    assert.ok(jobs.has(job), `pages.yml に ${job} job が無い`);
  }
  assert.match(
    jobs.get("verify"),
    CALLS_SHARED,
    "pages.yml の verify job が共有検査を呼んでいない",
  );
  assert.ok(
    needsOf(jobs.get("build")).includes("verify"),
    "build が verify を needs にしていない（検査が落ちても成果物が作られる）",
  );
  assert.ok(
    needsOf(jobs.get("deploy")).includes("build"),
    "deploy が build を needs にしていない（ビルドが落ちても公開される）",
  );
});

test("書き込み権限は Pages 公開の job だけが持つ", () => {
  assert.ok(names.length > 0, "workflow が1つも無い（空振りで緑）");
  const offenders = [];
  for (const name of names) {
    const top = permissionsIn(uncommented(read(name)), 0);
    assert.notEqual(
      top,
      null,
      `${name}: workflow 既定の permissions が未宣言（既定が広い権限になる）`,
    );
    for (const [scope, level] of top) {
      if (isWrite(level)) offenders.push(`${name} (既定): ${scope}: ${level}`);
    }
    const allowed = ALLOWED_WRITE_JOBS[name] ?? {};
    for (const [job, bodyText] of jobsOf(name)) {
      for (const [scope, level] of permissionsIn(bodyText, 4) ?? []) {
        if (!isWrite(level)) continue;
        if ((allowed[job] ?? []).includes(scope)) continue;
        offenders.push(`${name} の ${job}: ${scope}: ${level}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `想定外の書き込み権限があります（依存のインストールスクリプトに渡る）:\n${offenders.join("\n")}`,
  );
});

test("workflow が lib/site.ts と違う basePath を注入していない", () => {
  // 注入は package.json の build:publish / test:publish に一本化してある。
  // 新しい workflow が別の値（空文字を含む）を直接注入すると、検査したビルドと
  // 公開するビルドが別物になる。空も拾えるように書く。
  assert.ok(names.length > 0, "workflow が1つも無い（空振りで緑）");
  for (const name of names) {
    const body = uncommented(read(name))
      .split("\n")
      .map(stripInline)
      .join("\n");
    for (const m of body.matchAll(
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
