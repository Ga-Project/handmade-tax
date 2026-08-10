import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import {
  SITE_URL,
  SITE_TITLE,
  SITE_DESCRIPTION,
  absoluteUrl,
} from "@/lib/site";

const title = SITE_TITLE;
const description = SITE_DESCRIPTION;

const ogAlt =
  "販路ごとの売上CSVを、会計ソフト（freee・マネーフォワード・弥生）の仕訳CSVと月別集計に整形する";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  alternates: { canonical: SITE_URL },
  openGraph: {
    title,
    description,
    type: "website",
    locale: "ja_JP",
    url: SITE_URL,
    images: [
      { url: absoluteUrl("og.png"), width: 1200, height: 630, alt: ogAlt },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    // 文字列ではなくオブジェクトで渡す（文字列配列だと twitter:image:alt が出力されず、
    // X 上で共有カード画像に代替テキストが付かない）。
    images: [{ url: absoluteUrl("og.png"), alt: ogAlt }],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/* アクセス解析（cookieless・秘密キー不要）: 全プロダクト共通の単一 GoatCounter サイト
            「ga-project」に集約する。製品ごとの数値は path（/handmade-tax/）で区別されるので、
            GoatCounter 側でサイトを新規作成しない＝新プロダクトは自動で ga-project の新パスとして計測される。 */}
        <script
          data-goatcounter="https://ga-project.goatcounter.com/count"
          async
          src="//gc.zgo.at/count.js"
        />
        {children}
      </body>
    </html>
  );
}
