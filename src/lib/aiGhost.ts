/**
 * 编辑器内联流式补全（AI ghost text）—— 与 UI 解耦的核心逻辑。
 *
 * 一条完整链路（每一段都可以单独阅读）：
 *   ① 触发判定   canTriggerAiGhost / isCodeFile / GHOST_* 常量
 *   ② 取上下文   buildGhostContext（光标前文 ≤ GHOST_PREFIX_BYTES，附说明）
 *   ③ 组装提示词 buildGhostMessages（续写任务：只输出紧接着光标的代码）
 *   ④ 流式请求   streamChat（src/lib/aiStream.ts，SSE / 可中止 / 超时）
 *   ⑤ 显示清洗   cleanGhostStream（围栏剥离 + 去前导空行），流式逐增量实时显示
 *   ⑥ 编排状态机 AiGhostController（防抖 800ms、节流 ≥3s、中止、丢弃）
 *
 * 本模块不 import CodeMirror：它通过注入的 getState / getView 拿文档与光标，
 * 把「该显示什么」交给外部回调（EditorPane 里转成 CM6 的 StateEffect），
 * 因此状态机可以脱离编辑器单独推理，也避免 lib ↔ 组件 的循环依赖。
 *
 * 失败一律静默：请求出错 / 解析不出增量 / 用户中止，都只是「没有幽灵文本」，
 * 绝不弹提示、绝不打断打字。
 */
import { isAiConfigured, type ChatMessage } from "@/lib/ai";
import { streamChat } from "@/lib/aiStream";
import { languageOf } from "@/lib/aiGen";
import type { Settings } from "@/types";

// ---------------------------------------------------------------------------
// ① 触发判定与常量
// ---------------------------------------------------------------------------

/**
 * 触发防抖：文档变化后等 300ms（用户停止输入）再发请求。
 * 原为 800ms——幽灵的显示是同步状态（ghostKeymap 按 StateField 判断，不依赖渲染帧），
 * 它出现后即可被 Tab 接受；防抖太久会让「打完词立刻按 Tab」落在幽灵出现之前，
 * 此时下拉也可能还没弹开（弹窗要过一轮异步帧），Tab 只能落回缩进。
 * 300ms 与 Copilot 同类补全的体感一致；用户反馈还是偏慢，再压到 150ms
 * （打字平均击键间隔 ~120ms，150ms 仍能区分「还在打」和「停下了」）。
 */
export const GHOST_DEBOUNCE_MS = 150;
/**
 * 两次请求的最小间隔：连续打字时防抖本就会把请求压后，这里再兜一层，
 * 保证「上一发出去到现在」至少 0.8s，避免慢模型下请求排队堆积（代价控制）。
 * 原为 1.5s，用户反馈触发偏慢，收紧到 0.8s。
 */
export const GHOST_MIN_INTERVAL_MS = 800;
/** 单次流式请求的整体超时：内联补全要快，10s 还没吐完就丢弃 */
export const GHOST_TIMEOUT_MS = 10_000;
/** 光标前文（prefix）的字节上限：约 2KB，足够模型看出当前函数在写什么 */
export const GHOST_PREFIX_BYTES = 2048;
/** 光标后文（suffix）的字节上限：给一点「后面已经有什么」的线索即可 */
export const GHOST_SUFFIX_BYTES = 512;
/** 续写温度：0.2，偏低以保证补全稳定 */
export const GHOST_TEMPERATURE = 0.2;

/** 只有代码文件才触发内联补全（与「从注释生成代码」同源的判定表） */
const CODE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;

/**
 * 当前是否在代码文件里发动内联补全。
 * 需求 4：只在 AI 已配置且当前是代码文件时启用（非代码文件连防抖定时器都不排）。
 */
export function canTriggerAiGhost(file: string, settings: Settings | undefined): boolean {
  return CODE_EXT.test(file) && isAiConfigured(settings);
}

/** 设置开关：字段缺失（旧 settings.json）视为「开」，与编辑器其它开关同一约定 */
export function ghostOn(settings: Settings | undefined): boolean {
  return settings?.aiInlineComplete !== false;
}

export interface GhostContext {
  /** 光标前文（按字节截断，最多 GHOST_PREFIX_BYTES） */
  prefix: string;
  /** 光标后文（按字节截断，最多 GHOST_SUFFIX_BYTES） */
  suffix: string;
  /** 前文是否被截断过（提示词里要说明，否则模型会以为文件就这么短） */
  prefixTruncated: boolean;
}

/**
 * ② 取上下文：光标前文（主）+ 光标后文（辅）。
 *
 * 为什么前文也要限长：一个几千行的 .cpp 全塞进提示词既慢又贵，
 * 而续写只需要「光标附近」的上下文；截断时保留**紧邻光标的尾部**，
 * 并在提示词里注明「已截断」，避免模型把文件开头当成上一行。
 */
export function buildGhostContext(doc: string, pos: number): GhostContext {
  const p = Math.max(0, Math.min(pos, doc.length));
  const head = doc.slice(0, p);
  const tail = doc.slice(p);

  const prefixTruncated = new TextEncoder().encode(head).length > GHOST_PREFIX_BYTES;
  // 前文从尾部截（离光标最近的代码最重要）；后文从头部截
  const prefix = takeTailBytes(head, GHOST_PREFIX_BYTES);
  const suffix = takeHeadBytes(tail, GHOST_SUFFIX_BYTES);
  return { prefix, suffix, prefixTruncated };
}

/** 按 UTF-8 字节上限取文本尾部（用二分保证不切坏多字节字符） */
function takeTailBytes(text: string, limit: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= limit) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (enc.encode(text.slice(text.length - mid)).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(text.length - lo);
}

/** 按 UTF-8 字节上限取文本头部 */
function takeHeadBytes(text: string, limit: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= limit) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (enc.encode(text.slice(0, mid)).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

// ---------------------------------------------------------------------------
// ③ 提示词
// ---------------------------------------------------------------------------

/**
 * 「标识符补全」判定：光标紧挨着半个单词/成员名（word 字符结尾，或
 * `.` / `->` / `::` 后跟着标识符）时，用户意图是补全**这个单词**，
 * 而不是让 AI 生成整段代码——这时要走单词模式。
 *
 * 预处理行（#include / #define …）**不走**单词模式：指令关键字和头文件名
 * 需要「include <iostream>」「stdio.h>」这类可能含空格/点/尖括号的输出，
 * 单词模式会把模型限制成几个字母、收尾再被 `^\S*` 截断，导致 # 行完全不补全。
 */
export function isIdentCompletion(prefix: string): boolean {
  const lineTail = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (/^\s*#/.test(lineTail)) return false;
  return /([A-Za-z0-9_]$)|((::|->|\.)\s*[A-Za-z_][A-Za-z0-9_]*$)/.test(prefix);
}

/**
 * 续写任务的提示词：明确「只输出紧接着光标的字符」，
 * 并要求不要重复前文、不要 Markdown 围栏、不要解释——因为输出会被当作
 * 光标处的幽灵文本直接显示，任何多余内容都会变成肉眼可见的垃圾。
 *
 * identMode（单词模式）：光标停在半个标识符中间（如 `std::cou`、`totalN`、
 * `obj->get`），此时只应补全当前这个标识符的剩余几个字母。
 */
export function buildGhostMessages(file: string, ctx: GhostContext, identMode = false): ChatMessage[] {
  const system = identMode
    ? [
        "你是一名 C/C++ 编辑器内联补全引擎（类似 Copilot）。用户正在输入一个标识符，光标停在标识符中间（或成员访问 . / -> / :: 之后）。",
        "请只输出「当前这个标识符的剩余部分」，规则：",
        "1. 只补全光标所在的这一个单词，到标识符结尾为止；",
        "2. 严禁输出换行、空格、制表符、括号、分号或任何其它字符；",
        "3. 如果该标识符已经写完整了，输出空字符串（不要猜下一个词）；",
        "4. 不要解释、不要 Markdown 代码块围栏（不要写 ```）。",
      ].join("\n")
    : [
        "你是一名 C/C++ 编辑器内联补全引擎（类似 Copilot）。用户正在打字，光标停在某处。",
        "请只输出「紧接着光标之后应该出现的代码字符」，从光标的那个位置继续写：",
        "1. 不要重复光标之前已经写过的内容，不要重述上下文；",
        "2. 不要输出任何解释、注释性的说明、Markdown 代码块围栏（不要写 ```）；",
        "3. 保持与上下文一致的缩进风格（本编辑器按 4 空格缩进）；",
        "4. 光标所在行的行首缩进由编辑器提供：续写当前行时第一行不要输出前导缩进空格；从第二行起按 4 空格为单位给绝对缩进；",
        "5. 通常补全 1~5 行即可；如果光标处正好需要换行，第一行就以换行开始；",
        "6. 如果无法确定该写什么，输出空字符串（不要猜）。",
      ].join("\n");
  const user = [
    `【文件】${file}（语言：${languageOf(file)}）`,
    ctx.prefixTruncated
      ? `【光标之前的代码（只保留了靠近光标的最后 ${GHOST_PREFIX_BYTES} 字节，更早的内容已省略）】`
      : "【光标之前的代码】",
    "```cpp",
    ctx.prefix,
    "```",
    ctx.suffix.trim() ? "【光标之后已有的代码（仅作参考，不要重复输出它）】" : "",
    ctx.suffix.trim() ? "```cpp" : "",
    ctx.suffix.trim() ? ctx.suffix : "",
    ctx.suffix.trim() ? "```" : "",
    identMode
      ? "【任务】只输出当前标识符的剩余部分（几个字母），不要输出其它任何字符。"
      : "【任务】输出紧接着光标处应该出现的代码（从光标位置续写，不要重复上面的前文）。",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------------------------------------------------------------------------
// ⑤ 显示清洗：围栏剥离 + 按行首边界截断
// ---------------------------------------------------------------------------

/**
 * 清洗流式累积文本 → 可显示的幽灵文本。
 *
 * 处理三件事（顺序不能换）：
 *  1. CRLF 归一化（\r 单独出现也会把幽灵文本的显示搞乱）；
 *  2. 剥离 Markdown 围栏：开始处的 ``` 整行去掉、结尾不完整的 ``` 也去掉
 *     （模型即使被要求不要围栏，偶尔仍会写）；
 *  3. 丢掉开头的空行——幽灵文本直接接在光标后面，前面多一个换行就会
 *     凭空把后面的代码顶下去一行。
 */
/**
 * 一行是否只是 Markdown 代码围栏（``` 或 ```cpp；流式过程中还可能只有 `` 这半截）
 */
function isFenceLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("```") || (t.length > 0 && "```".startsWith(t));
}

export function cleanGhostStream(buf: string): string {
  let t = buf.replace(/\r\n?/g, "\n");

  // ① 开头整行围栏：去掉这一行，但**保留**它后面那个换行
  //   （否则首行的缩进/换行语义会被吃掉）
  const firstNl = t.indexOf("\n");
  if (firstNl >= 0 && isFenceLine(t.slice(0, firstNl))) t = t.slice(firstNl);
  else if (firstNl < 0 && isFenceLine(t)) t = "";

  // ② 结尾围栏：可能是「已经换行 + 整行围栏 + 可选换行」，也可能是行尾的半截 ```
  const lastNl = t.lastIndexOf("\n");
  const lastLine = lastNl >= 0 ? t.slice(lastNl + 1) : t;
  if (isFenceLine(lastLine)) {
    // 只切掉最后一行本身，前面内容（含分隔它们的换行）原样保留：
    // "a;\n```"      → "a;\n"
    // "a;\n```\n"    → "a;\n"
    // "```"          → ""
    t = lastNl >= 0 ? t.slice(0, lastNl + 1) : "";
  }

  // ③ 丢掉开头的空行：幽灵文本直接接在光标后，前面多一个换行会把后面的代码顶下去
  t = t.replace(/^\n+/, "");
  return t;
}

/**
 * 多行幽灵文本的首行缩进归一化。
 *
 * 模型看不到光标的列号，首行缩进经常与后续行错位（用户反馈「第一行和后面的缩进
 * 长度不同」），两类常见病灶：
 *  A) 光标已在一行缩进空白之后（列 > 0，该行只有缩进），模型第一行又带了缩进
 *     → 接受后首行双缩进（8 格），后续行 4 格；
 *  B) 光标在行首空行（列 = 0），模型第一行没给缩进但后续行有
 *     → 首行顶格，后续行缩进。
 * 显示与接受共用此归一化（都走 cleanGhostStream 之后的同一条链路），保证
 * 看见的幽灵和 Tab 接受的结果一致。
 */
export function normalizeGhostIndent(text: string, prefix: string): string {
  const nl = text.indexOf("\n");
  if (nl < 0) return text;
  const lineBefore = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const col = lineBefore.length;
  if (col === 0) {
    // B) 空行上的光标：首行无缩进而后续行有 → 补后续行的最小缩进
    if (lineBefore.trim() === "" && !/^[ \t]/.test(text)) {
      const indents = text
        .split("\n")
        .slice(1)
        .filter((l) => l.trim())
        .map((l) => (l.match(/^[ \t]*/) ?? [""])[0]);
      if (indents.length) {
        const min = indents.reduce((a, b) => (b.length < a.length ? b : a));
        if (min) return min + text;
      }
    }
    return text;
  }
  // A) 光标在「纯缩进空白行」之后：模型第一行的前导缩进与光标位置重复 → 裁掉
  if (/^[ \t]+$/.test(lineBefore)) return text.replace(/^[ \t]+/, "");
  return text;
}

/**
 * 按「行首边界」截断幽灵文本（自行实现，规则如下）：
 *
 *  · 完整行 = 以 \n 结尾的行。这些行一定可以显示（模型已经写完了它们）；
 *  · 最后一个不完整的尾巴（还没等到 \n）**不显示**，否则会出现
 *    「std::cou」这种半个词/半个标识符的幽灵文本，看起来像 bug；
 *  · minLen 传入「上一次已经显示的长度」，保证显示只增不减：
 *    尾部虽然暂时不显示，但它一旦补全成完整行就会立刻出现，
 *    不会出现"先显示后回退"的跳动。
 *
 * 返回值是显示文本的长度（调用方用 slice(0, n)）；n 可能为 0（连一行都没写完）。
 */
export function ghostLineBoundary(cleaned: string, minLen = 0): number {
  const nl = cleaned.lastIndexOf("\n");
  const boundary = nl >= 0 ? nl + 1 : 0;
  return Math.max(minLen, Math.min(boundary, cleaned.length));
}

/** 计算本次新增量后的显示文本（只增不减，见 ghostLineBoundary） */
export function foldGhostLines(prevShown: string, buffer: string): string {
  const cleaned = cleanGhostStream(buffer);
  const n = ghostLineBoundary(cleaned, prevShown.length);
  return cleaned.slice(0, n);
}

// ---------------------------------------------------------------------------
// ⑥ 编排状态机
// ---------------------------------------------------------------------------

/** 触发时需要的编辑器现场（由外部注入，本模块不依赖 CodeMirror 类型） */
export interface GhostViewState {
  /** 当前文档全文 */
  doc: string;
  /** 当前主光标位置 */
  cursor: number;
}

/** 一次补全请求的身份：位置变了就作废 */
interface GhostAttempt {
  id: number;
  pos: number;
}

export interface AiGhostControllerOptions {
  /** 当前文件名（工作区相对路径），用于语言判定与提示词 */
  file: string;
  /** 读取当前编辑器现场；返回 null 表示编辑器已不可用（销毁中/切换文件） */
  getState: () => GhostViewState | null;
  /** 实时读取设置（开关、接口地址、模型都要取最新一份） */
  getSettings: () => Settings | undefined;
  /** 幽灵文本变化回调："" 表示清空。由外部转成 CM6 的 StateEffect */
  onGhost: (text: string) => void;
}

/**
 * 内联补全的编排器（防抖 / 节流 / 中止 / 丢弃都在这里）。
 *
 * 生命周期约定：EditorPane 每次挂载建一个，卸载时 destroy()。
 * 切换文件时 EditorPane 会按 key 重挂载，因此「切文件 → 丢弃并中止」
 * 由 destroy() 顺手完成。
 */
export class AiGhostController {
  private readonly file: string;
  private readonly getState: () => GhostViewState | null;
  private readonly getSettings: () => Settings | undefined;
  private readonly onGhost: (text: string) => void;

  /** 防抖 / 节流补偿定时器 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 在飞请求的中止开关；结束后必须置回 null */
  private ctrl: AbortController | null = null;
  /** 请求序号：异步回调回来时用它判断自己是否已过期 */
  private gen = 0;
  /** 本会话发起过的请求数（测试与排查用） */
  private requests = 0;
  /** 上一次真正发出请求的时间戳，用于最小间隔节流 */
  private lastStartAt = 0;
  private destroyed = false;

  constructor(opts: AiGhostControllerOptions) {
    this.file = opts.file;
    this.getState = opts.getState;
    this.getSettings = opts.getSettings;
    this.onGhost = opts.onGhost;
  }

  /** 排查用：本会话真正发出去的请求数 */
  get requestCount(): number {
    return this.requests;
  }

  // -------------------------------------------------------------------------
  // 外部事件入口（EditorPane 的 updateListener / visibilitychange 调用）
  // -------------------------------------------------------------------------

  /**
   * 文档发生变化（用户打字 / 粘贴 / 撤销……）：
   * 立刻中止在飞请求、清掉幽灵文本，然后重新排一次防抖 —— 800ms 后再问一次。
   * fromGhostAccept：这次变化是「Tab 接受幽灵文本」写入的（事务带 userEvent "input.complete"），
   * 接受后不该立刻又触发新补全。
   */
  onDocChange(fromGhostAccept: boolean): void {
    if (this.destroyed) return;
    if (fromGhostAccept) return; // 「Tab 接受」写进来的：忽略
    this.cancel(); // 中止 + 清空 + 清定时器
    this.schedule();
  }

  /**
   * 选区/光标移动：丢弃幽灵文本并中止请求，**不**重新触发
   * （用户挪了光标说明他换地方了，等他打字再说）。
   */
  onSelectionMove(): void {
    if (this.destroyed) return;
    this.cancel();
  }

  /** 页面切到后台（visibilitychange）：丢弃并中止，避免后台白烧 token */
  onHidden(): void {
    if (this.destroyed) return;
    this.cancel();
  }

  /** 设置被关掉 / 文件不合适：丢弃并中止，且不再排新的请求 */
  stop(): void {
    this.cancel();
  }

  destroy(): void {
    this.destroyed = true;
    this.cancel();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 清空幽灵文本并强制中止在飞请求。
   */
  private clearGhost(): void {
    this.onGhost("");
  }

  private cancel(): void {
    this.gen++;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ctrl) {
      this.ctrl.abort();
      this.ctrl = null;
    }
    this.clearGhost();
  }

  /** 排一次「防抖 + 节流」后的补全 */
  private schedule(): void {
    if (this.destroyed) return;
    if (this.timer != null) return; // 已有排期，等它跑
    if (!this.canTrigger()) {
      this.stop(); // AI 未配置 / 非代码文件 / 开关关闭：连定时器都不排
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      // 节流：距上一次请求不足 GHOST_MIN_INTERVAL_MS 时，把请求压到窗口边界
      const wait = this.lastStartAt + GHOST_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.destroyed) void this.run();
        }, wait);
        return;
      }
      void this.run();
    }, GHOST_DEBOUNCE_MS);
  }

  private canTrigger(): boolean {
    return canTriggerAiGhost(this.file, this.getSettings()) && ghostOn(this.getSettings());
  }

  /**
   * 真正发请求：把现场（光标位置 + 前文快照）冻结下来，
   * 流式增量只更新「显示文本」，任何位置漂移都会让这次请求作废。
   */
  private async run(): Promise<void> {
    if (this.destroyed) return;
    if (!this.canTrigger()) return;
    const snap = this.getState();
    if (!snap) return;

    const settings = this.getSettings();
    const pos = snap.cursor;
    const ctx = buildGhostContext(snap.doc, pos);
    if (!ctx.prefix.trim()) return; // 空文件/行首之前什么都没有：没什么可续写的
    // 单词模式：光标前是半个标识符（std::cou / totalN / obj->get）——
    // 意图是补全这个单词，而不是生成整段代码。
    const identMode = isIdentCompletion(ctx.prefix);

    const id = ++this.gen;
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.lastStartAt = Date.now();
    this.requests++;

    let shown = "";
    let buffer = "";
    const attempt: GhostAttempt = { id, pos };

    const res = await streamChat({
      settings: settings ?? {},
      messages: buildGhostMessages(this.file, ctx, identMode),
      temperature: GHOST_TEMPERATURE,
      timeoutMs: GHOST_TIMEOUT_MS,
      signal: ctrl.signal,
      // 增量回调：清洗后**逐增量实时显示**——不等完整行。
      // 早期版本按「行首边界」截断（担心半个词看起来像 bug），代价是首 token
      // 到第一个换行之间幽灵文本不存在，用户此时按 Tab 会落回缩进行为
      // （「Tab 造成缩进而没有补全」的元凶）。Copilot 同样实时显示半个词，
      // 可接受；光标原位校验仍在，用户一动光标立刻丢弃。
      onDelta: (delta) => {
        if (this.destroyed || id !== this.gen) return;
        buffer += delta;
        const next = normalizeGhostIndent(cleanGhostStream(buffer), ctx.prefix);
        if (next === shown) return;
        shown = next;
        // 纯空白幽灵不显示：换行已被清洗剥掉、只剩缩进空格的建议在视觉上完全不可见，
        // 用户按 Tab 会「接受」一段看不见的空格——表现形式就是「在行首缩进了」。
        if (!next.trim()) return;
        // 显示前最后一道校验：光标必须还在原位，否则用户已经动了 → 丢掉
        const s = this.getState();
        if (!s || s.cursor !== attempt.pos) return;
        this.onGhost(shown);
      },
    });

    // 无论成功失败，这次请求都不再持有中止开关
    if (this.ctrl === ctrl) this.ctrl = null;

    // 静默处理收尾：过期 / 中止 / 出错 / 没内容 → 一律丢弃，不动文档
    if (this.destroyed || id !== this.gen) return;
    if (res.error) {
      this.clearGhost();
      return;
    }
    // 流已结束：不会再有增量到达。此时**完整显示**清洗后的全文——
    // 行首边界截断只是流式过程中的防半词措施；若补全整体只有一行
    // （如 "t << std::endl;"），按行边界永远等不到换行，就永远不显示。
    // 单词模式再兜底截到第一个空白符：即使模型违约输出了整段，也只取这个单词。
    let finalText = normalizeGhostIndent(cleanGhostStream(buffer), ctx.prefix);
    if (identMode) finalText = finalText.match(/^\S*/)?.[0] ?? "";
    if (!finalText.trim()) {
      this.clearGhost();
      return;
    }
    const s = this.getState();
    if (!s || s.cursor !== attempt.pos) {
      this.clearGhost();
      return;
    }
    if (finalText !== shown) {
      shown = finalText;
      this.onGhost(shown);
    }
  }
}
