// FAQ の回帰テスト（node:test・追加依存なし）
//
// FAQPage 構造化データは「そのページに実際に表示されている内容」でなければならない。
// 表示と構造化データが食い違うと、検索結果に出る文とページの文が別物になり、
// 構造化データのポリシー違反になる。
//
// ここでは 2 段で守る:
//   1) ソース: 表示も構造化データも lib/faq.ts を出所にしているか（二重管理への逆戻り検知）
//   2) 成果物: out/ をビルド済みなら、実際に出力された HTML で
//      「JSON-LD の全 Q/A が同じ HTML の可視テキストにある」「FAQ の無いページに
//      FAQPage が出ていない」を照合する（1 だけだと素通りするリグレッションを捕まえる）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FAQ } from "../lib/faq.ts";
import {
  buildStructuredData,
  serializeStructuredData,
} from "../lib/structured-data.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const at = (p) => resolve(__dirname, p);
const read = (p) => readFileSync(at(p), "utf8");

/** HTML からタグを落として可視テキストにする（script/style の中身は除く）。 */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, "");
}

/** HTML 内の JSON-LD を全部取り出してパースする。 */
function jsonLdBlocks(html) {
  const out = [];
  const re =
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    // serializeStructuredData が `<` を < に退避しているので、JSON.parse がそれを戻す。
    out.push(JSON.parse(m[1]));
  }
  return out;
}

function faqPagesIn(html) {
  return jsonLdBlocks(html).flatMap((d) =>
    (d["@graph"] ?? [d]).filter((n) => n["@type"] === "FAQPage"),
  );
}

/* ---- 1) 内容そのもの ---------------------------------------------------- */

test("FAQ に中身がある", () => {
  assert.ok(FAQ.length >= 5, "FAQ が痩せている");
  for (const item of FAQ) {
    assert.ok(item.q.trim().length > 0, "質問が空");
    assert.ok(item.a.trim().length >= 20, `回答が薄い: ${item.q}`);
  }
});

test("質問が重複していない", () => {
  assert.equal(new Set(FAQ.map((i) => i.q)).size, FAQ.length);
});

test("【正直さ】FAQ が税務判断を断定していない", () => {
  const all = FAQ.map((i) => `${i.q}\n${i.a}`).join("\n");
  assert.doesNotMatch(all, /申告を代行|税務署に提出し|確定申告が完了|節税/);
});

test("【正直さ】FAQ が『下書き』『送信しない』の前提を裏切っていない", () => {
  const answers = FAQ.map((i) => i.a).join("\n");
  assert.match(answers, /下書き/, "仕訳が下書きである旨が FAQ から消えている");
  assert.match(
    answers,
    /送信され(ません|ない)/,
    "CSVを送信しない旨が FAQ から消えている",
  );
});

/* ---- 2) 出所が1つであること ---------------------------------------------- */

test("表示も構造化データも lib/faq.ts を出所にしている", () => {
  assert.match(
    read("../lib/structured-data.ts"),
    /from "\.\/faq\.ts"/,
    "structured-data.ts が lib/faq.ts を読んでいない（構造化データが別管理になっている）",
  );
  const page = read("../app/page.tsx");
  assert.match(
    page,
    /from "@\/lib\/faq"/,
    "page.tsx が lib/faq.ts を読んでいない（表示が別管理になっている）",
  );
  assert.match(page, /<FaqSection \/>/, "FAQ がページに表示されていない");
});

test("構造化データの FAQ が lib/faq.ts と1対1で対応している", () => {
  const faqPage = buildStructuredData()["@graph"].find(
    (n) => n["@type"] === "FAQPage",
  );
  assert.ok(faqPage, "FAQPage が生成されていない");
  assert.deepEqual(
    faqPage.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
    FAQ.map((i) => [i.q, i.a]),
    "手書き項目の追加や絞り込み(slice等)で FAQ と構造化データがズレている",
  );
});

test("JSON-LD に script を打ち切る生の < が残らない", () => {
  // JSON.stringify は < をエスケープしないので、値に </script が入ると HTML パーサが
  // そこで script 要素を打ち切る。FAQ の文言はこれからも書き換わる場所なので固定する。
  const s = serializeStructuredData({ x: "</script><img onerror=1>" });
  assert.doesNotMatch(s, /</, "JSON-LD の < がエスケープされていない");
  assert.deepEqual(JSON.parse(s), { x: "</script><img onerror=1>" });
});

/* ---- 3) ビルド成果物との照合（out/ がある時だけ） ------------------------- */

const OUT = at("../out");
const hasBuild = existsSync(resolve(OUT, "index.html"));
// 公開経路（pages.yml の verify job）ではスキップを許さない。静かにスキップする検査は
// 緑のまま通るので、「安全網があるつもり」になるぶん、無いよりたちが悪い。
const REQUIRED = process.env.HANDMADE_TAX_REQUIRE_PUBLISH_CHECK === "1";

test("成果物照合の前提が満たされている", { skip: !REQUIRED }, () => {
  assert.ok(
    hasBuild,
    "HANDMADE_TAX_REQUIRE_PUBLISH_CHECK=1 だが out/index.html が無い。先に pnpm build を実行すること" +
      "（この検査がスキップされると、表示と構造化データの食い違いを検出しないまま CI が緑になる）。",
  );
});

test(
  "【成果物】トップの JSON-LD の全 Q/A が、同じ HTML の可視テキストにある",
  { skip: !hasBuild && !REQUIRED && "out/ が未ビルド" },
  () => {
    const html = readFileSync(resolve(OUT, "index.html"), "utf8");
    const pages = faqPagesIn(html);
    assert.equal(pages.length, 1, "トップの FAQPage は1つであるべき");
    const text = visibleText(html);
    for (const q of pages[0].mainEntity) {
      const name = q.name.replace(/\s+/g, "");
      const answer = q.acceptedAnswer.text.replace(/\s+/g, "");
      assert.ok(text.includes(name), `質問が表示されていない: ${q.name}`);
      assert.ok(text.includes(answer), `回答が表示されていない: ${q.name}`);
    }
  },
);

test(
  "【成果物】FAQ を表示しないページに FAQPage を出していない",
  { skip: !hasBuild && !REQUIRED && "out/ が未ビルド" },
  () => {
    const html = readFileSync(resolve(OUT, "404.html"), "utf8");
    assert.equal(
      faqPagesIn(html).length,
      0,
      "404 ページに FAQPage が出ている（表示していない内容のマークアップ）",
    );
  },
);
