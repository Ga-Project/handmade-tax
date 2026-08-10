// 公開URLと製品説明の単一の出所。
// canonical / og:url / og:image / sitemap.xml / 構造化データが同じ値を使う。
//
// ここを1箇所にしているのは、片方だけ変えたときに canonical と sitemap が食い違い、
// しかもビルドもテストも何も言わない、という壊れ方を防ぐため
// （test/site.test.mjs が成果物の3点一致を検査する）。

/** 公開先の絶対URL（末尾スラッシュあり）。GitHub Pages のプロジェクトページ配信。 */
export const SITE_URL = "https://ga-project.github.io/handmade-tax/";

/** サブパス配信の basePath。ビルド時 env と一致していないと公開先でアセットが 404 になる。 */
export const BASE_PATH = "/handmade-tax";

/** 製品名。 */
export const SITE_NAME = "ハンドメ確申コンバータ";

export const SITE_TITLE =
  "ハンドメ確申コンバータ — 販路の売上CSVを会計ソフトの仕訳インポート用に整形";

/**
 * 製品説明。meta description / og / twitter / 構造化データが全てこれを使う。
 *
 * 税務に関わる製品なので、免責（税区分を付与しない・送信しない・申告代行をしない）を
 * 説明文から落とさない。機械可読な説明だけ免責が抜ける、という食い違いを作らないため
 * 1箇所に置く（test/site.test.mjs が免責の存在を検査する）。
 */
export const SITE_DESCRIPTION =
  "minne・Creema・BASE・メルカリなどの売上CSVを、会計ソフトの仕訳インポート用CSVと月別×販路の集計に整形します（取込形式・エンコーディングはソフト側の仕様に合わせた調整が必要な場合があります）。消費税の税区分は付与しません。すべてブラウザ内で処理し、CSVはサーバーに送信しません。税務申告の代行はしません。";

/** サイト直下の相対パスを絶対URLにする。末尾スラッシュの有無に依存しない。 */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).href;
}
