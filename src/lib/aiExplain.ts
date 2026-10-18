/**
 * 「AI 解释代码」的核心逻辑（零依赖、与 UI 解耦）。
 *
 * 三段互相独立、可单独阅读：
 *   ① 抓现场：captureExplainContext —— 选区文本（4KB 上限）+ 前后各 30 行上下文
 *   ② 请求 AI：buildExplainMessages / requestExplanation —— 流式 Markdown 讲解
 *   ③ 插入注释：insertExplanationAsComment —— 把讲解变成 // 行注释插到选区上方（单事务）
 *
 * 失败一律返回中文 error（不抛异常），且**任何失败路径都不改动文档**：
 * 只有「AI 配置正常 + 文档在解释期间没有被改过 + 讲解非空」才会派发唯一一个事务。
 */
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { clipBytes, type ChatMessage } from "@/lib/ai";
import { streamChat } from "@/lib/aiStream";
import { languageOf as fileLanguage } from "@/lib/aiGen";
import type { InsertOutcome } from "@/lib/aiGen";
import { t } from "@/lib/i18n";
import { languageOf as uiLanguage, type Settings } from "@/types";

/** 选区文本的字节上限：按需求固定 4KB（中文按 3 字节算，避免按字符切片超限） */
export const EXPLAIN_SELECTION_BYTES = 4 * 1024;
/** 选区前后各取多少行作为上下文 */
export const EXPLAIN_CONTEXT_LINES = 30;
/** 上下文片段的字节上限（控制 token 量；正常代码远小于此值） */
export const EXPLAIN_CONTEXT_BYTES = 16 * 1024;
/** 讲解放宽超时：解释通常比生成代码长，给 60 秒；中途可随时关闭中止 */
export const EXPLAIN_TIMEOUT_MS = 60_000;
/** 讲解温度：0.3，允许一点表述自由度，但仍保持技术准确 */
export const EXPLAIN_TEMPERATURE = 0.3;

/** 打开对话框时冻结的现场：等待 AI 期间用它校验「文档是否被改过」 */
export interface ExplainContext {
  /** 选区起点（插入注释时以它所在行为锚点） */
  from: number;
  /** 选区终点 */
  to: number;
  /** 触发时的文档快照：用于插入前校验文档未变 */
  doc: string;
  /** 触发时的文档长度（与 doc.length 一致，快速比对用） */
  docLength: number;
  /** 选区首行行号（1 起） */
  startLine: number;
  /** 选区末行行号（1 起） */
  endLine: number;
  /** 发给 AI 的选区文本（最多 4KB，可能带截断说明） */
  selectionText: string;
  /** 选区前后各 30 行上下文，选中行用 → 标出（按字节上限兜底截断） */
  contextText: string;
  /** 选区文本是否因为超过 4KB 被截断 */
  selectionTruncated: boolean;
}

// ===========================================================================
// ① 抓现场
// ===========================================================================

/**
 * 抓取一次解释请求的现场。
 * 无选区（或选区只有空白）返回 null —— 调用方据此禁用菜单项 / 给中文提示。
 */
export function captureExplainContext(state: EditorState): ExplainContext | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  const rawSelection = state.sliceDoc(sel.from, sel.to);
  if (!rawSelection.trim()) return null;

  const startLine = state.doc.lineAt(sel.from).number;
  const endLine = state.doc.lineAt(sel.to).number;
  const selectionBytes = new TextEncoder().encode(rawSelection).length;
  const selectionTruncated = selectionBytes > EXPLAIN_SELECTION_BYTES;
  const selectionText = clipBytes(rawSelection, EXPLAIN_SELECTION_BYTES, 0.5, "选中的代码过长");

  // 上下文：选区前后各 30 行；选中行用 → 标出，便于模型对齐「讲解的是哪一段」
  const fromLine = Math.max(1, startLine - EXPLAIN_CONTEXT_LINES);
  const toLine = Math.min(state.doc.lines, endLine + EXPLAIN_CONTEXT_LINES);
  const parts: string[] = [];
  for (let n = fromLine; n <= toLine; n++) {
    const text = state.doc.line(n).text;
    parts.push(n >= startLine && n <= endLine ? `→ ${text}` : `  ${text}`);
  }
  const contextText = clipBytes(parts.join("\n"), EXPLAIN_CONTEXT_BYTES, 0.5, "选区附近的代码过长");

  return {
    from: sel.from,
    to: sel.to,
    doc: state.doc.toString(),
    docLength: state.doc.length,
    startLine,
    endLine,
    selectionText,
    contextText,
    selectionTruncated,
  };
}

// ===========================================================================
// ② 请求 AI（流式）
// ===========================================================================

/**
 * 组装提示词：要求用界面语言（中文 / 英文）做初学者友好的讲解，
 * 覆盖「整体做什么 / 逐行逐块 / 关键语法点」，且只输出讲解 Markdown。
 */
export function buildExplainMessages(file: string, ctx: ExplainContext, lang: "zh-CN" | "en-US"): ChatMessage[] {
  const english = lang === "en-US";
  const system = english
    ? [
        "You are a patient C++ programming tutor for beginners. The user selects a piece of C/C++ code for you to explain.",
        "Explain in beginner-friendly English, covering:",
        "1. What this code does overall (summarize in one or two sentences);",
        "2. A line-by-line or block-by-block walkthrough in execution order (variables, control flow, input/output, data structures);",
        "3. The key syntax points involved (types, scope, references, pointers, templates, STL, etc.) and anything beginners often confuse.",
        "Output only the explanation as Markdown. Do NOT rewrite the code, do NOT wrap the whole answer in a ``` code fence, and do NOT output a modified version of the code.",
        "Use inline `code` for identifiers when helpful. Keep headings and lists concise, and use short paragraphs.",
      ].join("\n")
    : [
        "你是一名耐心的 C++ 编程入门讲师。用户会选中一段 C/C++ 代码请你讲解。",
        "请用初学者友好的中文讲解，覆盖：",
        "1. 这段代码整体做什么（用一两句话概括）；",
        "2. 按执行顺序逐行或逐块解释（变量、控制流、输入输出、数据结构都要讲清楚）；",
        "3. 指出其中的关键语法点（类型、作用域、引用、指针、模板、STL 等）以及初学者容易混淆的地方。",
        "只输出 Markdown 讲解，不要重写代码，不要用 ``` 代码块包裹整段回答，不要输出改写后的代码。",
        "需要时可用行内 `code` 标注标识符；标题和列表保持简洁，段落不要过长。",
      ].join("\n");

  const header = english
    ? [
        `[File] ${file} (language: ${fileLanguage(file)})`,
        `[Selected code] lines ${ctx.startLine}-${ctx.endLine}${ctx.selectionTruncated ? " (truncated to 4 KB)" : ""}`,
      ]
    : [
        `【文件】${file}（语言：${fileLanguage(file)}）`,
        `【选中的代码】第 ${ctx.startLine}-${ctx.endLine} 行${ctx.selectionTruncated ? "（超过 4KB，已截断）" : ""}`,
      ];
  const contextTitle = english
    ? `[Context] ${EXPLAIN_CONTEXT_LINES} lines before and after the selection (→ marks the selected lines)`
    : `【上下文】选区前后各 ${EXPLAIN_CONTEXT_LINES} 行（→ 标出选中的行）`;
  const task = english
    ? "Explain the selected code for a beginner. Output only the Markdown explanation."
    : "请为初学者讲解选中的代码，只输出 Markdown 讲解。";
  const user = [...header, "```cpp", ctx.selectionText, "```", contextTitle, "```cpp", ctx.contextText, "```", task].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 清洗流式结果：去掉模型偶尔套在整段回答外面的 Markdown 围栏，并掐掉首尾空行。
 * 注意只处理「第一行是 ``` / ```markdown / ```md」的外层围栏，
 * 回答内部正常的代码围栏不会被误删。
 */
export function cleanExplanation(raw: string): string {
  let text = (raw || "").replace(/\r\n?/g, "\n").trim();
  const firstNl = text.indexOf("\n");
  const firstLine = (firstNl >= 0 ? text.slice(0, firstNl) : text).trim();
  if (firstNl >= 0 && /^```(?:markdown|md)?$/i.test(firstLine)) {
    text = text.slice(firstNl + 1);
    if (/\n?```\s*$/.test(text)) text = text.replace(/\n?```\s*$/, "");
  }
  return text.trim();
}

export interface ExplainRequestOptions {
  settings: Settings;
  /** 当前文件的工作区相对路径（只用于提示词，不落盘） */
  file: string;
  /** captureExplainContext 的产物 */
  ctx: ExplainContext;
  /** 调用方的取消信号（关闭对话框 / Esc / 切换文件时中止） */
  signal?: AbortSignal;
  /** 每收到一段增量回调一次（对话框据此流式渲染 Markdown） */
  onDelta?: (text: string) => void;
}

/**
 * ② 请求 AI：复用 aiStream.streamChat（SSE / 可中止 / 60s 超时）。
 * 任何失败都返回中文 error，绝不抛异常；返回的 text 已做外层围栏清洗。
 */
export async function requestExplanation(
  opts: ExplainRequestOptions
): Promise<{ text: string; error?: string }> {
  const { settings, file, ctx, signal, onDelta } = opts;
  const out = await streamChat({
    settings,
    messages: buildExplainMessages(file, ctx, uiLanguage(settings)),
    temperature: EXPLAIN_TEMPERATURE,
    timeoutMs: EXPLAIN_TIMEOUT_MS,
    signal,
    onDelta,
  });
  const text = cleanExplanation(out.text);
  if (out.error) return { text, error: out.error };
  if (!text.trim()) return { text: "", error: t("explain.errEmpty") };
  return { text };
}

// ===========================================================================
// ③ 插入为 // 行注释（单事务）
// ===========================================================================

/** 把 Markdown 讲解逐行变成 `// ` 注释（空行变成 `//`），并沿用选区首行的缩进 */
export function buildCommentLines(markdown: string, indent: string): string[] {
  const lines = cleanExplanation(markdown).split("\n");
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map((line) => (line.trim() ? `${indent}// ${line}` : `${indent}//`));
}

/**
 * ③ 把讲解作为 // 行注释插入到**选区首行上方**。
 *
 *  · 单事务：插入所有注释行 + 光标落到注释块末尾，一次 Ctrl+Z 整体撤销；
 *  · userEvent 用 "ai.explain"（非 input.type/delete），不会和用户之前的输入合并；
 *  · 插入前校验文档内容 / 长度与打开对话框时完全一致；不一致返回中文错误、文档零改动；
 *  · 返回值复用 aiGen.InsertOutcome 协议（ok:false 时文档零改动）。
 */
export function insertExplanationAsComment(
  view: EditorView,
  ctx: ExplainContext,
  markdown: string
): InsertOutcome {
  const text = cleanExplanation(markdown);
  if (!text.trim()) return { ok: false, error: t("explain.errEmpty") };

  const state = view.state;
  if (state.doc.length !== ctx.docLength || state.doc.toString() !== ctx.doc) {
    return { ok: false, error: t("explain.errDocChanged") };
  }

  const line = state.doc.lineAt(Math.min(ctx.from, state.doc.length));
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
  const comments = buildCommentLines(text, indent);
  const insert = comments.join("\n") + "\n";
  const endPos = line.from + insert.length;
  view.dispatch({
    changes: { from: line.from, insert },
    selection: { anchor: endPos },
    scrollIntoView: true,
    userEvent: "ai.explain",
  });
  return { ok: true, endPos, lineCount: comments.length };
}
