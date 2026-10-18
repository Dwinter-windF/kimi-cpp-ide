import type {
  AiMessage,
  BuildSystemInfo,
  CompileResult,
  DebugStopped,
  FileNode,
  Settings,
  Toolchain,
  VizData,
} from "@/types";
import { t } from "@/lib/i18n";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !("error" in data && data.error)) {
    (data as { error?: string }).error = t("api.requestFailed", { status: res.status });
  }
  return data;
}

export const api = {
  toolchain: () => req<Toolchain>("/api/toolchain"),
  getSettings: () => req<Settings>("/api/settings"),
  /** 系统已安装字体族名（GET /api/fonts 直接返回 JSON 字符串数组） */
  fonts: () => req<string[]>("/api/fonts"),
  saveSettings: (s: Settings) =>
    req<Settings>("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  files: () => req<{ tree: FileNode[]; buildSystem?: BuildSystemInfo }>("/api/files"),
  // 构建系统探测（CMake / Make / 单文件 g++）：徽标点击重新探测时调用
  buildSystem: () => req<{ buildSystem: BuildSystemInfo }>("/api/buildsystem"),
  readFile: (path: string) =>
    req<{ path: string; content: string }>(`/api/file?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    req<{ ok: boolean }>("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    }),
  createFile: (path: string, isDir = false) =>
    req<{ ok: boolean; error?: string }>("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, isDir }),
    }),
  deleteFile: (path: string) =>
    req<{ ok: boolean }>(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  renameFile: (from: string, to: string) =>
    req<{ ok: boolean }>("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    }),
  /**
   * 拖拽导入：把文件内容以 base64 写进工作区（服务端同名校验 + 自动改名，单文件上限 8MB）。
   * 返回 path 为最终落盘的工作区相对路径（可能被改成 name-1.cpp），renamed 标识是否改过名。
   */
  uploadFile: (path: string, base64: string) =>
    req<{ ok: boolean; path?: string; original?: string; renamed?: boolean; bytes?: number; error?: string }>(
      "/api/fs/upload",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, base64 }),
      }
    ),
  /**
   * 工作区文件 API（服务端 /api/fs/*，与 AI 文件工具同一套路由，无服务端改动）。
   * 「新建项目向导」用它把模板文件写进工作区：
   *  - fsWrite 服务端会自动递归创建父目录（fs.mkdirSync(dirname, {recursive:true})），单次上限 2MB；
   *  - 语义是「无条件覆盖」，所以向导在调用前先做重名探测 + 自动改名（见 lib/projectTemplates.ts）；
   *  - fsList 用来探测「工作区根目录已有哪些名字」，作为重名判定的权威来源（比前端文件树缓存可靠）。
   */
  fsWrite: (path: string, content: string) =>
    req<{ ok: boolean; path?: string; bytes?: number; error?: string }>("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    }),
  fsMkdir: (path: string) =>
    req<{ ok: boolean; error?: string }>("/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  fsList: (path: string) =>
    req<{ entries?: FsEntry[]; error?: string }>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  compile: (main: string, project: boolean, std?: string) =>
    req<CompileResult>("/api/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ main, project, std }),
    }),
  run: (exe: string) =>
    req<{ id: string; error?: string }>("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exe }),
    }),
  runInput: (id: string, text: string) =>
    req<{ ok: boolean }>(`/api/run/${id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  runKill: (id: string) => req<{ ok: boolean }>(`/api/run/${id}/kill`, { method: "POST" }),
  debugStart: (
    exe: string,
    breakpoints: { file: string; line: number }[],
    watch: string[],
    evalConsole?: boolean
  ) =>
    req<{ id: string; error?: string }>("/api/debug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // evalConsole 为可选字段：不传时服务端按 false 处理，旧调用方行为不变
      body: JSON.stringify({ exe, breakpoints, watch, evalConsole }),
    }),
  debugCmd: (id: string, op: string, watch?: string[]) =>
    req<{ ok: boolean }>(`/api/debug/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, watch }),
    }),
  debugEval: (id: string, expr: string) =>
    req<{ ok?: boolean; value?: string; error?: string }>(`/api/debug/${id}/eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expr }),
    }),
  debugViz: (id: string, expr: string) =>
    req<VizData>(`/api/debug/${id}/viz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expr }),
    }),
  /**
   * clang-format 一键格式化（POST /api/format）：只读工作区文件并返回格式化全文，不写盘。
   * 失败时带 error + code（前端按 code 走 i18n）；style 可选，缺省由服务端决定
   * （有 .clang-format 用 file，否则 LLVM）。
   */
  formatFile: (file: string, style?: string) =>
    req<{ ok?: boolean; path?: string; content?: string; style?: string; bytes?: number; error?: string; code?: string }>(
      "/api/format",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, style }),
      }
    ),
  ai: (messages: AiMessage[]) =>
    req<{ content?: string; error?: string }>("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    }),
};

/** 建立 SSE 连接, 返回 EventSource */
export function openStream(
  url: string,
  handlers: Record<string, (data: unknown) => void>
): EventSource {
  const es = new EventSource(url);
  for (const [event, fn] of Object.entries(handlers)) {
    es.addEventListener(event, (e) => {
      try {
        fn(JSON.parse((e as MessageEvent).data as string));
      } catch {
        /* ignore parse errors */
      }
    });
  }
  return es;
}

export type { DebugStopped };

/** GET /api/fs/list 的条目（相对工作区的 POSIX 路径） */
export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}
