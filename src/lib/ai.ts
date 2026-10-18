/**
 * AI 请求层（OpenAI 兼容 /chat/completions）—— 全应用唯一一份实现。
 *
 * 使用方：
 *  1. src/components/AiPanel.tsx    —— 对话 + 工作区文件工具调用循环（runToolLoop）
 *  2. src/lib/aiFix.ts（AI 一键修复） —— 单次请求、不带工具（requestChat + tools:false）
 *
 * 本模块只负责「发请求 / 执行本地文件工具 / 跑工具循环」，不碰 UI 与聊天记录
 * （store 里的 aiMessages 由调用方维护），因此两处入口复用同一套代码、零复制粘贴。
 * 所有错误一律转成中文文案返回，不向调用方抛异常（AI 未配置 / 超时 / 返回无法解析都在这里兜住）。
 */
import type { AiContext, Settings } from "@/types";
import { useIde } from "@/store";
import { t } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// 工作区文件工具（OpenAI tools / function calling 格式）
// 4 个工具都只操作「当前工作区」内的路径，真正执行落在本地 /api/fs/* 上；
// 服务端会用 toAbs 再做一次越界校验（越界 403），前端这里只负责转发与展示。
// ---------------------------------------------------------------------------
export const FS_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取当前工作区内某个文本文件的完整内容（相对路径，单个文件上限 1MB）。修改代码前先用它查看原文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区根目录的文件路径，例如 main.cpp 或 src/a.cpp" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "把内容写入当前工作区内的文件（相对路径；上级目录会自动创建，原内容被覆盖；单次写入上限 2MB）。要给出完整文件内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区根目录的文件路径，例如 src/a.cpp" },
          content: { type: "string", description: "要写入的完整文件内容（UTF-8）" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前工作区内某个目录的直接子项（相对路径；路径留空表示列工作区根目录）。不确定文件在哪时先用它。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区根目录的目录路径，留空则列出工作区根目录" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除当前工作区内的一个文件或空目录（相对路径）。非空目录不会被删除，会返回中文错误。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区根目录的文件或空目录路径" },
        },
        required: ["path"],
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// 前端 IDE 工具（不需要服务端改动）：
//   compile / run / get_problems / open_file
// 这些工具直接复用 store 现有的编译 / 运行 / 问题列表 / 打开文件能力，
// 执行结果与文件工具一样以 role:'tool' 回灌给模型，由模型决定下一步。
// ---------------------------------------------------------------------------
export const IDE_TOOLS = [
  {
    type: "function",
    function: {
      name: "compile",
      description: "编译当前工程（构建全部源文件，走 IDE 现有构建流程）。返回是否成功、错误数、首条错误与输出摘要。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run",
      description:
        "编译并运行当前程序，等待进程结束（最长 15 秒）。返回退出码与最后 2KB 输出；超时返回 timeout 摘要。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_problems",
      description: "读取当前编辑器/编译诊断列表（错误、警告及提示），用于定位编译失败原因。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description: "在当前工作区内打开一个文本文件（相对路径），切换编辑器到该文件。只能打开工作区内的文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对工作区根目录的文件路径，例如 src/main.cpp" },
        },
        required: ["path"],
      },
    },
  },
] as const;

/** 发给模型的完整工具表：工作区文件工具 + 前端 IDE 工具 */
export const AI_TOOLS = [...FS_TOOLS, ...IDE_TOOLS] as const;

/** 前端 IDE 工具名集合（runToolLoop 用它决定走本地 store 还是 /api/fs/*） */
const IDE_TOOL_NAMES = new Set<string>(IDE_TOOLS.map((x) => x.function.name));

/** 一次对话最多 8 轮「请求模型 → 执行工具 → 结果回灌」循环 */
export const MAX_TOOL_ROUNDS = 8;
/** 单条工具结果截断上限：8KB，防止上下文爆炸 */
export const TOOL_RESULT_LIMIT = 8 * 1024;

/** 对话（带工具循环）单轮请求超时：给慢模型留足时间，避免误杀正常的工具调用回合 */
export const CHAT_TIMEOUT_MS = 120_000;
/** 「AI 一键修复」单次请求超时：按需求固定 30s */
export const AI_FIX_TIMEOUT_MS = 30_000;

export type ToolArgs = Record<string, unknown>;

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface FsEntry {
  name?: string;
  path?: string;
  type?: string;
}

interface FsJson {
  error?: string;
  content?: string;
  bytes?: number;
  entries?: FsEntry[];
}

/**
 * AI 是否已配置可用凭据。
 * 「一键修复」要求接口地址与密钥都填好（需求：无 key 时按钮禁用并给提示）。
 */
export function isAiConfigured(s: Settings | undefined): boolean {
  return !!(s?.aiEndpoint || "").trim() && !!(s?.aiKey || "").trim();
}

/**
 * 归一化「AI 接口地址」：去掉首尾空白与结尾的 `/`。
 * 非流式（requestChat）与流式（src/lib/aiStream.ts）共用，避免两处各写一遍。
 */
export function resolveAiEndpoint(s: Settings | undefined): string {
  return (s?.aiEndpoint || "").trim().replace(/\/+$/, "");
}

/**
 * 组装 OpenAI 兼容 /chat/completions 的请求体（model / messages / temperature / stream）。
 * 非流式与流式共用同一份组装逻辑：鉴权头、超时、错误处理各自封装，
 * 字段组装只此一处，防止两条链路悄悄跑偏。
 */
export function buildChatBody(
  s: Settings | undefined,
  messages: ChatMessage[],
  temperature: number,
  stream: boolean,
  /** 调用方追加的请求体字段（如 DeepSeek 关闭推理的参数）； undefined 表示无 */
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    model: s?.aiModel || "gpt-4o-mini",
    messages,
    temperature,
    stream,
    ...extra,
  };
}

/** 供禁用按钮的 title 使用：说清缺哪一项 */
export function aiConfigHint(s: Settings | undefined): string {
  const hasEndpoint = !!(s?.aiEndpoint || "").trim();
  const hasKey = !!(s?.aiKey || "").trim();
  if (!hasEndpoint && !hasKey) return t("ai.configHint.both");
  if (!hasEndpoint) return t("ai.configHint.endpoint");
  if (!hasKey) return t("ai.configHint.key");
  return "";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function argPath(args: ToolArgs): string {
  return typeof args.path === "string" ? args.path.trim() : "";
}

/** 工具调用 → 一行中文动作描述（渲染在 AI 气泡上方的小字） */
export function toolActionLabel(name: string, args: ToolArgs): string {
  const p = argPath(args) || ".";
  switch (name) {
    case "read_file":
      return t("ai.action.read", { path: p });
    case "list_files":
      return t("ai.action.list", { path: p });
    case "write_file": {
      const text = typeof args.content === "string" ? args.content : "";
      return t("ai.action.write", { path: p, size: formatBytes(new TextEncoder().encode(text).length) });
    }
    case "delete_file":
      return t("ai.action.delete", { path: p });
    case "compile":
      return t("ai.action.compile");
    case "run":
      return t("ai.action.run");
    case "get_problems":
      return t("ai.action.problems");
    case "open_file":
      return t("ai.action.open", { path: p });
    default:
      return `🔧 ${name}`;
  }
}

/** 从头部（fromEnd=false）或尾部（fromEnd=true）按字节预算截取（二分保证不切坏多字节字符） */
function cutToBytes(text: string, budget: number, fromEnd: boolean): string {
  const enc = new TextEncoder();
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const slice = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid);
    if (enc.encode(slice).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return fromEnd ? text.slice(text.length - lo) : text.slice(0, lo);
}

/**
 * 按 UTF-8 字节数裁剪文本（中文按 3 字节算，避免按字符切片超限）。
 * headRatio 决定头部保留比例，其余给尾部，尽量同时保住文件开头的 #include 与结尾的 main。
 */
export function clipBytes(text: string, limit: number, headRatio = 0.7, note = ""): string {
  if (new TextEncoder().encode(text).length <= limit) return text;
  const headBudget = Math.floor(limit * headRatio);
  const tailBudget = Math.max(0, limit - headBudget);
  const head = cutToBytes(text, headBudget, false);
  const tail = cutToBytes(text, tailBudget, true);
  const suffix = note ? `：${note}` : "";
  return `${head}\n…（原文超过 ${formatBytes(limit)}，已截断${suffix}）…\n${tail}`;
}

/** 工具结果按字节截断到 8KB */
function clipToolResult(text: string): string {
  return clipBytes(text, TOOL_RESULT_LIMIT, 0.9, "工具结果过大");
}

async function readJson(resp: Response): Promise<FsJson> {
  return (await resp.json().catch(() => ({}))) as FsJson;
}

/** 文件被 AI 改动后：刷新文件树；正在编辑器里且未修改的文件同步成最新内容 */
export async function syncAfterFsChange(path: string, kind: "write" | "delete") {
  const st = useIde.getState();
  if (kind === "delete") {
    if (st.openFiles.includes(path)) st.closeFile(path);
    try {
      await useIde.getState().refreshFiles();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await st.refreshFiles();
  } catch {
    /* ignore */
  }
  const s = useIde.getState();
  if (s.openFiles.includes(path) && !s.dirty[path]) {
    try {
      const r = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
      const d = await readJson(r);
      if (r.ok && typeof d.content === "string") {
        const content = d.content;
        useIde.setState((prev) => ({
          contents: { ...prev.contents, [path]: content },
          dirty: { ...prev.dirty, [path]: false },
        }));
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * 执行一次本地文件工具，返回值直接作为 role:'tool' 的内容喂回模型。
 * 失败时也返回中文错误文本（而不是抛异常），让模型能自我纠正。
 */
export async function runFsTool(name: string, args: ToolArgs): Promise<string> {
  try {
    const p = argPath(args);
    if (name === "read_file") {
      if (!p) return "错误：缺少 path 参数";
      const r = await fetch(`/api/fs/read?path=${encodeURIComponent(p)}`);
      const d = await readJson(r);
      if (!r.ok) return `错误：${d.error || `读取失败 (${r.status})`}`;
      const content = typeof d.content === "string" ? d.content : "";
      return content || "（文件为空）";
    }
    if (name === "list_files") {
      const r = await fetch(`/api/fs/list?path=${encodeURIComponent(p)}`);
      const d = await readJson(r);
      if (!r.ok) return `错误：${d.error || `列目录失败 (${r.status})`}`;
      const entries = Array.isArray(d.entries) ? d.entries : [];
      if (entries.length === 0) return "（空目录）";
      return entries
        .map((e) => `${e.type === "dir" ? "[目录]" : "[文件]"} ${e.path || e.name || ""}`)
        .join("\n");
    }
    if (name === "write_file") {
      if (!p) return "错误：缺少 path 参数";
      const content = typeof args.content === "string" ? args.content : "";
      const r = await fetch("/api/fs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, content }),
      });
      const d = await readJson(r);
      if (!r.ok) return `错误：${d.error || `写入失败 (${r.status})`}`;
      await syncAfterFsChange(p, "write");
      const bytes = typeof d.bytes === "number" ? d.bytes : new TextEncoder().encode(content).length;
      return `已写入 ${p}（${formatBytes(bytes)}）`;
    }
    if (name === "delete_file") {
      if (!p) return "错误：缺少 path 参数";
      const r = await fetch("/api/fs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      const d = await readJson(r);
      if (!r.ok) return `错误：${d.error || `删除失败 (${r.status})`}`;
      await syncAfterFsChange(p, "delete");
      return `已删除 ${p}`;
    }
    return `错误：未知工具 ${name}`;
  } catch (e) {
    return `错误：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 把模型给的路径收敛成工作区相对 POSIX 路径。
 *  - 反斜杠统一成 /；去掉开头的 ./；
 *  - 绝对路径只允许落在当前工作区内，否则返回空串（拒绝打开工作区外文件）；
 *  - 含 `..` 段的路径直接拒绝，避免 store 里的文件 key 与文件树不一致。
 * 真正的越界校验仍由服务端 toAbs 兜底（403），这里只做前端预检与归一化。
 */
function normalizeWorkspacePath(raw: string): string {
  let p = raw.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.startsWith("../") || p.split("/").includes("..")) return "";
  const ws = (useIde.getState().workspace || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const isAbs = /^[A-Za-z]:\//.test(p) || p.startsWith("/");
  if (isAbs) {
    if (!ws) return "";
    const low = p.toLowerCase();
    const wl = ws.toLowerCase();
    if (!low.startsWith(wl + "/")) return "";
    p = p.slice(ws.length + 1);
  }
  return p;
}

/** 执行一个前端 IDE 工具，失败也用中文文本返回（让模型能自我纠正） */
async function runIdeTool(name: string, args: ToolArgs): Promise<string> {
  try {
    if (name === "compile") {
      const st = useIde.getState();
      if (!st.activeFile) return "错误：当前没有打开的文件，无法编译。";
      const res = await st.compile(true, { keepTab: true });
      if (!res) return "错误：编译未执行（没有打开的文件）。";
      const errors = (res.diagnostics || []).filter((d) => d.severity === "error");
      const first = errors[0];
      const lines = [
        res.ok
          ? `编译成功${typeof res.ms === "number" ? `（${res.ms} ms）` : ""}`
          : `编译失败${res.noCompiler ? "（未找到编译器）" : ""}：错误 ${errors.length} 个`,
      ];
      if (first) {
        lines.push(`首条错误：${first.file || "(链接阶段)"}:${first.line}:${first.col} ${first.message}`);
      } else if (res.error) {
        lines.push(`错误：${res.error}`);
      }
      if (res.output?.trim()) lines.push(`编译输出：\n${clipBytes(res.output, 4000, 0.6, "编译输出过大")}`);
      return lines.join("\n");
    }
    if (name === "run") {
      const r = await useIde.getState().runTool(15_000);
      if (r.timedOut) {
        return `运行超时（超过 15 秒，timeout）${r.output ? `\n最后输出（最多 2KB）：\n${r.output}` : ""}`;
      }
      if (r.error && r.code == null) {
        return `运行失败：${r.error}${r.output ? `\n最后输出（最多 2KB）：\n${r.output}` : ""}`;
      }
      return [
        `退出码：${r.code == null ? "?" : r.code}`,
        r.error ? `错误：${r.error}` : "",
        `最后输出（最多 2KB）：\n${r.output || "（无输出）"}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (name === "get_problems") {
      const st = useIde.getState();
      if (st.problems.length === 0) return "当前没有诊断或编译错误。";
      const lines = st.problems
        .slice(0, 50)
        .map(
          (p) =>
            `${p.file || "(链接阶段)"}:${p.line}:${p.col} [${p.severity}] ${p.message}${p.hint ? `（提示：${p.hint}）` : ""}`
        );
      const more = st.problems.length > 50 ? `\n…（其余 ${st.problems.length - 50} 条已省略）` : "";
      return `共 ${st.problems.length} 条诊断（当前文件：${st.activeFile || "无"}）：\n${lines.join("\n")}${more}`;
    }
    if (name === "open_file") {
      const raw = argPath(args);
      if (!raw) return "错误：缺少 path 参数";
      const p = normalizeWorkspacePath(raw);
      if (!p) return `错误：路径不在当前工作区内或包含非法片段：${raw}`;
      // 先用 /api/fs/read 做「工作区边界 + 文件存在 + 大小上限」校验，再走现有 store.openFile
      const r = await fetch(`/api/fs/read?path=${encodeURIComponent(p)}`);
      const d = await readJson(r);
      if (!r.ok) return `错误：${d.error || `打开失败 (${r.status})`}`;
      await useIde.getState().openFile(p);
      return useIde.getState().activeFile === p ? `已打开 ${p}` : `错误：打开失败 ${p}`;
    }
    return `错误：未知工具 ${name}`;
  } catch (e) {
    return `错误：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 工具分发：前端 IDE 工具走 store，其余沿用工作区文件工具 /api/fs/* */
export async function runAiTool(name: string, args: ToolArgs): Promise<string> {
  if (IDE_TOOL_NAMES.has(name)) return runIdeTool(name, args);
  return runFsTool(name, args);
}

export interface ChatOutcome {
  message?: { content?: string | null; tool_calls?: ChatToolCall[] };
  error?: string;
}

export interface ChatOptions {
  /** 是否附带工作区文件工具（tools / function calling），默认 true */
  tools?: boolean;
  temperature?: number;
  /** 单次请求超时 ms（默认 CHAT_TIMEOUT_MS；一键修复传 30s） */
  timeoutMs?: number;
  /**
   * 调用方的取消信号（可选）。与内部超时用同一个 AbortController 合并：
   * 「AI 插入代码」对话框的「取消」按钮、Esc 关闭、切换文件/卸载时用它中止在飞请求。
   * 不传时行为与以前完全一致（仅内部 30s/120s 超时）。
   */
  signal?: AbortSignal;
  /**
   * 当前打开文件上下文（可选）。传入时在本次请求的 messages 最前面追加一条
   * system 消息（不会写进聊天历史，下一轮会重新按最新值附加）；
   * 不传时请求体与旧版完全一致。
   */
  context?: AiContext;
}

/**
 * 把当前文件上下文组装成 system 消息。
 * 格式：`Current context: file=src/main.cpp`，有选中文本时追加 `<selection>…</selection>`。
 * 没有 file 时返回 null（等同于不传上下文）。
 */
export function contextSystemMessage(context: AiContext | undefined): ChatMessage | null {
  const file = (context?.file || "").replace(/[\r\n]/g, " ").trim();
  if (!file) return null;
  const selection = typeof context?.selection === "string" ? context.selection : "";
  let content = `Current context: file=${file}`;
  if (selection.trim()) content += `\n<selection>\n${selection}\n</selection>`;
  return { role: "system", content };
}

/**
 * 调用设置里配置的 OpenAI 兼容 /chat/completions。
 * 统一的超时（AbortController）与错误处理：任何失败都返回 { error: 中文提示 }，绝不抛异常。
 */
export async function requestChat(
  s: Settings,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<ChatOutcome> {
  const { tools: useTools = true, temperature = 0.3, timeoutMs = CHAT_TIMEOUT_MS, signal, context } = opts;
  const endpoint = resolveAiEndpoint(s);
  if (!endpoint) {
    return { error: t("ai.error.notConfigured") };
  }
  // 当前文件上下文只作为本次请求的 system 附加消息，不改动调用方的 history
  const ctxMsg = contextSystemMessage(context);
  const requestMessages = ctxMsg ? [ctxMsg, ...messages] : messages;
  const ctrl = new AbortController();
  let timedOut = false;
  let canceled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  // 调用方取消（可选）：向下传播到 fetch，并记下来给中文提示区分「取消 / 超时 / 网络错误」
  const onCallerAbort = () => {
    canceled = true;
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { error: t("ai.error.canceled") };
    }
    signal.addEventListener("abort", onCallerAbort);
  }
  try {
    let resp: Response;
    let raw: string;
    try {
      resp = await fetch(endpoint + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.aiKey || ""}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          ...buildChatBody(s, requestMessages, temperature, false),
          ...(useTools ? { tools: AI_TOOLS, tool_choice: "auto" } : {}),
        }),
      });
      raw = await resp.text();
    } catch (e) {
      if (timedOut) {
        return { error: t("ai.error.timeout", { seconds: Math.round(timeoutMs / 1000) }) };
      }
      // 用户主动取消：用中文说清「不是失败」，调用方据此不再提示错误
      if (canceled) return { error: t("ai.error.canceled") };
      return { error: t("ai.error.requestFailed", { message: e instanceof Error ? e.message : String(e) }) };
    }
    if (!resp.ok) {
      // 接口 / 模型不支持 tools 时通常就是 400：给出可操作的中文提示（不带工具的请求无需该提示）
      const hint =
        useTools && (resp.status === 400 || resp.status === 404 || resp.status === 422)
          ? t("ai.error.toolsUnsupported")
          : "";
      return { error: t("ai.error.http", { status: resp.status, body: raw.slice(0, 400), hint }) };
    }
    let data: {
      choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
      error?: { message?: string } | string;
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return { error: t("ai.error.invalidJson", { body: raw.slice(0, 200) }) };
    }
    if (data.error) {
      const msg = typeof data.error === "string" ? data.error : data.error.message || t("ai.error.unknown");
      return { error: t("ai.error.apiError", { message: msg }) };
    }
    const message = data.choices?.[0]?.message;
    if (!message) return { error: t("ai.error.empty") };
    return { message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export interface ChatLoopOptions {
  settings: Settings;
  /** 完整对话（含本次用户消息），会被就地追加 assistant / tool 消息 */
  history: ChatMessage[];
  /** 每执行一批工具回调一次（用于实时显示「🔧 读取 xxx」） */
  onAction?: (actions: string[]) => void;
  maxRounds?: number;
  timeoutMs?: number;
  /** 当前打开文件上下文（每次请求都作为 system 附加消息，不写入 history） */
  context?: AiContext;
}

export interface ChatLoopOutcome {
  /** 最终展示文本（已套用「空回复 / 达到轮数上限」兜底文案） */
  text: string;
  /** 本次实际执行的工具动作 */
  actions: string[];
  /** 非空表示失败（中文原因） */
  error: string;
}

/**
 * 工具调用循环：把历史 + tools 发给 /chat/completions；
 * 有 tool_calls 且轮数 < maxRounds 时逐个调用本地 /api/fs/*，结果以 role:'tool' 追加后继续请求；
 * 直到没有 tool_calls 或达到轮数上限。
 */
export async function runToolLoop(opts: ChatLoopOptions): Promise<ChatLoopOutcome> {
  const { settings, history, onAction, maxRounds = MAX_TOOL_ROUNDS, timeoutMs = CHAT_TIMEOUT_MS, context } = opts;
  const actions: string[] = [];
  let finalText = "";
  let error = "";
  let answered = false;
  try {
    for (let round = 0; round < maxRounds; round++) {
      const out = await requestChat(settings, history, { timeoutMs, context });
      if (out.error) {
        error = out.error;
        break;
      }
      const msg = out.message;
      if (!msg) {
        error = t("ai.error.emptyShort");
        break;
      }
      if (typeof msg.content === "string" && msg.content.trim()) finalText = msg.content;
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => !!c?.function?.name) : [];
      if (calls.length === 0) {
        answered = true;
        break;
      }
      // 助手的 tool_calls 消息必须原样回传，否则下一轮接口会报 400
      history.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name || "";
        const rawArgs = call.function?.arguments;
        let args: ToolArgs = {};
        let parseError = "";
        if (typeof rawArgs === "string" && rawArgs.trim()) {
          try {
            args = JSON.parse(rawArgs) as ToolArgs;
          } catch {
            parseError = `错误：工具参数不是合法 JSON：${rawArgs.slice(0, 200)}`;
          }
        }
        actions.push(parseError ? `🔧 ${name}${t("ai.action.parseFailed")}` : toolActionLabel(name, args));
        onAction?.([...actions]);
        // 单个工具失败只把错误文本喂回模型，让它自我纠正，不打断整轮对话
        const result = parseError || (await runAiTool(name, args));
        history.push({ role: "tool", tool_call_id: call.id || name, content: clipToolResult(result) });
      }
    }
  } catch (e) {
    error = t("ai.error.requestFailed", { message: e instanceof Error ? e.message : String(e) });
  }
  if (!error && !finalText.trim()) {
    finalText = answered
      ? t("ai.error.emptyReply")
      : t("ai.error.roundLimit", { max: maxRounds });
  }
  return { text: finalText, actions, error };
}
