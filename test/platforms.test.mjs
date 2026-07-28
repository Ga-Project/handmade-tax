// 販路自動判定のテスト（node:test・追加依存なし）
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, channelLabelFor, PLATFORMS } from "../lib/platforms.ts";

test("既知ヘッダ（minne）は high 判定になる", () => {
  const d = detectPlatform(["注文番号", "購入日", "商品代金", "販売手数料", "商品名"]);
  assert.equal(d.platform?.id, "minne");
  assert.equal(d.confidence, "high");
  assert.equal(channelLabelFor(d), "minne");
});

test("既知ヘッダ（BASE）を判別する", () => {
  const d = detectPlatform(["注文ID", "注文日時", "商品合計", "サービス利用料"]);
  assert.equal(d.platform?.id, "base");
  assert.equal(d.confidence, "high");
});

test("一部だけ一致するヘッダは low（要確認）", () => {
  // Creema の signature のうち 2/4 だけ一致
  const d = detectPlatform(["受注番号", "注文日", "何かの列"]);
  assert.equal(d.platform?.id, "creema");
  assert.equal(d.confidence, "low");
  assert.ok(d.score > 0 && d.score < 1);
});

test("未知ヘッダは none（不明・手動割り当て）", () => {
  const d = detectPlatform(["col1", "col2", "col3"]);
  assert.equal(d.platform, null);
  assert.equal(d.confidence, "none");
  assert.equal(channelLabelFor(d), "不明（手動割り当て）");
});

test("全プリセットが date と gross の対応を持つ（変換に最低限必要）", () => {
  for (const p of PLATFORMS) {
    assert.ok(p.map.date, `${p.id} に date マッピングが無い`);
    assert.ok(p.map.gross, `${p.id} に gross マッピングが無い`);
  }
});
