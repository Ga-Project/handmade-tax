import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// output:"export" では sitemap ルートを静的化する必要がある（未指定だとビルドが落ちる）。
export const dynamic = "force-static";

// static export で out/sitemap.xml を $0 生成する。単一ページ構成なので絶対URL 1件。
// URL は lib/site.ts が単一の出所（canonical / og:url とここが食い違うと、Search Console の
// 正規化が壊れる。test/site.test.mjs が成果物で3点一致を検査する）。
//
// robots.txt は置かない。robots.txt はオリジン単位でしか効かず、有効なのは
// https://ga-project.github.io/robots.txt（＝当社の管理外・実測 404）だけなので、
// /handmade-tax/robots.txt を置いてもクローラは読まない。sitemap は Search Console に
// URL を直接送信できるため、サブパス配信でも意味がある。
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
