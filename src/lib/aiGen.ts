/**
 * 「从注释生成代码」的核心逻辑（零依赖、与 UI 解耦）。
 *
 * 需求：用户写下 `// 快速排序，升序`，在注释行触发命令 → AI 根据注释生成实现 →
 * 插入到该注释行之后的新行。
 *
 * 本文件把整件事拆成**三段互相独立、可单独阅读/测试**的逻辑（硬约束要求可辨）：
 *   ① 提取注释：extractCommentAtLine / resolveTargetLineNumber / buildContextSnippet
 *   ② 请求 AI  ：buildGenMessages / requestCodeFromComment（低温、30s 超时、不带工具）
 *   ③ 插入文本：parseGeneratedCode / reindent / insertGeneratedCode（单个 CodeMirror 事务）
 * UI 侧（src/components/EditorPane.tsx）只负责「取 view → 依次调这三段 → 中文提示」。
 *
 * 失败一律返回中文 error（不抛异常），且**任何失败路径都不改动文档**：
 * 只有 ①② 都成功、且插入前校验过注释行仍然存在，才会派发唯一一个事务。
 */
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { clipBytes, requestChat, type ChatMessage } from "@/lib/ai";
import { t } from "@/lib/i18n";
import type { Settings } from "@/types";

/** 单次生成请求超时：按需求固定 30s（与「AI 一键修复」同一量级） */
export const AI_GEN_TIMEOUT_MS = 30_000;
/** 生成代码要稳定可复现，温度取低值（仅比一键修复的 0.1 略高，给实现留一点自由度） */
export const AI_GEN_TEMPERATURE = 0.15;
/** 注释行前后各取多少行作为上下文（帮助模型判断该生成语句还是函数定义） */
export const GEN_CONTEXT_LINES = 25;
/** 上下文片段的字节上限（约 6KB，控制 token 量） */
export const GEN_CONTEXT_BYTES = 6 * 1024;

/** 一条可用的行注释锚点（三段逻辑之间的数据契约） */
export interface CommentAnchor {
  /** 注释所在行号（1 起） */
  lineNumber: number;
  /** 注释行的缩进原文（空格/Tab），插入的每一行都沿用 */
  indent: string;
  /** `//` 之后去掉首尾空白的需求文本；空注释不会产出锚点 */
  comment: string;
  /** 注释行在文档中的起始位置：等待 AI 期间用户可能编辑文档，插入前用它校验锚点 */
  lineFrom: number;
}

// ===========================================================================
// ① 提取注释
// ===========================================================================

/**
 * 在**行内**定位真正的 `//` 注释起点：跳过字符串/字符字面量与跨行的块注释。
 * 返回 -1 表示本行没有 `//` 注释（整行只是块注释的行也算没有）。
 *
 * 为什么要扫一遍而不是直接 indexOf("//")：`printf("http://x");` 这类字符串里的
 * `//` 会被误当成注释，生成的需求文本就完全跑偏了。
 */
function findLineCommentStart(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++; // 转义字符，跳过下一个字符
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") return i;
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1; // 块注释跨行：本行没有可供生成的 `//` 注释
      i = end + 1; // 跳过整段块注释后继续找后面的 `//`
    }
  }
  return -1;
}

/**
 * 从文档的第 lineNumber 行提取行注释（整行注释 `// xxx` 或行尾注释 `code; // xxx`）。
 * 返回 null 表示这一行不可用：没有 `//`、注释内容为空（`//`、`//   `），或行号越界。
 */
export function extractCommentAtLine(state: EditorState, lineNumber: number): CommentAnchor | null {
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) return null;
  const line = state.doc.line(lineNumber);
  const text = line.text;
  const idx = findLineCommentStart(text);
  if (idx < 0) return null;
  const comment = text.slice(idx + 2).trim();
  if (!comment) return null; // 空注释（`//`）：按需求不触发
  return {
    lineNumber,
    indent: /^[ \t]*/.exec(text)?.[0] ?? "",
    comment,
    lineFrom: line.from,
  };
}

/**
 * 触发命令时要看的目标行：光标所在行，或选区首行（selection.main.from 所在行）。
 */
export function resolveTargetLineNumber(state: EditorState): number {
  const sel = state.selection.main;
  return state.doc.lineAt(sel.from).number;
}

/** 注释行前后各 GEN_CONTEXT_LINES 行，注释行用 `→` 标出，整体按字节截断 */
export function buildContextSnippet(state: EditorState, anchor: CommentAnchor): string {
  const from = Math.max(1, anchor.lineNumber - GEN_CONTEXT_LINES);
  const to = Math.min(state.doc.lines, anchor.lineNumber + GEN_CONTEXT_LINES);
  const parts: string[] = [];
  for (let n = from; n <= to; n++) {
    const text = state.doc.line(n).text;
    parts.push(n === anchor.lineNumber ? `→ ${text}` : `  ${text}`);
  }
  return clipBytes(parts.join("\n"), GEN_CONTEXT_BYTES, 0.5, "注释附近的代码过长");
}

/** 供提示词使用：按扩展名给出语言/文件类型（本 IDE 的编辑器是 C/C++ 系） */
export function languageOf(file: string): string {
  const ext = (file.split(".").pop() || "").toLowerCase();
  if (ext === "c") return "C";
  if (ext === "h") return "C/C++ 头文件";
  if (ext === "hpp" || ext === "hh" || ext === "hxx") return "C++ 头文件";
  return "C++"; // .cpp / .cc / .cxx 及其它一律按 C++ 处理
}

// ===========================================================================
// ② 请求 AI
// ===========================================================================

/** 组装提示词：文件 + 语言 + 上下文 + 注释需求；明确「只输出代码、不要围栏」 */
export function buildGenMessages(anchor: CommentAnchor, file: string, context: string): ChatMessage[] {
  const system = [
    "你是一名严谨的 C/C++ 代码生成助手。用户会给出一份文件、注释所在位置的上下文，以及一条中文注释（即需求）。",
    "请只生成实现该注释所描述功能的代码：",
    "1. 代码要能直接用在注释所在的位置：上下文显示注释在函数体内时给语句，在全局或类作用域时给函数、类型或声明；",
    "2. 使用标准 C++（C++17）；仅在注释位于文件顶部或全局作用域时补上必要的 #include；",
    "3. 不要给每行加公共缩进，直接写代码即可（缩进由调用方按注释行统一处理）；",
    "4. 不要重复注释行本身，不要输出解释文字、不要使用 Markdown 代码块围栏（不要写 ```）；",
    "5. 不要输出测试用例或使用示例；若注释含义不明确，按最常见、最合理的实现生成。",
  ].join("\n");
  const user = [
    `【文件】${file}（语言：${languageOf(file)}）`,
    `【注释所在行】第 ${anchor.lineNumber} 行`,
    "【上下文（→ 标出注释行本身）】",
    "```cpp",
    context,
    "```",
    "【需要实现的需求（来自注释）】",
    anchor.comment,
    "",
    "请输出这段注释对应的代码（不要包含注释行本身，不要解释）。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface GenRequestOptions {
  settings: Settings;
  /** 当前文件的工作区相对路径（只用于提示词，不落盘） */
  file: string;
  anchor: CommentAnchor;
  /** buildContextSnippet 的产物 */
  context: string;
}

export type GenResult = { ok: true; code: string } | { ok: false; error: string };

/**
 * ② 请求 AI：复用 src/lib/ai.ts 的 requestChat（OpenAI 兼容 /chat/completions）。
 * 低温 + 30s 超时 + 不带文件工具（只要一段代码）；任何失败都返回中文 error。
 */
export async function requestCodeFromComment(opts: GenRequestOptions): Promise<GenResult> {
  const { settings, file, anchor, context } = opts;
  const out = await requestChat(settings, buildGenMessages(anchor, file, context), {
    tools: false,
    temperature: AI_GEN_TEMPERATURE,
    timeoutMs: AI_GEN_TIMEOUT_MS,
  });
  if (out.error) return { ok: false, error: out.error };
  const code = parseGeneratedCode(out.message?.content ?? "", anchor.comment);
  if (!code.trim()) {
    return { ok: false, error: t("aiGen.errNoCode") };
  }
  return { ok: true, code };
}

// ===========================================================================
// ③ 插入文本
// ===========================================================================

/** 容忍模型先写一句「代码如下：」再给代码（没有围栏时的兜底） */
const PROSE_LEAD_RE = /^(以下是|下面是|代码如下|生成的?代码|实现代码)[^\n]{0,12}[:：]?\s*$/;

/**
 * 清洗模型回复 → 纯代码文本。
 * 容错：CRLF、Markdown 围栏（取最长的一段）、首尾空行、重复的注释行、一句引导语。
 */
export function parseGeneratedCode(raw: string, comment = ""): string {
  let text = (raw || "").replace(/\r\n?/g, "\n");
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length > 0) {
    // 取最长的围栏块：模型有时先给一小段示例再给真正的实现
    text = blocks.reduce((a, b) => (b.length > a.length ? b : a), "");
  } else {
    // 只有半个围栏（漏写结尾）时的兜底
    text = text.replace(/^\s*```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const lines = text.split("\n");
  // 掐掉首尾空行
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  // 模型偶尔会把注释行原样抄回来，去掉以免重复
  if (comment && lines.length > 0) {
    const first = lines[0].trim();
    if (first === `//${comment}` || first === `// ${comment}`) lines.shift();
  }
  // 去掉「代码如下：」之类的一行引导语（仅当它不可能是代码时）
  if (lines.length > 0 && PROSE_LEAD_RE.test(lines[0].trim())) lines.shift();

  return lines.join("\n");
}

/**
 * 把代码整体平移到注释行的缩进：
 * 先求非空行的最小公共缩进（模型可能自带一层缩进），整体左移后再统一加上注释行缩进，
 * 这样「保持缩进与注释行一致」，而代码内部的相对层级不受影响。
 * 空行输出空串（不留尾随空白）；混用 Tab/空格时按字符数对齐（本 IDE 默认 4 空格）。
 */
export function reindent(code: string, indent: string): string[] {
  const lines = code.split("\n");
  let min = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, /^[ \t]*/.exec(l)?.[0].length ?? 0);
  }
  if (!Number.isFinite(min)) min = 0;
  return lines.map((l) => (l.trim() ? indent + l.slice(min) : ""));
}

export type InsertOutcome =
  | { ok: true; endPos: number; lineCount: number }
  | { ok: false; error: string };

/**
 * ③ 插入文本：把生成结果插到注释行之后的新行。
 *
 * 插入策略（需求 3「自行合理实现并注释说明」）：
 *  · 位置固定为「注释行末尾插入 一个换行 + N 行代码」：不删除、不覆盖任何既有内容，
 *    下一行已有内容时是把它整段下移，绝不吃掉用户的代码；下一行为空行时也保留该空行。
 *  · 缩进：每行统一加上注释行的缩进（见 reindent），空行不留缩进。
 *  · 光标：插入后落在插入内容的末尾（最后一行代码之后），可直接继续输入。
 *  · 可撤销：整次插入只派发**一个** CodeMirror 事务；userEvent 用 "ai.generate"
 *    （非 input.type/delete，见 @codemirror/commands 的 joinableUserEvent 判定），
 *    因此不会与用户之前的输入合并，Ctrl+Z 一次即可整体撤销。
 *
 * 返回 ok:false 时**没有**改动文档：用于「AI 返回空代码」与「等待期间注释行已被改动」两种情况。
 */
export function insertGeneratedCode(view: EditorView, anchor: CommentAnchor, rawCode: string): InsertOutcome {
  const state = view.state;
  const code = parseGeneratedCode(rawCode, anchor.comment);
  if (!code.trim()) return { ok: false, error: t("aiGen.errNoCodeShort") };

  // 锚点校验：请求期间用户可能编辑/删除了那一行，行号会漂移，这里按「位置」重新确认注释还在
  const pos = Math.min(anchor.lineFrom, state.doc.length);
  const line = state.doc.lineAt(pos);
  const now = extractCommentAtLine(state, line.number);
  if (!now || now.comment !== anchor.comment) {
    return { ok: false, error: t("aiGen.errDocChanged") };
  }

  const lines = reindent(code, now.indent);
  const insert = "\n" + lines.join("\n");
  view.dispatch({
    changes: { from: line.to, insert }, // line.to = 注释行末尾（不含换行符）
    selection: { anchor: line.to + insert.length }, // 光标移到插入内容末尾
    scrollIntoView: true,
    userEvent: "ai.generate",
  });
  return { ok: true, endPos: line.to + insert.length, lineCount: lines.length };
}
