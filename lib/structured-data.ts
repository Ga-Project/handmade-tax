import { FAQ } from "./faq.ts";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "./site.ts";

// 構造化データ。ページに実際に表示されている内容だけを載せる。
//
// FAQPage は「そのページに表示されている FAQ」でなければならず、表示していないページに
// 出すのは構造化データのポリシー違反になる。そのため layout（=全ルート共通）ではなく
// FAQ を実際に描画しているトップページのコンポーネント側から差し込む。
// 404 ページには出ない、という保証を置き場所で取る。

export function buildStructuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        name: SITE_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web ブラウザ",
        inLanguage: "ja",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "JPY" },
        publisher: { "@type": "Organization", name: "株式会社Ga Project" },
      },
      {
        "@type": "FAQPage",
        mainEntity: FAQ.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  };
}

/**
 * JSON-LD を <script> の中身として安全な文字列にする。
 *
 * JSON.stringify は `<` をエスケープしないため、値に `</script` が入ると HTML パーサが
 * そこで script 要素を打ち切ってしまう。いまの値は同一リポジトリ内の定数だけだが、
 * lib/faq.ts は今後も文言が書き換わり続ける場所なので、`<` を1文字入れただけで
 * ページが壊れる状態にはしておかない。
 */
export function serializeStructuredData(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
