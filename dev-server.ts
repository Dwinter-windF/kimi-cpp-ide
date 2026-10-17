/**
 * Kimi C++ IDE - 本地开发服务器中间件
 * 提供: 工具链检测 / 文件管理 / 编译 / 运行(SSE 流式终端) / GDB 调试(MI2) / AI 代理
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { Plugin } from "vite";

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "cpp-ide-data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const isWin = process.platform === "win32";
const SRC_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".C"]);

/**
 * 工作区内的临时目录：本机安全软件拦截 %TEMP%（AppData\Local\Temp）写入，
 * cc1plus/as/ld 等编译子进程在其中创建临时文件会直接失败（"cannot create temporary file"）。
 * 统一把子进程的 TEMP/TMP/TMPDIR 指到这里；运行脚本/输出文件也放这里。
 */
const LOCAL_TMP = path.join(ROOT, ".ide-tmp");
try { fs.mkdirSync(LOCAL_TMP, { recursive: true }); } catch { /* 启动后再试 */ }
function tmpEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, TEMP: LOCAL_TMP, TMP: LOCAL_TMP, TMPDIR: LOCAL_TMP };
}

/** 路径存在且确实是目录（切换工作区时的硬校验） */
function isRealDir(p: string | null | undefined): p is string {
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 当前工作区根目录：可通过 POST /api/workspace/open 在运行期切换，因此必须是 let
 * （toAbs/toRel/buildTree/compileSources 等都闭包引用它，切换后自动生效）。
 * 初始值优先级：CPP_IDE_WORKSPACE（standalone.ts 解析后传入）> settings.json 的 workspacePath > ROOT/workspace
 */
let WORKSPACE: string = (() => {
  const fromEnv = process.env.CPP_IDE_WORKSPACE?.trim();
  if (isRealDir(fromEnv)) return path.resolve(fromEnv);
  const saved = loadSettings().workspacePath?.trim();
  if (isRealDir(saved)) return path.resolve(saved);
  return path.join(ROOT, "workspace");
})();
/**
 * 构建输出目录：必须始终位于 WORKSPACE 内，
 * 否则编译产物经 toRel 得到的相对路径会被 toAbs 判为越界，/api/run 找不到 exe。
 */
let BUILD_DIR = path.join(WORKSPACE, ".build");

/**
 * 让编译器子进程（cc1plus/as/ld）与其编译出的 exe 能找到工具链 DLL：
 * 将可执行文件所在目录临时前置到 PATH。MSYS2 工具链不在系统 PATH 时必须有此项。
 */
let lastToolDir: string | null = null;
function toolEnv(exePath?: string | null): NodeJS.ProcessEnv | undefined {
  const dir = exePath ? path.dirname(exePath) : lastToolDir;
  if (!dir) return undefined;
  lastToolDir = dir;
  const sep = isWin ? ";" : ":";
  return tmpEnv({ ...process.env, PATH: dir + sep + (process.env.PATH || "") });
}

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
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
  /** 用户通过「打开目录」选定的工作区绝对路径（持久化，下次启动优先使用） */
  workspacePath?: string;
}

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  message: string;
  raw: string;
}

export interface ToolInfo {
  found: boolean;
  path?: string;
  version?: string;
  source?: "path" | "settings";
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Settings;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveSettings(s: Settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// 工具链检测
// ---------------------------------------------------------------------------
function findOnPath(name: string): string | null {
  const cmd = isWin ? "where" : "which";
  try {
    const r = spawnSync(cmd, [name], { encoding: "utf-8", timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) return first;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function versionOf(exe: string): string | undefined {
  try {
    const r = spawnSync(exe, ["--version"], { encoding: "utf-8", timeout: 8000 });
    const line = (r.stdout || r.stderr || "").split(/\r?\n/)[0].trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}

function resolveTool(configured: string | undefined, candidates: string[]): ToolInfo {
  if (configured && configured.trim()) {
    const p = configured.trim();
    if (fs.existsSync(p)) {
      return { found: true, path: p, version: versionOf(p), source: "settings" };
    }
    return { found: false, source: "settings" };
  }
  for (const c of candidates) {
    const p = findOnPath(c);
    if (p) return { found: true, path: p, version: versionOf(p), source: "path" };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// 构建系统探测（CMakeLists.txt > Makefile/makefile > 单文件 g++）
// ---------------------------------------------------------------------------
/** 构建系统需要的外部工具 */
type BuildToolName = "cmake" | "make" | "ninja";

/** 探测到的构建系统类型 */
export type BuildSystemKind = "cmake" | "make" | "single";

/** 工具存在性（探测用，不带版本号：--version 有进程开销，探测会被高频接口触发） */
export interface ToolPresence {
  found: boolean;
  path?: string;
  /** known = 本机已知绝对路径；path = 从 PATH 里找到的 */
  source?: "known" | "path";
}

/** 构建系统判定结果（原样返回给前端做徽标 + 降级提示） */
export interface BuildSystemInfo {
  kind: BuildSystemKind;
  /** 徽标文案：「CMake」/「Make」/「g++ 单文件」 */
  label: string;
  /** 判定依据（描述文件名或降级原因） */
  evidence: string;
  tools: Record<BuildToolName, ToolPresence>;
  /** 工具缺失导致降级时的中文提示；正常时缺省 */
  warning?: string;
}

/** MSYS2 UCRT64 的工具目录：make/ninja 与 Makefile 里裸写的 g++ 都靠它 */
const MSYS2_BIN = "C:\\msys64\\ucrt64\\bin";
/**
 * 本机工具链的已知绝对路径（用户已确认安装）。
 * 探测只做 fs.existsSync，不 spawn 进程；找不到再退回 PATH 查找。
 */
const KNOWN_TOOL_PATHS: Record<BuildToolName, string[]> = {
  cmake: ["C:\\Program Files\\CMake\\bin\\cmake.exe", path.join(MSYS2_BIN, "cmake.exe")],
  make: [path.join(MSYS2_BIN, "mingw32-make.exe"), path.join(MSYS2_BIN, "make.exe")],
  ninja: [path.join(MSYS2_BIN, "ninja.exe")],
};

/**
 * PATH 查找缓存：findOnPath 会 spawn `where`，而探测可能被 /api/files 等高频接口触发。
 * 命中永久缓存；未命中只缓存 10 秒（用户刚装好工具时不必重启服务）。
 */
const PATH_LOOKUP_TTL = 10_000;
const pathLookupCache = new Map<string, { at: number; path: string | null }>();

function findOnPathCached(name: string): string | null {
  const now = Date.now();
  const hit = pathLookupCache.get(name);
  if (hit && (hit.path || now - hit.at < PATH_LOOKUP_TTL)) return hit.path;
  const p = findOnPath(name);
  pathLookupCache.set(name, { at: now, path: p });
  return p;
}

/** 探测单个构建工具：先本机已知绝对路径，再 PATH */
function findBuildTool(name: BuildToolName): ToolPresence {
  for (const p of KNOWN_TOOL_PATHS[name]) {
    try {
      if (fs.existsSync(p)) return { found: true, path: p, source: "known" };
    } catch {
      /* ignore */
    }
  }
  // make 在 MSYS2 里叫 mingw32-make，两种名字都试
  const names = name === "make" ? ["mingw32-make", "make"] : [name];
  for (const n of names) {
    const p = findOnPathCached(n);
    if (p) return { found: true, path: p, source: "path" };
  }
  return { found: false };
}

/** 参与判定 Makefile 的文件名（Windows 下不区分大小写，这里按常见写法列全） */
const MAKE_FILE_NAMES = ["Makefile", "makefile", "GNUmakefile"];

/**
 * 探测当前工作区的构建系统，优先级：① CMakeLists.txt > ② Makefile/makefile > ③ 单文件 g++。
 * 工具缺失时逐级降级（cmake/ninja 缺 → 有 Makefile 就退 make，否则退单文件），
 * 并在 warning 里给出中文说明，前端徽标据此提示。
 * 每次调用都重新读文件系统，因此打开目录 / 增删 Makefile 后重新调用即可得到新结果。
 */
export function detectBuildSystem(): BuildSystemInfo {
  const tools: Record<BuildToolName, ToolPresence> = {
    cmake: findBuildTool("cmake"),
    make: findBuildTool("make"),
    ninja: findBuildTool("ninja"),
  };
  const cmakeLists = path.join(WORKSPACE, "CMakeLists.txt");
  const hasCmakeLists = fs.existsSync(cmakeLists);
  const makeFile = MAKE_FILE_NAMES.map((n) => path.join(WORKSPACE, n)).find((p) => fs.existsSync(p));

  if (hasCmakeLists) {
    const missing = [!tools.cmake.found ? "cmake" : "", !tools.ninja.found ? "ninja" : ""].filter(Boolean);
    if (missing.length === 0) return { kind: "cmake", label: "CMake", evidence: "CMakeLists.txt", tools };
    const why = `检测到 CMakeLists.txt，但未找到 ${missing.join(" / ")}，已降级`;
    if (makeFile && tools.make.found) {
      return { kind: "make", label: "Make", evidence: path.basename(makeFile), tools, warning: `${why}为 make 构建。` };
    }
    return {
      kind: "single",
      label: "g++ 单文件",
      evidence: "未发现可用的构建系统",
      tools,
      warning: `${why}为单文件 g++ 编译（安装 cmake / ninja 后可自动改用 CMake）。`,
    };
  }

  if (makeFile) {
    if (tools.make.found) return { kind: "make", label: "Make", evidence: path.basename(makeFile), tools };
    return {
      kind: "single",
      label: "g++ 单文件",
      evidence: "未发现可用的构建系统",
      tools,
      warning: `检测到 ${path.basename(makeFile)}，但未找到 make（mingw32-make.exe），已降级为单文件 g++ 编译。`,
    };
  }

  return { kind: "single", label: "g++ 单文件", evidence: "未发现 CMakeLists.txt / Makefile", tools };
}

// ---------------------------------------------------------------------------
// 工作区文件管理
// ---------------------------------------------------------------------------
function toAbs(rel: string): string | null {
  const p = path.resolve(WORKSPACE, rel);
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + path.sep)) return null;
  return p;
}

function toRel(abs: string): string {
  return path.relative(WORKSPACE, abs).split(path.sep).join("/");
}

/**
 * AI 文件工具的大小上限（/api/fs/*）：
 *  - 单文件读取 1MB：防止把超大文件塞进模型上下文；
 *  - 单次写入 2MB：防止模型误写超大内容撑爆磁盘/编辑器。
 */
const FS_READ_LIMIT = 1024 * 1024;
const FS_WRITE_LIMIT = 2 * 1024 * 1024;

/**
 * 拖拽导入（POST /api/fs/upload）的单文件上限：8MB。
 * 为什么不沿用上面的 2MB：
 *  - /api/fs/write 是给 AI 模型写文件的，模型单次输出本就很小，2MB 足够且能防止误写撑爆磁盘；
 *  - 拖拽导入是用户主动从资源管理器挑选的真实源文件，需要装下较大的第三方单文件库
 *    （例如 sqlite3.c 约 8MB 量级、各种 *-single-header 库几百 KB），2MB 明显不够用；
 *  - 但也不能不设限：请求体是 base64（体积约膨胀 4/3），Node 侧还要再解码出一份 Buffer，
 *    8MB 意味着单次请求峰值内存约 19MB（11MB 请求体 + 8MB 缓冲），可控又不至于被误操作打爆。
 */
const FS_UPLOAD_LIMIT = 8 * 1024 * 1024;

/**
 * 同名文件自动改名：name.cpp → name-1.cpp → name-2.cpp …（最多探测 999 次）。
 * 返回第一个不存在的绝对路径；极端情况（999 个同名）返回 null，由调用方报 409。
 * 注意保留完整扩展名：archive.tar.gz → archive.tar-1.gz（与系统「副本」命名习惯一致，不丢后缀）。
 */
function uniquePath(abs: string): string | null {
  if (!fs.existsSync(abs)) return abs;
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  for (let i = 1; i <= 999; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 越界路径统一的中文错误（403） */
function fsOutOfRange(raw: string): { error: string } {
  return { error: `越界：只能访问当前工作区内的路径（收到：${raw}）` };
}

interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

function buildTree(dir: string): FileNode[] {
  const out: FileNode[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    if (e.name === ".build" || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: toRel(abs), type: "dir", children: buildTree(abs) });
    } else if (e.isFile()) {
      out.push({ name: e.name, path: toRel(abs), type: "file" });
    }
  }
  return out;
}

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === ".build") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectSources(abs));
    else if (SRC_EXTS.has(path.extname(e.name))) out.push(abs);
  }
  return out;
}

export function seedWorkspace() {
  const main = path.join(WORKSPACE, "main.cpp");
  if (!fs.existsSync(main) && buildTree(WORKSPACE).length === 0) {
    fs.writeFileSync(
      main,
      [
        "#include <iostream>",
        "#include <vector>",
        "",
        "int fib(int n) {",
        "    if (n < 2) return n;",
        "    return fib(n - 1) + fib(n - 2);",
        "}",
        "",
        "int main() {",
        "    std::vector<int> v;",
        "    for (int i = 0; i < 10; i++) v.push_back(fib(i));",
        "    for (int x : v) std::cout << x << \" \";",
        "    std::cout << std::endl;",
        "    return 0;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
  }
}

// ---------------------------------------------------------------------------
// 工作区切换
// ---------------------------------------------------------------------------
/**
 * 切换工作区（供 POST /api/workspace/open 使用）：
 *   校验路径存在且为目录 → 预创建 .build（失败则不改动任何状态）
 *   → 终止进行中的运行/调试会话（防句柄泄漏）→ 切换 WORKSPACE/BUILD_DIR
 *   → 空目录则复用 seedWorkspace 生成示例 main.cpp → 持久化到 settings.json
 * 返回 { ok:true, workspace } 或 { error: 中文错误信息 }。
 */
function switchWorkspace(raw: string): { ok: true; workspace: string } | { error: string } {
  // 允许用户直接粘贴带引号的路径（Windows 资源管理器「复制文件地址」会带引号）
  const clean = (raw || "").trim().replace(/^"(.*)"$/, "$1").trim();
  if (!clean) return { error: "请填写要打开为工作区的目录路径" };
  const abs = path.resolve(clean);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `目录不存在：${abs}` };
  }
  if (!st.isDirectory()) return { error: `不是目录：${abs}` };
  // 先建构建目录：不写权限等问题在切换状态之前就报错，避免切到半残状态
  const buildDir = path.join(abs, ".build");
  try {
    fs.mkdirSync(buildDir, { recursive: true });
  } catch {
    return { error: `无法在目标目录创建 .build 构建目录（可能没有写入权限）：${abs}` };
  }
  // 硬约束：切换目录必须终止进行中的运行/调试会话，否则旧进程句柄会一直挂在工作区上
  shutdownAll();
  WORKSPACE = abs;
  BUILD_DIR = buildDir;
  seedWorkspace();
  saveSettings({ ...loadSettings(), workspacePath: WORKSPACE });
  return { ok: true, workspace: WORKSPACE };
}

// ---------------------------------------------------------------------------
// 原生目录选择对话框（Windows / PowerShell FolderBrowserDialog）
// ---------------------------------------------------------------------------
/** 用户在对话框里停留的容忍上限（毫秒），超时自动关掉对话框避免悬挂 */
const PICK_TIMEOUT_MS = 180000;
let pickerBusy = false;

/**
 * 弹出系统原生「选择文件夹」对话框，返回用户选中的目录。
 * 关键点：
 *  - powershell -STA：FolderBrowserDialog 是 STA 组件，必须单线程套间；
 *  - 用一个不可见但 TopMost 的 Form 当 owner，服务进程没有前台窗口时对话框仍能显示在最前；
 *  - 结果写临时文件（UTF-8），绕开 stdout 重定向时 OEM 代码页把中文路径弄乱的问题；
 *  - 用户取消 / 无桌面会话 / 无 powershell → 统一 { ok:false, cancelled:true }，前端用手动输入兜底。
 */
function pickDirectory(): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> {
  if (!isWin) {
    return Promise.resolve({ ok: false, cancelled: true, error: "当前系统没有原生目录选择框，请手动输入路径" });
  }
  if (pickerBusy) {
    return Promise.resolve({ ok: false, cancelled: true, error: "已有一个目录选择框处于打开状态" });
  }
  const id = "kimi-pick-" + Date.now() + "-" + seq++;
  const scriptFile = path.join(LOCAL_TMP, id + ".ps1");
  const outFile = path.join(LOCAL_TMP, id + ".txt");
  const script = [
    "param([string]$OutFile)",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Add-Type -AssemblyName System.Windows.Forms",
    "  $owner = New-Object System.Windows.Forms.Form",
    "  $owner.Text = 'Kimi C++ IDE'",
    "  $owner.StartPosition = 'CenterScreen'",
    "  $owner.Width = 1",
    "  $owner.Height = 1",
    "  $owner.ShowInTaskbar = $false",
    "  $owner.TopMost = $true",
    "  $owner.Opacity = 0",
    "  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    "  $dlg.Description = '选择作为工作区的文件夹'",
    "  $dlg.ShowNewFolderButton = $true",
    "  $owner.Show()",
    "  $owner.Activate()",
    "  $r = $dlg.ShowDialog($owner)",
    "  $owner.Close()",
    "  if ($r -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {",
    "    [System.IO.File]::WriteAllText($OutFile, $dlg.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))",
    "    exit 0",
    "  }",
    "  exit 2",
    "} catch {",
    "  exit 3",
    "}",
    "",
  ].join("\r\n");
  try {
    // BOM：powershell 5.1 读取含中文的脚本时按 UTF-8 解析
    fs.writeFileSync(scriptFile, "\uFEFF" + script, "utf-8");
  } catch {
    return Promise.resolve({ ok: false, cancelled: true, error: "无法创建临时脚本文件，请手动输入路径" });
  }

  pickerBusy = true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; path?: string; cancelled?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pickerBusy = false;
      try {
        fs.rmSync(scriptFile, { force: true });
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const proc = spawn(
      "powershell.exe",
      ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile, outFile],
      { windowsHide: true, stdio: "ignore" }
    );
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, cancelled: true, error: "目录选择框等待超时" });
    }, PICK_TIMEOUT_MS);
    proc.on("error", () => finish({ ok: false, cancelled: true, error: "无法启动 PowerShell，请手动输入路径" }));
    proc.on("close", (code) => {
      if (settled) return;
      let picked = "";
      try {
        if (fs.existsSync(outFile)) picked = fs.readFileSync(outFile, "utf-8").replace(/^\uFEFF/, "").trim();
      } catch {
        /* ignore */
      }
      if (code === 0 && picked) finish({ ok: true, path: picked });
      else finish({ ok: false, cancelled: true });
    });
  });
}

// ---------------------------------------------------------------------------
// SSE 辅助
// ---------------------------------------------------------------------------
type SseClient = http.ServerResponse;
function sseInit(res: SseClient) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
}
function sseSend(res: SseClient, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client gone */
  }
}
function broadcast(clients: Set<SseClient>, event: string, data: unknown) {
  for (const c of clients) sseSend(c, event, data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// 编译
// ---------------------------------------------------------------------------
function parseDiagnostics(raw: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const re = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) {
      diags.push({
        file: m[1].trim(),
        line: parseInt(m[2], 10),
        col: parseInt(m[3], 10),
        severity: m[4] === "warning" ? "warning" : m[4] === "note" ? "note" : "error",
        message: m[5].trim(),
        raw: line,
      });
      continue;
    }
    const ld = line.match(/undefined reference to [`']([^`']+)[`']/);
    if (ld) {
      diags.push({
        file: "",
        line: 0,
        col: 0,
        severity: "error",
        message: `链接错误: 未定义的引用 '${ld[1]}'（通常是函数只声明未实现，或编译时漏掉了某个源文件）`,
        raw: line,
      });
    }
  }
  return diags;
}

// ---------------------------------------------------------------------------
// 构建系统执行（CMake / Make）
// ---------------------------------------------------------------------------
interface BuildRun {
  code: number | null;
  output: string;
}

/** 即将返回给前端的编译结果（exe 为工作区相对路径） */
interface BuildOutcome {
  ok: boolean;
  exe?: string;
  diagnostics: Diagnostic[];
  output: string;
  ms?: number;
  compiler?: string;
  error?: string;
}

/** 执行一条构建命令（make/cmake），stdout+stderr 按到达顺序合并成一份输出 */
function runBuildCommand(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<BuildRun> {
  return new Promise((resolve) => {
    let output = "";
    const proc = spawn(exe, args, { cwd: WORKSPACE, env, windowsHide: true });
    proc.stdout?.on("data", (d) => (output += d.toString()));
    proc.stderr?.on("data", (d) => (output += d.toString()));
    proc.on("error", (e) => resolve({ code: -1, output: output + `\n${String(e)}` }));
    proc.on("close", (code) => resolve({ code, output }));
  });
}

/**
 * 构建子进程环境：把 MSYS2 的 bin 与相关工具/编译器所在目录前置到 PATH。
 * 目的：Makefile 里常裸写 g++/cmake，工具链不在系统 PATH 时也能被找到；
 * 同时让 make/cmake 生成的 exe 能找到 g++ 的运行时 DLL。
 */
function buildToolEnv(exePaths: (string | undefined | null)[]): NodeJS.ProcessEnv {
  const sep = isWin ? ";" : ":";
  const dirs: string[] = [MSYS2_BIN];
  for (const p of exePaths) if (p) dirs.push(path.dirname(p));
  const seen = new Set<string>();
  const prepend = dirs.filter((d) => {
    const key = d.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...process.env, PATH: prepend.join(sep) + sep + (process.env.PATH || "") };
}

/** 与单文件流程相同的诊断路径规范化：工作区内的绝对路径转成相对路径 */
function normalizeDiagnostics(raw: string): Diagnostic[] {
  return parseDiagnostics(raw).map((d) => {
    const abs = d.file ? path.resolve(WORKSPACE, d.file) : "";
    if (abs && d.file && fs.existsSync(abs) && abs.startsWith(WORKSPACE)) return { ...d, file: toRel(abs) };
    return d;
  });
}

/**
 * 在目录树下挑选「修改时间最新」的 .exe 作为运行目标。
 * 为什么用时间戳而不是固定名字：make/CMake 的产物名由用户的 Makefile / CMakeLists.txt 决定
 * （可能是 a.exe、app.exe，甚至多目标），IDE 不解析构建脚本就无法可靠推断；
 * 「最新生成的 exe」= 本次构建刚产出的目标，是最稳的启发式。
 * 排除目录由调用方给出：构建缓存（.build*、CMakeFiles）里的 exe 是编译器探测产物，不是程序。
 */
function findNewestExe(root: string, skipDir: (name: string) => boolean): string | null {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 已被删除的目录直接跳过
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDir(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".exe")) continue;
      try {
        found.push({ path: abs, mtime: fs.statSync(abs).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  };
  walk(root);
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].path;
}

/** CMake 构建目录（工作区内，与 .build 并列；点目录不会出现在文件树里） */
function cmakeBuildDir(): string {
  return path.join(WORKSPACE, ".build-cmake");
}

/**
 * ① CMake 构建：cmake -S <ws> -B <ws>/.build-cmake -G Ninja → cmake --build <ws>/.build-cmake。
 * - CC/CXX 指到设置里的编译器（否则 CMake 会自己找一套可能缺 DLL 的 gcc）；
 * - -DCMAKE_MAKE_PROGRAM 必须是 ninja 的绝对路径（Ninja 不在 PATH 时也要能找到）；
 * - 构建失败时 stderr 全量进 output，前端错误展示与 AI 一键修复链路照旧。
 */
async function buildWithCmake(bs: BuildSystemInfo, settings: Settings): Promise<BuildOutcome> {
  const cmake = bs.tools.cmake.path!;
  const ninja = bs.tools.ninja.path!;
  const buildDir = cmakeBuildDir();
  const t0 = Date.now();
  const cxx = resolveTool(settings.compilerCpp, ["g++", "clang++"]);
  const cc = resolveTool(settings.compilerC, ["gcc", "clang"]);
  const env = buildToolEnv([cmake, ninja, cxx.path, cc.path]);
  if (cxx.path) env.CXX = cxx.path;
  if (cc.path) env.CC = cc.path;
  const buildType = settings.buildMode === "release" ? "Release" : "Debug";

  const configure = await runBuildCommand(
    cmake,
    ["-S", WORKSPACE, "-B", buildDir, "-G", "Ninja", "-DCMAKE_MAKE_PROGRAM=" + ninja, "-DCMAKE_BUILD_TYPE=" + buildType],
    env
  );
  let output = `$ cmake -S . -B .build-cmake -G Ninja -DCMAKE_BUILD_TYPE=${buildType}\n${configure.output}`;
  if (configure.code !== 0) {
    return { ok: false, diagnostics: normalizeDiagnostics(configure.output), output, ms: Date.now() - t0, compiler: cmake };
  }

  const build = await runBuildCommand(cmake, ["--build", buildDir], env);
  output += `\n$ cmake --build .build-cmake\n${build.output}`;
  const diagnostics = normalizeDiagnostics(build.output);
  if (build.code !== 0) {
    return { ok: false, diagnostics, output, ms: Date.now() - t0, compiler: cmake };
  }

  // 运行目标：在 .build-cmake 里找最新的 .exe；CMakeFiles/ 下是编译器探测产物，必须排除
  const exeAbs = findNewestExe(buildDir, (n) => n === "CMakeFiles" || n === "Testing" || n.startsWith("."));
  if (!exeAbs) {
    return {
      ok: false,
      diagnostics,
      output,
      ms: Date.now() - t0,
      compiler: cmake,
      error:
        "CMake 构建成功，但在 .build-cmake 里没有找到可执行文件（.exe）。" +
        "请确认 CMakeLists.txt 中有 add_executable(...)（若只定义了库目标，请补一个可执行目标）。",
    };
  }
  return { ok: true, exe: toRel(exeAbs), diagnostics, output, ms: Date.now() - t0, compiler: cmake };
}

/**
 * ② Make 构建：mingw32-make.exe -C <ws>。
 * 环境里把 C:\msys64\ucrt64\bin 前置到 PATH，让 Makefile 里裸写的 g++ 能被找到。
 * 运行目标策略：make 不会告诉我们产物名，取工作区里「时间戳最新的 .exe」，
 * 排除 .build*（IDE 自己的输出目录）等构建缓存目录。
 */
async function buildWithMake(bs: BuildSystemInfo, settings: Settings): Promise<BuildOutcome> {
  const make = bs.tools.make.path!;
  const t0 = Date.now();
  const cxx = resolveTool(settings.compilerCpp, ["g++", "clang++"]);
  const cc = resolveTool(settings.compilerC, ["gcc", "clang"]);
  const env = buildToolEnv([make, cxx.path, cc.path]);
  const r = await runBuildCommand(make, ["-C", WORKSPACE], env);
  const output = `$ mingw32-make -C .\n${r.output}`;
  const diagnostics = normalizeDiagnostics(r.output);
  if (r.code !== 0) {
    return { ok: false, diagnostics, output, ms: Date.now() - t0, compiler: make };
  }
  const exeAbs = findNewestExe(WORKSPACE, (n) => n.startsWith(".") || n === "CMakeFiles" || n === "node_modules");
  if (!exeAbs) {
    return {
      ok: false,
      diagnostics,
      output,
      ms: Date.now() - t0,
      compiler: make,
      error:
        "make 执行成功，但没有在工作区里找到生成的 .exe。" +
        "请确认 Makefile 的默认目标（all）会链接出可执行文件（例如 g++ -o app.exe main.cpp）。",
    };
  }
  return { ok: true, exe: toRel(exeAbs), diagnostics, output, ms: Date.now() - t0, compiler: make };
}

/**
 * 编译入口（POST /api/compile）：
 *   ① 工作区根有 CMakeLists.txt 且 cmake+ninja 可用 → CMake 构建（.build-cmake）
 *   ② 有 Makefile/makefile 且 make 可用       → mingw32-make 构建
 *   ③ 其余（含工具缺失降级）                  → 原有单文件 g++ 流程 compileSingleFile（逐行未改）
 * 三条路径的返回值都附带 buildSystem 探测结果，供前端徽标与终端提示使用。
 */
async function compileSources(mainRel: string, project: boolean, std?: string): Promise<unknown> {
  const settings = loadSettings();
  const bs = detectBuildSystem();
  if (bs.kind === "cmake") {
    return { ...(await buildWithCmake(bs, settings)), buildSystem: bs };
  }
  if (bs.kind === "make") {
    return { ...(await buildWithMake(bs, settings)), buildSystem: bs };
  }
  // 单文件：compileSingleFile 就是改造前的 compileSources 本体，逻辑一行未动
  const r = (await compileSingleFile(mainRel, project, std)) as Record<string, unknown>;
  return { ...r, buildSystem: bs };
}

async function compileSingleFile(mainRel: string, project: boolean, std?: string): Promise<unknown> {
  const settings = loadSettings();
  const mainAbs = toAbs(mainRel);
  if (!mainAbs || !fs.existsSync(mainAbs)) {
    return { ok: false, diagnostics: [], output: `找不到文件: ${mainRel}` };
  }
  let sources: string[];
  if (project) {
    sources = collectSources(WORKSPACE);
    if (!sources.includes(mainAbs)) sources.push(mainAbs);
  } else {
    sources = [mainAbs];
  }
  const hasCpp = sources.some((s) => path.extname(s) !== ".c");
  const tool = hasCpp
    ? resolveTool(settings.compilerCpp, ["g++", "clang++"])
    : resolveTool(settings.compilerC, ["gcc", "clang"]);
  if (!tool.found || !tool.path) {
    return {
      ok: false,
      diagnostics: [],
      output: "",
      noCompiler: true,
      need: hasCpp ? "C++ 编译器 (g++/clang++)" : "C 编译器 (gcc/clang)",
    };
  }
  const base = project ? "project" : path.basename(mainAbs, path.extname(mainAbs));
  const out = path.join(BUILD_DIR, base + (isWin ? ".exe" : ""));
  const stdFlag = (std || (hasCpp ? "c++17" : "c11")).startsWith("c++") || (std || "").startsWith("gnu++") ? `-${std || "c++17"}` : `-${std || "c11"}`;
  const optFlags = settings.buildMode === "release" ? ["-O2"] : ["-g", "-O0"];
  const extra = (settings.extraFlags || "").split(/\s+/).filter((f) => /^-/.test(f));
  const args = ["-std=" + stdFlag.replace(/^-/, ""), ...optFlags, "-Wall", "-I", WORKSPACE, ...extra, "-o", out, ...sources];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(tool.path!, args, { cwd: WORKSPACE, env: toolEnv(tool.path) });
    let outText = "";
    let errText = "";
    proc.stdout.on("data", (d) => (outText += d.toString()));
    proc.stderr.on("data", (d) => (errText += d.toString()));
    proc.on("error", (e) =>
      resolve({ ok: false, diagnostics: [], output: String(e), noCompiler: true, need: tool.path })
    );
    proc.on("close", (code) => {
      const raw = errText + outText;
      const diagnostics = parseDiagnostics(raw).map((d) => {
        const abs = d.file ? path.resolve(WORKSPACE, d.file) : "";
        if (abs && d.file && fs.existsSync(abs) && abs.startsWith(WORKSPACE)) {
          return { ...d, file: toRel(abs) };
        }
        return d;
      });
      resolve({
        ok: code === 0,
        exe: code === 0 ? toRel(out) : undefined,
        diagnostics,
        output: raw,
        ms: Date.now() - t0,
        compiler: tool.path,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 运行会话
// ---------------------------------------------------------------------------
interface RunSession {
  id: string;
  proc: ChildProcess;
  clients: Set<SseClient>;
  exited: boolean;
  /** 超时保护计时器：运行超过 RUN_TIMEOUT_MS 自动终止（防死循环卡死） */
  timer: NodeJS.Timeout;
  /**
   * 已广播事件的回放缓冲。前端「运行」是两步协议（POST 拿 id → GET 订阅 SSE），
   * 两步之间的网络间隙里快速程序可能已经输出完毕甚至退出；事件若只广播给
   * 当时的订阅者，晚到的订阅会永远收不到输出/退出 → 面板假死。
   * 迟到订阅先按序回放本缓冲，再转直播。
   */
  log: { event: string; data: unknown }[];
}
let runSession: RunSession | null = null;
/** 最近一次（可能已退出的）运行会话：供迟到订阅者按 id 回放，下一次运行时被覆盖 */
let lastRunSession: RunSession | null = null;
let seq = 1;

/** 单会话回放缓冲上限（防失控输出撑爆内存；exit 事件永远挤得进来） */
const RUN_LOG_CAP = 5000;
function recordRunEvent(session: RunSession, event: string, data: unknown) {
  if (session.log.length >= RUN_LOG_CAP) {
    const exitEntry = session.log.findIndex((e) => e.event === "exit");
    if (exitEntry >= 0) {
      // 缓冲已满且已有 exit（理论上不该再写）：直接丢弃
      return;
    }
    session.log.splice(0, 1);
  }
  session.log.push({ event, data });
}

/** 运行超时（毫秒）；交互式程序每次 stdin 输入会重置计时 */
const RUN_TIMEOUT_MS = 10000;

function armRunTimer(session: RunSession) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (session.exited || runSession !== session) return;
    const notice = {
      stream: "stderr",
      text: `\r\n[已自动终止：程序连续运行超过 ${RUN_TIMEOUT_MS / 1000} 秒（超时保护，防死循环）。等待输入的程序可通过继续输入延长。]\r\n`,
    };
    recordRunEvent(session, "out", notice);
    broadcast(session.clients, "out", notice);
    killRun();
  }, RUN_TIMEOUT_MS);
}

function killRun() {
  if (runSession && !runSession.exited) {
    try {
      clearTimeout(runSession.timer);
      if (isWin && runSession.proc.pid) {
        spawn("taskkill", ["/pid", String(runSession.proc.pid), "/T", "/F"]);
      } else {
        runSession.proc.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }
  runSession = null;
}

function startRun(exeRel: string): { id: string } | { error: string } {
  const exeAbs = toAbs(exeRel);
  if (!exeAbs || !fs.existsSync(exeAbs)) return { error: `找不到可执行文件: ${exeRel}（请先编译）` };
  lastRunSession = runSession; // 旧会话留作「迟到订阅回放」，下一次运行再覆盖
  killRun();
  const id = "run-" + seq++;
  let exeFinal = exeAbs;
  if (isWin && !exeFinal.toLowerCase().endsWith(".exe")) exeFinal += ".exe";
  const proc = spawn(exeFinal, [], { cwd: WORKSPACE, env: toolEnv() });
  const session: RunSession = {
    id,
    proc,
    clients: new Set(),
    exited: false,
    timer: setTimeout(() => {}, 0),
    log: [],
  };
  runSession = session;
  armRunTimer(session);
  // emit = 广播 + 记回放缓冲；迟到订阅者（POST→GET 间隙）先回放再转直播
  const emit = (stream: string, text: string) => {
    recordRunEvent(session, "out", { stream, text });
    broadcast(session.clients, "out", { stream, text });
  };
  proc.stdout?.on("data", (d) => emit("stdout", d.toString()));
  proc.stderr?.on("data", (d) => emit("stderr", d.toString()));
  proc.on("error", (e) => {
    clearTimeout(session.timer);
    recordRunEvent(session, "exit", { code: -1, error: String(e) });
    broadcast(session.clients, "exit", { code: -1, error: String(e) });
  });
  proc.on("close", (code) => {
    session.exited = true;
    clearTimeout(session.timer);
    recordRunEvent(session, "exit", { code });
    broadcast(session.clients, "exit", { code });
    for (const c of session.clients) try { c.end(); } catch { /* ignore */ }
    if (runSession === session) runSession = null;
    lastRunSession = session;
  });
  return { id };
}

// ---------------------------------------------------------------------------
// GDB MI 解析
// ---------------------------------------------------------------------------
function miUnescape(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 极简 MI 结果解析: key="value" / key={...} / key=[...] */
function miParseValue(t: string, i: number): [unknown, number] {
  while (i < t.length && t[i] === " ") i++;
  if (t[i] === '"') {
    let j = i + 1;
    let s = "";
    while (j < t.length && t[j] !== '"') {
      if (t[j] === "\\") {
        s += t[j] + (t[j + 1] || "");
        j += 2;
      } else {
        s += t[j];
        j++;
      }
    }
    return [miUnescape(s), j + 1];
  }
  if (t[i] === "{") {
    const obj: Record<string, unknown> = {};
    let j = i + 1;
    while (j < t.length && t[j] !== "}") {
      while (j < t.length && (t[j] === " " || t[j] === ",")) j++;
      let k = j;
      while (k < t.length && t[k] !== "=") k++;
      const key = t.slice(j, k);
      const [val, nj] = miParseValue(t, k + 1);
      obj[key] = val;
      j = nj > k ? nj : k + 1; // 进度保护: 异常输入也强制前移
      while (j < t.length && t[j] === " ") j++;
      if (t[j] === ",") j++;
    }
    return [obj, j + 1];
  }
  if (t[i] === "[") {
    const arr: unknown[] = [];
    let j = i + 1;
    while (j < t.length && t[j] !== "]") {
      while (j < t.length && (t[j] === " " || t[j] === ",")) j++;
      if (j < t.length && t[j] === "]") break;
      // MI 数组元素允许重复键形式 key=value（如 stack=[frame={...},frame={...}]），
      // 检测到 key= 前缀时跳过它，只保留值
      const km = /^[A-Za-z_][\w-]*=/.exec(t.slice(j, j + 40));
      if (km) j += km[0].length;
      const [val, nj] = miParseValue(t, j);
      arr.push(val);
      j = nj > j ? nj : j + 1; // 进度保护: 异常输入也强制前移
      while (j < t.length && t[j] === " ") j++;
      if (t[j] === ",") j++;
    }
    return [arr, j + 1];
  }
  // bare token
  let j = i;
  while (j < t.length && t[j] !== "," && t[j] !== "}" && t[j] !== "]") j++;
  return [t.slice(i, j).trim(), j];
}

function miParseResult(payload: string): Record<string, unknown> {
  const [val] = miParseValue("{" + payload + "}", 0);
  return (val as Record<string, unknown>) || {};
}

function miQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

interface DebugVar {
  expr: string;
  value?: string;
  error?: string;
}

interface DebugFrame {
  level: number;
  func: string;
  file: string;
  line: number;
}

/** GDB 应答队列项: 发出的每条待应答命令按序入队, ^done/^error 按序出队 */
type ReplyItem =
  | { kind: "var"; expr: string }
  | { kind: "locals" }
  | { kind: "frames" }
  | { kind: "http-eval"; expr: string; resolve: (r: { value?: string; error?: string }) => void }
  // 泛化请求-应答: 可视化等 HTTP 接口发一条 MI 命令并等待其 ^done 负载
  | { kind: "http-req"; resolve: (r: Record<string, unknown>) => void }
  // 发出去就不打算收应答的命令(如 -var-delete), 其 ^done/^error 仅出队丢弃
  | { kind: "ignore" };

interface DebugSession {
  id: string;
  proc: ChildProcess;
  clients: Set<SseClient>;
  started: boolean;
  exited: boolean;
  watch: string[];
  replyQueue: ReplyItem[];
  lastStop: { reason: string; file: string; line: number; func: string } | null;
  lastStack: DebugFrame[];
  /** 可视化请求互斥链: 同一时刻只跑一个 viz 展开, 防止 MI 应答交错 */
  vizChain: Promise<unknown>;
  pendingStop: {
    reason: string;
    file: string;
    line: number;
    func: string;
    remaining: number;
    vars: DebugVar[];
    locals: Record<string, string>[];
    stack: DebugFrame[];
  } | null;
}

let debugSession: DebugSession | null = null;

function gdbSend(session: DebugSession, cmd: string) {
  try {
    session.proc.stdin?.write(cmd + "\n");
  } catch {
    /* ignore */
  }
}

function evaluateWatch(session: DebugSession) {
  const stop = session.pendingStop;
  if (!stop) return;
  stop.vars = session.watch.map((expr) => ({ expr }));
  stop.remaining = session.watch.length + 2; // + locals + frames
  for (const expr of session.watch) {
    session.replyQueue.push({ kind: "var", expr });
    gdbSend(session, `-data-evaluate-expression ${miQuote(expr)}`);
  }
  session.replyQueue.push({ kind: "locals" });
  gdbSend(session, "-stack-list-locals 1");
  session.replyQueue.push({ kind: "frames" });
  gdbSend(session, "-stack-list-frames");
}

/** 悬浮求值: 仅在停止状态下可用, 结果通过 HTTP 直接返回 */
function debugEval(session: DebugSession, expr: string): Promise<{ value?: string; error?: string }> {
  return new Promise((resolve) => {
    if (session.exited) return resolve({ error: "调试已结束" });
    if (session.pendingStop) return resolve({ error: "忙" });
    if (!session.lastStop) return resolve({ error: "程序正在运行，命中断点后可查看" });
    session.replyQueue.push({ kind: "http-eval", expr, resolve });
    gdbSend(session, `-data-evaluate-expression ${miQuote(expr)}`);
  });
}

function flushStop(session: DebugSession) {
  const stop = session.pendingStop;
  if (!stop) return;
  session.pendingStop = null;
  if (stop.reason === "refresh") {
    // 仅刷新变量: 沿用上次停止位置与调用栈, 避免前端丢失当前行高亮
    broadcast(session.clients, "stopped", {
      reason: session.lastStop?.reason || "refresh",
      file: session.lastStop?.file || "",
      line: session.lastStop?.line || 0,
      func: session.lastStop?.func || "",
      vars: stop.vars,
      locals: stop.locals,
      stack: stop.stack.length > 0 ? stop.stack : session.lastStack,
    });
    return;
  }
  session.lastStop = { reason: stop.reason, file: stop.file, line: stop.line, func: stop.func };
  session.lastStack = stop.stack;
  broadcast(session.clients, "stopped", {
    reason: stop.reason,
    file: stop.file,
    line: stop.line,
    func: stop.func,
    vars: stop.vars,
    locals: stop.locals,
    stack: stop.stack,
  });
}

function handleDebugLine(session: DebugSession, line: string) {
  if (!line) return;
  if (line.startsWith('~"') || line.startsWith("~\"")) {
    const m = line.match(/^~"(.*)"$/s);
    if (m) broadcast(session.clients, "console", { text: miUnescape(m[1]) });
    return;
  }
  if (line.startsWith('&"')) {
    const m = line.match(/^&"(.*)"$/s);
    if (m) broadcast(session.clients, "log", { text: miUnescape(m[1]) });
    return;
  }
  if (line.startsWith("*stopped")) {
    const payload = line.slice("*stopped".length).replace(/^,/, "");
    const r = miParseResult(payload) as {
      reason?: string;
      frame?: { func?: string; file?: string; line?: string };
      exited_normally?: string;
    };
    const reason = r.reason || "stopped";
    if (reason.startsWith("exited")) {
      session.exited = true;
      broadcast(session.clients, "exited", { reason });
      cleanupDebug();
      return;
    }
    session.pendingStop = {
      reason,
      file: (r.frame?.file || "").split("\\").join("/"),
      line: parseInt(r.frame?.line || "0", 10),
      func: r.frame?.func || "",
      remaining: 0,
      vars: [],
      locals: [],
      stack: [],
    };
    evaluateWatch(session);
    return;
  }
  if (line.startsWith("*running")) {
    broadcast(session.clients, "running", {});
    return;
  }
  if (line.startsWith("^error")) {
    const payload = line.slice("^error".length).replace(/^,/, "");
    const r = miParseResult(payload) as { msg?: string };
    const item = session.replyQueue.shift();
    if (item?.kind === "http-eval") {
      item.resolve({ error: r.msg || "求值失败" });
    } else if (item?.kind === "http-req") {
      item.resolve({ error: r.msg || "GDB 错误" });
    } else if (item?.kind === "ignore") {
      /* fire-and-forget 出队丢弃 */
    } else if (item && session.pendingStop) {
      const stop = session.pendingStop;
      if (item.kind === "var") {
        const target = stop.vars.find((v) => v.expr === item.expr && v.value === undefined && v.error === undefined);
        if (target) target.error = r.msg || "求值失败";
      }
      stop.remaining--;
      if (stop.remaining <= 0) flushStop(session);
    } else if (!item) {
      broadcast(session.clients, "log", { text: r.msg || line });
    }
    return;
  }
  if (line.startsWith("^done")) {
    const payload = line.slice("^done".length).replace(/^,/, "");
    const r = miParseResult(payload) as {
      value?: string;
      locals?: { name?: string; value?: string }[];
      variables?: { name?: string; value?: string }[];
      stack?: ({ frame?: { level?: string; func?: string; file?: string; line?: string } } & {
        level?: string;
        func?: string;
        file?: string;
        line?: string;
      })[];
    };
    const item = session.replyQueue.shift();
    if (item?.kind === "http-eval") {
      item.resolve(r.value !== undefined ? { value: r.value } : { error: "无结果" });
      return;
    }
    if (item?.kind === "http-req") {
      item.resolve(r as unknown as Record<string, unknown>);
      return;
    }
    if (item?.kind === "ignore") return; // fire-and-forget 出队丢弃
    if (!item) return; // 无入队命令的应答(如 -gdb-set / -break-insert), 忽略
    const stop = session.pendingStop;
    if (!stop) return;
    if (item.kind === "var") {
      if (r.value !== undefined) {
        const target = stop.vars.find((v) => v.expr === item.expr && v.value === undefined && v.error === undefined);
        if (target) target.value = r.value;
      }
    } else if (item.kind === "locals") {
      const list = r.locals || r.variables || [];
      stop.locals = list.map((l) => ({ name: l.name || "?", value: l.value || "" }));
    } else if (item.kind === "frames") {
      const list = r.stack || [];
      stop.stack = list
        .map((el) => {
          const f = el.frame || el;
          return {
            level: parseInt(f.level || "0", 10),
            func: f.func || "?",
            file: (f.file || "").split("\\").join("/"),
            line: parseInt(f.line || "0", 10),
          };
        })
        .sort((a, b) => a.level - b.level);
    }
    stop.remaining--;
    if (stop.remaining <= 0) flushStop(session);
    return;
  }
}

function cleanupDebug() {
  if (debugSession) {
    for (const c of debugSession.clients) try { c.end(); } catch { /* ignore */ }
    try {
      debugSession.proc.kill();
    } catch {
      /* ignore */
    }
    debugSession = null;
  }
}

function startDebug(exeRel: string, breakpoints: { file: string; line: number }[], watch: string[]): { id: string } | { error: string } {
  const settings = loadSettings();
  const gdb = resolveTool(settings.gdbPath, ["gdb"]);
  if (!gdb.found || !gdb.path) return { error: "未找到 GDB 调试器。请安装 MinGW-w64/MSYS2 的 gdb，或在设置中指定路径。" };
  const exeAbs = toAbs(exeRel);
  if (!exeAbs || !fs.existsSync(exeAbs)) return { error: `找不到可执行文件: ${exeRel}（请先编译）` };
  cleanupDebug();
  const id = "dbg-" + seq++;
  // 优先沿用编译器目录（被调试 exe 的运行时 DLL 在那），否则退回 gdb 所在目录
  const proc = spawn(gdb.path, ["-q", "--interpreter=mi2", exeAbs], { cwd: WORKSPACE, env: toolEnv() ?? toolEnv(gdb.path) });
  const session: DebugSession = {
    id,
    proc,
    clients: new Set(),
    started: false,
    exited: false,
    watch,
    replyQueue: [],
    lastStop: null,
    lastStack: [],
    vizChain: Promise.resolve(),
    pendingStop: null,
  };
  debugSession = session;
  let buf = "";
  proc.stdout?.on("data", (d) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      try {
        handleDebugLine(session, line);
      } catch (e) {
        // 解析异常不得击垮整个开发服务器
        console.error("[debug] 处理 GDB 行失败:", e instanceof Error ? e.message : e, "| 行:", line.slice(0, 300));
      }
    }
  });
  proc.stderr?.on("data", (d) => broadcast(session.clients, "log", { text: d.toString() }));
  proc.on("close", () => {
    session.exited = true;
    broadcast(session.clients, "exited", { reason: "gdb-end" });
    if (debugSession === session) debugSession = null;
  });
  // 初始化与断点
  gdbSend(session, "-gdb-set confirm off");
  gdbSend(session, "-gdb-set print pretty on");
  gdbSend(session, "-gdb-set unwindonsignal on");
  gdbSend(session, "-enable-pretty-printing");
  for (const bp of breakpoints) {
    const file = bp.file.split("/").pop();
    gdbSend(session, `-break-insert -f ${miQuote(file + ":" + bp.line)}`);
  }
  return { id };
}

function debugCmd(op: string, watch?: string[]) {
  const session = debugSession;
  if (!session) return;
  if (watch) session.watch = watch;
  switch (op) {
    case "run":
      if (!session.started) {
        session.started = true;
        gdbSend(session, "-exec-run");
      } else {
        gdbSend(session, "-exec-continue");
      }
      break;
    case "continue":
      gdbSend(session, "-exec-continue");
      break;
    case "next":
      gdbSend(session, "-exec-next");
      break;
    case "step":
      gdbSend(session, "-exec-step");
      break;
    case "finish":
      gdbSend(session, "-exec-finish");
      break;
    case "vars": {
      // 仅刷新变量: 保留上次停止位置与调用栈
      session.pendingStop = {
        reason: "refresh",
        file: session.lastStop?.file || "",
        line: session.lastStop?.line || 0,
        func: session.lastStop?.func || "",
        remaining: 0,
        vars: [],
        locals: [],
        stack: session.lastStack,
      };
      evaluateWatch(session);
      break;
    }
    case "quit":
      gdbSend(session, "-gdb-exit");
      cleanupDebug();
      break;
  }
}

// ---------------------------------------------------------------------------
// 数据结构可视化: 调试暂停时把 vector / 数组 / 链表展开为结构化 JSON
// ---------------------------------------------------------------------------
const VIZ_MAX_ELEMS = 100;      // 数组/vector 最多展示元素数
const VIZ_MAX_LIST_NODES = 40;  // 链表最多遍历节点数（防失控）
let vizSeq = 0;

/** 发一条 MI 命令并等待其 ^done 负载; 超时兜底防止 HTTP 请求挂死 */
function miRequest(session: DebugSession, cmd: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const item: ReplyItem = {
      kind: "http-req",
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
    };
    const timer = setTimeout(() => {
      const i = session.replyQueue.indexOf(item);
      if (i >= 0) session.replyQueue.splice(i, 1);
      resolve({ error: "GDB 应答超时" });
    }, timeoutMs);
    session.replyQueue.push(item);
    gdbSend(session, cmd);
  });
}

/** 类型名规范化: 去空白、去 struct/class 前缀，用于链表 next 指针的同型判定 */
function normTypeName(t: string): string {
  return t.replace(/\s+/g, " ").trim().replace(/^(struct|class|union|enum) /, "");
}

/** 从 GDB 值字符串里抓第一个十六进制地址（指针值的文本形态） */
function parseAddr(v: string): string | null {
  const m = /0x[0-9a-fA-F]+/.exec(v || "");
  return m ? m[0].toLowerCase() : null;
}

const isNullAddr = (a: string | null): boolean => !a || /^0x0+$/.test(a);

interface VizChild {
  name: string;
  exp: string;
  type: string;
  value?: string;
  numchild: number;
}

/** -var-list-children: 取一层子元素（带值），失败时退化为不带值重试 */
async function vizChildren(session: DebugSession, varName: string): Promise<VizChild[]> {
  let r = await miRequest(session, `-var-list-children --all-values ${varName}`);
  if (r.error) r = await miRequest(session, `-var-list-children ${varName}`);
  if (r.error) throw new Error(String(r.error));
  const raw = (r.children ?? []) as Record<string, unknown>[];
  return raw.map((c) => ({
    name: String(c.name ?? ""),
    exp: String(c.exp ?? ""),
    type: String(c.type ?? ""),
    value: c.value !== undefined ? String(c.value) : undefined,
    numchild: parseInt(String(c.numchild ?? "0"), 10) || 0,
  }));
}

/** GDB MI 对 C++ 结构体的 children 会先包一层 public:/private: 访问限定伪节点，这里拍平取真实成员 */
async function vizFields(session: DebugSession, varName: string, depth = 0): Promise<VizChild[]> {
  const kids = await vizChildren(session, varName);
  const out: VizChild[] = [];
  for (const k of kids) {
    if (/^(public|protected|private)$/.test(k.exp) && !k.type && !k.value && depth < 2) {
      out.push(...(await vizFields(session, k.name, depth + 1)));
      continue;
    }
    out.push(k);
  }
  return out;
}

/** 取模板串顶层第一个逗号前的部分: "int, std::allocator<int>" → "int" */
function splitTopComma(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "<") depth++;
    else if (s[i] === ">") depth--;
    else if (s[i] === "," && depth === 0) return s.slice(0, i).trim();
  }
  return s.trim();
}

/**
 * std::vector 无 pretty-printer 时，-var-list-children 只能看到 _M_start/_M_finish 等内部指针。
 * 这是纯内存读取的兜底：指针差求长度 + @ 操作符一次性解出前 N 个元素，不调用 inferior 函数。
 */
async function vizVectorRaw(
  session: DebugSession,
  expr: string,
  rootType: string,
  kids: VizChild[]
): Promise<Record<string, unknown> | null> {
  const tm = /(?:^|[:\s])vector<([\s\S]+)>$/.exec(rootType);
  if (!tm) return null;
  const elemType = splitTopComma(tm[1]);
  const startK = kids.find((k) => k.exp === "_M_start") ?? kids[0];
  const finishK = kids.find((k) => k.exp === "_M_finish");
  if (!startK?.value || !finishK?.value) return null;
  const startAddr = parseAddr(startK.value);
  if (isNullAddr(startAddr)) return { kind: "vector", expr, type: rootType, elems: [], total: 0, truncated: false };
  const countR = await miRequest(
    session,
    `-data-evaluate-expression ${miQuote(`(long)(${expr}._M_finish - ${expr}._M_start)`)}`
  );
  if (countR.error) return null;
  const count = parseInt(String(countR.value ?? "0"), 10);
  if (!Number.isFinite(count) || count <= 0) return { kind: "vector", expr, type: rootType, elems: [], total: 0, truncated: false };
  const show = Math.min(count, VIZ_MAX_ELEMS);
  const memR = await miRequest(
    session,
    `-data-evaluate-expression ${miQuote(`*(${elemType} *)(${startAddr})@${show}`)}`
  );
  if (memR.error) return null;
  const inner = String(memR.value ?? "").trim().replace(/^\{/, "").replace(/\}$/, "");
  const values = inner ? inner.split(",").map((s) => s.trim()) : [];
  return {
    kind: "vector",
    expr,
    type: rootType,
    elems: values.map((v, i) => ({ label: String(i), value: v, type: elemType })),
    total: count,
    truncated: count > VIZ_MAX_ELEMS,
  };
}

/** 链表遍历: 逐节点解引用读字段，找「指向自身类型」的指针成员作为 next；地址去重防环 */
async function vizWalkList(
  session: DebugSession,
  createVar: (e: string) => Promise<Record<string, unknown>>,
  expr: string,
  rootType: string,
  rootValue: string
): Promise<Record<string, unknown>> {
  const pointee = normTypeName(rootType.replace(/\*\s*$/, ""));
  const nodes: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let cur = expr;
  let truncated = false;
  let cycle = false;
  for (let i = 0; i < VIZ_MAX_LIST_NODES; i++) {
    // 记录当前节点地址用于防环
    const addrR = await miRequest(session, `-data-evaluate-expression ${miQuote(cur)}`);
    const addr = parseAddr(String(addrR.value ?? ""));
    if (addr && visited.has(addr)) {
      cycle = true;
      break;
    }
    if (addr) visited.add(addr);

    // 读当前节点字段
    let kids: VizChild[];
    try {
      const v = await createVar(`*(${cur})`);
      kids = await vizFields(session, String(v.name));
    } catch (e) {
      if (nodes.length === 0) throw e; // 第一个节点就读失败 → 整体报错
      break; // 后续节点读失败（如内存损坏）→ 画到已读到的部分
    }
    const fields = kids.map((k) => ({ label: k.exp, value: k.value ?? "", type: k.type }));
    if (kids.length === 0) {
      if (nodes.length === 0) {
        // 指向非结构体（如 char*）：退回标量，显示所指值
        const derefR = await miRequest(session, `-data-evaluate-expression ${miQuote(`*(${cur})`)}`);
        const dv = derefR.error ? "" : String(derefR.value ?? "");
        return { kind: "scalar", expr, type: rootType, value: dv || rootValue || "?" };
      }
      break;
    }
    nodes.push({ index: i, addr: addr ?? undefined, fields });

    // 找 next 指针：类型为「指向本节点类型」的指针成员
    const nextField = kids.find(
      (k) => /\*\s*$/.test(k.type) && normTypeName(k.type.replace(/\*\s*$/, "")) === pointee
    );
    if (!nextField) break;
    const nextAddr = parseAddr(nextField.value ?? "");
    if (isNullAddr(nextAddr)) break;
    cur = `(${cur})->${nextField.exp}`;
  }
  if (nodes.length >= VIZ_MAX_LIST_NODES) truncated = true;
  return { kind: "list", expr, type: rootType, nodes, truncated, cycle };
}

/** 可视化主逻辑：判定形态（链表/容器/结构体/标量）并展开一层或逐节点数据 */
async function debugVizCompute(session: DebugSession, expr: string): Promise<Record<string, unknown>> {
  if (session.exited) return { kind: "error", error: "调试已结束" };
  if (session.pendingStop) return { kind: "error", error: "忙" };
  if (!session.lastStop) return { kind: "error", error: "程序正在运行，命中断点后可查看" };

  // var 对象随会话消亡，不 -var-delete（其应答会污染应答队列），名字用序号保证唯一
  const createVar = async (e: string) => {
    const r = await miRequest(session, `-var-create vz${vizSeq++} * ${miQuote(e)}`);
    if (r.error) throw new Error(String(r.error));
    return r;
  };

  try {
    const root = await createVar(expr);
    const rootName = String(root.name ?? "");
    const rootType = String(root.type || "");
    const rootNum = parseInt(String(root.numchild ?? "0"), 10) || 0;
    const rootValue = String(root.value ?? "");

    // 指针类型：按链表尝试逐节点遍历
    if (/\*\s*$/.test(rootType)) {
      if (isNullAddr(parseAddr(rootValue))) return { kind: "scalar", expr, type: rootType, value: rootValue || "nullptr" };
      return await vizWalkList(session, createVar, expr, rootType, rootValue);
    }

    // std::vector：pretty-printer 生效时 varobject 是动态的，numchild 可能报 0、值是摘要串，
    // 但仍应尝试取子元素；子元素 exp 形如 "[0]"（打印器）或 "0"（原始）
    const isVector = /(?:^|[:\s])vector\s*</.test(rootType);
    if (isVector) {
      let kids: VizChild[] = [];
      try {
        kids = await vizChildren(session, rootName);
      } catch {
        kids = [];
      }
      const idxExps = kids.length > 0 && kids.every((k) => /^\[?\d+\]?$/.test(k.exp.trim()));
      if (idxExps) {
        const shown = kids.slice(0, VIZ_MAX_ELEMS);
        return {
          kind: "vector",
          expr,
          type: rootType,
          elems: shown.map((k) => ({ label: k.exp.trim().replace(/^\[|\]$/g, ""), value: k.value ?? "?", type: k.type })),
          total: rootNum || kids.length,
          truncated: kids.length > VIZ_MAX_ELEMS,
        };
      }
      // 子元素不是索引形态（pretty-printer 缺失，只剩内部成员）→ 纯内存读取兜底
      const raw = await vizVectorRaw(session, expr, rootType, kids);
      if (raw) return raw;
      if (kids.length > 0) {
        return {
          kind: "struct",
          expr,
          type: rootType,
          elems: kids.slice(0, VIZ_MAX_ELEMS).map((k) => ({ label: k.exp, value: k.value ?? (k.numchild > 0 ? "{…}" : "?"), type: k.type })),
          total: kids.length,
          truncated: kids.length > VIZ_MAX_ELEMS,
        };
      }
      return { kind: "scalar", expr, type: rootType, value: rootValue || "?" };
    }
    if (rootNum === 0) return { kind: "scalar", expr, type: rootType, value: rootValue || "?" };

    // 数组 / 结构体：取一层子元素（结构体先拍平访问限定伪节点）
    const kids = await vizFields(session, rootName);
    let truncated = false;
    let elems = kids;
    if (elems.length > VIZ_MAX_ELEMS) {
      elems = elems.slice(0, VIZ_MAX_ELEMS);
      truncated = true;
    }
    const mapped = elems.map((k) => ({
      label: k.exp,
      value: k.value ?? (k.numchild > 0 ? "{…}" : "?"),
      type: k.type,
    }));
    const numericExps = mapped.length > 0 && mapped.every((e2) => /^\d+$/.test(e2.label));
    const isArray = /\[\s*\d+\s*\]\s*$/.test(rootType);
    const kind = isArray || numericExps ? "array" : "struct";
    return { kind, expr, type: rootType, elems: mapped, total: rootNum || kids.length, truncated };
  } catch (e) {
    return { kind: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** 可视化入口：互斥链串行化并发请求，结果统一补上 expr 字段 */
function debugViz(session: DebugSession, expr: string): Promise<Record<string, unknown>> {
  const run = () =>
    debugVizCompute(session, expr).then(
      (r) => ({ ...r, expr }),
      (e) => ({ kind: "error", expr, error: e instanceof Error ? e.message : String(e) })
    );
  const next = session.vizChain.then(run, run);
  session.vizChain = next;
  return next;
}

// ---------------------------------------------------------------------------
// AI 代理
// ---------------------------------------------------------------------------
async function aiChat(messages: { role: string; content: string }[]): Promise<unknown> {
  const s = loadSettings();
  if (!s.aiEndpoint || !s.aiKey) {
    return { error: "未配置 AI API。请在「设置 → AI 接口」中填写兼容 OpenAI 的接口地址、密钥和模型。" };
  }
  const url = s.aiEndpoint.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.aiKey}`,
      },
      body: JSON.stringify({ model: s.aiModel || "gpt-4o-mini", messages, stream: false, temperature: 0.3 }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text();
      return { error: `AI 接口返回 ${resp.status}: ${t.slice(0, 500)}` };
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { error: "AI 接口返回为空" };
    return { content };
  } catch (e) {
    return { error: `AI 请求失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// API 路由（与 Vite 解耦：独立服务与 Vite 中间件共用）
// ---------------------------------------------------------------------------
export async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!req.url || !req.url.startsWith("/api/")) return;
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;
  const method = req.method || "GET";

  try {
            // ---- 工具链 ----
            if (route === "/api/toolchain" && method === "GET") {
              const s = loadSettings();
              json(res, 200, {
                cc: resolveTool(s.compilerC, ["gcc", "clang", "clang-cl"]),
                cxx: resolveTool(s.compilerCpp, ["g++", "clang++"]),
                gdb: resolveTool(s.gdbPath, ["gdb"]),
              });
              return;
            }
            // ---- 设置 ----
            if (route === "/api/settings" && method === "GET") {
              json(res, 200, loadSettings());
              return;
            }
            if (route === "/api/settings" && method === "POST") {
              const body = (await readBody(req)) as Settings;
              const cur = loadSettings();
              const merged = { ...cur, ...body };
              saveSettings(merged);
              json(res, 200, merged);
              return;
            }
            // ---- 构建系统探测（CMake / Make / 单文件 g++）----
            // 纯新增接口：前端刷新徽标用；探测每次都读文件系统，增删 Makefile 后立刻生效
            if (route === "/api/buildsystem" && method === "GET") {
              json(res, 200, { buildSystem: detectBuildSystem() });
              return;
            }
            // ---- 工作区 ----
            if (route === "/api/workspace" && method === "GET") {
              // buildSystem 为新增字段（向后兼容：旧前端忽略即可）
              json(res, 200, { workspace: WORKSPACE, buildSystem: detectBuildSystem() });
              return;
            }
            if (route === "/api/workspace/open" && method === "POST") {
              const body = (await readBody(req)) as { path?: string };
              const r = switchWorkspace(body.path || "");
              if ("error" in r) {
                json(res, 400, { error: r.error });
                return;
              }
              // 切换工作区后必须重新探测（新目录可能是 CMake/Makefile 工程）
              json(res, 200, { ok: true, workspace: r.workspace, tree: buildTree(WORKSPACE), buildSystem: detectBuildSystem() });
              return;
            }
            if (route === "/api/workspace/pick" && method === "GET") {
              json(res, 200, await pickDirectory());
              return;
            }
            // ---- 文件树 ----
            if (route === "/api/files" && method === "GET") {
              // 顺带带回 buildSystem：新建/删除/重命名文件后前端会刷新文件树，
              // 于是「增删 Makefile」也能自动重新探测，无需额外请求
              json(res, 200, { tree: buildTree(WORKSPACE), buildSystem: detectBuildSystem() });
              return;
            }
            // ---- 读文件 ----
            if (route === "/api/file" && method === "GET") {
              const p = toAbs(url.searchParams.get("path") || "");
              if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
                json(res, 404, { error: "文件不存在" });
                return;
              }
              json(res, 200, { path: toRel(p), content: fs.readFileSync(p, "utf-8") });
              return;
            }
            // ---- 写文件 ----
            if (route === "/api/file" && method === "PUT") {
              const body = (await readBody(req)) as { path: string; content: string };
              const p = toAbs(body.path);
              if (!p) {
                json(res, 400, { error: "非法路径" });
                return;
              }
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.writeFileSync(p, body.content ?? "", "utf-8");
              json(res, 200, { ok: true, path: toRel(p) });
              return;
            }
            // ---- 新建 ----
            if (route === "/api/file" && method === "POST") {
              const body = (await readBody(req)) as { path: string; isDir?: boolean };
              const p = toAbs(body.path);
              if (!p || p === WORKSPACE) {
                json(res, 400, { error: "非法路径" });
                return;
              }
              if (fs.existsSync(p)) {
                json(res, 409, { error: "已存在同名文件" });
                return;
              }
              if (body.isDir) fs.mkdirSync(p, { recursive: true });
              else {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, "", "utf-8");
              }
              json(res, 200, { ok: true, path: toRel(p) });
              return;
            }
            // ---- 重命名/移动 ----
            if (route === "/api/rename" && method === "POST") {
              const body = (await readBody(req)) as { from: string; to: string };
              const a = toAbs(body.from);
              const b = toAbs(body.to);
              if (!a || !b || !fs.existsSync(a)) {
                json(res, 400, { error: "路径非法" });
                return;
              }
              fs.mkdirSync(path.dirname(b), { recursive: true });
              fs.renameSync(a, b);
              json(res, 200, { ok: true });
              return;
            }
            // ---- 删除 ----
            if (route === "/api/file" && method === "DELETE") {
              const p = toAbs(url.searchParams.get("path") || "");
              if (!p || p === WORKSPACE || !fs.existsSync(p)) {
                json(res, 400, { error: "路径非法" });
                return;
              }
              fs.rmSync(p, { recursive: true, force: true });
              json(res, 200, { ok: true });
              return;
            }
            // ---- 工作区文件 API（供 AI 助手工具调用）----
            // 硬约束：全部路径复用 toAbs 的越界检查，只能操作 WORKSPACE 内路径，
            // 越界一律 403 中文错误；读上限 1MB / 写上限 2MB；delete 只允许文件与空目录（不递归）。
            // 这些路由是纯新增，既有 /api/file 系列行为不变。
            if (route === "/api/fs/list" && method === "GET") {
              const raw = url.searchParams.get("path") || "";
              const p = toAbs(raw);
              if (!p) {
                json(res, 403, fsOutOfRange(raw));
                return;
              }
              if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
                json(res, 404, { error: `目录不存在：${raw || "."}` });
                return;
              }
              const entries = fs
                .readdirSync(p, { withFileTypes: true })
                .map((e) => ({
                  name: e.name,
                  path: toRel(path.join(p, e.name)),
                  type: e.isDirectory() ? ("dir" as const) : ("file" as const),
                }))
                .sort((a, b) =>
                  a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
                );
              json(res, 200, { entries });
              return;
            }
            if (route === "/api/fs/read" && method === "GET") {
              const raw = url.searchParams.get("path") || "";
              if (!raw.trim()) {
                json(res, 400, { error: "缺少 path 参数" });
                return;
              }
              const p = toAbs(raw);
              if (!p) {
                json(res, 403, fsOutOfRange(raw));
                return;
              }
              let st: fs.Stats;
              try {
                st = fs.statSync(p);
              } catch {
                json(res, 404, { error: `文件不存在：${raw}` });
                return;
              }
              if (!st.isFile()) {
                json(res, 404, { error: `不是文件：${raw}` });
                return;
              }
              if (st.size > FS_READ_LIMIT) {
                json(res, 413, {
                  error: `文件超过 ${FS_READ_LIMIT / 1024 / 1024}MB 读取上限：${raw}（${(st.size / 1024).toFixed(1)} KB）`,
                });
                return;
              }
              json(res, 200, { content: fs.readFileSync(p, "utf-8") });
              return;
            }
            if (route === "/api/fs/write" && method === "POST") {
              const body = (await readBody(req)) as { path?: string; content?: string };
              const raw = typeof body.path === "string" ? body.path : "";
              const content = typeof body.content === "string" ? body.content : "";
              if (!raw.trim()) {
                json(res, 400, { error: "缺少 path 参数" });
                return;
              }
              const p = toAbs(raw);
              if (!p) {
                json(res, 403, fsOutOfRange(raw));
                return;
              }
              if (p === WORKSPACE || (fs.existsSync(p) && fs.statSync(p).isDirectory())) {
                json(res, 400, { error: `目标是目录，不能写入：${raw}` });
                return;
              }
              const bytes = Buffer.byteLength(content, "utf-8");
              if (bytes > FS_WRITE_LIMIT) {
                json(res, 413, {
                  error: `写入内容 ${(bytes / 1024 / 1024).toFixed(2)}MB 超过 ${FS_WRITE_LIMIT / 1024 / 1024}MB 上限`,
                });
                return;
              }
              fs.mkdirSync(path.dirname(p), { recursive: true });
              fs.writeFileSync(p, content, "utf-8");
              json(res, 200, { ok: true, path: toRel(p), bytes });
              return;
            }
            // ---- 拖拽导入上传（纯新增）----
            // 前端把资源管理器里拖进来的文件用 FileReader 读成 base64，这里写进工作区根目录。
            // 与 /api/fs/write 的差异（因此单独开一条路由而不是复用 write）：
            //   ① 内容是 base64 而非 JSON 文本 → 空文件、二进制内容都能原样落盘；
            //   ② 上限放宽到 8MB（理由见 FS_UPLOAD_LIMIT）；
            //   ③ 同名文件自动改名（name.cpp → name-1.cpp），绝不覆盖用户已有文件。
            // 路径安全完全沿用 toAbs：越界（`..\` / 绝对路径逃出工作区）一律 403。
            if (route === "/api/fs/upload" && method === "POST") {
              const body = (await readBody(req)) as { path?: string; base64?: string };
              const raw = typeof body.path === "string" ? body.path.trim() : "";
              if (!raw) {
                json(res, 400, { error: "缺少 path 参数" });
                return;
              }
              const p = toAbs(raw);
              if (!p) {
                json(res, 403, fsOutOfRange(raw));
                return;
              }
              if (p === WORKSPACE || (fs.existsSync(p) && fs.statSync(p).isDirectory())) {
                json(res, 400, { error: `目标是目录，不能写入：${raw}` });
                return;
              }
              // 前端传的是 FileReader.readAsDataURL 剥掉前缀后的纯 base64；
              // 这里仍兜底接受完整 data URL（第三方调用/以后前端改动都不会踩坑）。
              let b64 = typeof body.base64 === "string" ? body.base64.trim() : "";
              if (b64.startsWith("data:")) {
                const comma = b64.indexOf(",");
                b64 = comma >= 0 ? b64.slice(comma + 1) : "";
              }
              // 先按 base64 长度估算字节数（3/4）：超大内容不必先分配解码缓冲，直接 413
              const estimated = Math.floor((b64.length * 3) / 4);
              if (estimated > FS_UPLOAD_LIMIT) {
                json(res, 413, {
                  error: `文件约 ${(estimated / 1024 / 1024).toFixed(2)}MB，超过 ${FS_UPLOAD_LIMIT / 1024 / 1024}MB 上传上限（${raw}）`,
                });
                return;
              }
              // 严格校验 base64：空串合法（允许导入空文件），非法字符 / 长度不合法一律 400，
              // 避免 Buffer.from 静默丢弃非法字符导致落盘内容与用户文件不一致。
              if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
                json(res, 400, { error: "base64 内容不合法（请用 FileReader 读取文件后传入）" });
                return;
              }
              const buf = Buffer.from(b64, "base64");
              if (buf.length > FS_UPLOAD_LIMIT) {
                json(res, 413, {
                  error: `文件 ${(buf.length / 1024 / 1024).toFixed(2)}MB 超过 ${FS_UPLOAD_LIMIT / 1024 / 1024}MB 上传上限（${raw}）`,
                });
                return;
              }
              const target = uniquePath(p);
              if (!target) {
                json(res, 409, { error: `同名文件过多，无法自动改名：${raw}` });
                return;
              }
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, buf);
              json(res, 200, {
                ok: true,
                path: toRel(target),
                original: toRel(p),
                renamed: target !== p,
                bytes: buf.length,
              });
              return;
            }
            if (route === "/api/fs/mkdir" && method === "POST") {
              const body = (await readBody(req)) as { path?: string };
              const raw = typeof body.path === "string" ? body.path : "";
              if (!raw.trim()) {
                json(res, 400, { error: "缺少 path 参数" });
                return;
              }
              const p = toAbs(raw);
              if (!p) {
                json(res, 403, fsOutOfRange(raw));
                return;
              }
              // 工作区根目录天然存在：视作成功，避免模型因重复 mkdir 卡住
              if (p === WORKSPACE) {
                json(res, 200, { ok: true });
                return;
              }
              if (fs.existsSync(p)) {
                if (fs.statSync(p).isDirectory()) {
                  json(res, 200, { ok: true });
                  return;
                }
                json(res, 409, { error: `已存在同名文件：${raw}` });
                return;
              }
              fs.mkdirSync(p, { recursive: true });
              json(res, 200, { ok: true });
              return;
            }
            if (route === "/api/fs/delete" && method === "POST") {
              const body = (await readBody(req)) as { path?: string };
              const raw = typeof body.path === "string" ? body.path : "";
              if (!raw.trim()) {
                json(res, 400, { error: "缺少 path 参数" });
                return;
              }
              const p = toAbs(raw);
              if (!p) {
                json(res, 403, fsOutOfRange(raw));
                return;
              }
              if (p === WORKSPACE) {
                json(res, 400, { error: "不能删除工作区根目录" });
                return;
              }
              let st: fs.Stats;
              try {
                st = fs.statSync(p);
              } catch {
                json(res, 404, { error: `不存在：${raw}` });
                return;
              }
              if (st.isDirectory()) {
                // 非空目录不递归删除，返回中文错误让模型自己决定改怎么处理
                if (fs.readdirSync(p).length > 0) {
                  json(res, 400, { error: `目录非空，未删除（本接口不做递归删除）：${raw}` });
                  return;
                }
                fs.rmdirSync(p);
              } else {
                fs.unlinkSync(p);
              }
              json(res, 200, { ok: true });
              return;
            }
            // ---- 编译 ----
            if (route === "/api/compile" && method === "POST") {
              const body = (await readBody(req)) as { main: string; project?: boolean; std?: string };
              const result = await compileSources(body.main || "main.cpp", !!body.project, body.std);
              json(res, 200, result);
              return;
            }
            // ---- 运行 ----
            if (route === "/api/run" && method === "POST") {
              const body = (await readBody(req)) as { exe: string };
              const result = startRun(body.exe || ".build/main.exe");
              if ("error" in result) json(res, 400, result);
              else json(res, 200, result);
              return;
            }
            if (route.startsWith("/api/run/") && method === "POST") {
              const parts = route.split("/"); // /api/run/:id/:action
              const id = parts[3];
              const action = parts[4];
              if (!runSession || runSession.id !== id) {
                json(res, 404, { error: "运行会话不存在" });
                return;
              }
              if (action === "input") {
                const body = (await readBody(req)) as { text: string };
                runSession.proc.stdin?.write(body.text);
                armRunTimer(runSession); // 交互输入重置超时计时
                json(res, 200, { ok: true });
              } else if (action === "kill") {
                killRun();
                json(res, 200, { ok: true });
              } else {
                json(res, 404, { error: "unknown action" });
              }
              return;
            }
            if (route.startsWith("/api/run/") && method === "GET") {
              const id = route.split("/")[3];
              // 当前会话优先；已退出的会话从 lastRunSession 取，供「POST→GET 间隙里
              // 程序已跑完」的迟到订阅回放输出与退出事件，而不是 404 假死
              const session =
                (runSession && runSession.id === id ? runSession : null) ??
                (lastRunSession && lastRunSession.id === id ? lastRunSession : null);
              if (!session) {
                json(res, 404, { error: "运行会话不存在" });
                return;
              }
              res.on("close", () => session.clients.delete(res));
              sseInit(res);
              for (const e of session.log) sseSend(res, e.event, e.data);
              if (session.exited) {
                try { res.end(); } catch { /* ignore */ }
                return;
              }
              session.clients.add(res);
              return;
            }
            // ---- 调试: 启动 ----
            if (route === "/api/debug" && method === "POST") {
              const body = (await readBody(req)) as {
                exe: string;
                breakpoints: { file: string; line: number }[];
                watch: string[];
              };
              const result = startDebug(body.exe, body.breakpoints || [], body.watch || []);
              if ("error" in result) json(res, 400, result);
              else json(res, 200, result);
              return;
            }
            // ---- 调试: 控制 ----
            if (route.startsWith("/api/debug/") && method === "POST") {
              const parts = route.split("/");
              const id = parts[3];
              if (!debugSession || debugSession.id !== id) {
                json(res, 404, { error: "调试会话不存在（可能已退出）" });
                return;
              }
              // 悬浮求值: 等待 GDB 应答后直接以 JSON 返回
              if (parts[4] === "eval") {
                const body = (await readBody(req)) as { expr?: string };
                const expr = (body.expr || "").trim();
                if (!expr) {
                  json(res, 400, { error: "空表达式" });
                  return;
                }
                const result = await debugEval(debugSession, expr);
                if (result.error) json(res, 400, result);
                else json(res, 200, result);
                return;
              }
              // 数据结构可视化: 展开 vector/数组/链表为结构化 JSON
              if (parts[4] === "viz") {
                const body = (await readBody(req)) as { expr?: string };
                const expr = (body.expr || "").trim();
                if (!expr) {
                  json(res, 400, { error: "空表达式" });
                  return;
                }
                const result = await debugViz(debugSession, expr);
                if (result.kind === "error") json(res, 400, result);
                else json(res, 200, result);
                return;
              }
              const body = (await readBody(req)) as { op: string; watch?: string[] };
              debugCmd(body.op, body.watch);
              json(res, 200, { ok: true });
              return;
            }
            if (route.startsWith("/api/debug/") && method === "GET") {
              const id = route.split("/")[3];
              if (!debugSession || debugSession.id !== id) {
                json(res, 404, { error: "调试会话不存在（可能已退出）" });
                return;
              }
              res.on("close", () => debugSession?.clients.delete(res));
              sseInit(res);
              debugSession.clients.add(res);
              return;
            }
            // ---- AI ----
            if (route === "/api/ai" && method === "POST") {
              const body = (await readBody(req)) as { messages: { role: string; content: string }[] };
              const result = await aiChat(body.messages || []);
              json(res, 200, result);
              return;
            }
      json(res, 404, { error: "未知接口: " + route });
    } catch (e) {
      json(res, 500, { error: String(e instanceof Error ? e.message : e) });
    }
}

/** 进程退出前清理运行/调试会话 */
export function shutdownAll() {
  killRun();
  cleanupDebug();
}

// ---------------------------------------------------------------------------
// Vite 插件（开发模式）
// ---------------------------------------------------------------------------
export function cppIdePlugin(): Plugin {
  return {
    name: "kimi-cpp-ide",
    configureServer(server) {
      seedWorkspace();
      server.httpServer?.on("close", shutdownAll);

      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/api/")) {
          void handleApiRequest(req, res);
          return;
        }
        // 仅处理 API；非 API 且带扩展名的静态文件让 Vite 处理
        if (req.url && req.url !== "/" && !req.url.startsWith("/@") && !path.extname(req.url)) {
          // SPA 回退
          const index = path.join(ROOT, "index.html");
          if (fs.existsSync(index)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            fs.createReadStream(index).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

export default cppIdePlugin;
