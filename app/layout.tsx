import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const title =
  "ハンドメ確申コンバータ — 販路の売上CSVを会計ソフトの仕訳インポート用に整形";
const description =
  "minne・Creema・BASE・メルカリなどの売上CSVを、会計ソフトの仕訳インポート用CSVと月別×販路の集計に整形します（取込形式・エンコーディングはソフト側の仕様に合わせた調整が必要な場合があります）。消費税の税区分は付与しません。すべてブラウザ内で処理し、CSVはサーバーに送信しません。税務申告の代行はしません。";

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    type: "website",
    locale: "ja_JP",
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
