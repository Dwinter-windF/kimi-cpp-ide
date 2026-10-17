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
import type { Settings } from "@/types";
import { useIde } from "@/store";

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
  if (!hasEndpoint && !hasKey) return "未配置 AI 接口：请在「设置 → AI 接口」填写接口地址与密钥后使用。";
  if (!hasEndpoint) return "未配置 AI 接口地址：请在「设置 → AI 接口」填写接口地址后使用。";
  if (!hasKey) return "未配置 AI 密钥：请在「设置 → AI 接口」填写密钥后使用。";
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
      return `🔧 读取 ${p}`;
    case "list_files":
      return `🔧 列出目录 ${p}`;
    case "write_file": {
      const text = typeof args.content === "string" ? args.content : "";
      return `🔧 写入 ${p} (${formatBytes(new TextEncoder().encode(text).length)})`;
    }
    case "delete_file":
      return `🔧 删除 ${p}`;
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
  const { tools: useTools = true, temperature = 0.3, timeoutMs = CHAT_TIMEOUT_MS, signal } = opts;
  const endpoint = resolveAiEndpoint(s);
  if (!endpoint) {
    return { error: "未配置 AI 接口。请在「设置 → AI 接口」中填写兼容 OpenAI 的接口地址、密钥和模型。" };
  }
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
      return { error: "已取消 AI 请求。" };
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
          ...buildChatBody(s, messages, temperature, false),
          ...(useTools ? { tools: FS_TOOLS, tool_choice: "auto" } : {}),
        }),
      });
      raw = await resp.text();
    } catch (e) {
      if (timedOut) {
        return { error: `AI 请求超时（${Math.round(timeoutMs / 1000)} 秒）：请检查网络、接口地址与密钥后重试。` };
      }
      // 用户主动取消：用中文说清「不是失败」，调用方据此不再提示错误
      if (canceled) return { error: "已取消 AI 请求。" };
      return { error: `AI 请求失败：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!resp.ok) {
      // 接口 / 模型不支持 tools 时通常就是 400：给出可操作的中文提示（不带工具的请求无需该提示）
      const hint =
        useTools && (resp.status === 400 || resp.status === 404 || resp.status === 422)
          ? "\n\n该接口或模型可能不支持工具调用（tools / function calling）。请在「设置 → AI 接口」换用支持工具调用的模型（如 kimi-k2、gpt-4o、claude 系列等），或直接提问（不带工具）继续对话。"
          : "";
      return { error: `AI 接口返回 ${resp.status}：${raw.slice(0, 400)}${hint}` };
    }
    let data: {
      choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
      error?: { message?: string } | string;
    };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return { error: `AI 接口返回了无法解析的内容：${raw.slice(0, 200)}` };
    }
    if (data.error) {
      const msg = typeof data.error === "string" ? data.error : data.error.message || "未知错误";
      return { error: `AI 接口返回错误：${msg}` };
    }
    const message = data.choices?.[0]?.message;
    if (!message) return { error: "AI 接口返回为空（没有 choices[0].message）" };
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
  const { settings, history, onAction, maxRounds = MAX_TOOL_ROUNDS, timeoutMs = CHAT_TIMEOUT_MS } = opts;
  const actions: string[] = [];
  let finalText = "";
  let error = "";
  let answered = false;
  try {
    for (let round = 0; round < maxRounds; round++) {
      const out = await requestChat(settings, history, { timeoutMs });
      if (out.error) {
        error = out.error;
        break;
      }
      const msg = out.message;
      if (!msg) {
        error = "AI 接口返回为空";
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
        actions.push(parseError ? `🔧 ${name}（参数解析失败）` : toolActionLabel(name, args));
        onAction?.([...actions]);
        // 单个工具失败只把错误文本喂回模型，让它自我纠正，不打断整轮对话
        const result = parseError || (await runFsTool(name, args));
        history.push({ role: "tool", tool_call_id: call.id || name, content: clipToolResult(result) });
      }
    }
  } catch (e) {
    error = `AI 请求失败：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!error && !finalText.trim()) {
    finalText = answered
      ? "(空回复)"
      : `（已达到 ${maxRounds} 轮工具调用上限，停止继续调用工具。可以让我继续，或把任务拆小一些。）`;
  }
  return { text: finalText, actions, error };
}
