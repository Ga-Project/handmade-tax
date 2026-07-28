#!/usr/bin/env bash
# handmade-tax — static export（out/ 生成）のビルド & ローカル確認ラッパ。
# サーバランタイムは使わない（next start なし）。out/ を静的配信して確認する。
#
# 使い方:
#   ./run.sh            # pnpm build で out/ を生成（デプロイ物）
#   ./run.sh serve      # out/ をビルドしてローカル配信（http://localhost:3000）
#   ./run.sh dev        # 開発サーバ（pnpm dev・ホットリロード）
set -euo pipefail
cd "$(dirname "$0")"

cmd="${1:-build}"

case "$cmd" in
build)
  pnpm build
  echo "run.sh: out/ を生成しました。ローカル確認は './run.sh serve'。" >&2
  ;;
serve)
  pnpm build
  if command -v npx >/dev/null 2>&1; then
    echo "run.sh: out/ を http://localhost:3000 で配信します（Ctrl-C で停止）。" >&2
    npx --yes serve out
  else
    echo "run.sh: npx が見つかりません。python3 で配信します（http://localhost:3000）。" >&2
    python3 -m http.server -d out 3000
  fi
  ;;
dev)
  exec pnpm dev
  ;;
*)
  echo "run.sh: 不明なコマンド: '$cmd'（build | serve | dev）" >&2
  exit 64
  ;;
esac
