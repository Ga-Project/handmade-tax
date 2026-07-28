// ハンドメ確申コンバータ — 404。static export では out/404.html に書き出される（GitHub Pages 404）。
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "404 — ハンドメ確申コンバータ",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="shell">
      <h1 className="brand">404</h1>
      <p className="sub">ページが見つかりません。</p>
      <p>
        <Link href="/">ホームへ戻る</Link>
      </p>
    </main>
  );
}
