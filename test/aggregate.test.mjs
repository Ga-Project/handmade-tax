// 集計のテスト（node:test・追加依存なし）
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, cellOf, aggregationToCsv, monthOf } from "../lib/aggregate.ts";
import { parseRecords } from "../lib/csv.ts";

const SALES = [
  { date: "2026-07-01", gross: 1200, fee: 120, channel: "minne", memo: "" },
  { date: "2026-07-15", gross: 800, fee: 80, channel: "minne", memo: "" },
  { date: "2026-07-20", gross: 500, fee: 50, channel: "Creema", memo: "" },
  { date: "2026-08-02", gross: 1000, fee: 0, channel: "minne", memo: "" },
];

test("monthOf は YYYY-MM を返す", () => {
  assert.equal(monthOf("2026-07-01"), "2026-07");
});

test("月 × 販路のセルが正しく集計される（net = gross - fee）", () => {
  const agg = aggregate(SALES);
  const julyMinne = cellOf(agg, "2026-07", "minne");
  assert.equal(julyMinne.gross, 2000);
  assert.equal(julyMinne.fee, 200);
  assert.equal(julyMinne.net, 1800);
  assert.equal(julyMinne.count, 2);

  const julyCreema = cellOf(agg, "2026-07", "Creema");
  assert.equal(julyCreema.gross, 500);
  assert.equal(julyCreema.net, 450);
});

test("月合計・販路合計・総合計が一致する", () => {
  const agg = aggregate(SALES);
  assert.equal(agg.rowTotals.get("2026-07").gross, 2500);
  assert.equal(agg.rowTotals.get("2026-08").gross, 1000);
  assert.equal(agg.colTotals.get("minne").gross, 3000);
  assert.equal(agg.grand.gross, 3500);
  assert.equal(agg.grand.fee, 250);
  assert.equal(agg.grand.net, 3250);
  assert.equal(agg.grand.count, 4);
});

test("月・販路が昇順に並ぶ", () => {
  const agg = aggregate(SALES);
  assert.deepEqual(agg.months, ["2026-07", "2026-08"]);
  assert.ok(agg.channels.includes("minne"));
  assert.ok(agg.channels.includes("Creema"));
});

test("aggregationToCsv は空セルを飛ばし総合計行を付ける", () => {
  const agg = aggregate(SALES);
  const recs = parseRecords(aggregationToCsv(agg));
  assert.deepEqual(recs[0], ["月", "販路", "総売上", "手数料", "純売上", "件数"]);
  const last = recs[recs.length - 1];
  assert.equal(last[0], "合計");
  assert.equal(last[2], "3500");
  assert.equal(last[4], "3250");
  // 2026-08 の Creema は 0 件なので行に出ない
  const hasEmpty = recs.some((r) => r[0] === "2026-08" && r[1] === "Creema");
  assert.equal(hasEmpty, false);
});
