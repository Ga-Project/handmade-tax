// generate-og.mjs — OGP 共有カード (public/og.png, 1200×630) を scripts/og-template.html から生成する。
//
// 静的書き出し（output:"export"）製品なので og.png は「事前生成してリポにコミット」する運用。
// Pages の CI は headless Chrome を持たないため、この生成はローカルの再現手順であり
// ビルドパイプラインには含めない（public/og.png が成果物で、next が out/ にそのままコピーする）。
//
// 使い方: node scripts/generate-og.mjs
//   Chrome を --headless で叩いて 1200×630 のスクショを撮るだけ（追加依存なし）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const template = resolve(here, "og-template.html");
const out = resolve(here, "..", "public", "og.png");

// macOS の Google Chrome を既定に、環境変数 CHROME で上書き可能にする。
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!existsSync(template)) {
  console.error(`テンプレートが見つかりません: ${template}`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });

execFileSync(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1200,630",
    `--screenshot=${out}`,
    `file://${template}`,
  ],
  { stdio: "inherit" },
);

console.log(`OGP 画像を書き出しました: ${out}`);
