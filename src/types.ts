export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  message: string;
  raw: string;
  hint?: string;
}

export interface ToolInfo {
  found: boolean;
  path?: string;
  version?: string;
  source?: "path" | "settings";
}

export interface Toolchain {
  cc: ToolInfo;
  cxx: ToolInfo;
  gdb: ToolInfo;
}

/** 全局配色方案 */
export type ThemeName = "dark" | "light";

export interface Settings {
  compilerC?: string;
  compilerCpp?: string;
  gdbPath?: string;
  std?: string;
  buildMode?: string; // "debug"（默认 -g -O0）| "release"（-O2）
  extraFlags?: string; // 自定义编译参数，空格分隔，如 "-DDEBUG -lm"
  aiEndpoint?: string;
  aiKey?: string;
  aiModel?: string;
  /** 用户通过「打开目录」选定的工作区绝对路径（持久化在 cpp-ide-data/settings.json） */
  workspacePath?: string;
  /**
   * 全局配色方案（持久化在 cpp-ide-data/settings.json，重启后保持）。
   * 可选字段：旧 settings.json 没有该字段、或写入非法值时一律按 "dark" 处理（向后兼容）。
   */
  theme?: ThemeName;
  // 编辑器功能开关（均为可选：旧的 settings.json 没有这些字段时按“开”处理）
  highlightSelectionMatches?: boolean; // 划词相同词高亮（仅标识符/关键字）
  highlightBracketPairs?: boolean; // 括号匹配高亮
  /** AI 内联流式补全（幽灵文本：打字停顿后在光标处显示建议，Tab 接受 / Esc 拒绝） */
  aiInlineComplete?: boolean;
  /** 自动保存：停止输入约 0.8 秒后自动落盘；关闭文件时也会立即保存（默认关，缺字段视为关） */
  autoSave?: boolean;
  /** 撤销历史最大步数（默认 500，合法范围 10–5000；调整后会重置已打开文件的撤销历史） */
  maxUndoSteps?: number;
}

/** 编辑器功能开关的字段名 */
export type EditorFlag = "highlightSelectionMatches" | "highlightBracketPairs" | "aiInlineComplete";

/**
 * 读取编辑器功能开关。
 * 字段缺失（旧版 cpp-ide-data/settings.json）或为 undefined 时视为 true，保证向后兼容。
 */
export function editorFlagOn(s: Settings | undefined, flag: EditorFlag): boolean {
  return s?.[flag] !== false;
}

/** 撤销历史最大步数默认值 */
export const DEFAULT_MAX_UNDO_STEPS = 500;
/** 撤销历史步数的合法范围 */
export const MAX_UNDO_STEPS_RANGE = { min: 10, max: 5000 } as const;

/**
 * 读取撤销历史最大步数：缺字段 / 非数字时按默认值 500，超出范围时收敛到 10–5000。
 */
export function maxUndoStepsOf(s: Settings | undefined): number {
  const n = s?.maxUndoSteps;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_MAX_UNDO_STEPS;
  return Math.min(MAX_UNDO_STEPS_RANGE.max, Math.max(MAX_UNDO_STEPS_RANGE.min, Math.floor(n)));
}

/**
 * 读取配色方案。
 * 字段缺失（旧版 cpp-ide-data/settings.json）或为其它值时一律视为 "dark"，
 * 保证升级前的用户界面观感完全不变。
 */
export function themeOf(s: Settings | undefined): ThemeName {
  return s?.theme === "light" ? "light" : "dark";
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

export interface CompileResult {
  ok: boolean;
  exe?: string;
  diagnostics: Diagnostic[];
  output: string;
  ms?: number;
  noCompiler?: boolean;
  need?: string;
  compiler?: string;
  error?: string;
  /** 本次编译所用构建系统的探测结果（服务端新增字段，旧版本服务端缺省） */
  buildSystem?: BuildSystemInfo;
}

// ---------------------------------------------------------------------------
// 构建系统（服务端探测：CMakeLists.txt > Makefile/makefile > 单文件 g++）
// ---------------------------------------------------------------------------

/** 构建系统类型：CMake / Make / 单文件 g++ */
export type BuildSystemKind = "cmake" | "make" | "single";

/** 单个构建工具（cmake/make/ninja）的存在性 */
export interface ToolPresence {
  found: boolean;
  path?: string;
  /** known = 本机已知绝对路径；path = 从 PATH 里找到的 */
  source?: "known" | "path";
}

/** GET /api/buildsystem、GET /api/files、GET /api/workspace、POST /api/compile 带回的探测结果 */
export interface BuildSystemInfo {
  kind: BuildSystemKind;
  /** 徽标文案：「CMake」/「Make」/「g++ 单文件」 */
  label: string;
  /** 判定依据（描述文件名或降级原因） */
  evidence: string;
  tools: Record<"cmake" | "make" | "ninja", ToolPresence>;
  /** 工具缺失导致降级时的中文提示；正常时缺省 */
  warning?: string;
}

export interface WatchVar {
  expr: string;
  value?: string;
  error?: string;
}

export interface DebugFrame {
  level: number;
  func: string;
  file: string;
  line: number;
}

export interface DebugStopped {
  reason: string;
  file: string;
  line: number;
  func: string;
  vars: WatchVar[];
  locals: { name: string; value: string }[];
  stack: DebugFrame[];
}

// ---- 数据结构可视化（调试暂停时由 /api/debug/:id/viz 返回）----
export interface VizField {
  label: string;
  value: string;
  type?: string;
}

export interface VizNode {
  index: number;
  /** 节点地址（链表防环/标注用） */
  addr?: string;
  fields: VizField[];
}

export interface VizData {
  kind: "vector" | "array" | "list" | "struct" | "scalar" | "error";
  expr?: string;
  /** GDB 类型串，如 std::vector<int> / int [10] / Node * */
  type?: string;
  /** scalar 时的值 */
  value?: string;
  /** vector/array/struct 的（一层）元素 */
  elems?: VizField[];
  /** 链表的节点序列 */
  nodes?: VizNode[];
  /** 元素总数（可能因截断多于 elems.length） */
  total?: number;
  /** 因超出上限被截断 */
  truncated?: boolean;
  /** 链表检测到环 */
  cycle?: boolean;
  error?: string;
}

export interface TermLine {
  kind: "in" | "out" | "err" | "sys";
  text: string;
}

export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /**
   * 该条回复生成过程中 AI 实际执行的本地工具动作（一行一条中文小字，渲染在气泡上方）。
   * 仅 AiPanel 的工具调用循环会写入；历史消息 / 其他入口留空。
   */
  toolActions?: string[];
}

export interface Breakpoint {
  file: string;
  line: number;
}

// ---------------------------------------------------------------------------
// AI 一键修复
// ---------------------------------------------------------------------------

/** 单个待修复文件：「发给 AI 的原文」与「AI 返回的新内容」 */
export interface AiFixFile {
  /** 工作区相对路径（与 store.contents / /api/file 的 path 一致） */
  path: string;
  /** 请求时该文件的完整内容（未被截断，保证写回安全） */
  original: string;
  /** AI 返回的修正后完整内容 */
  fixed: string;
}

export type AiFixStatus = "idle" | "loading" | "ready" | "error";

export interface AiFixState {
  /** idle=弹层关闭；loading=请求中；ready=可预览；error=失败提示 */
  status: AiFixStatus;
  /** 中文错误提示（请求失败 / 超时 / 返回无法解析 / 部分写回失败） */
  error: string;
  /** AI 的附加说明或本次上下文的取舍说明（例如跳过了过大的文件） */
  note: string;
  files: AiFixFile[];
  /** 当前预览的文件下标 */
  active: number;
}

/** aiFix 的初始（弹层关闭）状态：只读，写入时一律先展开成新对象 */
export const AI_FIX_IDLE: AiFixState = { status: "idle", error: "", note: "", files: [], active: 0 };

/** POST /api/workspace/open 的返回；失败时只有 error（中文） */
export interface OpenWorkspaceResult {
  ok?: boolean;
  workspace?: string;
  tree?: FileNode[];
  /** 切换后的构建系统探测结果（新增字段） */
  buildSystem?: BuildSystemInfo;
  error?: string;
}

/** GET /api/workspace/pick 的返回；用户取消或无桌面会话时 cancelled=true */
export interface PickDirResult {
  ok?: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}
