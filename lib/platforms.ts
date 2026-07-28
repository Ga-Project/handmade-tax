// ハンドメ確申コンバータ — 販路プリセット（フレームワーク非依存・純関数）
//
// 主要ハンドメイド販路の「ヘッダ→項目」対応を best-effort で持つレジストリ。
// 実際の書式は販路の仕様変更・出力設定で変わるため、ここでの対応は
// 「利用者が確認・修正する出発点」であって正解表ではない。UI 側で必ず編集可能にする。

/** 割り当て対象の論理項目。 */
export type FieldKey =
  | "date"
  | "gross"
  | "fee"
  | "channel"
  | "memo"
  | "settlement";

/** 各論理項目に対応する「元 CSV のヘッダ名」。channel は定数ラベルで補える。 */
export type FieldMap = Partial<Record<FieldKey, string>>;

export interface Platform {
  id: string;
  /** 販路の表示名（既定の channel ラベルにも使う）。 */
  label: string;
  /** この販路と判定するための代表的なヘッダ名（正規化して照合）。 */
  signatures: string[];
  /** ヘッダ名ベースの項目対応（best-effort）。 */
  map: FieldMap;
}

export type Confidence = "high" | "low" | "none";

export interface DetectionResult {
  platform: Platform | null;
  confidence: Confidence;
  /** 一致した signature 数 / signature 総数（0〜1）。 */
  score: number;
}

/**
 * 販路プリセット。ヘッダ名は各サービスの CSV 出力で観測されやすい表記を
 * best-effort で置いたもので、確定仕様ではない（利用者が UI で確認・修正する前提）。
 */
export const PLATFORMS: Platform[] = [
  {
    id: "minne",
    label: "minne",
    signatures: ["注文番号", "購入日", "商品代金", "販売手数料"],
    map: {
      date: "購入日",
      gross: "商品代金",
      fee: "販売手数料",
      memo: "商品名",
      settlement: "入金日",
    },
  },
  {
    id: "creema",
    label: "Creema",
    signatures: ["受注番号", "注文日", "商品金額", "手数料"],
    map: {
      date: "注文日",
      gross: "商品金額",
      fee: "手数料",
      memo: "作品名",
      settlement: "入金予定日",
    },
  },
  {
    id: "base",
    label: "BASE",
    signatures: ["注文ID", "注文日時", "商品合計", "サービス利用料"],
    map: {
      date: "注文日時",
      gross: "商品合計",
      fee: "サービス利用料",
      memo: "商品名",
      settlement: "入金日",
    },
  },
  {
    id: "mercari",
    label: "メルカリ",
    signatures: ["取引ID", "売却日", "商品代金", "販売手数料"],
    map: {
      date: "売却日",
      gross: "商品代金",
      fee: "販売手数料",
      memo: "商品名",
      settlement: "振込日",
    },
  },
];

/** ヘッダ名を照合用に正規化する（前後空白・囲みクオート・全角空白を除去）。 */
export function normalizeHeader(name: string): string {
  return name
    .replace(/^﻿/, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[\s　]+/g, "")
    .toLowerCase();
}

/**
 * ヘッダ配列から販路を推定する。
 * - すべての signature が揃えば high
 * - 一部だけ一致すれば low（要確認）
 * - 何も一致しなければ none（不明・手動割り当て）
 * 複数候補が並んだ場合は一致率（score）が最も高いものを採る。
 */
export function detectPlatform(header: string[]): DetectionResult {
  const present = new Set(header.map(normalizeHeader));
  let best: Platform | null = null;
  let bestScore = 0;

  for (const p of PLATFORMS) {
    const matched = p.signatures.filter((s) =>
      present.has(normalizeHeader(s)),
    ).length;
    const score = matched / p.signatures.length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  if (!best || bestScore === 0)
    return { platform: null, confidence: "none", score: 0 };
  if (bestScore >= 1)
    return { platform: best, confidence: "high", score: bestScore };
  return { platform: best, confidence: "low", score: bestScore };
}

/** 表示用の販路ラベル。未判定は「不明（手動割り当て）」。 */
export function channelLabelFor(detection: DetectionResult): string {
  return detection.platform ? detection.platform.label : "不明（手動割り当て）";
}
