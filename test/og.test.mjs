// OGP 共有カードのドリフト検知（node:test・追加依存なし）
//
// public/og.png は scripts/og-template.html から headless Chrome で生成してコミットする運用
// （Pages の CI に Chrome が無いためビルド時生成ができない）。この方式の弱点は、
// テンプレートだけ直して png の再生成を忘れても、ビルドもテストも何も言わないこと。
// 古いカードが静かに配信され続けるのを防ぐため、テンプレートのハッシュを固定する。
//
// このテストが落ちたら: `pnpm og` で png を作り直し、下の TEMPLATE_SHA256 を新しい値に更新する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const at = (p) => resolve(__dirname, p);

// scripts/og-template.html の内容ハッシュ。テンプレートを変えたら png を再生成して更新する。
const TEMPLATE_SHA256 =
  "d6daec011cd23822e0f0697de6bcfe6748f358296ba845d52b0930c4e9e2bec3";

test("og-template.html を変えたら og.png を再生成する（ハッシュ固定）", () => {
  const actual = createHash("sha256")
    .update(readFileSync(at("../scripts/og-template.html")))
    .digest("hex");
  assert.equal(
    actual,
    TEMPLATE_SHA256,
    "scripts/og-template.html が変更されています。`pnpm og` で public/og.png を作り直し、" +
      `test/og.test.mjs の TEMPLATE_SHA256 を ${actual} に更新してください`,
  );
});

test("og.png が 1200×630 の PNG である（metadata の宣言と一致）", () => {
  const buf = readFileSync(at("../public/og.png"));
  // PNG シグネチャ + IHDR（幅・高さはビッグエンディアン32bitで 16..24 バイト目）
  assert.deepEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "public/og.png が PNG ではない",
  );
  assert.equal(buf.readUInt32BE(16), 1200, "og.png の幅が 1200 でない");
  assert.equal(buf.readUInt32BE(20), 630, "og.png の高さが 630 でない");
});
