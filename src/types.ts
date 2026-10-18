import type { LanguageId } from "@/lib/i18n";

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
  /** clang-format（新增可选字段：旧服务端不返回时按不可用处理） */
  clangFormat?: ToolInfo;
}

/** 全局配色方案 */
export type ThemeName = "dark" | "light";

export interface Settings {
  compilerC?: string;
  compilerCpp?: string;
  gdbPath?: string;
  /** clang-format 可执行文件路径（留空自动从 PATH 查找；用于「格式化文档」） */
  clangFormatPath?: string;
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
  /**
   * 界面语言（持久化在 cpp-ide-data/settings.json）。
   * 可选字段：旧 settings.json 没有该字段、或写入非法值时一律按 "zh-CN" 处理（向后兼容）。
   */
  language?: LanguageId;
  // 编辑器功能开关（均为可选：旧的 settings.json 没有这些字段时按“开”处理）
  highlightSelectionMatches?: boolean; // 划词相同词高亮（仅标识符/关键字）
  highlightBracketPairs?: boolean; // 括号匹配高亮
  /** AI 内联流式补全（幽灵文本：打字停顿后在光标处显示建议，Tab 接受 / Esc 拒绝） */
  aiInlineComplete?: boolean;
  /** 自动保存：停止输入约 0.8 秒后自动落盘；关闭文件时也会立即保存（默认关，缺字段视为关） */
  autoSave?: boolean;
  /** 撤销历史最大步数（默认 500，合法范围 10–5000；调整后会重置已打开文件的撤销历史） */
  maxUndoSteps?: number;
  // -------------------------------------------------------------------------
  // 字体（均为可选：旧 settings.json 没有这些字段时用下面的默认值，向后兼容）
  // -------------------------------------------------------------------------
  /** 界面字体族（非编辑器区域；默认 "Segoe UI"，写入 --ide-ui-font） */
  uiFontFamily?: string;
  /** 界面字号 px（默认 13，合法范围 11–18，写入 --ide-ui-font-size） */
  uiFontSize?: number;
  /** 编辑器字体族（CodeMirror 代码区；默认 Consolas / 微软雅黑 / monospace 风格） */
  editorFontFamily?: string;
  /** 编辑器字号 px（默认 14，合法范围 10–32） */
  editorFontSize?: number;
  /** 编辑器 Tab 宽度（默认 4，合法范围 1–8） */
  editorTabSize?: number;
  /**
   * 调试求值控制台门控：开始调试前勾选，值为 true 才允许在暂停时对表达式求值。
   * 可选字段：旧 settings.json 没有该字段时按 false 处理（见 evalConsoleOf）；
   * 开始调试时会把当时的值快照进调试会话，运行中修改不影响已启动的会话。
   */
  evalConsole?: boolean;
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

/**
 * 读取「调试求值控制台」门控。
 * 字段缺失（旧 settings.json）或任何非 true 值一律视为 false（默认关闭）。
 */
export function evalConsoleOf(s: Settings | undefined): boolean {
  return s?.evalConsole === true;
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

/**
 * 读取界面语言。
 * 字段缺失（旧版 cpp-ide-data/settings.json）或为其它值时一律视为 "zh-CN"，
 * 保证升级前的用户界面观感完全不变。
 */
export function languageOf(s: Settings | undefined): LanguageId {
  return s?.language === "en-US" ? "en-US" : "zh-CN";
}

// ---------------------------------------------------------------------------
// 字体设置
// ---------------------------------------------------------------------------

/** 界面字体默认值（系统默认的西文字体；CSS 里还会追加中文/无衬线兜底） */
export const DEFAULT_UI_FONT_FAMILY = "Segoe UI";
/** 界面字号默认值 */
export const DEFAULT_UI_FONT_SIZE = 13;
/** 界面字号合法范围 */
export const UI_FONT_SIZE_RANGE = { min: 11, max: 18 } as const;

/** 编辑器字体默认值（等宽字体优先，附中文兜底） */
export const DEFAULT_EDITOR_FONT_FAMILY = "Consolas, 'Microsoft YaHei', '微软雅黑', monospace";
/** 编辑器字号默认值 */
export const DEFAULT_EDITOR_FONT_SIZE = 14;
/** 编辑器字号合法范围 */
export const EDITOR_FONT_SIZE_RANGE = { min: 10, max: 32 } as const;

/** 编辑器 Tab 宽度默认值 / 合法范围 */
export const DEFAULT_EDITOR_TAB_SIZE = 4;
export const EDITOR_TAB_SIZE_RANGE = { min: 1, max: 8 } as const;

/** 字号收敛：非数字回落到默认值，越界夹到合法区间并取整 */
function fontSizeOf(value: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** 字体族收敛：缺字段 / 空白 / 非字符串时回落到默认值 */
function fontFamilyOf(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.replace(/[;{}]/g, "").trim().slice(0, 200);
  return v || fallback;
}

/** 读取界面字体族（缺字段 / 非法值 → 默认 "Segoe UI"） */
export function uiFontFamilyOf(s: Settings | undefined): string {
  return fontFamilyOf(s?.uiFontFamily, DEFAULT_UI_FONT_FAMILY);
}

/** 读取界面字号（缺字段 / 非法值 → 13；越界夹到 11–18） */
export function uiFontSizeOf(s: Settings | undefined): number {
  return fontSizeOf(s?.uiFontSize, DEFAULT_UI_FONT_SIZE, UI_FONT_SIZE_RANGE);
}

/** 读取编辑器字体族（缺字段 / 非法值 → 默认等宽字体栈） */
export function editorFontFamilyOf(s: Settings | undefined): string {
  return fontFamilyOf(s?.editorFontFamily, DEFAULT_EDITOR_FONT_FAMILY);
}

/** 读取编辑器字号（缺字段 / 非法值 → 14；越界夹到 10–32） */
export function editorFontSizeOf(s: Settings | undefined): number {
  return fontSizeOf(s?.editorFontSize, DEFAULT_EDITOR_FONT_SIZE, EDITOR_FONT_SIZE_RANGE);
}

/** 读取编辑器 Tab 宽度（缺字段 / 非法值 → 4；越界夹到 1–8） */
export function editorTabSizeOf(s: Settings | undefined): number {
  return fontSizeOf(s?.editorTabSize, DEFAULT_EDITOR_TAB_SIZE, EDITOR_TAB_SIZE_RANGE);
}

/** 把任意字体族值转成可安全写进 CSS 的字体栈（单个含空格的族名自动加引号） */
export function fontFamilyToCss(value: string | undefined): string {
  const v = fontFamilyOf(value, DEFAULT_UI_FONT_FAMILY);
  // 含逗号 → 已是字体栈，原样使用（fontFamilyOf 已清掉可能破坏声明的字符）；
  // 已自带成对引号 → 也原样使用；单个族名（如 Microsoft YaHei）需要加引号，
  // 否则空格会被 CSS 当成多个族名。
  if (v.includes(",")) return v;
  if (/^(['"]).*\1$/.test(v)) return v;
  return `"${v.replace(/["\\]/g, "")}"`;
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

/** std::map / std::set 的一行（map 有 key；set 只有 value） */
export interface VizTableEntry {
  key?: string;
  value: string;
  type?: string;
}

/** 二叉树节点（id 为地址；left/right 指向 nodes 里的 id） */
export interface VizTreeNode {
  id: string;
  addr?: string;
  /** 节点上用于展示的值（优先 val/value/data/key/id/name） */
  label: string;
  fields?: VizField[];
  left?: string | null;
  right?: string | null;
}

/** 二维数组 / vector<vector> 的表格数据 */
export interface VizGrid {
  rows: { label: string; cells: VizField[] }[];
  cols: number;
}

export type VizKind =
  | "vector"
  | "array"
  | "list"
  | "struct"
  | "scalar"
  | "error"
  | "map"
  | "set"
  | "tree"
  | "grid";

export interface VizData {
  kind: VizKind;
  expr?: string;
  /** GDB 类型串，如 std::vector<int> / int [10] / Node * */
  type?: string;
  /** scalar 时的值 */
  value?: string;
  /** vector/array/struct 的（一层）元素 */
  elems?: VizField[];
  /** 链表的节点序列 */
  nodes?: VizNode[];
  /** map/set 的键值行（map 按中序展示；set 仅 value） */
  entries?: VizTableEntry[];
  /** 二叉树（root 为 nodes 里的 id） */
  tree?: { root: string; nodes: VizTreeNode[]; cycle?: boolean; truncated?: boolean };
  /** 二维表格（行/列索引由前端补角标） */
  grid?: VizGrid;
  /** 元素总数（可能因截断多于 elems.length） */
  total?: number;
  /** 因超出上限被截断 */
  truncated?: boolean;
  /** 链表检测到环 */
  cycle?: boolean;
  /** 服务端返回的机器可读提示码（前端走 i18n；未知值忽略） */
  note?: string;
  /** 服务端返回的错误码（前端走 i18n；未知值回落到 error 文本） */
  code?: string;
  error?: string;
}

export interface TermLine {
  kind: "in" | "out" | "err" | "sys";
  text: string;
}

/**
 * AI 聊天附带的「当前打开文件」上下文（可选字段）。
 * file 为工作区相对路径（如 src/main.cpp），selection 为当前选中文本（前端已截到 2KB）。
 * 不传时服务端 / AI 请求行为与旧版完全一致。
 */
export interface AiContext {
  file?: string;
  selection?: string;
}

/** 调试求值控制台的一行历史（expr 必有；成功给 value，失败给 error） */
export interface EvalConsoleLine {
  expr: string;
  value?: string;
  error?: string;
}

/** AI 的 run 工具结果：退出码 + 最后 2KB 输出（timedOut=true 时表示等待超时） */
export interface AiRunResult {
  ok: boolean;
  code?: number | null;
  output: string;
  timedOut?: boolean;
  error?: string;
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
