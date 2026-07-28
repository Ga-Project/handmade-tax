"use client";

// ハンドメ確申コンバータ — トップページ（換算レーン UI・完全クライアント処理）
//
// 販路の売上 CSV を読み込み、会計ソフトの仕訳インポート用 CSV と 月×販路 集計に変換する。
// CSV はブラウザ内だけで処理し、サーバーには一切送信しない。税務判断・申告代行はしない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeBytes } from "@/lib/decode";
import { parseCsv } from "@/lib/csv";
import {
  detectPlatform,
  channelLabelFor,
  normalizeHeader,
  PLATFORMS,
  type FieldKey,
  type FieldMap,
} from "@/lib/platforms";
import {
  extractSales,
  resolveColumns,
  generateJournal,
  journalToCsv,
  journalTotals,
  getFormat,
  JOURNAL_FORMATS,
  DEFAULT_ACCOUNTS,
  type AccountConfig,
  type ColumnIndex,
  type FormatId,
  type RowIssue,
  type SaleRow,
} from "@/lib/journal";
import { aggregate, cellOf, aggregationToCsv } from "@/lib/aggregate";

interface FileEntry {
  id: string;
  name: string;
  ok: boolean;
  encoding: string;
  header: string[];
  rows: string[][];
  platformLabel: string;
  confidence: "high" | "low" | "none";
  channelName: string;
  mapping: FieldMap;
  presetMap: FieldMap;
}

/** 1 ファイルを実際に解決した結果（バッジ・準備判定・集計の唯一の根拠）。 */
interface FileResult {
  file: FileEntry;
  cols: ColumnIndex;
  resolved: Record<FieldKey, boolean>;
  ready: boolean; // date と gross が実際に解決できたか
  sales: SaleRow[];
  issues: RowIssue[];
}

/** 表示用: 行の問題にファイル名を添えたもの。 */
type FlatIssue = RowIssue & { fileName: string };

interface Snapshot {
  files: FileEntry[];
  accounts: AccountConfig;
  format: FormatId;
}

const STORAGE_KEY = "handmade-tax:v1";
const FIELD_KEYS: FieldKey[] = [
  "date",
  "gross",
  "fee",
  "channel",
  "memo",
  "settlement",
];

const MAP_FIELDS: { key: FieldKey; label: string; required: boolean }[] = [
  { key: "date", label: "取引日", required: true },
  { key: "gross", label: "総売上", required: true },
  { key: "fee", label: "手数料", required: false },
  { key: "memo", label: "摘要/商品名", required: false },
  { key: "settlement", label: "入金日", required: false },
];

const yen = (n: number): string => "¥" + n.toLocaleString("ja-JP");

function download(filename: string, text: string): void {
  // 出力は UTF-8。BOM は付けない: 会計ソフトの仕訳インポートは 1 列目のヘッダ名で列を
  // 対応づけるため、先頭に BOM が混じると 1 列目のヘッダが一致せず取込に失敗し得る。
  // Excel で直接開くと文字化けする場合があるが、その用途より取込の確実さを優先する。
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function firstSample(rows: string[][], colIndex: number | undefined): string {
  if (colIndex === undefined) return "";
  for (const r of rows) {
    const v = (r[colIndex] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/** プリセットの（表記ゆれのある）ヘッダ名を、この CSV の実ヘッダ文字列に解決する。
 * こうすることで select の value が実オプションと一致して表示され、resolveColumns も解決でき、
 * 「✓自動なのに列が解決しない」偽の成功が起きない。解決できない項目は落とす（= 要確認になる）。 */
function toActualMap(header: string[], preset: FieldMap): FieldMap {
  const norm = header.map(normalizeHeader);
  const out: FieldMap = {};
  for (const k of FIELD_KEYS) {
    const v = preset[k];
    if (!v) continue;
    const i = norm.indexOf(normalizeHeader(v));
    if (i >= 0) out[k] = header[i];
  }
  return out;
}

export default function Home() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [accounts, setAccounts] = useState<AccountConfig>(DEFAULT_ACCOUNTS);
  const [format, setFormat] = useState<FormatId>("freee");
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingCount, setLoadingCount] = useState(0);
  const [doneMsg, setDoneMsg] = useState("");
  const [restore, setRestore] = useState<Snapshot | null>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);

  // テーマの初期化。SSR を避けて effect 内でのみ触る。保存があれば適用、無ければ OS 設定を反映。
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("handmade-tax:theme");
    } catch {
      /* localStorage 不可の環境では OS 設定にフォールバック */
    }
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
      document.documentElement.setAttribute("data-theme", saved);
      return;
    }
    const prefersDark =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(prefersDark ? "dark" : "light");
  }, []);

  // 前回セッションの復元候補を読む（自動では戻さず、バナーで選ばせる）。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw) as Snapshot;
      if (snap.files && snap.files.length > 0) setRestore(snap);
    } catch {
      /* 壊れた保存は無視 */
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("handmade-tax:theme", next);
    } catch {
      /* 保存不可でも UI は切り替わる */
    }
  };

  const announce = (msg: string) => {
    if (liveRef.current) liveRef.current.textContent = msg;
  };

  const ingest = useCallback(async (list: FileList | File[]) => {
    const arr = Array.from(list).filter(
      (f) => /\.csv$/i.test(f.name) || f.type.includes("csv"),
    );
    if (arr.length === 0) return;
    setLoading(true);
    setLoadingCount(arr.length);
    const next: FileEntry[] = [];
    for (const file of arr) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const { text, encoding } = decodeBytes(buf);
        const { header, rows } = parseCsv(text);
        const det = detectPlatform(header);
        const actual = det.platform
          ? toActualMap(header, det.platform.map)
          : {};
        next.push({
          id: `${file.name}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          ok: header.length > 0 && rows.length > 0,
          encoding,
          header,
          rows,
          platformLabel: channelLabelFor(det),
          confidence: det.confidence,
          channelName: det.platform ? det.platform.label : "不明",
          mapping: { ...actual },
          presetMap: { ...actual },
        });
      } catch {
        next.push({
          id: `${file.name}-err`,
          name: file.name,
          ok: false,
          encoding: "utf-8",
          header: [],
          rows: [],
          platformLabel: "読み込み失敗",
          confidence: "none",
          channelName: "不明",
          mapping: {},
          presetMap: {},
        });
      }
    }
    setFiles((prev) => [...prev, ...next]);
    setLoading(false);
    if (next.some((f) => f.ok)) {
      setStep(2);
      announce("ステーション②「割当」に進みました");
    }
  }, []);

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const updateMapping = (fileId: string, key: FieldKey, column: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === fileId
          ? { ...f, mapping: { ...f.mapping, [key]: column || undefined } }
          : f,
      ),
    );
  };

  const updateChannel = (fileId: string, name: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, channelName: name } : f)),
    );
  };

  // 各ファイルを実際に解決する。バッジ・準備判定・売上・要確認行のすべての根拠。
  const results: FileResult[] = useMemo(() => {
    return files.map((f) => {
      if (!f.ok) {
        return {
          file: f,
          cols: {},
          resolved: {
            date: false,
            gross: false,
            fee: false,
            channel: false,
            memo: false,
            settlement: false,
          },
          ready: false,
          sales: [],
          issues: [],
        };
      }
      const cols = resolveColumns(f.header, f.mapping);
      const resolved: Record<FieldKey, boolean> = {
        date: cols.date !== undefined,
        gross: cols.gross !== undefined,
        fee: cols.fee !== undefined,
        channel: cols.channel !== undefined,
        memo: cols.memo !== undefined,
        settlement: cols.settlement !== undefined,
      };
      const ready = resolved.date && resolved.gross;
      const { sales, issues } = ready
        ? extractSales({ header: f.header, rows: f.rows }, cols, f.channelName)
        : { sales: [], issues: [] };
      return { file: f, cols, resolved, ready, sales, issues };
    });
  }, [files]);

  const resolvedById = useMemo(() => {
    const m: Record<string, FileResult> = {};
    for (const r of results) m[r.file.id] = r;
    return m;
  }, [results]);

  const sales: SaleRow[] = useMemo(
    () => results.flatMap((r) => r.sales),
    [results],
  );

  const issueList: FlatIssue[] = useMemo(
    () =>
      results.flatMap((r) =>
        r.issues.map((iss) => ({ ...iss, fileName: r.file.name })),
      ),
    [results],
  );

  const lines = useMemo(
    () => generateJournal(sales, accounts),
    [sales, accounts],
  );
  const totals = useMemo(() => journalTotals(lines), [lines]);
  const agg = useMemo(() => aggregate(sales), [sales]);
  const maxMonthGross = useMemo(
    () =>
      Math.max(1, ...agg.months.map((m) => agg.rowTotals.get(m)?.gross ?? 0)),
    [agg],
  );

  const mappingReady = results.some((r) => r.ready);
  const canExport = sales.length > 0;

  // セッションの自動保存（明細 + 割当 + フォーマット）。
  useEffect(() => {
    try {
      if (files.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      const snap: Snapshot = { files, accounts, format };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      /* 容量超過等は黙って諦める（機能は継続） */
    }
  }, [files, accounts, format]);

  const doRestore = () => {
    if (!restore) return;
    setFiles(restore.files);
    setAccounts(restore.accounts ?? DEFAULT_ACCOUNTS);
    setFormat(restore.format ?? "freee");
    setRestore(null);
    setStep(2);
  };
  const discardRestore = () => {
    setRestore(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
  };

  const exportJournal = () => {
    if (!canExport) return;
    download(
      `仕訳_${format}_${new Date().toISOString().slice(0, 10)}.csv`,
      journalToCsv(lines, getFormat(format)),
    );
    setDoneMsg(`${lines.length}件を出力しました`);
    setTimeout(() => setDoneMsg(""), 2400);
  };
  const exportAgg = () => {
    if (!canExport) return;
    download(
      `集計_${new Date().toISOString().slice(0, 10)}.csv`,
      aggregationToCsv(agg),
    );
    setDoneMsg(`${agg.months.length}ヶ月分を出力しました`);
    setTimeout(() => setDoneMsg(""), 2400);
  };

  // レールのノード状態。
  const node1Done = files.length > 0;
  const node2Done = mappingReady && step > 2;
  const nodes = [
    {
      n: 1,
      name: "取込",
      count: `${files.length} ファイル`,
      active: step === 1,
      done: node1Done && step !== 1,
      enabled: true,
    },
    {
      n: 2,
      name: "割当",
      count: `${sales.length} 件`,
      active: step === 2,
      done: node2Done,
      enabled: files.length > 0,
    },
    {
      n: 3,
      name: "書き出し",
      count: `${lines.length} 仕訳`,
      active: step === 3,
      done: false,
      enabled: canExport,
    },
  ] as const;

  return (
    <>
      <a href="#workbench" className="skip">
        ワークベンチへスキップ
      </a>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            ハンドメ確申コンバータ
            <small>
              販路の売上CSV → 会計ソフトの仕訳インポート用CSV・月別集計
            </small>
          </div>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={
              theme === "dark" ? "ライトテーマに切替" : "ダークテーマに切替"
            }
          >
            ◐
          </button>
        </header>

        {restore && (
          <div
            className="restore"
            role="region"
            aria-label="前回のレーンを復元"
          >
            <span>
              前回のレーンが残っています（{restore.files.length}{" "}
              ファイル）。復元しますか？
            </span>
            <span className="acts">
              <button type="button" className="linkbtn" onClick={doRestore}>
                復元
              </button>
              <button
                type="button"
                className="linkbtn"
                onClick={discardRestore}
              >
                破棄
              </button>
            </span>
          </div>
        )}

        {/* LANE RAIL */}
        <nav aria-label="変換レーン">
          <ol className="rail">
            {nodes.map((node) => {
              const cls = [
                "rail-node",
                node.active ? "is-active" : "",
                node.done ? "is-done" : "",
                node.active ? "seg-active" : node.done ? "seg-done" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={node.n} className={cls} style={{ listStyle: "none" }}>
                  <button
                    type="button"
                    className="dot"
                    onClick={() => node.enabled && setStep(node.n as 1 | 2 | 3)}
                    disabled={!node.enabled}
                    aria-current={node.active ? "step" : undefined}
                    aria-label={`ステーション${node.n} ${node.name}`}
                  >
                    {node.done ? "✓" : node.n}
                  </button>
                  <span className="rail-name">{node.name}</span>
                  <span className="rail-count">{node.count}</span>
                </li>
              );
            })}
          </ol>
        </nav>

        <p
          ref={liveRef}
          aria-live="polite"
          style={{ position: "absolute", left: "-9999px" }}
        />

        <main id="workbench" className="plate">
          {loading ? (
            <section aria-busy="true">
              <h2>読み込み中</h2>
              <p className="sub">
                CSVを解析しています。ブラウザ内で処理しています。
              </p>
              <div className="skeleton" />
              <div className="skeleton" style={{ width: "80%" }} />
              <div className="skeleton" style={{ width: "60%" }} />
              <p className="loading-note">{loadingCount}件を換算中…</p>
            </section>
          ) : step === 1 ? (
            <StationIntake
              files={files}
              dragging={dragging}
              setDragging={setDragging}
              onFiles={ingest}
              onRemove={removeFile}
            />
          ) : step === 2 ? (
            <StationMap
              files={files}
              resolvedById={resolvedById}
              issues={issueList}
              accounts={accounts}
              setAccounts={setAccounts}
              format={format}
              setFormat={setFormat}
              onMap={updateMapping}
              onChannel={updateChannel}
              onNext={() => {
                setStep(3);
                announce("ステーション③「書き出し」に進みました");
              }}
              ready={mappingReady}
            />
          ) : (
            <StationExport
              agg={agg}
              maxMonthGross={maxMonthGross}
              totals={totals}
              sales={sales}
              issues={issueList}
            />
          )}
        </main>

        <p className="notice">
          <strong>これは仕訳CSVを整形するツールです。</strong>{" "}
          各会計ソフトの仕訳インポート用にCSVを整形します（取込形式・列の並び・エンコーディングは
          ソフト側の仕様に合わせた調整が必要な場合があります）。税務署への申告や提出は行いません。
          <strong>消費税の税区分は付与しません</strong>
          （課税事業者の方はご自身で設定してください）。生成される仕訳は下書きであり、勘定科目・金額・日付は
          <strong>必ずご自身で確認のうえ</strong>
          取り込んでください。販路プリセットは目安であり
          正確さを保証するものではありません。CSVはブラウザ内で処理され、サーバーに送信されません。
        </p>
      </div>

      {/* 排出トレイ（常設・書き出しCTA） */}
      <div className="tray" role="region" aria-label="排出トレイ">
        {doneMsg ? (
          <span className="tray-done">◯ {doneMsg}</span>
        ) : (
          <>
            <button
              type="button"
              className="btn primary on-accent"
              onClick={exportJournal}
              disabled={!canExport}
              title={
                canExport
                  ? undefined
                  : "CSVを取り込み、取引日と総売上を割り当てると書き出せます"
              }
            >
              ⏏ 仕訳CSVを書き出す
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={exportAgg}
              disabled={!canExport}
              title={canExport ? undefined : "変換対象の明細がありません"}
            >
              集計CSV
            </button>
          </>
        )}
      </div>
    </>
  );
}

/* ---- 要確認行の可視化（サイレントなデータ欠落を防ぐ）--------------------- */
function IssuesWarning({ issues }: { issues: FlatIssue[] }) {
  if (issues.length === 0) return null;
  const shown = issues.slice(0, 12);
  return (
    <div className="warn-box" role="alert">
      <p className="warn-head">
        ⚑ {issues.length}
        行を変換できませんでした（下記を確認し、必要なら手動で入力してください）
      </p>
      <div className="map-wrap">
        <table className="issues-table">
          <thead>
            <tr>
              <th scope="col">ファイル</th>
              <th scope="col">行</th>
              <th scope="col">理由</th>
              <th scope="col">内容</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((iss, i) => (
              <tr key={`${iss.fileName}-${iss.index}-${i}`}>
                <td className="mono">{iss.fileName}</td>
                <td className="mono">{iss.index + 1}行目</td>
                <td>{iss.reason}</td>
                <td className="mono src">
                  {iss.cells.join(" | ").slice(0, 80) || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {issues.length > shown.length && (
        <p className="warn-more">
          ほか {issues.length - shown.length} 行（同種の要確認）
        </p>
      )}
    </div>
  );
}

/* ---- ① 取込 --------------------------------------------------------------- */
function StationIntake(props: {
  files: FileEntry[];
  dragging: boolean;
  setDragging: (v: boolean) => void;
  onFiles: (list: FileList | File[]) => void;
  onRemove: (id: string) => void;
}) {
  const { files, dragging, setDragging, onFiles, onRemove } = props;
  return (
    <section>
      <h2>① 取込</h2>
      <p className="sub">
        minne / Creema / BASE / メルカリ
        などの売上CSVをスロットへ。複数まとめて可。
      </p>

      <label
        className={"slot" + (dragging ? " drag" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        <span className="chev" aria-hidden="true">
          ⌄ スロットへ
        </span>
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          aria-label="CSVファイルを選択"
          onChange={(e) => e.target.files && onFiles(e.target.files)}
        />
      </label>

      {files.length > 0 && (
        <div className="chips">
          {files.map((f) => (
            <span key={f.id} className={"chip" + (f.ok ? "" : " err")}>
              {f.ok ? f.name : `${f.name}（判定できませんでした）`}
              <button
                type="button"
                onClick={() => onRemove(f.id)}
                aria-label={`${f.name} を外す`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="platform-chips" aria-label="対応している販路">
        {PLATFORMS.map((p) => (
          <span key={p.id} className="pchip">
            {p.label}
          </span>
        ))}
        <span className="pchip">その他（手動割り当て）</span>
      </div>

      <span className="assure">⛨ CSVはサーバーに送信されません</span>
    </section>
  );
}

/* ---- ② 割当 --------------------------------------------------------------- */
function StationMap(props: {
  files: FileEntry[];
  resolvedById: Record<string, FileResult>;
  issues: FlatIssue[];
  accounts: AccountConfig;
  setAccounts: (a: AccountConfig) => void;
  format: FormatId;
  setFormat: (f: FormatId) => void;
  onMap: (fileId: string, key: FieldKey, column: string) => void;
  onChannel: (fileId: string, name: string) => void;
  onNext: () => void;
  ready: boolean;
}) {
  const {
    files,
    resolvedById,
    issues,
    accounts,
    setAccounts,
    format,
    setFormat,
    onMap,
    onChannel,
    onNext,
    ready,
  } = props;
  const okFiles = files.filter((f) => f.ok);

  return (
    <section>
      <h2>② 割当</h2>
      <p className="sub">
        自動判定した対応を確認・修正してください。プリセットは目安です。
        <strong>要確認</strong>の行は必ず見てください。
      </p>

      {okFiles.length === 0 && (
        <p>読み込めたCSVがありません。前のステーションで取り込んでください。</p>
      )}

      {okFiles.map((f) => {
        const r = resolvedById[f.id];
        const fileReady = r?.ready ?? false;
        // ファイル単位バッジ: 実際に date/gross が解決し、かつ高信頼のときだけ ✓自動。
        const showAuto = fileReady && f.confidence === "high";
        return (
          <div key={f.id} style={{ marginBottom: 26 }}>
            <h3
              style={{
                fontSize: 15,
                marginBottom: 8,
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span className="mono">{f.name}</span>
              {showAuto ? (
                <span className="tag auto">✓ 自動</span>
              ) : (
                <span className="tag check">⚑ 要確認</span>
              )}
              <span className="label">販路: {f.platformLabel}</span>
            </h3>

            <div className="field" style={{ maxWidth: 260, marginBottom: 10 }}>
              <label htmlFor={`ch-${f.id}`}>販路名（集計・摘要に使用）</label>
              <input
                id={`ch-${f.id}`}
                value={f.channelName}
                onChange={(e) => onChannel(f.id, e.target.value)}
              />
            </div>

            <div className="map-wrap">
              <table className="map-table">
                <thead>
                  <tr>
                    <th scope="col">項目</th>
                    <th scope="col">元CSV列</th>
                    <th scope="col">生データ例</th>
                    <th scope="col" aria-label="対応"></th>
                    <th scope="col">状態</th>
                  </tr>
                </thead>
                <tbody>
                  {MAP_FIELDS.map((field) => {
                    const current = f.mapping[field.key] ?? "";
                    const colIndex = current ? f.header.indexOf(current) : -1;
                    const sample = firstSample(
                      f.rows,
                      colIndex >= 0 ? colIndex : undefined,
                    );
                    // ✓自動は「プリセット由来かつ実際に解決」したときだけ。
                    const isResolved = r?.resolved[field.key] ?? false;
                    const auto =
                      isResolved &&
                      current !== "" &&
                      current === f.presetMap[field.key];
                    const unset = field.required && !isResolved;
                    return (
                      <tr key={field.key}>
                        <th scope="row">
                          {field.label}
                          {field.required && (
                            <span style={{ color: "var(--error)" }}> *</span>
                          )}
                        </th>
                        <td>
                          <select
                            aria-label={`${field.label} に対応する元CSV列`}
                            value={current}
                            onChange={(e) =>
                              onMap(f.id, field.key, e.target.value)
                            }
                          >
                            <option value="">
                              {field.required ? "（未選択）" : "（なし）"}
                            </option>
                            {f.header.map((h, i) => (
                              <option key={`${h}-${i}`} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="src">{sample || "—"}</td>
                        <td className="arrow" aria-hidden="true">
                          ▸
                        </td>
                        <td>
                          {unset ? (
                            <span className="tag check">⚑ 要確認</span>
                          ) : auto ? (
                            <span className="tag auto">✓ 自動</span>
                          ) : isResolved ? (
                            <span className="label">手動</span>
                          ) : (
                            <span className="label">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <IssuesWarning issues={issues} />

      <h3 style={{ fontSize: 15, margin: "18px 0 6px" }}>
        勘定科目（下書き・上書き可）
      </h3>
      <div className="acct-config">
        <div className="field">
          <label htmlFor="acc-recv">売掛金（借方）</label>
          <input
            id="acc-recv"
            value={accounts.receivable}
            onChange={(e) =>
              setAccounts({ ...accounts, receivable: e.target.value })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="acc-sales">売上高（貸方）</label>
          <input
            id="acc-sales"
            value={accounts.sales}
            onChange={(e) =>
              setAccounts({ ...accounts, sales: e.target.value })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="acc-fee">支払手数料（借方）</label>
          <input
            id="acc-fee"
            value={accounts.fee}
            onChange={(e) => setAccounts({ ...accounts, fee: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="fmt">出力フォーマット</label>
          <select
            id="fmt"
            value={format}
            onChange={(e) => setFormat(e.target.value as FormatId)}
          >
            {JOURNAL_FORMATS.map((jf) => (
              <option key={jf.id} value={jf.id}>
                {jf.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="sub" style={{ marginTop: 8 }}>
        日付書式はいずれのフォーマットも YYYY/MM/DD です。
        {getFormat(format).encodingNote}
      </p>

      <button
        type="button"
        className="btn primary on-accent"
        style={{ marginTop: 16 }}
        onClick={onNext}
        disabled={!ready}
        title={
          ready ? undefined : "取引日と総売上の割り当て（実際に解決）が必要です"
        }
      >
        集計と書き出しへ ▸
      </button>
    </section>
  );
}

/* ---- ③ 書き出し（集計 + 検算）--------------------------------------------- */
function StationExport(props: {
  agg: ReturnType<typeof aggregate>;
  maxMonthGross: number;
  totals: { debit: number; credit: number };
  sales: SaleRow[];
  issues: FlatIssue[];
}) {
  const { agg, maxMonthGross, totals, sales, issues } = props;

  if (sales.length === 0) {
    return (
      <section>
        <h2>③ 書き出し</h2>
        <div className="error-box">
          <span aria-hidden="true">⚠</span>
          <span>
            変換できる明細がありません。ステーション②で「取引日」と「総売上」の列を割り当ててください。
          </span>
        </div>
        <IssuesWarning issues={issues} />
      </section>
    );
  }

  return (
    <section>
      <h2>③ 書き出し</h2>
      <p className="sub">
        内容を確認して、右下の排出トレイから書き出してください。貸借の検算: 借方{" "}
        {yen(totals.debit)} ／ 貸方 {yen(totals.credit)}
        {totals.debit === totals.credit ? "（一致）" : "（不一致・要確認）"}。
      </p>

      <IssuesWarning issues={issues} />

      <div className="tiles">
        <div className="tile">
          <div className="label">総売上</div>
          <div className="data-lg">{yen(agg.grand.gross)}</div>
        </div>
        <div className="tile">
          <div className="label">手数料計</div>
          <div className="data-lg">{yen(agg.grand.fee)}</div>
        </div>
        <div className="tile">
          <div className="label">純売上</div>
          <div className="data-lg">{yen(agg.grand.net)}</div>
        </div>
        <div className="tile">
          <div className="label">販路数</div>
          <div className="data-lg">{agg.channels.length}</div>
        </div>
      </div>

      <div className="map-wrap">
        <table className="matrix">
          <caption
            className="label"
            style={{ textAlign: "left", marginBottom: 6 }}
          >
            月 × 販路（総売上）
          </caption>
          <thead>
            <tr>
              <th scope="col">月</th>
              {agg.channels.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
              <th scope="col">月計</th>
              <th scope="col">推移</th>
            </tr>
          </thead>
          <tbody>
            {agg.months.map((m) => {
              const rowTotal = agg.rowTotals.get(m)?.gross ?? 0;
              return (
                <tr key={m}>
                  <th scope="row">{m}</th>
                  {agg.channels.map((c) => {
                    const cell = cellOf(agg, m, c);
                    return (
                      <td key={c}>{cell.count ? yen(cell.gross) : "—"}</td>
                    );
                  })}
                  <td className="total">{yen(rowTotal)}</td>
                  <td>
                    <span
                      className="bar"
                      style={{
                        display: "block",
                        width: `${(rowTotal / maxMonthGross) * 100}%`,
                      }}
                      aria-hidden="true"
                    />
                  </td>
                </tr>
              );
            })}
            <tr className="total">
              <th scope="row">販路計</th>
              {agg.channels.map((c) => (
                <td key={c}>{yen(agg.colTotals.get(c)?.gross ?? 0)}</td>
              ))}
              <td>{yen(agg.grand.gross)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
