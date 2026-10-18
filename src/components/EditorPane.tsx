import { useMemo, useRef, useEffect, useCallback, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { Loader2, Sparkles, TriangleAlert, Wand2, X, BookOpen, FileCode2 } from "lucide-react";
import {
  EditorView,
  Decoration,
  GutterMarker,
  gutter,
  keymap,
  lineNumbers,
  hoverTooltip,
  drawSelection,
  highlightActiveLine,
  rectangularSelection,
  crosshairCursor,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  EditorState,
  StateField,
  StateEffect,
  RangeSet,
  Prec,
  Compartment,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  codeFolding,
  foldService,
  foldGutter,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxTree,
  ensureSyntaxTree,
} from "@codemirror/language";
import { cpp } from "@codemirror/legacy-modes/mode/clike";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { createPortal } from "react-dom";
import { SearchPanel } from "@/components/SearchPanel";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { useIde } from "@/store";
import { setActiveEditor } from "@/lib/editorRegistry";
import { aiConfigHint, isAiConfigured } from "@/lib/ai";
import {
  buildContextSnippet,
  extractCommentAtLine,
  insertGeneratedCode,
  requestCodeFromComment,
  resolveTargetLineNumber,
  type CommentAnchor,
} from "@/lib/aiGen";
import { editorFlagOn, editorFontFamilyOf, editorFontSizeOf, editorTabSizeOf, fontFamilyToCss, maxUndoStepsOf, themeOf, type Diagnostic, type ThemeName } from "@/types";
import { captureInsertContext, insertCodeAtCursor, type InsertContext } from "@/lib/aiInsert";
import { AiInsertDialog } from "@/components/AiInsertDialog";
import { captureExplainContext, insertExplanationAsComment, type ExplainContext } from "@/lib/aiExplain";
import { AiExplainDialog } from "@/components/AiExplainDialog";
import { AiGhostController } from "@/lib/aiGhost";
import { ghostExtensions, ghostKeymap, setGhostText } from "@/lib/aiInline";
import { snippetCompletionOptions, snippetExtensions, snippetKeymap, tryExpandSnippet } from "@/lib/snippetEditor";
import { api } from "@/lib/api";
import { t, useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// 主题与语法高亮: 不同语法元素以不同颜色区分
// 两套主题（darkTheme / lightTheme）结构逐项对应，用 themeComp 这个 Compartment
// 在 settings.theme 变化时热切换；语法高亮 HighlightStyle 同样一暗一亮的配对。
// 注意：& 的底色必须分别等于 index.css 里 --ide-bg-base 的暗/亮取值，
// 因为 index.css 有一条 `.cm-editor { background-color: var(--ide-bg-base) !important }` 兜底。
// ---------------------------------------------------------------------------
const darkTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#16161e", color: "#c0caf5", fontSize: "13.5px", height: "100%" },
    ".cm-scroller": { fontFamily: "'JetBrains Mono', Consolas, 'Courier New', '微软雅黑', monospace", lineHeight: "1.55" },
    ".cm-content": { caretColor: "#7aa2f7" },
    // 光标加粗：默认 1.6px 细线在括号配对底色/同词标记旁完全不可见（用户反馈看不到光标）
    ".cm-cursor": { borderLeftColor: "#7aa2f7", borderLeftWidth: "2px" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "#16161e",
      color: "#7d87b2",
      border: "none",
      borderRight: "1px solid #1f2335",
    },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", padding: "0 4px 0 6px" },
    ".cm-activeLine": { backgroundColor: "#1f233566" },
    ".cm-activeLineGutter": { backgroundColor: "#1f2335", color: "#c0caf5" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#283457" },
    ".cm-foldPlaceholder": {
      backgroundColor: "#292e42",
      border: "none",
      color: "#7aa2f7",
      padding: "0 6px",
      borderRadius: "3px",
      margin: "0 2px",
      cursor: "pointer",
    },
    ".cm-foldGutter span": { cursor: "pointer", color: "#7d87b2" },
    ".cm-breakpoint-gutter": { width: "20px", cursor: "pointer" },
    ".cm-breakpoint-gutter .cm-gutterElement": {
      padding: "0 3px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    ".cm-bp-dot": { width: "9px", height: "9px", borderRadius: "50%", backgroundColor: "#f7768e" },
    ".cm-debug-line": { backgroundColor: "#22381f !important" },
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "#1a1b26",
      border: "1px solid #292e42",
      color: "#c0caf5",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#283457", color: "#c0caf5" },
    ".cm-completionDetail": { color: "#565f89", fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionIcon": { opacity: 0.7 },
    ".cm-panels": { backgroundColor: "transparent", color: "#c0caf5" },
    ".cm-searchMatch": { backgroundColor: "#3d59a166", outline: "1px solid #3d59a1" },
    ".cm-searchMatch-selected": { backgroundColor: "#3d59a1" },
    ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "2px solid #f7768e66" },
    ".cm-lintRange-warning": { backgroundImage: "none", borderBottom: "2px solid #e0af6866" },
    ".cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltipLint": {
      backgroundColor: "#1a1b26",
      border: "1px solid #292e42",
      color: "#c0caf5",
      padding: "4px 8px",
    },
    ".cm-debug-hover": {
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', '微软雅黑', monospace",
      fontSize: "12px",
      whiteSpace: "pre-wrap",
      maxWidth: "480px",
    },
    ".cm-debug-hover-expr": { color: "#2ac3de" },
    ".cm-debug-hover-value": { color: "#9ece6a" },
    // 配对括号：改透明底 + 浅色描边。原来是实心 #3d59a1 蓝块 + 与光标同色的描边，
    // 光标紧邻括号时被蓝块整个吞掉（用户反馈「光标被括号选中」）
    ".cm-matchingBracket": {
      backgroundColor: "#7aa2f726 !important",
      color: "#e0e8ff !important",
      outline: "1px solid #7aa2f7aa",
      borderRadius: "2px",
    },
    ".cm-nonmatchingBracket": { backgroundColor: "#f7768e44", color: "#f7768e !important" },
    // 划词高亮：覆盖 search 包默认的 #99ff7780 亮绿（暗色主题下刺眼且淹没光标），
    // 换成与主题一致的低饱和蓝
    ".cm-selectionMatch": { backgroundColor: "#7aa2f72b", borderRadius: "2px" },
  },
  { dark: true }
);

/**
 * 亮色主题：与 darkTheme 逐项对应（背景 / 文字 / 光标 / 行号 / 当前行 / 选区 /
 * 折叠占位符 / 断点槽 / 调试行 / 补全与悬浮 tooltip / 搜索面板 / 搜索命中 /
 * lint 下划线 / 匹配与非匹配括号）。
 * 浅底上颜色统一压深，保证对比度：正文 #1f2333（14.2:1）、强调蓝 #2f6fd0（4.4:1）。
 */
const lightTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#f3f4f8", color: "#1f2333", fontSize: "13.5px", height: "100%" },
    ".cm-scroller": { fontFamily: "'JetBrains Mono', Consolas, 'Courier New', '微软雅黑', monospace", lineHeight: "1.55" },
    ".cm-content": { caretColor: "#2f6fd0" },
    ".cm-cursor": { borderLeftColor: "#2f6fd0", borderLeftWidth: "2px" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "#f3f4f8",
      color: "#6e778f",
      border: "none",
      borderRight: "1px solid #e3e6f0",
    },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", padding: "0 4px 0 6px" },
    ".cm-activeLine": { backgroundColor: "#e4ebf9" },
    ".cm-activeLineGutter": { backgroundColor: "#e4ebf9", color: "#1f2333" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#cddcf7" },
    ".cm-foldPlaceholder": {
      backgroundColor: "#e9ecf5",
      border: "none",
      color: "#2f6fd0",
      padding: "0 6px",
      borderRadius: "3px",
      margin: "0 2px",
      cursor: "pointer",
    },
    ".cm-foldGutter span": { cursor: "pointer", color: "#6e778f" },
    ".cm-breakpoint-gutter": { width: "20px", cursor: "pointer" },
    ".cm-breakpoint-gutter .cm-gutterElement": {
      padding: "0 3px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    ".cm-bp-dot": { width: "9px", height: "9px", borderRadius: "50%", backgroundColor: "#c62f4b" },
    ".cm-debug-line": { backgroundColor: "#dff0d8 !important" },
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "#ffffff",
      border: "1px solid #ccd2e1",
      color: "#1f2333",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#d9e4f7", color: "#1f2333" },
    ".cm-completionDetail": { color: "#5d6684", fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionIcon": { opacity: 0.7 },
    ".cm-panels": { backgroundColor: "transparent", color: "#1f2333" },
    ".cm-searchMatch": { backgroundColor: "#3b62c433", outline: "1px solid #3b62c4" },
    // 暗色下命中项底 #3d59a1 与浅色文字对比足够，亮色下必须显式给白字，否则深字压深蓝不可读
    ".cm-searchMatch-selected": { backgroundColor: "#3b62c4", color: "#ffffff" },
    ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "2px solid #c62f4b66" },
    ".cm-lintRange-warning": { backgroundImage: "none", borderBottom: "2px solid #97690b66" },
    ".cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltipLint": {
      backgroundColor: "#ffffff",
      border: "1px solid #ccd2e1",
      color: "#1f2333",
      padding: "4px 8px",
    },
    ".cm-debug-hover": {
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', '微软雅黑', monospace",
      fontSize: "12px",
      whiteSpace: "pre-wrap",
      maxWidth: "480px",
    },
    ".cm-debug-hover-expr": { color: "#0e7a91" },
    ".cm-debug-hover-value": { color: "#2f7d32" },
    // 配对括号：同暗色主题，实心块改透明底 + 浅色描边，避免吞掉光标
    ".cm-matchingBracket": {
      backgroundColor: "#2f6fd01f !important",
      color: "#1f2333 !important",
      outline: "1px solid #2f6fd099",
      borderRadius: "2px",
    },
    ".cm-nonmatchingBracket": { backgroundColor: "#c62f4b26", color: "#c62f4b !important" },
    // 划词高亮：覆盖 search 包默认亮绿，换成与主题一致的淡蓝
    ".cm-selectionMatch": { backgroundColor: "#2f6fd01c", borderRadius: "2px" },
  },
  { dark: false }
);

// 括号彩虹配色（按嵌套深度取色）：用 CSS 变量，跟随亮/暗主题自动切换，
// 因此这段装饰（buildRainbow）不需要随主题重建。
const RAINBOW_VARS = [
  "--ide-rainbow-0",
  "--ide-rainbow-1",
  "--ide-rainbow-2",
  "--ide-rainbow-3",
  "--ide-rainbow-4",
  "--ide-rainbow-5",
];

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#bb9af7" },
  { tag: [tags.string, tags.special(tags.string)], color: "#9ece6a" },
  { tag: [tags.comment, tags.blockComment], color: "#565f89", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "#ff9e64" },
  { tag: [tags.meta], color: "#7dcfff" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "#2ac3de" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#7aa2f7" },
  { tag: [tags.operator, tags.angleBracket], color: "#89ddff" },
  { tag: tags.propertyName, color: "#73daca" },
  { tag: tags.variableName, color: "#c0caf5" },
  { tag: tags.labelName, color: "#e0af68" },
]);

/**
 * 亮色语法高亮：tag 集合与暗色完全一致，仅把颜色压深。
 * 必须单独一套：暗色的 variableName #c0caf5 在浅底上对比度只有 1.1:1（等于看不见）、
 * string #9ece6a 只有 1.7:1、keyword #bb9af7 只有 2.9:1；亮色取值见注释中的对比度。
 */
const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#6d28d9" }, // 6.5:1
  { tag: [tags.string, tags.special(tags.string)], color: "#2f7d32" }, // 4.7:1
  { tag: [tags.comment, tags.blockComment], color: "#5d6684", fontStyle: "italic" }, // 5.2:1
  { tag: [tags.number, tags.bool, tags.null], color: "#b45309" }, // 4.6:1
  { tag: [tags.meta], color: "#0f6f9e" }, // 5.0:1
  { tag: [tags.typeName, tags.className, tags.tagName], color: "#0e7a91" }, // 4.5:1
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#2f6fd0" }, // 4.4:1
  { tag: [tags.operator, tags.angleBracket], color: "#0b6ea8" }, // 5.0:1
  { tag: tags.propertyName, color: "#0d7a72" }, // 4.7:1
  { tag: tags.variableName, color: "#1f2333" }, // 14.2:1
  { tag: tags.labelName, color: "#97690b" }, // 4.4:1
]);

/**
 * 一套主题 = 编辑器外观 + 语法高亮。
 * 两者放进同一个 Compartment，reconfigure 时原子替换，不会出现
 * “亮色底 + 暗色高亮”这类中间态。
 */
function themeExtension(t: ThemeName): Extension {
  return t === "light"
    ? [lightTheme, syntaxHighlighting(lightHighlight)]
    : [darkTheme, syntaxHighlighting(highlight)];
}

/**
 * 编辑器字体 / 字号：装进 Compartment，设置变化时只 reconfigure 这一项，
 * 不重建视图，因此文档、撤销历史、补全状态、断点装饰全部保留。
 * 字号写 editorAttributes（内联样式，优先级高于主题里的 13.5px）；
 * 字体族同时写 scroller / content / gutters —— 两套主题的 .cm-scroller 显式设过字体，
 * 必须让 .cm-content / .cm-gutters 也显式覆盖，才能保证代码区字体真正生效。
 */
function editorFontExtension(family: string, size: number): Extension {
  const cssFamily = fontFamilyToCss(family);
  return [
    EditorView.editorAttributes.of({ style: `font-size:${size}px` }),
    EditorView.theme({
      ".cm-scroller": { fontFamily: cssFamily },
      ".cm-content": { fontFamily: cssFamily },
      ".cm-gutters": { fontFamily: cssFamily },
    }),
  ];
}

/** Tab 宽度：tabSize 控制制表符显示宽度，indentUnit 保证回车自动缩进用同样数量的空格 */
function editorTabExtension(size: number): Extension {
  return [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))];
}

// ---------------------------------------------------------------------------
// {} 折叠: 自定义 foldService, 扫描配对大括号（跳过字符串与注释）
// ---------------------------------------------------------------------------
function findBraceFold(state: EditorState, lineStart: number, lineEnd: number) {
  const line = state.doc.lineAt(lineEnd);
  const text = line.text;
  let openIdx = -1;
  const startCol = Math.max(0, lineStart - line.from);
  for (let i = startCol; i < text.length; i++) {
    if (text[i] === "{") {
      openIdx = i;
      break;
    }
    // 行内已有闭合且没有新打开的 { 则不折叠
    if (text[i] === "}") return null;
  }
  if (openIdx < 0) return null;
  const openPos = line.from + openIdx;
  let depth = 1;
  let inStr: string | null = null;
  let inBlock = false;
  for (let ln = line.number; ln <= state.doc.lines; ln++) {
    const l = state.doc.line(ln);
    const t = l.text;
    let i = ln === line.number ? openIdx + 1 : 0;
    let inLine = false;
    for (; i < t.length; i++) {
      const ch = t[i];
      const next = t[i + 1];
      if (inLine) continue;
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "/" && next === "/") {
        inLine = true;
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlock = true;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const to = l.from + i;
          if (to <= openPos + 1) return null;
          return { from: openPos + 1, to };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 断点
// ---------------------------------------------------------------------------
class BpMarker extends GutterMarker {
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-bp-dot";
    return d;
  }
}
const bpMarker = new BpMarker();

function breakpointGutter(lines: number[], onToggle: (line: number) => void) {
  return gutter({
    class: "cm-breakpoint-gutter",
    markers: (view) => {
      const marks: Range<GutterMarker>[] = [];
      for (const ln of lines) {
        if (ln >= 1 && ln <= view.state.doc.lines) {
          marks.push(bpMarker.range(view.state.doc.line(ln).from));
        }
      }
      return RangeSet.of(marks);
    },
    domEventHandlers: {
      mousedown(view, line) {
        onToggle(view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 调试当前行高亮
// ---------------------------------------------------------------------------
const setDbgLine = StateEffect.define<number | null>();
const dbgLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDbgLine)) {
        const n = e.value;
        deco =
          n == null || n < 1 || n > tr.state.doc.lines
            ? Decoration.none
            : Decoration.set([Decoration.line({ class: "cm-debug-line" }).range(tr.state.doc.line(n).from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// 括号彩虹: 按嵌套深度给 () [] {} 着色（跳过字符串与注释），
// 配对高亮由 bracketMatching + 主题 .cm-matchingBracket 强化
// ---------------------------------------------------------------------------
function buildRainbow(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const marks: Range<Decoration>[] = [];
  const stack: { ch: string; depth: number; len: number }[] = [];
  let inStr: string | null = null;
  let inBlock = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      const depth = stack.length;
      stack.push({ ch, depth, len: marks.length });
      marks.push(
        Decoration.mark({ attributes: { style: `color:var(${RAINBOW_VARS[depth % RAINBOW_VARS.length]}); font-weight:600` } }).range(i, i + 1)
      );
    } else if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{";
      // 回退到匹配的同类开括号
      let k = stack.length - 1;
      while (k >= 0 && stack[k].ch !== open) k--;
      if (k >= 0) {
        const depth = k;
        stack.length = k; // 丢弃未匹配的中间层
        marks.push(
          Decoration.mark({ attributes: { style: `color:var(${RAINBOW_VARS[depth % RAINBOW_VARS.length]}); font-weight:600` } }).range(i, i + 1)
        );
      }
    }
  }
  // 未闭合的开括号去掉着色（保持配对语义清晰）
  const leftover = new Set(stack.map((s) => s.len));
  return Decoration.set(
    marks.filter((_, idx) => !leftover.has(idx)),
    true
  );
}

const rainbowBrackets = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildRainbow(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildRainbow(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);


// ---------------------------------------------------------------------------
// 调试悬浮查看: 停止状态下悬浮变量 → 服务端 -data-evaluate-expression → tooltip
// ---------------------------------------------------------------------------
function extractExprAt(text: string, col: number, side: number): { from: number; to: number; expr: string } | null {
  const isIdCh = (c: string) => !!c && /[A-Za-z0-9_]/.test(c);
  const n = text.length;
  let pos = col;
  // 落在标识符边界时按悬浮方向取一侧
  if (pos >= n || !isIdCh(text[pos])) {
    if (side < 0 && pos > 0 && isIdCh(text[pos - 1])) pos--;
    else if (side > 0 && pos + 1 < n && isIdCh(text[pos + 1])) pos++;
    else return null;
  }
  let s = pos;
  while (s > 0 && isIdCh(text[s - 1])) s--;
  let e = pos;
  while (e < n && isIdCh(text[e])) e++;
  if (!/^[A-Za-z_]/.test(text[s] || "")) return null;
  // 向前吸收 a->b / a.b 成员链
  for (;;) {
    const before = text.slice(Math.max(0, s - 2), s);
    if (before === "->" || (before === "." && !/^\d/.test(text[s] ?? ""))) {
      let ns = s - 2;
      while (ns > 0 && isIdCh(text[ns - 1])) ns--;
      if (ns >= s - 2) break;
      s = ns;
    } else break;
  }
  // 向后吸收简单下标，如 v[0]、m[k]
  if (text[e] === "[") {
    let d = 0;
    for (let i = e; i < n; i++) {
      if (text[i] === "[") d++;
      else if (text[i] === "]") {
        d--;
        if (d === 0) {
          e = i + 1;
          break;
        }
      }
    }
  }
  const expr = text.slice(s, e);
  if (!/^[A-Za-z_]/.test(expr)) return null;
  return { from: s, to: e, expr };
}

const debugHover = hoverTooltip(async (view, pos, side) => {
  const st = useIde.getState();
  if (st.runState !== "debugging" || !st.debugStopped || !st.debugSessionId) return null;
  const line = view.state.doc.lineAt(pos);
  const found = extractExprAt(line.text, pos - line.from, side);
  if (!found) return null;
  let value: string;
  try {
    value = await st.debugEvalExpr(found.expr);
  } catch (e) {
    value = "⚠ " + (e instanceof Error ? e.message : String(e));
  }
  if (!value) value = t("common.emptyValue");
  return {
    pos: line.from + found.from,
    end: line.from + found.to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-debug-hover";
      const name = document.createElement("span");
      name.className = "cm-debug-hover-expr";
      name.textContent = found.expr;
      const val = document.createElement("span");
      val.className = value.startsWith("⚠") ? "text-[color:var(--ide-error)]" : "cm-debug-hover-value";
      val.textContent = value;
      dom.append(name, document.createTextNode(" = "), val);
      return { dom };
    },
  };
});

// ---------------------------------------------------------------------------
// 代码补全: 关键字 + 常用片段 + 当前文档单词 + 头文件
// ---------------------------------------------------------------------------
const KEYWORDS = [
  "auto", "break", "case", "catch", "char", "class", "const", "constexpr", "continue",
  "default", "delete", "do", "double", "else", "enum", "explicit", "extern", "false",
  "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable", "namespace",
  "new", "noexcept", "nullptr", "operator", "private", "protected", "public", "register",
  "reinterpret_cast", "return", "short", "signed", "sizeof", "static", "static_assert",
  "static_cast", "struct", "switch", "template", "this", "throw", "true", "try", "typedef",
  "typeid", "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "while",
];

const BUILTINS: Completion[] = [
  { label: "std", type: "namespace" },
  { label: "cout", type: "variable", detail: "std::cout" },
  { label: "cin", type: "variable", detail: "std::cin" },
  { label: "endl", type: "variable", detail: "std::endl" },
  { label: "string", type: "type" },
  { label: "vector", type: "type" },
  { label: "map", type: "type" },
  { label: "printf", type: "function" },
  { label: "scanf", type: "function" },
  { label: "malloc", type: "function" },
  { label: "free", type: "function" },
  { label: "memcpy", type: "function" },
  { label: "strlen", type: "function" },
  { label: "sort", type: "function", detail: "std::sort" },
];

const HEADERS = [
  "iostream", "vector", "string", "cstdio", "cstring", "cstdlib", "cmath", "algorithm",
  "map", "set", "unordered_map", "unordered_set", "queue", "stack", "deque", "list",
  "memory", "utility", "ctime", "climits", "cstdint", "fstream", "sstream", "iomanip",
  "tuple", "array", "bitset", "numeric", "functional", "stdexcept", "cassert", "cctype",
  "iterator", "random", "chrono", "limits", "thread", "mutex",
];

/**
 * 补全里的代码片段：数据与展开逻辑统一在 src/lib/snippets.ts / snippetEditor.ts。
 * 这里只负责把它们并进本文件补全源；detail 每次请求时现取，切换语言立即生效。
 */
function cppCompletions(context: CompletionContext): CompletionResult | null {
  const includeMatch = context.matchBefore(/#\s*include\s*[<"][^>"]*$/);
  if (includeMatch) {
    const from = includeMatch.from + includeMatch.text.length;
    return {
      from,
      options: HEADERS.map((h) => ({ label: h, type: "namespace" as const })),
      validFor: /^[^>"]*$/,
    };
  }
  const word = context.matchBefore(/[\w#]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const docWords = new Set<string>();
  const re = /[A-Za-z_]\w{2,}/g;
  let m: RegExpExecArray | null;
  const text = context.state.doc.toString();
  while ((m = re.exec(text))) {
    const w = m[0];
    if (!KEYWORDS.includes(w)) docWords.add(w);
  }
  const options: Completion[] = [
    ...KEYWORDS.map((k) => ({ label: k, type: "keyword" as const })),
    ...BUILTINS,
    ...snippetCompletionOptions(),
    ...[...docWords].map((w) => ({ label: w, type: "text" as const })),
    // 去掉与已输入文本完全相同的「回显项」：它来自 docWords（刚打的词已在文档里），
    // 排在第一位会让 Tab/Enter 的 accept 变成肉眼不可见的空操作——用户以为「Tab 没反应」
    // 再按一次，弹窗已关闭，Tab 落回缩进（「按 Tab 在行行首缩进」的元凶之一）。
    // 片段项例外：前缀打全（如 for）时它仍然要留在列表里，选中后展开循环骨架。
  ].filter((o) => o.label !== word.text || o.type === "snippet");
  // 全部选项都被过滤（输入的已是完整关键字/唯一词）：没必要开弹窗
  if (options.length === 0) return null;
  return { from: word.from, options, validFor: /^\w*$/ };
}

// #region 划词相同词高亮：只有标识符/关键字类的完整单词才触发
// 之前直接挂 highlightSelectionMatches()：选中任意文本都会把全文相同串高亮。
// 现在按下面三条收敛（不满足时用 Compartment 把该扩展从配置中摘除）：
//   1. 划选文本必须是一个完整单词 [A-Za-z_][A-Za-z0-9_]*（排除数字、字符串片段、
//      注释内容、运算符、含空格的任意子串）；
//   2. 选区两侧不能还是标识符字符（排除长单词内部的子串，如 count 里的 oun）；
//   3. 用 syntaxTree 取选区处的语法节点，节点范围必须与选区完全一致，且节点类型
//      属于 identifier/keyword/variableName/propertyName/typeName 等；
//      number/string/comment/operator/meta 等一律不通过。
const HL_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HL_ID_CHAR_RE = /[A-Za-z0-9_]/;

// 允许高亮的语法节点基名（忽略 .definition / .standard / .special 等修饰后缀）
const HL_ALLOWED_NODES = new Set([
  "keyword",
  "identifier",
  "variableName",
  "propertyName",
  "definition",
  "typeName",
  "className",
  "namespace",
  "function",
  "labelName",
  "self",
  "atom",
  "constant",
]);

// 明确不高亮的语法节点（数字/字符串/注释/运算符/标点/预处理指令等）
const HL_BLOCKED_NODES = new Set([
  "number",
  "integer",
  "float",
  "string",
  "comment",
  "lineComment",
  "blockComment",
  "docComment",
  "operator",
  "punctuation",
  "bracket",
  "paren",
  "squareBracket",
  "brace",
  "meta",
  "invalid",
  "regexp",
  "attributeName",
  "tagName",
  "heading",
]);

/** 取选区处、且范围与选区完全一致的语法节点（语法树未覆盖或跨节点时返回 null） */
function syntaxNodeExactlyAt(state: EditorState, from: number, to: number) {
  let tree = syntaxTree(state);
  if (tree.length < to) {
    const ensured = ensureSyntaxTree(state, Math.min(state.doc.length, to + 1), 50);
    if (ensured) tree = ensured;
  }
  if (tree.length < to) return null;
  const node = tree.resolveInner(from, 1);
  return node.from === from && node.to === to ? node : null;
}

/** 当前选区是否是一个「可高亮的单词」（标识符/关键字） */
function isHighlightableWordSelection(state: EditorState): boolean {
  const sel = state.selection;
  if (sel.ranges.length !== 1) return false;
  const { from, to } = sel.main;
  if (to - from < 1 || to - from > 200) return false;
  if (!HL_WORD_RE.test(state.sliceDoc(from, to))) return false;
  if (from > 0 && HL_ID_CHAR_RE.test(state.sliceDoc(from - 1, from))) return false;
  if (to < state.doc.length && HL_ID_CHAR_RE.test(state.sliceDoc(to, to + 1))) return false;
  const node = syntaxNodeExactlyAt(state, from, to);
  if (!node) return false; // 语法树无法确认 → 不高亮
  const base = node.name.split(".")[0];
  if (HL_BLOCKED_NODES.has(base)) return false;
  return HL_ALLOWED_NODES.has(base);
}

// 划词高亮 / 括号匹配高亮各自一个 Compartment（开关切换时不重建其它扩展）
const SEL_MATCH_COMP = new Compartment();
const BRACKET_COMP = new Compartment();
// 撤销历史一个 Compartment：最大回退步数可调（只换 history 配置，不动其它扩展）
const HISTORY_COMP = new Compartment();
const SEL_MATCH_ON = highlightSelectionMatches({ wholeWords: true });
const SEL_MATCH_OFF: Extension = [];
const BRACKET_ON = bracketMatching();
const BRACKET_OFF: Extension = [];

// 选区变化时在同一个 dispatch 内决定保留/摘除划词高亮扩展。
// 注意：不能用 ViewPlugin.update 里再 dispatch（CM6 禁止在 update 过程中派发事务），
// transactionExtender 是唯一能在同一事务里追加 reconfigure 的钩子。
const selectionMatchExtender = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged && tr.newSelection.eq(tr.startState.selection)) return null;
  const active = SEL_MATCH_COMP.get(tr.startState) === SEL_MATCH_ON;
  const wanted =
    editorFlagOn(useIde.getState().settings, "highlightSelectionMatches") &&
    isHighlightableWordSelection(tr.state);
  if (wanted === active) return null;
  return { effects: SEL_MATCH_COMP.reconfigure(wanted ? SEL_MATCH_ON : SEL_MATCH_OFF) };
});
// #endregion

// ---------------------------------------------------------------------------
// 从注释生成代码：入口常量（三段核心逻辑在 src/lib/aiGen.ts）
// ---------------------------------------------------------------------------
/**
 * 快捷键选 Ctrl+Alt+G 的原因：Ctrl+/ 已被 CodeMirror defaultKeymap 的
 * toggleComment（注释/取消注释）占用，Ctrl+G 是浏览器「查找下一个」，故另选此键。
 */
const GEN_FROM_COMMENT_KEY = "Mod-Alt-g";
/** 菜单里展示的快捷键文案（Windows 上 Mod = Ctrl） */
const GEN_FROM_COMMENT_LABEL = "Ctrl+Alt+G";
/** 目标行没有可用注释时的统一提示 */
const NO_COMMENT_HINT_KEY = "editor.noCommentHint";

// ---------------------------------------------------------------------------
// AI 插入代码：入口常量（三段核心逻辑在 src/lib/aiInsert.ts）
// ---------------------------------------------------------------------------
/**
 * 快捷键选 Ctrl+Alt+I 的原因：I 是 Insert 的首字母，且不与该编辑器已有的
 * Ctrl+Alt+G（从注释生成）、Ctrl+/（切换注释）、Ctrl+Space（补全）冲突。
 */
const AI_INSERT_KEY = "Mod-Alt-i";
/** 菜单里展示的快捷键文案（Windows 上 Mod = Ctrl） */
const AI_INSERT_LABEL = "Ctrl+Alt+I";

// ---------------------------------------------------------------------------
// AI 解释代码：入口常量（三段核心逻辑在 src/lib/aiExplain.ts）
// ---------------------------------------------------------------------------
/**
 * 快捷键选 Ctrl+Alt+E 的原因：E 是 Explain 的首字母，且与已有的
 * Ctrl+Alt+G（从注释生成）、Ctrl+Alt+I（AI 插入）、Ctrl+/（切换注释）均不冲突。
 */
const EXPLAIN_KEY = "Mod-Alt-e";
/** 菜单里展示的快捷键文案（Windows 上 Mod = Ctrl） */
const EXPLAIN_LABEL = "Ctrl+Alt+E";

// ---------------------------------------------------------------------------
// clang-format 一键格式化：VSCode 惯例 Shift+Alt+F（单事务替换全文，可一次撤销）
// ---------------------------------------------------------------------------
const FORMAT_KEY = "Shift-Alt-f";
const FORMAT_LABEL = "Shift+Alt+F";

/** 服务端 /api/format 错误码 → i18n key（未知码回落到 detail 文本） */
const FORMAT_ERROR_KEYS: Record<string, string> = {
  FORMAT_UNAVAILABLE: "format.errUnavailable",
  FORMAT_TIMEOUT: "format.errTimeout",
  FORMAT_TOO_LARGE: "format.errTooLarge",
  FORMAT_BAD_STYLE: "format.errBadStyle",
  FORMAT_EMPTY: "format.errEmpty",
  FORMAT_NO_FILE: "format.errNoFile",
  FORMAT_INVALID_PATH: "format.errPath",
};

// ---------------------------------------------------------------------------
// 编辑器组件
// ---------------------------------------------------------------------------
export function EditorPane({ file }: { file: string }) {
  const tr = useT();
  const content = useIde((s) => s.contents[file] ?? "");
  // 内容未从磁盘读入前不挂载编辑器：否则 @uiw 的 value 同步会把「整文填充」
  // 记进撤销历史，用户多按几次 Ctrl+Z 会把缓冲区撤成空文档（重做可恢复但易误保存）
  const loaded = useIde((s) => file in s.contents);
  const setContent = useIde((s) => s.setContent);
  const breakpoints = useIde((s) => s.breakpoints[file] ?? EMPTY_LINES);
  const toggleBreakpoint = useIde((s) => s.toggleBreakpoint);
  const problems = useIde((s) => s.problems);
  const debugStopped = useIde((s) => s.debugStopped);
  const saveFile = useIde((s) => s.saveFile);
  const reveal = useIde((s) => s.reveal);
  const clearReveal = useIde((s) => s.clearReveal);
  const fontSize = useIde((s) => editorFontSizeOf(s.settings));
  const fontFamily = useIde((s) => editorFontFamilyOf(s.settings));
  const tabSize = useIde((s) => editorTabSizeOf(s.settings));
  const setFontSize = useIde((s) => s.setEditorFontSize);
  const selMatchOn = useIde((s) => editorFlagOn(s.settings, "highlightSelectionMatches"));
  const bracketMatchOn = useIde((s) => editorFlagOn(s.settings, "highlightBracketPairs"));
  // AI 内联补全开关（默认开；关闭时立即丢弃并中止，且不再排新的请求）
  const ghostEnabled = useIde((s) => editorFlagOn(s.settings, "aiInlineComplete"));
  // 撤销历史最大步数（默认 500；变化时用 Compartment 只换 history 配置）
  const maxUndoSteps = useIde((s) => maxUndoStepsOf(s.settings));
  // 配色方案（缺字段 / 非法值按 dark）
  const theme = useIde((s) => themeOf(s.settings));
  const viewRef = useRef<EditorView | null>(null);
  // 查找替换面板的宿主：CM createPanel 给空 div，React portal 把 SearchPanel 渲染进去
  const [searchHost, setSearchHost] = useState<{ dom: HTMLElement; view: EditorView } | null>(null);
  const fontComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const tabComp = useRef(new Compartment());

  // -------------------------------------------------------------------------
  // 「从注释生成代码」的 UI 编排（三段核心逻辑见 src/lib/aiGen.ts）：
  //   ① extractCommentAtLine 提取注释 → ② requestCodeFromComment 请求 AI
  //   → ③ insertGeneratedCode 插入文本（单事务，可一次撤销）
  // 这里只负责：两个入口（右键菜单 / 快捷键）、生成中状态、中文提示。
  // -------------------------------------------------------------------------
  // 右键菜单状态：记录点击坐标、点击到的行、该行提取出的注释锚点（null = 该行不可用）
  // 以及右键时是否有选区（决定「AI 解释代码」是否可用）。
  const [genMenu, setGenMenu] = useState<{
    x: number;
    y: number;
    line: number;
    anchor: CommentAnchor | null;
    hasSelection: boolean;
  } | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genNotice, setGenNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const genBusyRef = useRef(false);
  // 请求期间用户切走文件时，EditorPane 会按 key 重挂载：用它丢弃迟到的回复
  const genDisposedRef = useRef(false);

  // -------------------------------------------------------------------------
  // 「AI 插入代码」（自然语言加功能）的 UI 编排（核心逻辑见 src/lib/aiInsert.ts）：
  //   ① captureInsertContext 抓现场（光标/选区/文档快照）→ ② AiInsertDialog 里
  //   requestCodeFromInstruction 请求 AI → ③ insertCodeAtCursor 单事务插入光标处。
  // 这里只负责：两个入口（右键菜单项 / Ctrl+Alt+I）与「打开对话框」时抓现场。
  // -------------------------------------------------------------------------
  const [insertCtx, setInsertCtx] = useState<InsertContext | null>(null);

  /** 打开对话框：把此刻的光标 / 选区 / 文档快照固定下来，供插入前校验用 */
  const openInsertDialog = useCallback(() => {
    const view = viewRef.current;
    setGenMenu(null);
    if (!view) return;
    setInsertCtx(captureInsertContext(view.state));
  }, []);

  // 扩展在 useMemo 里只建一次，快捷键处理器经 ref 转发以拿到每次渲染最新的 openInsertDialog
  const openInsertDialogRef = useRef(openInsertDialog);
  openInsertDialogRef.current = openInsertDialog;

  // -------------------------------------------------------------------------
  // 「AI 解释代码」的 UI 编排（核心逻辑见 src/lib/aiExplain.ts）：
  //   ① captureExplainContext 抓选区 + 前后 30 行 → ② AiExplainDialog 里流式请求
  //   → ③ insertExplanationAsComment 单事务把讲解作为 // 注释插到选区上方。
  // 这里只负责：两个入口（右键菜单项 / Ctrl+Alt+E）、无选区提示、打开对话框时抓现场。
  // -------------------------------------------------------------------------
  const [explainCtx, setExplainCtx] = useState<ExplainContext | null>(null);

  /** 打开解释对话框：无选区时只给中文提示，不发请求、不弹窗 */
  const openExplainDialog = useCallback(() => {
    const view = viewRef.current;
    setGenMenu(null);
    if (!view) return;
    const ctx = captureExplainContext(view.state);
    if (!ctx) {
      setGenNotice({ kind: "error", text: t("explain.errNoSelection") });
      return;
    }
    setExplainCtx(ctx);
  }, []);

  const openExplainDialogRef = useRef(openExplainDialog);
  openExplainDialogRef.current = openExplainDialog;

  // -------------------------------------------------------------------------
  // clang-format「格式化文档」：先保存未保存修改（与 Ctrl+S 同一写入通道），
  // 再请求 /api/format；成功后用**单个 CodeMirror 事务**替换全文，
  // 并用 isolateHistory 把它与前后输入隔开 → Ctrl+Z 一次即可完整撤销。
  // -------------------------------------------------------------------------
  const [formatBusy, setFormatBusy] = useState(false);
  const formatBusyRef = useRef(false);

  const runFormat = useCallback(async () => {
    const view = viewRef.current;
    if (!view || formatBusyRef.current) return;
    const before = view.state.doc.toString();
    formatBusyRef.current = true;
    setFormatBusy(true);
    setGenMenu(null);
    try {
      // ① 有未保存修改时先落盘：只写编辑器当前内容，绝不静默丢弃
      if (useIde.getState().dirty[file]) {
        const saved = (await api.writeFile(file, before)) as { ok?: boolean; error?: string };
        if (saved.error) {
          setGenNotice({ kind: "error", text: tr("format.errSave", { detail: saved.error }) });
          return;
        }
        // 保存期间用户继续输入 → 不清理脏标记，也不应用格式化结果
        if (viewRef.current !== view || view.state.doc.toString() !== before) {
          setGenNotice({ kind: "error", text: tr("format.errStale") });
          return;
        }
        useIde.setState((s) => ({ dirty: { ...s.dirty, [file]: false } }));
      }

      // ② 服务端只读工作区文件并返回格式化全文（不写盘）
      const r = await api.formatFile(file);
      if (r.error) {
        const key = r.code ? FORMAT_ERROR_KEYS[r.code] : "";
        setGenNotice({
          kind: "error",
          text: key ? tr(key) : tr("format.errFailed", { detail: r.error }),
        });
        return;
      }
      const formatted = r.content ?? "";
      if (!formatted) {
        setGenNotice({ kind: "error", text: tr("format.errEmpty") });
        return;
      }
      if (viewRef.current !== view) return;
      const current = view.state.doc.toString();
      if (current !== before) {
        // 格式化期间文档被改：放弃结果，避免覆盖用户新输入
        setGenNotice({ kind: "error", text: tr("format.errStale") });
        return;
      }
      if (formatted === current) {
        setGenNotice({ kind: "info", text: tr("format.unchanged") });
        return;
      }
      // ③ 单事务替换全文 + 与前后历史隔离（一次 Ctrl+Z 回到格式化前）
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
        annotations: [isolateHistory.of("full")],
      });
      view.focus();
      setGenNotice({ kind: "info", text: tr("format.done") });
    } catch (e) {
      setGenNotice({
        kind: "error",
        text: tr("format.errFailed", { detail: e instanceof Error ? e.message : String(e) }),
      });
    } finally {
      formatBusyRef.current = false;
      setFormatBusy(false);
    }
  }, [file, tr]);
  const runFormatRef = useRef(runFormat);
  runFormatRef.current = runFormat;

  // 提示条自动消失（错误留更久，便于阅读）
  useEffect(() => {
    if (!genNotice) return;
    const timer = setTimeout(() => setGenNotice(null), genNotice.kind === "error" ? 10_000 : 6_000);
    return () => clearTimeout(timer);
  }, [genNotice]);

  useEffect(
    () => () => {
      genDisposedRef.current = true;
    },
    []
  );

  // 轻量右键菜单：点别处 / Esc / 滚动 / 窗口失焦 都关闭
  useEffect(() => {
    if (!genMenu) return;
    const close = () => setGenMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, [genMenu]);

  /** 两个入口共用的一条龙：提取注释 → 请求 AI → 插入注释行之后 */
  const runGenerate = useCallback(
    async (view: EditorView, lineNumber: number) => {
      if (genBusyRef.current) return; // 生成中忽略重复触发
      // ① 提取注释：非注释行 / 空注释（`//`）一律不触发
      const anchor = extractCommentAtLine(view.state, lineNumber);
      if (!anchor) {
        setGenNotice({ kind: "error", text: t(NO_COMMENT_HINT_KEY) });
        return;
      }
      // 健壮性：AI 未配置时给中文提示，不发请求、不改文档
      const st = useIde.getState();
      if (!isAiConfigured(st.settings)) {
        setGenNotice({ kind: "error", text: aiConfigHint(st.settings) || t("editor.notConfigured") });
        return;
      }
      const context = buildContextSnippet(view.state, anchor);
      genBusyRef.current = true;
      setGenBusy(true);
      setGenNotice(null);
      try {
        // ② 请求 AI：低温 / 30s 超时 / 不带工具；settings 取最新一份
        const res = await requestCodeFromComment({
          settings: useIde.getState().settings,
          file,
          anchor,
          context,
        });
        if (genDisposedRef.current || viewRef.current !== view) return; // 已切换文件：丢弃结果
        if (!res.ok) {
          setGenNotice({ kind: "error", text: res.error });
          return;
        }
        // ③ 插入文本：失败（AI 空内容 / 文档已改动）时文档零改动
        const inserted = insertGeneratedCode(view, anchor, res.code);
        setGenNotice(
          inserted.ok
            ? { kind: "info", text: t("editor.inserted", { count: inserted.lineCount }) }
            : { kind: "error", text: inserted.error }
        );
      } finally {
        genBusyRef.current = false;
        if (!genDisposedRef.current) setGenBusy(false);
      }
    },
    [file]
  );

  // 扩展在 useMemo 里只建一次，处理器经 ref 转发以拿到每次渲染最新的 runGenerate
  const genRef = useRef(runGenerate);
  genRef.current = runGenerate;

  // -------------------------------------------------------------------------
  // AI 内联流式补全（幽灵文本）的接线
  //   核心状态机（防抖 800ms / 节流 ≥3s / 中止 / 丢弃）全在 src/lib/aiGhost.ts；
  //   这里只做三件事：① 把编辑器现场喂给它 ② 把「要显示的文本」转成 CM6 effect
  //   ③ 页面切后台 / 开关关闭 / 组件卸载时让它停下。
  // -------------------------------------------------------------------------
  const ghostCtrlRef = useRef<AiGhostController | null>(null);
  if (ghostCtrlRef.current === null) {
    ghostCtrlRef.current = new AiGhostController({
      file,
      // 每次要用时都重新取现场：文档与光标都可能已经变了
      getState: () => {
        const v = viewRef.current;
        if (!v) return null;
        return { doc: v.state.doc.toString(), cursor: v.state.selection.main.head };
      },
      getSettings: () => useIde.getState().settings,
      // 幽灵文本只走装饰，不写文档；setGhostText("") 即清空
      onGhost: (text) => {
        const v = viewRef.current;
        if (!v) return;
        try {
          v.dispatch({ effects: setGhostText.of(text) });
        } catch {
          /* 视图正在销毁时派发会抛异常：静默忽略（补全失败不该打断任何东西） */
        }
      },
    });
  }

  // 文档变化 → 防抖后触发；光标/选区移动 → 丢弃并中止。
  // 用扩展而不是 React 事件：粘贴、撤销、AI 写回等任何来源的改动都会走到这里。
  // 扩展在编辑器创建时就参与配置，所以只需要一个稳定的实例（useMemo 无依赖）。
  // 注意：开关状态在这里**实时读 store**——extensions 不会因为设置变化而重建，
  // 若缓存 ghostEnabled 就会出现「关了开关还继续补全」的竞态。
  const ghostListener = useMemo(
    () =>
      EditorView.updateListener.of((u: ViewUpdate) => {
        const ctrl = ghostCtrlRef.current;
        if (!ctrl) return;
        // 开关关闭：丢弃幽灵文本并中止在飞请求（下一次 onDocChange 也不会再排期）
        if (!editorFlagOn(useIde.getState().settings, "aiInlineComplete")) {
          ctrl.stop();
          return;
        }
        if (u.docChanged) {
          // 「Tab 接受」写进来的事务带 userEvent "input.complete"：不把它当用户输入重新触发
          ctrl.onDocChange(u.transactions.some((t) => t.isUserEvent("input.complete")));
        }
        else if (u.selectionSet) ctrl.onSelectionMove();
      }),
    []
  );

  // 组件卸载（含切换文件时的 key 重挂载）：中止在飞请求并丢弃幽灵文本
  useEffect(() => {
    const ctrl = ghostCtrlRef.current;
    const view = viewRef.current;
    return () => {
      ctrl?.destroy();
      // 视图已销毁：迟到的增量回调经 getState/onGhost 拿到 null 后直接丢弃
      if (viewRef.current === view) viewRef.current = null;
    };
  }, []);

  // 开关关闭：立刻丢弃幽灵文本并中止在飞请求（不等下一次打字）
  useEffect(() => {
    if (!ghostEnabled) ghostCtrlRef.current?.stop();
  }, [ghostEnabled]);

  // 页面切到后台：丢弃并中止，不在后台白烧 token
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") ghostCtrlRef.current?.onHidden();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /** 打开自定义右键菜单，并把坐标夹到视口内（避免菜单被裁掉；按「四项 + 一行提示」估高 220px） */
  const openGenMenu = useCallback(
    (x: number, y: number, line: number, anchor: CommentAnchor | null, hasSelection: boolean) => {
      setGenMenu({
        x: Math.min(x, Math.max(0, window.innerWidth - 240)),
        y: Math.min(y, Math.max(0, window.innerHeight - 220)),
        line,
        anchor,
        hasSelection,
      });
    },
    []
  );

  /**
   * 入口 a：编辑器右键菜单 —— 拦截 CM 默认菜单，记录点击行并弹出四项：
   * 「格式化文档」（clang-format）、「从注释生成代码」（需该行有 // 注释）、
   * 「AI 解释代码」（需有选区）与「AI 插入代码…」（任意位置可用）。
   * 光标处理：点在**已有选区内**时保留选区（否则「AI 解释代码」右键就会把选区弄丢），
   * 点在选区外才把光标移到点击处——这样「AI 插入代码」的插入点仍是用户点的那一行。
   */
  const genContextMenuExt = useMemo(
    () =>
      EditorView.domEventHandlers({
        contextmenu: (event, view) => {
          event.preventDefault();
          const sel = view.state.selection.main;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? sel.from;
          const line = view.state.doc.lineAt(pos).number;
          const insideSelection = !sel.empty && pos >= sel.from && pos <= sel.to;
          if (!insideSelection && (!sel.empty || sel.head !== pos)) {
            view.dispatch({ selection: { anchor: pos } });
          }
          openGenMenu(
            event.clientX,
            event.clientY,
            line,
            extractCommentAtLine(view.state, line),
            !view.state.selection.main.empty
          );
          return true;
        },
      }),
    [openGenMenu]
  );

  // Ctrl+滚轮缩放字号（写入 settings.editorFontSize，与设置对话框共用同一份值）
  const zoomByWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setFontSize(editorFontSizeOf(useIde.getState().settings) + (e.deltaY < 0 ? 1 : -1));
    },
    [setFontSize]
  );

  // 字体 / 字号通过同一个 compartment 热更新（避免重建全部扩展）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontComp.current.reconfigure(editorFontExtension(fontFamily, fontSize)),
    });
  }, [fontFamily, fontSize]);

  // Tab 宽度热更新：只换 tabSize + indentUnit，不重建视图
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: tabComp.current.reconfigure(editorTabExtension(tabSize)) });
  }, [tabSize]);

  // 亮/暗主题热切换：只 reconfigure themeComp（外观 + 语法高亮一起换），
  // 不重建其它扩展，因此文档、撤销历史、补全状态、断点装饰全部保留，也无需刷新页面。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeComp.current.reconfigure(themeExtension(theme)) });
  }, [theme]);

  // 划词相同词高亮开关：只替换 compartment，即时生效且不影响其它编辑器状态
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const active = SEL_MATCH_COMP.get(view.state) === SEL_MATCH_ON;
    const wanted = selMatchOn && isHighlightableWordSelection(view.state);
    if (active === wanted) return;
    view.dispatch({ effects: SEL_MATCH_COMP.reconfigure(wanted ? SEL_MATCH_ON : SEL_MATCH_OFF) });
  }, [selMatchOn]);

  // 括号匹配高亮开关：同样用 compartment 热更新
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const active = BRACKET_COMP.get(view.state) === BRACKET_ON;
    if (active === bracketMatchOn) return;
    view.dispatch({ effects: BRACKET_COMP.reconfigure(bracketMatchOn ? BRACKET_ON : BRACKET_OFF) });
  }, [bracketMatchOn]);

  // 最大回退步数热更新：只换 history 的配置。
  // 注意：history 的 StateField 身份会随 reconfigure 改变，已打开文件的撤销历史会重置
  // （CodeMirror 没有「截断最旧事件」的 API，这是换上限的固有代价），设置面板里有提示。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: HISTORY_COMP.reconfigure(history({ minDepth: maxUndoSteps })) });
  }, [maxUndoSteps]);

  // 跳转定位（问题列表/断点列表点击后）
  useEffect(() => {
    const view = viewRef.current;
    if (reveal && reveal.file === file && view) {
      if (reveal.line >= 1 && reveal.line <= view.state.doc.lines) {
        const pos = view.state.doc.line(reveal.line).from;
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
      }
      clearReveal();
    }
  }, [reveal, file, clearReveal]);

  const fileProblems = useMemo(
    () =>
      problems.filter(
        (p) => p.file === file || (p.file !== "" && (p.file.endsWith("/" + file) || p.file.split("/").pop() === file.split("/").pop()))
      ),
    [problems, file]
  );

  const debugLine =
    debugStopped && debugStopped.file && (debugStopped.file === file || debugStopped.file.endsWith("/" + file))
      ? debugStopped.line
      : null;

  // 调试行高亮通过 effect 派发（避免重建扩展）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setDbgLine.of(debugLine) });
  }, [debugLine]);

  const onToggle = useCallback(
    (line: number) => toggleBreakpoint(file, line),
    [file, toggleBreakpoint]
  );

  const extensions = useMemo(() => {
    const cmDiags: (CmDiagnostic & { line: number })[] = fileProblems
      .filter((p) => p.line >= 1)
      .map((p) => ({
        line: p.line,
        from: Math.max(0, p.col - 1),
        to: Math.max(0, p.col - 1) + 1,
        severity: p.severity === "error" ? ("error" as const) : p.severity === "warning" ? ("warning" as const) : ("info" as const),
        message: p.hint ? `${p.message}\n💡 ${p.hint}` : p.message,
        source: p.file ? p.file.split("/").pop() : undefined,
      }));
    return [
      lineNumbers(),
      breakpointGutter(breakpoints, onToggle),
      dbgLineField,
      debugHover,
      rainbowBrackets,
      drawSelection(),
      highlightActiveLine(),
      rectangularSelection(),
      crosshairCursor(),
      EditorState.allowMultipleSelections.of(true),
      fontComp.current.of(editorFontExtension(fontFamily, fontSize)),
      StreamLanguage.define(cpp),
      // 撤销历史：minDepth 即「最多保留的事件数」（CM 源码 updateBranch 的超参叫 maxLen），
      // 超出后丢弃最旧的事件；用 Compartment 包起来让步数可调
      HISTORY_COMP.of(history({ minDepth: maxUndoSteps })),
      // Tab 宽度与自动缩进宽度（设置里可调，Compartment 热更新）
      tabComp.current.of(editorTabExtension(tabSize)),
      indentOnInput(),
      BRACKET_COMP.of(bracketMatchOn ? BRACKET_ON : BRACKET_OFF),
      closeBrackets(),
      // 划词高亮由 selectionMatchExtender 按语法节点动态摘除/装回
      SEL_MATCH_COMP.of(selMatchOn ? SEL_MATCH_ON : SEL_MATCH_OFF),
      selectionMatchExtender,
      codeFolding({ placeholderText: "⋯" }),
      foldGutter({ openText: "▾", closedText: "▸" }),
      foldService.of(findBraceFold),
      autocompletion({ override: [cppCompletions], activateOnTyping: true, maxRenderedOptions: 40 }),
      linter(
        (view) => {
          const out: CmDiagnostic[] = [];
          for (const d of cmDiags) {
            if (d.line > view.state.doc.lines) continue;
            const line = view.state.doc.line(d.line);
            const from = Math.min(line.from + d.from, line.to);
            const to = Math.max(from, Math.min(line.from + d.to - 1, line.to));
            out.push({ ...d, from, to });
          }
          return out;
        },
        { delay: 200 }
      ),
      lintGutter(),
      // AI 内联补全：幽灵文本装饰 + Tab/Esc 拦截 + 文档/选区变化监听
      ...ghostExtensions,
      ghostKeymap,
      // 代码片段：占位序列状态 + 主题色描边 + 激活时 Tab/Esc 优先消费
      ...snippetExtensions,
      snippetKeymap,
      ghostListener,
      Prec.highest(
        keymap.of([
          {
            // VSCode 惯例：Shift+Alt+F 格式化当前文档（clang-format）
            key: FORMAT_KEY,
            run: () => {
              void runFormatRef.current();
              return true;
            },
          },
          {
            key: "Mod-s",
            run: () => {
              void saveFile(file);
              return true;
            },
          },
          {
            // 入口 b：快捷键「从注释生成代码」——仅当光标行（或选区首行）有 // 注释时生成
            key: GEN_FROM_COMMENT_KEY,
            run: (view) => {
              const line = resolveTargetLineNumber(view.state);
              if (!extractCommentAtLine(view.state, line)) {
                setGenNotice({ kind: "error", text: t(NO_COMMENT_HINT_KEY) });
                return true;
              }
              void genRef.current(view, line);
              return true;
            },
          },
          {
            // 入口 b2：快捷键「AI 插入代码」——编辑器有焦点时打开对话框（不在编辑器里不抢键）
            key: AI_INSERT_KEY,
            run: (view) => {
              if (!view.hasFocus) return false;
              openInsertDialogRef.current();
              return true;
            },
          },
          {
            // 入口 b3：快捷键「AI 解释代码」——有选区才打开；无选区由 openExplainDialog 给提示
            key: EXPLAIN_KEY,
            run: () => {
              openExplainDialogRef.current();
              return true;
            },
          },
        ])
      ),
      // 补全弹窗键位必须在 indentWithTab 之前：下拉开着时 Tab 接受选中项；
      // 没开时 acceptCompletion 返回 false，接着尝试片段展开；片段也不匹配才落回缩进。
      // 注意：本版 @codemirror/autocomplete 的 completionKeymap 只绑到 Enter（无 Tab），
      // Tab→acceptCompletion 必须显式绑定；片段项用自定义 apply 展开，不依赖内置 snippet 状态。
      // 完整优先级链：AI 幽灵文本（ghostKeymap，Prec.highest）> 补全下拉 > 片段展开 > 缩进。
      // 片段占位序列激活时由 snippetKeymap（Prec.highest）先把 Tab 消费为「跳下一个占位」。
      keymap.of([
        { key: "Tab", run: acceptCompletion },
        { key: "Tab", run: tryExpandSnippet },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      // 查找替换：注册 search() 并替换默认面板（自定义中文 React 面板，见 SearchPanel.tsx）
      search({
        top: true,
        createPanel: (view) => {
          const dom = document.createElement("div");
          queueMicrotask(() => setSearchHost({ dom, view }));
          return {
            dom,
            top: true,
            focus: () => {
              const input = dom.querySelector("input");
              if (input instanceof HTMLInputElement) {
                input.focus();
                input.select();
              }
            },
            destroy: () => setSearchHost(null),
          };
        },
      }),
      // 右键菜单（拦截 CM 默认菜单，见 genContextMenuExt）
      genContextMenuExt,
      // 配色（外观 + 语法高亮）装在 Compartment 里：主题切换只 reconfigure 这一项
      themeComp.current.of(themeExtension(theme)),
    ];
  }, [breakpoints, onToggle, fileProblems, cmDiagKey(fileProblems), file, saveFile, genContextMenuExt, ghostListener]);
  // 注：fontSize / fontFamily / tabSize / selMatchOn / bracketMatchOn / ghostEnabled / theme
  // 故意不放进依赖：它们都由上面的 compartment / effect 热更新，重建全部扩展反而会丢失插件状态。

  // 右键菜单项点击：先关菜单，再走同一条生成流程（锚点已在右键时提取好）
  const runFromGenMenu = () => {
    const view = viewRef.current;
    const menu = genMenu;
    setGenMenu(null);
    if (view && menu) void genRef.current(view, menu.line);
  };

  // -------------------------------------------------------------------------
  // 自动保存：停止输入约 0.8 秒后把当前文件落盘。
  // 开关状态在 onChange 时从 store 现取（不订阅）：避免设置开关本身触发编辑器重渲染；
  // 换文件/卸载时清掉未触发的定时器（关闭标签页走 store.closeFile，会立即保存兜底）。
  // -------------------------------------------------------------------------
  const autoSaveTimer = useRef<number | null>(null);
  const clearAutoSaveTimer = () => {
    if (autoSaveTimer.current !== null) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
  };
  const handleChange = useCallback(
    (val: string) => {
      setContent(file, val);
      if (useIde.getState().settings.autoSave !== true) return;
      clearAutoSaveTimer();
      autoSaveTimer.current = window.setTimeout(() => {
        autoSaveTimer.current = null;
        void useIde.getState().saveFile(file);
      }, 800);
    },
    [file, setContent]
  );
  useEffect(() => clearAutoSaveTimer, [file]);

  return (
    <div className="relative h-full">
      {loaded ? (
      <CodeMirror
        value={content}
        onChange={handleChange}
        extensions={extensions}
        theme="none"
        onCreateEditor={(view) => {
          viewRef.current = view;
          setActiveEditor(view);
          view.dom.addEventListener("wheel", zoomByWheel, { passive: false });
        }}
        // @uiw/react-codemirror 默认给编辑器 prepend 一个 keymap.of([indentWithTab])
        // （indentWithTab  prop 默认为 true）——位置在我们 extensions 之前，优先级更高，
        // Tab 永远先被「缩进」消费，补全接受（completionKeymap/acceptCompletion）轮不到。
        // 缩进键位我们自己绑（见下面 keymap.of 末尾的 indentWithTab），这里必须关掉。
        indentWithTab={false}
        basicSetup={false}
        style={{ height: "100%" }}
      />
      ) : (
        <div className="h-full flex items-center justify-center text-[13px] text-[color:var(--ide-text-faint)]">
          {tr("common.loading")}
        </div>
      )}

      {/* 查找替换面板：React portal 渲染进 CM 提供的宿主 div（位于编辑器顶部） */}
      {searchHost && createPortal(<SearchPanel view={searchHost.view} />, searchHost.dom)}

      {/* 右键菜单：轻量自绘（App 里其余弹层都是 Radix，这里只需要一项，避免多包一层 Provider） */}
      {genMenu && (
        <div
          role="menu"
          aria-label={tr("editor.contextMenu")}
          className="kimi-menu-in fixed z-50 min-w-[208px] py-1 rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)] shadow-2xl"
          style={{ left: genMenu.x, top: genMenu.y }}
          onMouseDown={(e) => e.stopPropagation()} // 别让 document 上的关闭监听吃掉这次点击
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* clang-format：任何时候可用；格式化前自动保存未保存修改 */}
          <button
            role="menuitem"
            onClick={() => void runFormat()}
            disabled={formatBusy}
            title={tr("format.menuTitle")}
            className={`kimi-tab w-full flex items-center gap-2 px-3 py-[6px] text-[12.5px] text-left ${
              formatBusy
                ? "text-[color:var(--ide-text-faint)] cursor-not-allowed"
                : "text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
            }`}
          >
            {formatBusy ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-[color:var(--ide-accent)]" />
            ) : (
              <FileCode2 size={13} className="shrink-0 text-[color:var(--ide-accent)]" />
            )}
            {formatBusy ? tr("format.busy") : tr("format.menu")}
            <span className="ml-auto pl-3 text-[11px] font-mono text-[color:var(--ide-text-faint)]">
              {FORMAT_LABEL}
            </span>
          </button>
          <button
            role="menuitem"
            onClick={runFromGenMenu}
            disabled={!genMenu.anchor || genBusy}
            title={
              genMenu.anchor
                ? tr("editor.genFromCommentTitle", { line: genMenu.line, comment: genMenu.anchor.comment })
                : tr(NO_COMMENT_HINT_KEY)
            }
            className={`kimi-tab w-full flex items-center gap-2 px-3 py-[6px] text-[12.5px] text-left ${
              !genMenu.anchor || genBusy
                ? "text-[color:var(--ide-text-faint)] cursor-not-allowed"
                : "text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
            }`}
          >
            <Sparkles size={13} className="shrink-0 text-[color:var(--ide-purple-bright)]" />
            {tr("editor.genFromComment")}
            <span className="ml-auto pl-3 text-[11px] font-mono text-[color:var(--ide-text-faint)]">
              {GEN_FROM_COMMENT_LABEL}
            </span>
          </button>
          {/* 入口 a2：AI 解释代码——需要选区；无选区时禁用并给 title 提示 */}
          <button
            role="menuitem"
            onClick={openExplainDialog}
            disabled={!genMenu.hasSelection}
            title={genMenu.hasSelection ? tr("editor.explainCodeTitle") : tr("editor.explainNoSelection")}
            className={`kimi-tab w-full flex items-center gap-2 px-3 py-[6px] text-[12.5px] text-left ${
              !genMenu.hasSelection
                ? "text-[color:var(--ide-text-faint)] cursor-not-allowed"
                : "text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
            }`}
          >
            <BookOpen size={13} className="shrink-0 text-[color:var(--ide-purple-bright)]" />
            {tr("editor.explainCode")}
            <span className="ml-auto pl-3 text-[11px] font-mono text-[color:var(--ide-text-faint)]">
              {EXPLAIN_LABEL}
            </span>
          </button>
          {/* 入口 a3：AI 插入代码（自然语言加功能）——任何时候都可用，光标位置即插入点 */}
          <button
            role="menuitem"
            onClick={openInsertDialog}
            title={tr("editor.insertCodeTitle")}
            className="kimi-tab w-full flex items-center gap-2 px-3 py-[6px] text-[12.5px] text-left text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
          >
            <Wand2 size={13} className="shrink-0 text-[color:var(--ide-purple-bright)]" />
            {tr("editor.insertCode")}
            <span className="ml-auto pl-3 text-[11px] font-mono text-[color:var(--ide-text-faint)]">
              {AI_INSERT_LABEL}
            </span>
          </button>
          <div className="px-3 pt-1 pb-[2px] text-[11px] leading-4 text-[color:var(--ide-text-faint)]">
            {genMenu.anchor ? tr("editor.lineComment", { line: genMenu.line, comment: genMenu.anchor.comment }) : tr("editor.noCommentShort")}
          </div>
        </div>
      )}

      {/* 生成中：AI 请求进行中（30s 超时），期间不阻塞编辑 */}
      {genBusy && (
        <div className="kimi-bubble-in pointer-events-none absolute top-2 right-4 z-20 flex items-center gap-2 px-3 py-1.5 rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] text-[12px] text-[color:var(--ide-text-dim)] shadow-lg">
          <Loader2 size={13} className="animate-spin text-[color:var(--ide-purple-bright)]" />
          {tr("editor.generating")}
        </div>
      )}

      {/* 中文提示条：未配置 AI / 失败 / 空注释 / 插入成功；失败一律不改文档 */}
      {genNotice && (
        <div
          className={`kimi-bubble-in absolute bottom-3 right-4 z-20 flex items-start gap-2 max-w-[440px] px-3 py-2 rounded-md border bg-[color:var(--ide-bg-panel)] shadow-lg text-[12px] leading-5 ${
            genNotice.kind === "error"
              ? "border-[color:var(--ide-error-soft)] text-[color:var(--ide-error)]"
              : "border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)]"
          }`}
          role="status"
        >
          {genNotice.kind === "error" ? (
            <TriangleAlert size={13} className="mt-[3px] shrink-0" />
          ) : (
            <Sparkles size={13} className="mt-[3px] shrink-0 text-[color:var(--ide-purple-bright)]" />
          )}
          <span className="whitespace-pre-wrap break-words">{genNotice.text}</span>
          <button
            className="kimi-pop ml-1 mt-[1px] shrink-0 p-[2px] rounded text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            title={tr("editor.closeNotice")}
            onClick={() => setGenNotice(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* 「AI 插入代码」对话框：指令输入 + 上下文说明 + 生成并插入；Esc 关闭、可取消 */}
      <AiInsertDialog
        ctx={insertCtx}
        file={file}
        onInsert={(ctx, code) => insertCodeAtCursor(viewRef.current!, ctx, code)}
        onClose={() => setInsertCtx(null)}
      />

      {/* 「AI 解释代码」对话框：打开即流式请求，解释完成后可插入为 // 注释（单事务可撤销） */}
      <AiExplainDialog
        ctx={explainCtx}
        file={file}
        onInsert={(ctx, markdown) => {
          const view = viewRef.current;
          if (!view) return { ok: false as const, error: tr("explain.errDocChanged") };
          const res = insertExplanationAsComment(view, ctx, markdown);
          if (res.ok) {
            setGenNotice({ kind: "info", text: tr("explain.inserted", { count: res.lineCount }) });
          }
          return res;
        }}
        onClose={() => setExplainCtx(null)}
      />
    </div>
  );
}

const EMPTY_LINES: number[] = [];

function cmDiagKey(diags: Diagnostic[]): string {
  return diags.map((d) => `${d.line}:${d.col}:${d.severity}`).join("|");
}
