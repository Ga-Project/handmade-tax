// 文字コード判定のテスト（node:test・追加依存なし）
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBytes, stripBom, hasReplacementChar } from "../lib/decode.ts";

test("stripBom は先頭 BOM を 1 個だけ除去する", () => {
  assert.equal(stripBom("﻿日付"), "日付");
  assert.equal(stripBom("日付"), "日付");
});

test("hasReplacementChar は U+FFFD を検出する", () => {
  assert.equal(hasReplacementChar("あ�い"), true);
  assert.equal(hasReplacementChar("あいう"), false);
});

test("UTF-8 バイト列は utf-8 として読まれる", () => {
  const bytes = new TextEncoder().encode("商品,金額");
  const { text, encoding } = decodeBytes(bytes);
  assert.equal(text, "商品,金額");
  assert.equal(encoding, "utf-8");
});

test("UTF-8 の BOM 付きバイト列は BOM が除去される", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("日付")]);
  const { text, encoding } = decodeBytes(bytes);
  assert.equal(text, "日付");
  assert.equal(encoding, "utf-8");
});

test("Shift_JIS バイト列は utf-8 で置換文字が出て sjis にフォールバックする", () => {
  // 「あ」= Shift_JIS 0x82 0xA0（UTF-8 としては不正 → U+FFFD が出る）
  const bytes = new Uint8Array([0x82, 0xa0]);
  const { text, encoding } = decodeBytes(bytes);
  assert.equal(encoding, "shift_jis");
  assert.equal(text, "あ");
});
