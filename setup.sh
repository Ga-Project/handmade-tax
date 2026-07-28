#!/usr/bin/env bash
# handmade-tax — web 雛形のセットアップ: 依存導入 + secrets 案内。
set -euo pipefail
cd "$(dirname "$0")"

if command -v pnpm >/dev/null 2>&1; then
  echo "[setup] pnpm install"
  pnpm install
else
  echo "[setup] pnpm が見つかりません。'brew install pnpm node' を実行してください。" >&2
  exit 69
fi

cat <<'EOS'

[setup] secrets:
  static export のため実行時サーバ秘密は原則不要。
  必要になったら .env.age.example を参考に env を用意する(実値はコミットしない)。
  age recipient 分離の枠組みは secrets.age / age.recipient で維持。手順は README.md 参照。

[setup] 開発 & ビルド:
  pnpm dev          # http://localhost:3000(ホットリロード)
  pnpm build        # out/ に static export
  ./run.sh serve    # out/ をローカル配信して確認
EOS
echo "[setup] done."
