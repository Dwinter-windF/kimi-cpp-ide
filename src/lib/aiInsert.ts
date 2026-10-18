/**
 * 「自然语言加功能」（AI 插入代码）的核心逻辑（零依赖、与 UI 解耦）。
 *
 * 场景：用户在编辑器里说一句「给这个类加一个打印函数」，AI 结合当前文件上下文
 * 生成代码，**插入到当前光标处**（有选区时替换选区）。
 *
 * ── 与 src/lib/aiGen.ts（从注释生成代码）的关系：复用，不复制第二份 ──────────────
 * 两者只有「触发口径」不同（注释锚点 vs 光标位置），而「请求 AI → 清洗 → 重排缩进 →
 * 单事务插入 → 光标落点」是同一件事，因此这里**直接复用 aiGen 的导出**：
 *   · AI_GEN_TIMEOUT_MS / AI_GEN_TEMPERATURE —— 同一套 30s 超时与低温取值（需求要求 ≈0.2）；
 *   · parseGeneratedCode —— 剥 Markdown 围栏（多块取最长）/ 首尾空行 / 「代码如下：」引导语，
 *                            并把模型抄回来的那一行去掉（这里把用户指令当 comment 传入，
 *                            因为模型同样可能把指令原样抄成一行注释）；
 *   · reindent            —— 求最小公共缩进后整体平移到目标缩进；
 *   · languageOf          —— 按扩展名给出 C/C++ 语言名；
 *   · InsertOutcome       —— 复用同一套「成功/失败」返回协议（ok:false 时文档零改动）；
 *   · 另复用 src/lib/ai.ts 的 requestChat / clipBytes / isAiConfigured。
 * 只有「插入位置」这一段无法复用：insertGeneratedCode 的落点是**注释行之后**、校验的是
 * 注释锚点；光标插入没有锚点，要落到**光标处**并校验光标/文档未变，故新增
 * insertCodeAtCursor（同样的单事务 + userEvent:"ai.insert" + 光标移到插入内容末尾）。
 *
 * 失败一律返回中文 error（不抛异常），且**任何失败路径都不改动文档**：
 * 只有「AI 已配置 + 指令非空 + 请求成功 + 解析出代码 + 插入前校验通过」才派发唯一一个事务。
 */
import type { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { clipBytes, isAiConfigured, requestChat, type ChatMessage } from "@/lib/ai";
import {
  AI_GEN_TEMPERATURE,
  AI_GEN_TIMEOUT_MS,
  languageOf,
  parseGeneratedCode,
  reindent,
  type InsertOutcome,
} from "@/lib/aiGen";
import { t } from "@/lib/i18n";
import type { Settings } from "@/types";

/** 请求前抓取的编辑器现场：光标位置 / 选区 / 文档快照。等待 AI 期间用它校验「光标或文件是否变了」 */
export interface InsertContext {
  /** 触发时的光标（选区头）位置 */
  cursor: number;
  /** 选区两端（from === to 表示没有选中内容，纯光标插入） */
  selFrom: number;
  selTo: number;
  /** 触发时的文档快照：既用于生成上下文，也用于插入前确认「文件没被改过」 */
  doc: string;
  /** 触发时的文档长度（与 doc.length 一致，放在这里便于校验时快速比对） */
  docLength: number;
}

export type InsertRequestResult = { ok: true; code: string } | { ok: false; error: string };
/** 插入结果：与 aiGen.InsertOutcome 同一套协议（ok:false 时文档零改动） */
export type InsertResult = InsertOutcome;

/**
 * 发送给 AI 的「当前文件」字节上限（约 12KB，中文按 3 字节算，约 4K token 量级）。
 * 小文件（绝大多数源文件）永远走原文、不截断——文件树里的样例都是这个量级。
 */
export const INSERT_CONTEXT_BYTES = 12 * 1024;
/** 大文件截断时保住「光标附近」的行数：上下各 60 行（需求 1 的「上下文行数上限说明」） */
export const INSERT_CONTEXT_LINES = 60;
/** 上下文说明文案（渲染在对话框里，让用户知道 AI 看到的是什么范围） */
export function contextScopeHint(): string {
  return t("aiInsert.contextScope", { lines: INSERT_CONTEXT_LINES });
}

// ===========================================================================
// ① 抓取现场 + 组装上下文
// ===========================================================================

/**
 * 请求前抓一次现场。**对话框打开时抓**，因此用户在对话框里打字、点按钮都不影响它。
 */
export function captureInsertContext(state: EditorState): InsertContext {
  const sel = state.selection.main;
  return {
    cursor: sel.head,
    selFrom: sel.from,
    selTo: sel.to,
    doc: state.doc.toString(),
    docLength: state.doc.length,
  };
}

/** 光标在第几行（1 起）：用于在上下文里标出插入点 */
function cursorLineNumber(ctx: InsertContext): number {
  return ctx.doc.slice(0, Math.min(ctx.cursor, ctx.doc.length)).split("\n").length;
}

/** 整篇上下文：光标所在行尾加 `⟪光标⟫` 标记，让模型知道代码要「长」在哪里 */
function markCursorLine(text: string): string {
  return `${text}  ⟪光标⟫`;
}

/**
 * 生成上下文的截断策略（需求 2「自行定策略并注释说明」）：
 *   1. 文档整体（含光标标记）不超过 INSERT_CONTEXT_BYTES → 发全文，truncated=false；
 *   2. 超过 → 只取**光标所在行上下各 INSERT_CONTEXT_LINES 行**（光标是插入点，附近的类/函数
 *      定义才是「这个类」的判定依据），再按字节上限 clipBytes 兜底截断，truncated=true；
 *   3. 大文件时在开头写明「原文件共 N 行，这里只有第 from-to 行」，避免模型误以为这就是全文。
 * 返回值里的 truncated 供对话框显示中文说明（用户可见，避免误解 AI 看到了全文）。
 */
export function buildInsertContext(ctx: InsertContext, file: string): { text: string; truncated: boolean } {
  const lines = ctx.doc.split("\n");
  const cursorLine = cursorLineNumber(ctx);
  // 全文：只需在光标那一行尾打标记
  const full = lines.map((l, i) => (i + 1 === cursorLine ? markCursorLine(l) : l)).join("\n");
  if (new TextEncoder().encode(full).length <= INSERT_CONTEXT_BYTES) {
    return { text: full, truncated: false };
  }

  const from = Math.max(1, cursorLine - INSERT_CONTEXT_LINES);
  const to = Math.min(lines.length, cursorLine + INSERT_CONTEXT_LINES);
  const body = lines.slice(from - 1, to).map((l, i) => (from + i === cursorLine ? markCursorLine(l) : l)).join("\n");
  const head = `…（${file} 共 ${lines.length} 行，以下只截取第 ${from}-${to} 行）…\n`;
  return {
    text: head + clipBytes(body, INSERT_CONTEXT_BYTES, 0.5, "光标附近代码过长"),
    truncated: true,
  };
}

/**
 * 组装提示词：文件 + 语言 + 上下文 + 用户指令。
 * 明确「只输出代码、不要解释、不要 Markdown 围栏、不要重复指令」——与从注释生成同一套口径。
 */
export function buildInsertMessages(file: string, context: string, instruction: string): ChatMessage[] {
  const system = [
    "你是一名严谨的 C/C++ 代码生成助手。用户会给出一份文件、光标所在的上下文，以及一句自然语言指令。",
    "请只生成要插入到光标处的代码：",
    "1. 代码要能直接用在光标所在的位置：光标在函数体内时给语句，在类作用域时给成员函数，在全局作用域时给函数或声明；",
    "2. 使用标准 C++（C++17）；只有确实需要且文件里没有时才补 #include；",
    "3. 保持与周围代码一致的风格（命名、缩进；注释用中文）；",
    "4. 不要给每行加公共缩进（缩进由调用方按光标所在行处理）；不要重复用户指令，不要输出解释文字，",
    "   不要使用 Markdown 代码块围栏（不要写 ```），不要输出测试用例或使用示例；",
    "5. 指令含义不明确时按最常见、最合理的实现生成。",
  ].join("\n");
  const user = [
    `【文件】${file}（语言：${languageOf(file)}）`,
    "【上下文（⟪光标⟫ 标出插入点）】",
    "```cpp",
    context,
    "```",
    "【用户指令】",
    instruction,
    "",
    "请只输出要插入到光标处的代码（不要解释、不要围栏）。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ===========================================================================
// ② 请求 AI
// ===========================================================================

export interface InsertRequestOptions {
  settings: Settings;
  /** 当前文件的工作区相对路径（只用于提示词，不落盘） */
  file: string;
  /** buildInsertContext 的产物 */
  context: string;
  instruction: string;
  /** 调用方的取消信号（对话框的「取消」/ Esc / 卸载都会中止它） */
  signal?: AbortSignal;
}

/**
 * ② 请求 AI：复用 src/lib/ai.ts 的 requestChat（OpenAI 兼容 /chat/completions）。
 * 低温（AI_GEN_TEMPERATURE=0.15，与需求 ≈0.2 同一量级）+ 30s 超时 + 不带文件工具；
 * 任何失败都返回中文 error，绝不抛异常。
 *
 * 注意：**指令为空 / AI 未配置在这里就返回失败，绝不发请求**（需求 4）。
 */
export async function requestCodeFromInstruction(opts: InsertRequestOptions): Promise<InsertRequestResult> {
  const { settings, file, context, instruction, signal } = opts;
  const text = instruction.trim();
  if (!text) return { ok: false, error: t("aiInsert.errEmptyInstruction") };
  if (!isAiConfigured(settings)) {
    return { ok: false, error: t("aiInsert.errNotConfigured") };
  }
  const out = await requestChat(settings, buildInsertMessages(file, context, text), {
    tools: false,
    temperature: AI_GEN_TEMPERATURE,
    timeoutMs: AI_GEN_TIMEOUT_MS,
    signal,
  });
  if (out.error) return { ok: false, error: out.error };
  // 清洗：复用 aiGen.parseGeneratedCode（剥围栏/引导语/首尾空行，并把模型抄回来的指令行去掉）
  const code = parseGeneratedCode(out.message?.content ?? "", text);
  if (!code.trim()) {
    return { ok: false, error: t("aiInsert.errNoCode") };
  }
  return { ok: true, code };
}

// ===========================================================================
// ③ 插入文本（光标处，单事务）
// ===========================================================================

/**
 * ③ 插入文本：把生成结果插到**触发时的光标处**（触发时有选区则替换该选区）。
 *
 * 插入策略：
 *  · 有选区 → 用生成代码替换选区（「把选中的这段改成…」这类指令才符合直觉），
 *    替换后按选区所在行的缩进重排；
 *  · 无选区 → 纯插入，不删除任何既有字符：
 *      - 多行代码：代码块单独占行——块前补换行（光标已在行首时不用补）、
 *        块后再补换行（光标已在行尾时不用补），代码整体按**光标所在行的缩进**重排；
 *          例：光标在 `    return 0;` 行首且缩进 4 空格 → 插入 `\n    <代码>\n    return 0;`；
 *          例：光标在 `    foo();|` 行尾 → 插入 `\n    <代码>`，下方内容原样保留；
 *      - 单行代码：直接就地插入（不补换行、不动缩进），例如在语句中间补 `std::cout << x;`
 *        ——只有单行插入才可能把光标后的文字接到同一行，这正符合「补一句」的预期。
 *  · 光标：插入后落在插入内容的末尾，可直接继续输入；scrollIntoView 保证可见。
 *  · 可撤销：整次插入只派发**一个** CodeMirror 事务，userEvent 用 "ai.insert"
 *    （非 input.type/delete，见 @codemirror/commands 的 joinableUserEvent 判定），
 *    因此不会与用户之前的输入合并，Ctrl+Z 一次即可整体撤销。
 *
 * 插入前校验（需求 3）：文档内容 / 长度 / 光标位置 / 选区任一与触发时不一致 → 返回中文错误、
 * **不改动文档**（避免把代码插到用户已经改过的位置）。
 * 返回 ok:false 时文档零改动：用于「AI 返回空代码」「等待期间光标或文档变了」。
 */
export function insertCodeAtCursor(view: EditorView, ctx: InsertContext, rawCode: string): InsertOutcome {
  const built = buildInsertTransaction(view.state, ctx, rawCode);
  if (!built.tr) return built.outcome;
  view.dispatch(built.tr);
  return built.outcome;
}

/**
 * 插入事务的构造（无副作用）：只依赖 EditorState + rawCode，因此可在无 DOM 的测试里直接调用；
 * insertCodeAtCursor 只是它 + view.dispatch 的薄包装。逻辑见上面 insertCodeAtCursor 的注释。
 */
export function buildInsertTransaction(
  state: EditorState,
  ctx: InsertContext,
  rawCode: string
): { outcome: InsertOutcome; tr: Transaction | null } {
  const code = parseGeneratedCode(rawCode);
  if (!code.trim()) {
    return { outcome: { ok: false, error: t("aiInsert.errNoCodeShort") }, tr: null };
  }

  // 校验 1：文档未被改动（内容 + 长度双保险，长度比对是为了快速短路）
  if (state.doc.length !== ctx.docLength || state.doc.toString() !== ctx.doc) {
    return {
      outcome: { ok: false, error: t("aiInsert.errDocChanged") },
      tr: null,
    };
  }
  // 校验 2：光标 / 选区未变（用户没点别处，也没重新划选）
  const sel = state.selection.main;
  if (sel.head !== ctx.cursor || sel.from !== ctx.selFrom || sel.to !== ctx.selTo) {
    return {
      outcome: { ok: false, error: t("aiInsert.errCursorMoved") },
      tr: null,
    };
  }

  // 缩进一律跟随光标所在行（替换选区时也跟随，避免把选中的缩进吃掉）
  const indent = /^[ \t]*/.exec(state.doc.lineAt(ctx.cursor).text)?.[0] ?? "";
  const reindented = reindent(code, indent);
  /** 块（单独占行）：多行代码，或替换选区 */
  const replacing = ctx.selTo > ctx.selFrom;
  const multiline = reindented.length > 1;
  const block = multiline || replacing;
  // 块才按行重排缩进；单行就地插入不加缩进（否则会在句子中间凭空多出空格）
  const body = block ? reindented.join("\n") : code;

  /**
   * 块前 / 块后是否需要补换行（都不补时就是「就地插入」）：
   *  · 无选区：只有**多行代码**才有块的概念——光标不在行首才补前换行、不在行尾才补后换行，
   *    这样块恰好单独占一行，也不会在文档末尾多出空行；单行代码一律就地插入。
   *  · 有选区（替换）：只有选区**没有覆盖整行**时才补换行把代码顶成单独的行，
   *    整行选中（如删掉一整条语句）直接替换，不产生多余空行。
   */
  const startLine = state.doc.lineAt(ctx.selFrom);
  const endLine = state.doc.lineAt(ctx.selTo);
  const coversLineStart = replacing ? ctx.selFrom === startLine.from : false;
  const coversLineEnd = replacing ? ctx.selTo === endLine.to : false;
  const lead = replacing
    ? coversLineStart
      ? ""
      : "\n"
    : multiline && ctx.selFrom > 0 && ctx.selFrom !== startLine.from
      ? "\n"
      : "";
  const trail = replacing
    ? coversLineEnd || ctx.selTo >= state.doc.length
      ? ""
      : "\n"
    : multiline && ctx.selTo < state.doc.length && ctx.selTo !== endLine.to
      ? "\n"
      : "";
  const insert = lead + body + trail;
  const endPos = ctx.selFrom + insert.length;
  const lineCount = body.split("\n").length;

  return {
    outcome: { ok: true, endPos, lineCount },
    tr: state.update({
      changes: { from: ctx.selFrom, to: ctx.selTo, insert },
      selection: { anchor: endPos },
      scrollIntoView: true,
      userEvent: "ai.insert",
    }),
  };
}
