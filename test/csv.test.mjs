// CSV パーサ / シリアライザのテスト（node:test・追加依存なし）
// 実行: pnpm test（Node が .ts の型を落として直接 import する）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseRecords, serializeCsv, serializeField } from "../lib/csv.ts";

test("単純な行とヘッダを分ける", () => {
  const { header, rows } = parseCsv("日付,金額\n2026/07/01,1200\n2026/07/02,800");
  assert.deepEqual(header, ["日付", "金額"]);
  assert.deepEqual(rows, [
    ["2026/07/01", "1200"],
    ["2026/07/02", "800"],
  ]);
});

test("クオート内のカンマはフィールドの一部", () => {
  const recs = parseRecords('a,"1,200",b');
  assert.deepEqual(recs, [["a", "1,200", "b"]]);
});

test("クオート内の改行を保持する", () => {
  const recs = parseRecords('"line1\nline2",x');
  assert.deepEqual(recs, [["line1\nline2", "x"]]);
});

test('"" は 1 個の " にデコードされる', () => {
  const recs = parseRecords('"say ""hi""",y');
  assert.deepEqual(recs, [['say "hi"', "y"]]);
});

test("CRLF と LF が混在しても 1 行ずつに分かれる", () => {
  const recs = parseRecords("a,b\r\nc,d\ne,f");
  assert.deepEqual(recs, [
    ["a", "b"],
    ["c", "d"],
    ["e", "f"],
  ]);
});

test("末尾改行や空行で空レコードを作らない", () => {
  const recs = parseRecords("a,b\n\nc,d\n");
  assert.deepEqual(recs, [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("空フィールドを保持する（末尾カンマ）", () => {
  const recs = parseRecords("a,,c");
  assert.deepEqual(recs, [["a", "", "c"]]);
});

test("serializeField は特殊文字を含む場合だけクオートする", () => {
  assert.equal(serializeField("plain"), "plain");
  assert.equal(serializeField("a,b"), '"a,b"');
  assert.equal(serializeField('he said "hi"'), '"he said ""hi"""');
  assert.equal(serializeField("multi\nline"), '"multi\nline"');
});

test("serialize → parse で往復一致する", () => {
  const rows = [
    ["日付", "摘要"],
    ["2026/07/01", 'カンマ, と "クオート"'],
    ["2026/07/02", "改行\nあり"],
  ];
  const round = parseRecords(serializeCsv(rows));
  assert.deepEqual(round, rows);
});
