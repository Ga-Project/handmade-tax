// 仕訳生成のテスト（node:test・追加依存なし）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount,
  parseDate,
  formatDate,
  resolveColumns,
  extractSales,
  generateJournal,
  journalToCsv,
  journalTotals,
  getFormat,
  JOURNAL_FORMATS,
  DEFAULT_ACCOUNTS,
} from "../lib/journal.ts";
import { parseCsv } from "../lib/csv.ts";
import { parseRecords } from "../lib/csv.ts";

test("parseAmount は記号・カンマ・円を除去して整数化する", () => {
  assert.equal(parseAmount("¥1,200"), 1200);
  assert.equal(parseAmount("1200円"), 1200);
  assert.equal(parseAmount("-50"), -50);
  assert.ok(Number.isNaN(parseAmount("")));
  assert.ok(Number.isNaN(parseAmount("abc")));
});

// M2 回帰: 全角数字・全角記号を NFKC 正規化して解釈する（正規化しないと該当行が丸ごと欠落する）。
test("parseAmount は全角数字・全角記号を解釈する（NFKC）", () => {
  assert.equal(parseAmount("１２００"), 1200);
  assert.equal(parseAmount("￥１，２００"), 1200);
  assert.equal(parseAmount("－５０"), -50);
});

test("parseDate は各表記を YYYY-MM-DD に正規化する", () => {
  assert.equal(parseDate("2026/7/5"), "2026-07-05");
  assert.equal(parseDate("2026-07-05"), "2026-07-05");
  assert.equal(parseDate("2026年7月15日"), "2026-07-15");
  assert.equal(parseDate("2026/07/05 13:20"), "2026-07-05");
  assert.equal(parseDate("不明"), null);
  assert.equal(parseDate("2026/13/40"), null);
});

// M2 回帰: 全角の日付表記も解釈できる。
test("parseDate は全角表記を解釈する（NFKC）", () => {
  assert.equal(parseDate("２０２６/０７/０５"), "2026-07-05");
  assert.equal(parseDate("２０２６年７月５日"), "2026-07-05");
});

// S1 回帰: resolveColumns は normalizeHeader 基準で照合する（全角/空白差でも解決する）。
test("resolveColumns は表記ゆれ（全角/空白）を吸収して列を解決する", () => {
  const header = ["　購入日 ", "商品代金", "ｶﾅ列"];
  const cols = resolveColumns(header, { date: "購入日", gross: "商品代金" });
  assert.equal(cols.date, 0);
  assert.equal(cols.gross, 1);
});

test("formatDate は YYYY/MM/DD にする", () => {
  assert.equal(formatDate("2026-07-05"), "2026/07/05");
});

const SAMPLE = "購入日,商品代金,販売手数料,商品名\n2026/07/01,1200,120,ピアス\n2026/07/03,800,0,リング";

function salesFromSample() {
  const parsed = parseCsv(SAMPLE);
  const cols = resolveColumns(parsed.header, {
    date: "購入日",
    gross: "商品代金",
    fee: "販売手数料",
    memo: "商品名",
  });
  return extractSales(parsed, cols, "minne");
}

test("extractSales は列割り当てから明細を取り出す", () => {
  const { sales, issues } = salesFromSample();
  assert.equal(issues.length, 0);
  assert.deepEqual(sales[0], {
    date: "2026-07-01",
    gross: 1200,
    fee: 120,
    channel: "minne",
    memo: "ピアス",
  });
  assert.equal(sales[1].fee, 0);
});

// M1 回帰: 変換できない行は黙って捨てず issues として返す（UI で可視化する根拠）。
test("日付・金額が壊れた行は issues に入り、明細からは除外される", () => {
  const parsed = parseCsv("購入日,商品代金\nbad,1000\n2026/07/01,abc\n2026/07/02,500");
  const cols = resolveColumns(parsed.header, { date: "購入日", gross: "商品代金" });
  const { sales, issues } = extractSales(parsed, cols, "minne");
  assert.equal(sales.length, 1);
  assert.equal(sales[0].gross, 500);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((i) => i.index),
    [0, 1],
  );
  assert.ok(issues.every((i) => i.kind === "unparsable"));
});

// S2 回帰: 列数がヘッダと一致しない行は変換せず misaligned として要確認に回す。
test("列数がヘッダと一致しない行は misaligned として除外される", () => {
  // 2 行目は 3 列（ヘッダは 2 列）→ 別列の数値を金額と誤読しないよう除外。
  const parsed = parseCsv("購入日,商品代金\n2026/07/01,1000\n2026/07/02,500,余分");
  const cols = resolveColumns(parsed.header, { date: "購入日", gross: "商品代金" });
  const { sales, issues } = extractSales(parsed, cols, "minne");
  assert.equal(sales.length, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "misaligned");
  assert.equal(issues[0].index, 1);
});

// S3 回帰: マイナス売上（返品・返金）は誤った仕訳を作らず refund として要確認に回す。
test("マイナス売上（返品）は refund として除外される", () => {
  const parsed = parseCsv("購入日,商品代金\n2026/07/01,1000\n2026/07/02,-500");
  const cols = resolveColumns(parsed.header, { date: "購入日", gross: "商品代金" });
  const { sales, issues } = extractSales(parsed, cols, "minne");
  assert.equal(sales.length, 1);
  assert.equal(sales[0].gross, 1000);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "refund");
});

test("仕訳の貸借が一致する（Σ借方 == Σ貸方）", () => {
  const { sales } = salesFromSample();
  const lines = generateJournal(sales);
  const { debit, credit } = journalTotals(lines);
  assert.equal(debit, credit);
  // 売上 1200 + 800 + 手数料 120 = 2120（貸借とも）
  assert.equal(debit, 2120);
});

test("fee=0 の売上は手数料行を生成しない", () => {
  const lines = generateJournal([{ date: "2026-07-03", gross: 800, fee: 0, channel: "minne", memo: "" }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].debitAccount, DEFAULT_ACCOUNTS.receivable);
  assert.equal(lines[0].creditAccount, DEFAULT_ACCOUNTS.sales);
});

test("fee>0 の売上は売上行 + 手数料行を生成し、科目・金額が正しい", () => {
  const lines = generateJournal([{ date: "2026-07-01", gross: 1200, fee: 120, channel: "minne", memo: "ピアス" }]);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    { d: lines[0].debitAccount, da: lines[0].debitAmount, c: lines[0].creditAccount, ca: lines[0].creditAmount },
    { d: "売掛金", da: 1200, c: "売上高", ca: 1200 },
  );
  assert.deepEqual(
    { d: lines[1].debitAccount, da: lines[1].debitAmount, c: lines[1].creditAccount, ca: lines[1].creditAmount },
    { d: "支払手数料", da: 120, c: "売掛金", ca: 120 },
  );
});

test("勘定科目は上書きできる", () => {
  const lines = generateJournal([{ date: "2026-07-01", gross: 1000, fee: 100, channel: "c", memo: "" }], {
    receivable: "未収入金",
    sales: "売上",
    fee: "手数料",
  });
  assert.equal(lines[0].debitAccount, "未収入金");
  assert.equal(lines[1].debitAccount, "手数料");
});

test("journalToCsv はフォーマットのヘッダと YYYY/MM/DD 日付を出す", () => {
  const lines = generateJournal([{ date: "2026-07-01", gross: 1200, fee: 120, channel: "minne", memo: "ピアス" }]);
  const csv = journalToCsv(lines, getFormat("freee"));
  const recs = parseRecords(csv);
  assert.deepEqual(recs[0], ["日付", "借方勘定科目", "借方金額", "貸方勘定科目", "貸方金額", "摘要"]);
  assert.equal(recs[1][0], "2026/07/01");
  assert.equal(recs[1][2], "1200");
  // 弥生フォーマットはヘッダラベルが変わる
  const yayoi = parseRecords(journalToCsv(lines, getFormat("yayoi")));
  assert.equal(yayoi[0][0], "取引日付");
  assert.equal(yayoi[0][1], "借方科目");
});

// M3 回帰: 出力は UTF-8。案内文が「作れない Shift_JIS 出力」を主張していないこと。
test("全フォーマットのエンコーディング案内が UTF-8 を明示し、Shift_JIS 出力を主張しない", () => {
  for (const f of JOURNAL_FORMATS) {
    assert.match(f.encodingNote, /UTF-8/, `${f.id} の案内に UTF-8 の明示が無い`);
    assert.doesNotMatch(
      f.encodingNote,
      /Shift_JIS (取込が一般的|で保存|で出力)/,
      `${f.id} が作れない Shift_JIS 出力を主張している`,
    );
  }
});

// M3 回帰: journalToCsv は先頭に BOM を付けない（1 列目ヘッダの取込ずれを避ける）。
test("journalToCsv は先頭に BOM を付けない", () => {
  const csv = journalToCsv(generateJournal([{ date: "2026-07-01", gross: 100, fee: 0, channel: "c", memo: "" }]), getFormat("freee"));
  assert.notEqual(csv.charCodeAt(0), 0xfeff);
});
