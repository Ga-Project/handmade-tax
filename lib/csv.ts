// ハンドメ確申コンバータ — CSV パーサ / シリアライザ（フレームワーク非依存・純関数）
//
// 外部依存を持たない自前実装（papaparse 等は入れない）。RFC 4180 に沿って
// クオート付きフィールド・フィールド内の改行やカンマ・"" によるクオートのエスケープ・
// CRLF / LF の混在を扱う。ブラウザ内で完結し、値はどこにも送信しない。

/** ヘッダ行と本体行に分けた解析結果。 */
export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

/**
 * CSV テキストをレコード（string[][]）に分解する。
 * - クオート内のカンマ・改行はフィールドの一部として保持する
 * - "" は 1 個の " にデコードする
 * - CRLF / CR / LF いずれの行区切りも 1 行として扱う
 * - 完全な空行（内容ゼロ）は読み飛ばす（末尾改行で空レコードを生まない）
 */
export function parseRecords(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // この行に何らかの内容（フィールド・カンマ・クオート）が現れたか。
  // 完全な空行を空レコードとして push しないための番兵。
  let sawContent = false;
  const n = text.length;

  const endRow = () => {
    if (!sawContent) return;
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    sawContent = false;
  };

  for (let i = 0; i < n; i++) {
    const c = text[i]!;

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawContent = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawContent = true;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") {
      endRow();
    } else {
      field += c;
      sawContent = true;
    }
  }
  // 末尾フィールド（改行で終わっていない場合）。
  if (sawContent || field !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}

/** 先頭行をヘッダとして取り出す。空 CSV は header/rows とも空。 */
export function parseCsv(text: string): ParsedCsv {
  const records = parseRecords(text);
  if (records.length === 0) return { header: [], rows: [] };
  const [header, ...rows] = records;
  return { header: header ?? [], rows };
}

/** カンマ・クオート・改行を含むフィールドだけをクオートで包む（RFC 4180）。 */
export function serializeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** レコード配列を CSV テキストにする。行区切りは CRLF、末尾に改行を 1 つ付ける。 */
export function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.map(serializeField).join(",")).join("\r\n") + "\r\n";
}
