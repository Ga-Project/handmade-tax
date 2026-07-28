// 常時表示される正直さ・プライバシーのコピーの回帰テスト（node:test・追加依存なし）
//
// 税金に関わるツールなので、「申告代行ではない」「下書きを自分で確認する」「サーバー送信しない」
// といった注意書きが消えないようにガードする。文面は変わってよいが要件が落ちたら落ちるようにする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(__dirname, "../app/page.tsx"), "utf8");

const REQUIRED = [
  { re: /送信され(ません|ない)/, why: "CSVをサーバーに送信しない旨（プライバシー）" },
  { re: /下書き/, why: "生成される仕訳が下書きである旨" },
  { re: /ご自身で確認/, why: "取込前に自分で確認する旨" },
  { re: /申告|提出/, why: "申告・提出を代行しない旨" },
  { re: /目安/, why: "販路プリセットが目安である旨" },
  // M4/S4: 消費税区分を付けない旨（単一 6 列レイアウトで税区分は扱わない）
  { re: /税区分|消費税/, why: "消費税区分を付与しない旨" },
];

for (const { re, why } of REQUIRED) {
  test(`【正直さ】トップページに常時表示: ${why}`, () => {
    assert.match(page, re, `app/page.tsx から「${why}」が失われている`);
  });
}

test("【正直さ】税務申告を代行すると誤認させる断定表現がない", () => {
  assert.doesNotMatch(page, /申告を代行します|税務署に提出します|確定申告が完了/);
});
