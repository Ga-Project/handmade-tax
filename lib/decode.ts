// ハンドメ確申コンバータ — 文字コード判定（フレームワーク非依存・純関数）
//
// ハンドメイド販路の CSV は UTF-8 のことも Shift_JIS(CP932) のこともある。
// まず UTF-8 として読み、置換文字(U+FFFD)が出たら Shift_JIS として読み直す。
// 先頭の BOM は取り除く。TextDecoder はブラウザ / Node 双方の標準 API。

export type Encoding = "utf-8" | "shift_jis";

export interface DecodeResult {
  text: string;
  encoding: Encoding;
}

/** 先頭の UTF-8 BOM(U+FEFF)を 1 個だけ取り除く。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 置換文字(U+FFFD)を含むか。UTF-8 デコード失敗の検出に使う。 */
export function hasReplacementChar(text: string): boolean {
  return text.includes("�");
}

function decodeWith(bytes: Uint8Array, encoding: Encoding): string | null {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * バイト列を最適な文字コードでデコードする。
 * 1. UTF-8 で読み、置換文字が無ければ採用
 * 2. 置換文字が出たら Shift_JIS で読み直して採用
 * 3. どちらも不可なら UTF-8 の寛容デコードにフォールバック
 * いずれも先頭 BOM は除去する。
 */
export function decodeBytes(bytes: Uint8Array): DecodeResult {
  const utf8 = decodeWith(bytes, "utf-8");
  if (utf8 !== null && !hasReplacementChar(utf8)) {
    return { text: stripBom(utf8), encoding: "utf-8" };
  }

  const sjis = decodeWith(bytes, "shift_jis");
  if (sjis !== null && !hasReplacementChar(sjis)) {
    return { text: stripBom(sjis), encoding: "shift_jis" };
  }

  // どちらも綺麗に読めない場合は、より多く読めた方を返す（最終フォールバック）。
  const fallback = utf8 ?? sjis ?? "";
  return {
    text: stripBom(fallback),
    encoding: sjis !== null && utf8 === null ? "shift_jis" : "utf-8",
  };
}
