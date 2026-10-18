import { useEffect, useMemo, useRef } from "react";
import { Network, X } from "lucide-react";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";
import type { VizData } from "@/types";

/**
 * 数据结构可视化面板：调试暂停时把 vector / 数组 / 链表 / std::map/set /
 * 手写二叉树 / 二维数组画成图。
 * 图结构用 <canvas> 绘制（主题色读 --ide-* 变量）；键值表与网格用 HTML 表格，
 * 同样是 --ide-* 变量，亮暗主题自动跟随。
 */

const CHAR_W = 7.2; // 12px 等宽字符近似宽度（布局估算用）
const LINE_H = 16;
const PAD = 8;

const TREE_NODE_W = 84;
const TREE_NODE_H = 36;
const TREE_H_GAP = 26;
const TREE_V_GAP = 52;

type SegColor = "label" | "value" | "accent" | "dim" | "faint" | "warning";
interface Seg {
  text: string;
  color?: SegColor;
}
interface VBox {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: Seg[][];
  align?: "center" | "left";
}
interface VArrow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface VLabel {
  x: number;
  y: number;
  text: string;
  color?: SegColor;
  center?: boolean;
  small?: boolean;
}
interface Layout {
  width: number;
  height: number;
  boxes: VBox[];
  arrows: VArrow[];
  labels: VLabel[];
}

interface Theme {
  text: string;
  dim: string;
  faint: string;
  border: string;
  panel: string;
  accent: string;
  cyan: string;
  warning: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const trunc = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function readTheme(): Theme {
  return {
    text: cssVar("--ide-text", "#c0caf5"),
    dim: cssVar("--ide-text-dim", "#9aa5ce"),
    faint: cssVar("--ide-text-faint", "#565f89"),
    border: cssVar("--ide-border", "#2a2e3f"),
    panel: cssVar("--ide-bg-panel", "#1f2335"),
    accent: cssVar("--ide-accent", "#7aa2f7"),
    cyan: cssVar("--ide-cyan", "#7dcfff"),
    warning: cssVar("--ide-warning", "#e0af68"),
  };
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** 前端二次防御：任何以 _M_ 开头的内部实现字段都不展示 */
const isInternalField = (label: string) => label.startsWith("_M_");

/** vector / 数组：一排方框，上方标索引；struct：竖排字段框 */
function layoutElems(data: VizData, t: TFn): Layout {
  const elems = (data.elems ?? []).filter((e) => !isInternalField(e.label));
  const boxes: VBox[] = [];
  const labels: VLabel[] = [];
  const arrows: VArrow[] = [];

  if (data.kind === "struct") {
    if (elems.length === 0) {
      labels.push({ x: 20, y: 40, text: t("viz.noFields"), color: "faint" });
      return { width: 220, height: 64, boxes, arrows, labels };
    }
    const texts = elems.map((e) => `${e.label}: ${trunc(e.value, 40)}`);
    const maxChars = Math.max(10, ...texts.map((t) => t.length));
    const w = clamp(maxChars * CHAR_W + 28, 200, 470);
    let y = 14;
    for (const e of elems) {
      const h = 26;
      boxes.push({
        x: 20,
        y,
        w,
        h,
        lines: [[{ text: `${e.label}: `, color: "label" }, { text: trunc(e.value, 44), color: "value" }]],
        align: "left",
      });
      y += h + 6;
    }
    return { width: w + 44, height: y + 4, boxes, arrows, labels };
  }

  // vector / array：横向一排
  const items = [...elems];
  if (data.truncated) items.push({ label: "…", value: "…" });
  if (items.length === 0) {
    labels.push({ x: 20, y: 42, text: t("viz.emptyContainer"), color: "faint" });
    return { width: 220, height: 64, boxes, arrows, labels };
  }
  let x = 20;
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const bw = clamp(Math.max(e.label.length, trunc(e.value).length) * CHAR_W + 24, 50, 190);
    labels.push({ x: x + bw / 2, y: 16, text: e.label, color: "faint", center: true, small: true });
    boxes.push({
      x,
      y: 26,
      w: bw,
      h: 36,
      lines: [[{ text: trunc(e.value), color: "value" }]],
      align: "center",
    });
    x += bw + 12;
  }
  let noteY = 0;
  if (data.truncated) {
    noteY = 92;
    labels.push({ x: 20, y: noteY, text: t("viz.truncated", { total: data.total ?? "?", shown: elems.length }), color: "faint" });
  }
  return { width: Math.max(x + 20, 240), height: noteY ? noteY + 14 : 80, boxes, arrows, labels };
}

/** 链表：节点框 + 箭头依次向右，支持环/截断标注 */
function layoutList(data: VizData, t: TFn): Layout {
  const nodes = data.nodes ?? [];
  const boxes: VBox[] = [];
  const arrows: VArrow[] = [];
  const labels: VLabel[] = [];
  if (nodes.length === 0) {
    labels.push({ x: 20, y: 42, text: t("viz.emptyList"), color: "faint" });
    return { width: 220, height: 64, boxes, arrows, labels };
  }
  const GAP = 48;
  let x = 20;
  let maxH = 0;
  const geo: { x: number; y: number; w: number; h: number }[] = [];
  for (const nd of nodes) {
    const fields = nd.fields.filter((f) => !isInternalField(f.label));
    const lines: Seg[][] = [
      [{ text: t("viz.node", { index: nd.index }), color: "dim" }],
      ...fields.map(
        (f): Seg[] => [
          { text: `${f.label}: `, color: "label" },
          { text: trunc(f.value, 20), color: f.type && /\*\s*$/.test(f.type) ? "accent" : "value" },
        ]
      ),
    ];
    const chars = Math.max(8, ...lines.flat().map((s) => s.text.length));
    const w = clamp(chars * CHAR_W + 26, 130, 280);
    const h = 20 + fields.length * LINE_H + 12;
    geo.push({ x, y: 18, w, h });
    boxes.push({ x, y: 18, w, h, lines, align: "left" });
    maxH = Math.max(maxH, h);
    x += w + GAP;
  }
  for (let i = 0; i + 1 < geo.length; i++) {
    const a = geo[i];
    const b = geo[i + 1];
    arrows.push({ x1: a.x + a.w + 3, y1: a.y + a.h / 2, x2: b.x - 6, y2: b.y + b.h / 2 });
  }
  let noteY = 18 + maxH + 24;
  if (!data.cycle && !data.truncated) {
    const last = geo[geo.length - 1];
    labels.push({ x: last.x + last.w + 18, y: last.y + last.h / 2 + 4, text: t("viz.null"), color: "faint" });
  }
  if (data.cycle) {
    labels.push({ x: 20, y: noteY, text: t("viz.cycle"), color: "warning" });
    noteY += 16;
  }
  if (data.truncated) {
    labels.push({ x: 20, y: noteY, text: t("viz.truncatedNodes", { count: nodes.length }), color: "faint" });
    noteY += 16;
  }
  return { width: Math.max(x + 20, 260), height: Math.max(noteY + 4, 92), boxes, arrows, labels };
}

function layoutScalar(data: VizData): Layout {
  return {
    width: 320,
    height: 60,
    boxes: [],
    arrows: [],
    labels: [{ x: 20, y: 36, text: trunc(data.value ?? "?", 64), color: "value" }],
  };
}

/**
 * 经典二叉树布局：递归求左右子树宽度（节点宽 + 层间横/纵间距），
 * 再按「左子树 → 节点 → 右子树」的中序顺序落位；环/重复引用只画箭头不重复展开。
 */
function layoutTree(data: VizData, t: TFn): Layout {
  const boxes: VBox[] = [];
  const arrows: VArrow[] = [];
  const labels: VLabel[] = [];
  const nodes = data.tree?.nodes ?? [];
  if (!data.tree || nodes.length === 0) {
    labels.push({ x: 20, y: 42, text: t("viz.emptyTree"), color: "faint" });
    return { width: 240, height: 64, boxes, arrows, labels };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = byId.get(data.tree.root);
  if (!root) {
    labels.push({ x: 20, y: 42, text: t("viz.emptyTree"), color: "faint" });
    return { width: 240, height: 64, boxes, arrows, labels };
  }

  const measure = (id: string | null | undefined, path: Set<string>): number => {
    if (!id) return 0;
    const n = byId.get(id);
    if (!n || path.has(id)) return TREE_NODE_W;
    const next = new Set(path).add(id);
    const lw = n.left ? measure(n.left, next) : 0;
    const rw = n.right ? measure(n.right, next) : 0;
    return lw + (lw ? TREE_H_GAP : 0) + TREE_NODE_W + (rw ? TREE_H_GAP : 0) + rw;
  };

  const pos = new Map<string, { x: number; y: number }>();
  const placed = new Set<string>();
  let maxDepth = 0;
  const place = (id: string | null | undefined, left: number, depth: number, path: Set<string>) => {
    if (!id) return;
    const n = byId.get(id);
    if (!n || placed.has(id)) return;
    placed.add(id);
    const next = new Set(path).add(id);
    const lw = n.left && !next.has(n.left) ? measure(n.left, next) : 0;
    const rw = n.right && !next.has(n.right) ? measure(n.right, next) : 0;
    const cx = left + lw + (lw ? TREE_H_GAP : 0) + TREE_NODE_W / 2;
    const cy = 14 + depth * (TREE_NODE_H + TREE_V_GAP);
    pos.set(id, { x: cx, y: cy });
    boxes.push({
      x: cx - TREE_NODE_W / 2,
      y: cy,
      w: TREE_NODE_W,
      h: TREE_NODE_H,
      lines: [[{ text: trunc(n.label.replace(/\s+/g, " "), 12), color: "value" }]],
      align: "center",
    });
    maxDepth = Math.max(maxDepth, depth);
    place(n.left, left, depth + 1, next);
    place(n.right, cx + TREE_NODE_W / 2 + (rw ? TREE_H_GAP : 0), depth + 1, next);
  };
  place(root.id, 20, 0, new Set());

  // 箭头最后画：环/重复引用也画到已有节点，便于观察
  for (const n of nodes) {
    const from = pos.get(n.id);
    if (!from) continue;
    for (const child of [n.left, n.right]) {
      if (!child || child === n.id) continue;
      const to = pos.get(child);
      if (!to) continue;
      arrows.push({
        x1: from.x,
        y1: from.y + TREE_NODE_H,
        x2: to.x,
        y2: to.y - 3,
      });
    }
  }

  const width = Math.max(measure(root.id, new Set()) + 40, 260);
  let noteY = 14 + (maxDepth + 1) * (TREE_NODE_H + TREE_V_GAP) + 4;
  if (data.tree.cycle || data.cycle) {
    labels.push({ x: 20, y: noteY, text: t("viz.tree.cycle"), color: "warning" });
    noteY += 16;
  }
  if (data.tree.truncated || data.truncated) {
    labels.push({ x: 20, y: noteY, text: t("viz.tree.truncated", { count: nodes.length }), color: "faint" });
    noteY += 16;
  }
  return { width, height: Math.max(noteY + 8, 92), boxes, arrows, labels };
}

function computeLayout(data: VizData, t: TFn): Layout {
  if (data.kind === "tree") return layoutTree(data, t);
  if (data.kind === "list") return layoutList(data, t);
  if (data.kind === "scalar") return layoutScalar(data);
  return layoutElems(data, t);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function renderLayout(ctx: CanvasRenderingContext2D, L: Layout, th: Theme) {
  const MONO = '"JetBrains Mono", Consolas, "Courier New", monospace';
  const colorOf = (c?: SegColor): string =>
    c === "label" ? th.cyan : c === "accent" ? th.accent : c === "dim" ? th.dim : c === "faint" ? th.faint : c === "warning" ? th.warning : th.text;

  ctx.textBaseline = "middle";
  // 箭头（先画线，节点框盖住衔接处更干净）
  for (const ar of L.arrows) {
    ctx.strokeStyle = th.dim;
    ctx.fillStyle = th.dim;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ar.x1, ar.y1);
    ctx.lineTo(ar.x2, ar.y2);
    ctx.stroke();
    const ang = Math.atan2(ar.y2 - ar.y1, ar.x2 - ar.x1);
    const sz = 7;
    ctx.beginPath();
    ctx.moveTo(ar.x2, ar.y2);
    ctx.lineTo(ar.x2 - sz * Math.cos(ang - 0.45), ar.y2 - sz * Math.sin(ang - 0.45));
    ctx.lineTo(ar.x2 - sz * Math.cos(ang + 0.45), ar.y2 - sz * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }
  // 方框
  for (const b of L.boxes) {
    ctx.beginPath();
    roundRectPath(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fillStyle = th.panel;
    ctx.fill();
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `12px ${MONO}`;
    b.lines.forEach((segs, i) => {
      const widths = segs.map((s) => ctx.measureText(s.text).width);
      const total = widths.reduce((a, c2) => a + c2, 0);
      let cx = b.align === "center" ? b.x + (b.w - total) / 2 : b.x + PAD + 2;
      const yMid = b.y + 10 + i * LINE_H + LINE_H / 2 - (b.lines.length > 1 ? 2 : 0);
      segs.forEach((s, j) => {
        ctx.fillStyle = colorOf(s.color);
        ctx.fillText(s.text, cx, yMid);
        cx += widths[j];
      });
    });
  }
  // 文本标注
  for (const lb of L.labels) {
    ctx.font = `${lb.small ? 10 : 12}px ${MONO}`;
    ctx.fillStyle = colorOf(lb.color);
    const w = ctx.measureText(lb.text).width;
    ctx.fillText(lb.text, lb.center ? lb.x - w / 2 : lb.x, lb.y);
  }
}

const KIND_LABEL: Record<string, string> = {
  vector: "viz.kind.vector",
  array: "viz.kind.array",
  list: "viz.kind.list",
  struct: "viz.kind.struct",
  scalar: "viz.kind.scalar",
  map: "viz.kind.map",
  set: "viz.kind.set",
  tree: "viz.kind.tree",
  grid: "viz.kind.grid",
};

/** 服务端提示码 → i18n key（未知值忽略，绝不直接显示内部字段） */
const NOTE_KEYS: Record<string, string> = {
  mapRedBlackTree: "viz.note.mapRedBlackTree",
  setRedBlackTree: "viz.note.setRedBlackTree",
  treeFallback: "viz.note.treeFallback",
  gridTruncated: "viz.note.gridTruncated",
};

/** 服务端错误码 → i18n key（未知错误码回落到 error 文本） */
const ERROR_KEYS: Record<string, string> = {
  VIZ_MAP_UNSUPPORTED: "viz.error.mapUnsupported",
  VIZ_SET_UNSUPPORTED: "viz.error.setUnsupported",
  VIZ_GRID_UNSUPPORTED: "viz.error.gridUnsupported",
  VIZ_VECTOR_UNSUPPORTED: "viz.error.vectorUnsupported",
  VIZ_UNSUPPORTED_STRUCT: "viz.error.structUnsupported",
};

function errorText(data: VizData, t: TFn): string {
  if (data.code && ERROR_KEYS[data.code]) return t(ERROR_KEYS[data.code]);
  return data.error || t("viz.error.generic");
}

function noteText(data: VizData, t: TFn): string {
  return data.note && NOTE_KEYS[data.note] ? t(NOTE_KEYS[data.note]) : "";
}

function shortType(t: string): string {
  return t.replace(/\s+/g, " ").trim().length > 48 ? t.replace(/\s+/g, " ").trim().slice(0, 47) + "…" : t.replace(/\s+/g, " ").trim();
}

function VizNotice({ text, tone = "muted" }: { text: string; tone?: "muted" | "warning" }) {
  if (!text) return null;
  return (
    <div
      className={`text-[11.5px] leading-5 px-2 py-1 rounded border ${
        tone === "warning"
          ? "border-[color:var(--ide-warning)] text-[color:var(--ide-warning)]"
          : "border-[color:var(--ide-border)] text-[color:var(--ide-text-muted)]"
      }`}
    >
      {text}
    </div>
  );
}

/** std::map / std::set：map 两列（键→值），set 单列；保留 GDB 打印器的中序顺序 */
function MapSetTable({ data }: { data: VizData }) {
  const t = useT();
  const entries = data.entries ?? [];
  const isMap = data.kind === "map";
  const note = noteText(data, t);
  return (
    <div className="kimi-tab-fade flex-1 min-h-0 overflow-auto p-3 space-y-2">
      <VizNotice text={note} />
      {entries.length === 0 ? (
        <div className="text-[12px] text-[color:var(--ide-text-faint)]">{t("viz.emptyContainer")}</div>
      ) : (
        <table className="border-collapse text-[12px] font-mono text-[color:var(--ide-text)]">
          <thead>
            <tr className="text-[color:var(--ide-cyan)]">
              {isMap && <th className="text-left font-semibold px-3 py-1.5 border border-[color:var(--ide-border)]">{t("viz.map.key")}</th>}
              <th className="text-left font-semibold px-3 py-1.5 border border-[color:var(--ide-border)]">
                {isMap ? t("viz.map.value") : t("viz.set.value")}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${i}:${e.key ?? ""}`} className="hover:bg-[color:var(--ide-hover)]">
                {isMap && (
                  <td className="align-top px-3 py-1.5 border border-[color:var(--ide-border)] text-[color:var(--ide-warning)] break-all">
                    {e.key ?? "?"}
                  </td>
                )}
                <td className="align-top px-3 py-1.5 border border-[color:var(--ide-border)] text-[color:var(--ide-success)] break-all">
                  {e.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.truncated && (
        <div className="text-[11px] text-[color:var(--ide-text-faint)]">
          {t("viz.truncated", { total: data.total ?? "?", shown: entries.length })}
        </div>
      )}
    </div>
  );
}

/** 二维数组 / vector<vector>：R×C 网格，左上角与首行/首列是索引角标 */
function GridTable({ data }: { data: VizData }) {
  const t = useT();
  const rows = data.grid?.rows ?? [];
  const cols = Math.max(data.grid?.cols ?? 0, ...rows.map((r) => r.cells.length), 0);
  const note = noteText(data, t);
  return (
    <div className="kimi-tab-fade flex-1 min-h-0 overflow-auto p-3 space-y-2">
      <VizNotice text={note} tone={data.truncated ? "warning" : "muted"} />
      {rows.length === 0 || cols === 0 ? (
        <div className="text-[12px] text-[color:var(--ide-text-faint)]">{t("viz.emptyContainer")}</div>
      ) : (
        <table className="border-collapse text-[12px] font-mono text-[color:var(--ide-text)]">
          <thead>
            <tr>
              <th className="px-2 py-1.5 border border-[color:var(--ide-border)] text-[color:var(--ide-text-faint)] font-normal">
                {t("viz.grid.corner")}
              </th>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} className="px-2 py-1.5 border border-[color:var(--ide-border)] text-[color:var(--ide-cyan)] font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={`${r}:${row.label}`} className="hover:bg-[color:var(--ide-hover)]">
                <th className="px-2 py-1.5 border border-[color:var(--ide-border)] text-[color:var(--ide-cyan)] font-semibold">
                  {row.label || r}
                </th>
                {Array.from({ length: cols }, (_, c) => (
                  <td
                    key={c}
                    className="px-2 py-1.5 border border-[color:var(--ide-border)] text-[color:var(--ide-success)] whitespace-nowrap"
                  >
                    {row.cells[c]?.value ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.truncated && (
        <div className="text-[11px] text-[color:var(--ide-text-faint)]">
          {t("viz.truncated", { total: data.total ?? "?", shown: rows.reduce((n, r) => n + r.cells.length, 0) })}
        </div>
      )}
    </div>
  );
}

export function StructVizPanel() {
  const t = useT();
  const vizData = useIde((s) => s.vizData);
  const vizExpr = useIde((s) => s.vizExpr);
  const vizBusy = useIde((s) => s.vizBusy);
  const closeViz = useIde((s) => s.closeViz);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 二次防御：即使服务端漏掉，也不把 _M_* 内部字段交给布局/表格
  const safeData = useMemo(() => {
    if (!vizData || vizData.kind === "error") return vizData;
    return { ...vizData, elems: vizData.elems?.filter((e) => !isInternalField(e.label)) };
  }, [vizData]);
  const internalOnly =
    !!vizData &&
    vizData.kind !== "error" &&
    (vizData.elems?.length ?? 0) > 0 &&
    (safeData?.elems?.length ?? 0) === 0 &&
    vizData.kind !== "map" &&
    vizData.kind !== "set" &&
    vizData.kind !== "grid" &&
    vizData.kind !== "tree";

  const isTable = vizData?.kind === "map" || vizData?.kind === "set" || vizData?.kind === "grid";
  const layout = useMemo(
    () => (safeData && safeData.kind !== "error" && !isTable && !internalOnly ? computeLayout(safeData, t) : null),
    [safeData, isTable, internalOnly, t]
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(wrap.clientWidth, layout?.width ?? 0, 120);
      const cssH = Math.max(wrap.clientHeight, layout?.height ?? 0, 60);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (layout) renderLayout(ctx, layout, readTheme());
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [layout]);

  if (!vizData || !vizExpr) return null;
  const kind = KIND_LABEL[vizData.kind] ? t(KIND_LABEL[vizData.kind]) : vizData.kind;
  const note = noteText(vizData, t);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[color:var(--ide-border)]">
        <Network size={12} className="text-[color:var(--ide-accent)] shrink-0" />
        <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase shrink-0">{t("viz.title")}</span>
        <span className="text-[12px] text-[color:var(--ide-cyan)] font-mono truncate" title={vizExpr}>
          {vizExpr}
        </span>
        {vizData.type && (
          <span className="text-[11px] text-[color:var(--ide-text-faint)] font-mono truncate" title={vizData.type}>
            {shortType(vizData.type)}
          </span>
        )}
        <span className="text-[10px] px-1.5 py-[1px] rounded border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-muted)] shrink-0">
          {kind}
        </span>
        {vizBusy && <span className="text-[11px] text-[color:var(--ide-warning)] shrink-0">{t("viz.refreshing")}</span>}
        <div className="flex-1" />
        <button
          onClick={closeViz}
          className="kimi-pop text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-error)] shrink-0"
          title={t("viz.close")}
        >
          <X size={13} />
        </button>
      </div>
      {vizData.kind === "error" || internalOnly ? (
        <div className="flex-1 px-4 py-3 text-[12.5px] text-[color:var(--ide-error)] overflow-auto">
          ⚠ {internalOnly ? t("viz.error.internalHidden") : errorText(vizData, t)}
        </div>
      ) : isTable ? (
        vizData.kind === "grid" ? (
          <GridTable data={vizData} />
        ) : (
          <MapSetTable data={vizData} />
        )
      ) : (
        <div
          ref={wrapRef}
          key={`${vizExpr}|${vizData.kind}|${vizData.elems?.length ?? 0}|${vizData.nodes?.length ?? 0}|${vizData.tree?.nodes.length ?? 0}|${vizData.total ?? 0}`}
          className="kimi-tab-fade flex-1 min-h-0 overflow-auto"
        >
          {note && (
            <div className="m-2">
              <VizNotice text={note} />
            </div>
          )}
          <canvas ref={canvasRef} className="block" />
        </div>
      )}
    </div>
  );
}
