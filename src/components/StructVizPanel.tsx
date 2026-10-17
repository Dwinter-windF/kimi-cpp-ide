import { useEffect, useMemo, useRef } from "react";
import { Network, X } from "lucide-react";
import { useIde } from "@/store";
import type { VizData } from "@/types";

/**
 * 数据结构可视化面板：调试暂停时把 vector / 数组 / 链表画成图。
 * 用 <canvas> 绘制（需求指定 Canvas 渲染），主题色读 --ide-* 变量。
 */

const CHAR_W = 7.2; // 12px 等宽字符近似宽度（布局估算用）
const LINE_H = 16;
const PAD = 8;

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

/** vector / 数组：一排方框，上方标索引；struct：竖排字段框 */
function layoutElems(data: VizData): Layout {
  const elems = data.elems ?? [];
  const boxes: VBox[] = [];
  const labels: VLabel[] = [];
  const arrows: VArrow[] = [];

  if (data.kind === "struct") {
    if (elems.length === 0) {
      labels.push({ x: 20, y: 40, text: "（无字段）", color: "faint" });
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
    labels.push({ x: 20, y: 42, text: "（空容器）", color: "faint" });
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
    labels.push({ x: 20, y: noteY, text: `共 ${data.total ?? "?"} 个元素，仅显示前 ${elems.length} 个`, color: "faint" });
  }
  return { width: Math.max(x + 20, 240), height: noteY ? noteY + 14 : 80, boxes, arrows, labels };
}

/** 链表：节点框 + 箭头依次向右，支持环/截断标注 */
function layoutList(data: VizData): Layout {
  const nodes = data.nodes ?? [];
  const boxes: VBox[] = [];
  const arrows: VArrow[] = [];
  const labels: VLabel[] = [];
  if (nodes.length === 0) {
    labels.push({ x: 20, y: 42, text: "（空链表）", color: "faint" });
    return { width: 220, height: 64, boxes, arrows, labels };
  }
  const GAP = 48;
  let x = 20;
  let maxH = 0;
  const geo: { x: number; y: number; w: number; h: number }[] = [];
  for (const nd of nodes) {
    const lines: Seg[][] = [
      [{ text: `节点 ${nd.index}`, color: "dim" }],
      ...nd.fields.map(
        (f): Seg[] => [
          { text: `${f.label}: `, color: "label" },
          { text: trunc(f.value, 20), color: f.type && /\*\s*$/.test(f.type) ? "accent" : "value" },
        ]
      ),
    ];
    const chars = Math.max(8, ...lines.flat().map((s) => s.text.length));
    const w = clamp(chars * CHAR_W + 26, 130, 280);
    const h = 20 + nd.fields.length * LINE_H + 12;
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
    labels.push({ x: last.x + last.w + 18, y: last.y + last.h / 2 + 4, text: "∅ 空", color: "faint" });
  }
  if (data.cycle) {
    labels.push({ x: 20, y: noteY, text: "↩ 检测到环，已停止遍历", color: "warning" });
    noteY += 16;
  }
  if (data.truncated) {
    labels.push({ x: 20, y: noteY, text: `仅显示前 ${nodes.length} 个节点`, color: "faint" });
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

function computeLayout(data: VizData): Layout {
  if (data.kind === "list") return layoutList(data);
  if (data.kind === "scalar") return layoutScalar(data);
  return layoutElems(data);
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
  vector: "vector",
  array: "数组",
  list: "链表",
  struct: "结构体",
  scalar: "标量",
};

function shortType(t: string): string {
  return t.replace(/\s+/g, " ").trim().length > 48 ? t.replace(/\s+/g, " ").trim().slice(0, 47) + "…" : t.replace(/\s+/g, " ").trim();
}

export function StructVizPanel() {
  const vizData = useIde((s) => s.vizData);
  const vizExpr = useIde((s) => s.vizExpr);
  const vizBusy = useIde((s) => s.vizBusy);
  const closeViz = useIde((s) => s.closeViz);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const layout = useMemo(
    () => (vizData && vizData.kind !== "error" ? computeLayout(vizData) : null),
    [vizData]
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
  const kind = KIND_LABEL[vizData.kind] ?? vizData.kind;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[color:var(--ide-border)]">
        <Network size={12} className="text-[color:var(--ide-accent)] shrink-0" />
        <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase shrink-0">可视化</span>
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
        {vizBusy && <span className="text-[11px] text-[color:var(--ide-warning)] shrink-0">刷新中…</span>}
        <div className="flex-1" />
        <button
          onClick={closeViz}
          className="kimi-pop text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-error)] shrink-0"
          title="关闭可视化"
        >
          <X size={13} />
        </button>
      </div>
      {vizData.kind === "error" ? (
        <div className="flex-1 px-4 py-3 text-[12.5px] text-[color:var(--ide-error)] overflow-auto">⚠ {vizData.error}</div>
      ) : (
        <div
          ref={wrapRef}
          key={`${vizExpr}|${vizData.kind}|${vizData.elems?.length ?? 0}|${vizData.nodes?.length ?? 0}|${vizData.total ?? 0}`}
          className="kimi-tab-fade flex-1 min-h-0 overflow-auto"
        >
          <canvas ref={canvasRef} className="block" />
        </div>
      )}
    </div>
  );
}
