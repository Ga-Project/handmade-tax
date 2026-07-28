// ハンドメ確申コンバータ — 仕訳生成（フレームワーク非依存・純関数）
//
// 販路の売上明細を「会計ソフトに取り込める仕訳 CSV」に変換する。
// ここで作るのは *下書き* であり、勘定科目・金額・日付は利用者が取込前に必ず確認する前提。
// 税務判断・申告の代行はしない（あくまで CSV 整形）。

import { serializeCsv } from "./csv.ts";
import { normalizeHeader } from "./platforms.ts";
import type { FieldMap } from "./platforms.ts";
import type { ParsedCsv } from "./csv.ts";

/** 1 件の売上（正規化済み）。金額は円・整数。date は YYYY-MM-DD。 */
export interface SaleRow {
  date: string;
  gross: number;
  fee: number;
  channel: string;
  memo: string;
}

/** 仕訳 1 行（貸借同額の複式）。金額は円・整数。 */
export interface JournalLine {
  date: string; // 内部表現は YYYY-MM-DD
  debitAccount: string;
  debitAmount: number;
  creditAccount: string;
  creditAmount: number;
  memo: string;
}

/** 既定の勘定科目（利用者が上書き可能）。 */
export interface AccountConfig {
  receivable: string; // 売掛金
  sales: string; // 売上高
  fee: string; // 支払手数料
}

export const DEFAULT_ACCOUNTS: AccountConfig = {
  receivable: "売掛金",
  sales: "売上高",
  fee: "支払手数料",
};

export type FormatId = "freee" | "mf" | "yayoi";

export interface JournalFormat {
  id: FormatId;
  label: string;
  /** 出力する 6 列のヘッダラベル。 */
  headers: [string, string, string, string, string, string];
  /** 想定される取込時の文字コード（案内表示用）。 */
  encodingNote: string;
}

export const JOURNAL_FORMATS: JournalFormat[] = [
  {
    id: "freee",
    label: "freee",
    headers: [
      "日付",
      "借方勘定科目",
      "借方金額",
      "貸方勘定科目",
      "貸方金額",
      "摘要",
    ],
    encodingNote:
      "文字コードは UTF-8（BOMなし）です。取込時にエンコーディング指定があれば UTF-8 を選んでください。",
  },
  {
    id: "mf",
    label: "マネーフォワード",
    headers: [
      "取引日",
      "借方勘定科目",
      "借方金額",
      "貸方勘定科目",
      "貸方金額",
      "摘要",
    ],
    encodingNote:
      "文字コードは UTF-8（BOMなし）です。取込前に勘定科目のマッピングをご確認ください。",
  },
  {
    id: "yayoi",
    label: "弥生",
    headers: [
      "取引日付",
      "借方科目",
      "借方金額",
      "貸方科目",
      "貸方金額",
      "摘要",
    ],
    encodingNote:
      "文字コードは UTF-8（BOMなし）で書き出します。弥生の取込画面で文字コードに UTF-8 を指定してください（列の並び順・書式は取込設定に合わせて調整が必要な場合があります）。",
  },
];

export function getFormat(id: FormatId): JournalFormat {
  const f = JOURNAL_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`unknown format: ${id}`);
  return f;
}

/**
 * "¥1,200" / "1200円" / "－50" / 全角 "１２００" 等から整数の円を得る。解釈不能は NaN。
 * 先に NFKC 正規化して全角数字・全角記号（￥ ，－ 等）を半角に畳んでから解釈する
 * （正規化しないと全角入力の行が丸ごと変換対象から漏れる = サイレントなデータ欠落になる）。
 */
export function parseAmount(raw: string): number {
  if (raw == null) return NaN;
  const cleaned = raw.normalize("NFKC").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return NaN;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n);
}

/**
 * 各種和式・スラッシュ・ハイフン表記の日付を YYYY-MM-DD に正規化する。
 * 対応: 2026/7/5, 2026-07-05, 2026.7.5, 2026年7月5日, "2026/07/05 13:20"(時刻は捨てる)、
 * および全角表記 "２０２６/０７/０５"。先に NFKC 正規化して全角数字・区切りを半角へ畳む。
 * 解釈不能は null。
 */
export function parseDate(raw: string): string | null {
  if (raw == null) return null;
  const m = raw
    .normalize("NFKC")
    .match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** YYYY-MM-DD を各フォーマットの表示日付にする（freee/MF/弥生いずれも YYYY/MM/DD）。 */
export function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

/** 割り当て済みの列インデックス。値が無い項目は undefined。 */
export interface ColumnIndex {
  date?: number;
  gross?: number;
  fee?: number;
  channel?: number;
  memo?: number;
  settlement?: number;
}

/**
 * ヘッダ配列 + FieldMap（ヘッダ名対応）から列インデックスを解決する。
 * 照合は normalizeHeader で行う（自動判定 detectPlatform と同じ基準）。
 * exact 一致にすると、プリセット表記と実ヘッダの全角/空白差で「✓自動」表示なのに
 * 実際には列が解決されない = sales 0 件という偽の成功が起きる。それを塞ぐ。
 */
export function resolveColumns(header: string[], map: FieldMap): ColumnIndex {
  const norm = header.map(normalizeHeader);
  const idx: ColumnIndex = {};
  const find = (name: string | undefined): number | undefined => {
    if (!name) return undefined;
    const i = norm.indexOf(normalizeHeader(name));
    return i >= 0 ? i : undefined;
  };
  idx.date = find(map.date);
  idx.gross = find(map.gross);
  idx.fee = find(map.fee);
  idx.channel = find(map.channel);
  idx.memo = find(map.memo);
  idx.settlement = find(map.settlement);
  return idx;
}

/** 変換できなかった / 要確認の行 1 件。UI で必ず可視化する（黙って捨てない）。 */
export type RowIssueKind = "unparsable" | "misaligned" | "refund";

export interface RowIssue {
  /** 本体行の 0 始まりインデックス。 */
  index: number;
  kind: RowIssueKind;
  reason: string;
  /** 表示用に元の行データ（生セル）を保持する。 */
  cells: string[];
}

export interface ExtractResult {
  sales: SaleRow[];
  /** 仕訳に変換されなかった行（要確認）。サイレントに捨てず UI に出す。 */
  issues: RowIssue[];
}

/**
 * パース済み CSV と列割り当てから売上明細を取り出す。
 * 以下の行は仕訳に変換せず issues として返す（誤った仕訳を黙って作らない・データを黙って捨てない）:
 *   - misaligned: 列数がヘッダと一致しない（別列の数値を金額と誤読する恐れ）
 *   - unparsable: 取引日 or 総売上 が解釈できない
 *   - refund:     総売上がマイナス（返品・返金。符号の扱いは手動確認が必要）
 * fee は列が無い / 空なら 0。channel は列があればその値、無ければ既定ラベルを使う。
 */
export function extractSales(
  parsed: ParsedCsv,
  columns: ColumnIndex,
  defaultChannel: string,
): ExtractResult {
  const sales: SaleRow[] = [];
  const issues: RowIssue[] = [];
  const width = parsed.header.length;

  parsed.rows.forEach((row, i) => {
    const cell = (idx: number | undefined): string =>
      idx === undefined ? "" : (row[idx] ?? "").trim();

    // S2: 列数不一致は列ズレの疑い。金額の誤読を避けるため変換せず要確認に回す。
    if (width > 0 && row.length !== width) {
      issues.push({
        index: i,
        kind: "misaligned",
        reason: `列数がヘッダと一致しません（${row.length}列 / ヘッダ${width}列）`,
        cells: row,
      });
      return;
    }

    const date = parseDate(cell(columns.date));
    const gross = parseAmount(cell(columns.gross));
    if (date === null || Number.isNaN(gross)) {
      issues.push({
        index: i,
        kind: "unparsable",
        reason:
          date === null
            ? "取引日を解釈できません"
            : "総売上を数値として解釈できません",
        cells: row,
      });
      return;
    }

    // S3: マイナス売上（返品・返金）は符号の扱いが仕訳で逆になるため、黙って変換しない。
    if (gross < 0) {
      issues.push({
        index: i,
        kind: "refund",
        reason: "総売上がマイナスです（返品・返金は手動でご確認ください）",
        cells: row,
      });
      return;
    }

    const feeRaw = cell(columns.fee);
    const feeParsed = feeRaw === "" ? 0 : parseAmount(feeRaw);
    const fee = Number.isNaN(feeParsed) ? 0 : Math.abs(feeParsed);
    const channel = cell(columns.channel) || defaultChannel;
    const memo = cell(columns.memo);

    sales.push({ date, gross, fee, channel, memo });
  });

  return { sales, issues };
}

/**
 * 売上明細から複式の仕訳下書きを作る。
 * - 売上計上: (借)売掛金 gross / (貸)売上高 gross（取引日）
 * - 販売手数料: (借)支払手数料 fee / (貸)売掛金 fee（取引日・fee>0 のときだけ）
 * 各行は貸借同額。したがって Σ借方 == Σ貸方 が常に成り立つ。
 */
export function generateJournal(
  sales: SaleRow[],
  accounts: AccountConfig = DEFAULT_ACCOUNTS,
): JournalLine[] {
  const lines: JournalLine[] = [];
  for (const s of sales) {
    const baseMemo = s.memo ? `${s.channel} ${s.memo}` : s.channel;
    lines.push({
      date: s.date,
      debitAccount: accounts.receivable,
      debitAmount: s.gross,
      creditAccount: accounts.sales,
      creditAmount: s.gross,
      memo: `売上 ${baseMemo}`.trim(),
    });
    if (s.fee > 0) {
      lines.push({
        date: s.date,
        debitAccount: accounts.fee,
        debitAmount: s.fee,
        creditAccount: accounts.receivable,
        creditAmount: s.fee,
        memo: `販売手数料 ${s.channel}`.trim(),
      });
    }
  }
  return lines;
}

/** 仕訳行を指定フォーマットの CSV 文字列にする（ヘッダ + 明細）。 */
export function journalToCsv(
  lines: JournalLine[],
  format: JournalFormat,
): string {
  const rows: string[][] = [format.headers.slice()];
  for (const l of lines) {
    rows.push([
      formatDate(l.date),
      l.debitAccount,
      String(l.debitAmount),
      l.creditAccount,
      String(l.creditAmount),
      l.memo,
    ]);
  }
  return serializeCsv(rows);
}

/** Σ借方 と Σ貸方 を返す（画面表示・検算用）。 */
export function journalTotals(lines: JournalLine[]): {
  debit: number;
  credit: number;
} {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debitAmount;
    credit += l.creditAmount;
  }
  return { debit, credit };
}
