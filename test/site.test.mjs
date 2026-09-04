// site.test.mjs — 公開先の生成物を読んで、配信とURLの前提が崩れていないか検査する。
//
// 背景（実害）: この製品は basePath 未設定のまま公開され、HTML は 200 で返るのに
// CSS も JS も 404 という状態で稼働していた。変換は全て JS なので訪問者は何もできない。
// 型検査も lint もこの class を検出できないので、実際に basePath 付きでビルドした
// HTML を読んで検査する。
//
// out/ が無い・basePath 無しでビルドされている場合はスキップするが、
// **`pnpm run test:publish` ではスキップを許さない**（この script が
// 「公開と同じ条件でビルド → 検査」を1つにまとめており、CI はこれを回す）。
// 静かにスキップする検査は緑のまま通るので、「安全網があるつもり」になるぶん、
// 無いよりたちが悪い。test:publish は下の env を立てて必ず本検査を通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SITE_URL, BASE_PATH, SITE_DESCRIPTION } from "../lib/site.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../out");

/** out/ 配下の .html を全部集める。 */
function htmlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith(".html") ? [full] : [];
  });
}

const files = htmlFiles(OUT);
const builtWithBasePath =
  files.length > 0 &&
  files.some((f) =>
    readFileSync(f, "utf8").includes(`href="${BASE_PATH}/_next/`),
  );

// スキップを許さない実行（package.json の test:publish が "1" を立てる）。
const REQUIRED = process.env.HANDMADE_TAX_REQUIRE_PUBLISH_CHECK === "1";

const attr = (html, re) => (html.match(re) ?? [])[1];

test("公開検査の前提が満たされている", { skip: !REQUIRED }, () => {
  assert.ok(
    builtWithBasePath,
    `HANDMADE_TAX_REQUIRE_PUBLISH_CHECK=1 だが、basePath 付きでビルドした out/ が見つからない。` +
      ` 'pnpm run build:publish' を先に実行すること` +
      `（この検査がスキップされると、公開先でアセットが 404 のまま CI が緑になる）。`,
  );
});

test("ビルドに注入する basePath が lib/site.ts と食い違っていない", () => {
  // basePath を実際に注入するのはビルドコマンド側なので、lib/site.ts の BASE_PATH と
  // 片方だけ変えると、canonical / sitemap が指すURLと、生成物のアセットパスが食い違う。
  // 注入箇所は package.json の build:publish 1 箇所に寄せてあり、ここでその一致を固定する。
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json")));
  assert.match(
    pkg.scripts?.["build:publish"] ?? "",
    /NEXT_PUBLIC_BASE_PATH=/,
    "build:publish が basePath を注入していない（公開先でアセットが404になる）",
  );
  for (const rel of ["../package.json", "../.github/workflows/pages.yml"]) {
    const path = resolve(__dirname, rel);
    if (!existsSync(path)) continue; // 配布形態によっては workflow が同梱されない
    for (const m of readFileSync(path, "utf8").matchAll(
      /NEXT_PUBLIC_BASE_PATH\s*[:=]\s*"?([^"\s]+)"?/g,
    )) {
      assert.equal(
        m[1],
        BASE_PATH,
        `${rel} が注入する basePath が lib/site.ts の BASE_PATH と違う`,
      );
    }
  }
});

test(
  "サブパス配信でアセット・内部リンクが basePath を失っていない",
  { skip: !builtWithBasePath && !REQUIRED },
  () => {
    const offenders = [];
    for (const file of files) {
      const html = readFileSync(file, "utf8");
      for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
        const url = match[1];
        if (url.startsWith("//")) continue; // 別オリジン（//gc.zgo.at/... 等）は対象外
        if (url.startsWith(`${BASE_PATH}/`) || url === BASE_PATH) continue;
        offenders.push(`${file.slice(OUT.length + 1)}: ${url}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `basePath が前置されていない内部参照があります（公開先で 404 になります）:\n${offenders.join("\n")}`,
    );
  },
);

test(
  "canonical / og:url / sitemap の URL が lib/site.ts と3点一致している",
  { skip: files.length === 0 && !REQUIRED },
  () => {
    const html = readFileSync(resolve(OUT, "index.html"), "utf8");
    const canonical = attr(html, /<link rel="canonical" href="([^"]+)"/);
    const ogUrl = attr(html, /<meta property="og:url" content="([^"]+)"/);
    const sitemap = attr(
      readFileSync(resolve(OUT, "sitemap.xml"), "utf8"),
      /<loc>([^<]+)<\/loc>/,
    );
    assert.equal(canonical, SITE_URL, "canonical が lib/site.ts と違う");
    assert.equal(ogUrl, SITE_URL, "og:url が lib/site.ts と違う");
    assert.equal(sitemap, SITE_URL, "sitemap.xml の loc が lib/site.ts と違う");
  },
);

test(
  "og:image が実在し、公開先で解決できるパスになっている",
  { skip: files.length === 0 && !REQUIRED },
  () => {
    const html = readFileSync(resolve(OUT, "index.html"), "utf8");
    const ogImage = attr(html, /<meta property="og:image" content="([^"]+)"/);
    assert.equal(ogImage, `${SITE_URL}og.png`, "og:image のURLが想定と違う");
    assert.ok(
      existsSync(resolve(OUT, "og.png")),
      "out/og.png が出力されていない",
    );
    // X 上で代替テキストが付くこと（文字列配列で渡すと出力されない）
    assert.ok(
      /<meta name="twitter:image:alt"/.test(html),
      "twitter:image:alt が出力されていない",
    );
  },
);

test("【正直さ】製品説明から免責が落ちていない", () => {
  // meta description も構造化データの description もこの1つを使う。
  // 機械可読な説明だけ免責が抜ける、という食い違いを作らない。
  assert.match(SITE_DESCRIPTION, /税区分は付与しません/);
  assert.match(SITE_DESCRIPTION, /送信しません/);
  assert.match(SITE_DESCRIPTION, /申告の代行はしません/);
});
