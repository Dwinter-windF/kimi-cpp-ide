import { create } from "zustand";
import { api, openStream, type FsEntry } from "@/lib/api";
import { explainError } from "@/lib/analyze";
import {
  buildTemplate,
  getTemplate,
  splitRootName,
  uniqueRootName,
  validateProjectName,
  type CreateProjectResult,
  type ProjectTemplateId,
} from "@/lib/projectTemplates";
import {
  IMPORT_MAX_BYTES,
  formatBytes,
  isSupportedImport,
  readFileAsBase64,
  type DroppedEntry,
  type ImportSummary,
} from "@/lib/dropImport";
import {
  AI_FIX_IDLE,
  type AiFixState,
  type AiMessage,
  type Breakpoint,
  type BuildSystemInfo,
  type CompileResult,
  type DebugFrame,
  type Diagnostic,
  type FileNode,
  type OpenWorkspaceResult,
  type PickDirResult,
  type Settings,
  type TermLine,
  type Toolchain,
  type VizData,
  type WatchVar,
} from "@/types";

type RunState = "idle" | "compiling" | "running" | "debugging";

interface IdeState {
  // 文件
  tree: FileNode[];
  /** 当前工作区绝对路径（由 /api/workspace 获取，可运行期切换） */
  workspace: string;
  openFiles: string[];
  activeFile: string | null;
  contents: Record<string, string>;
  dirty: Record<string, boolean>;
  // 断点 / 问题
  breakpoints: Record<string, number[]>;
  problems: Diagnostic[];
  // 工具链 / 设置
  toolchain: Toolchain | null;
  /** 服务端探测到的构建系统（CMake / Make / 单文件 g++）；null = 尚未探测 */
  buildSystem: BuildSystemInfo | null;
  settings: Settings;
  showSettings: boolean;
  // 运行状态
  runState: RunState;
  compilingProject: boolean;
  termLines: TermLine[];
  // 调试
  debugSessionId: string | null;
  debugStopped: { file: string; line: number; func: string; reason: string } | null;
  callStack: DebugFrame[];
  watchExprs: string[];
  watchValues: Record<string, string>;
  watchErrors: Record<string, string>;
  /** 监视表达式值变化计数器（用于闪烁动画） */
  watchChanged: Record<string, number>;
  locals: { name: string; value: string }[];
  /** 数据结构可视化：当前展示的图（vizExpr 为被可视化的表达式） */
  vizData: VizData | null;
  vizExpr: string | null;
  vizBusy: boolean;
  // AI
  aiMessages: AiMessage[];
  aiBusy: boolean;
  /** 最近一次编译的编译器原始输出（AI 一键修复要把它作为「完整编译错误文本」发给 AI） */
  compileOutput: string;
  /** AI 一键修复：预览/接受/拒绝的状态（编排逻辑在 src/lib/aiFix.ts） */
  aiFix: AiFixState;
  // UI
  bottomTab: "terminal" | "problems" | "debug" | "ai";
  editorFontSize: number;
  setEditorFontSize: (px: number) => void;
  /** 左右栏宽度 / 底部面板高度（px，持久化在 localStorage） */
  layout: Layout;
  /**
   * 更新布局尺寸（越界自动夹取）。
   * @param patch 要修改的字段
   * @param commit 是否同时落盘 localStorage：拖动过程中只更新 React 状态（每帧只 set，保证流畅），
   *               等到 pointerup 再传 true 写一次 localStorage。
   */
  setLayout: (patch: Partial<Layout>, commit?: boolean) => void;
  reveal: { file: string; line: number } | null;
  requestReveal: (file: string, line: number) => void;
  clearReveal: () => void;
  nameDialog: {
    title: string;
    placeholder?: string;
    initial?: string;
    onSubmit: (value: string) => void;
  } | null;
  openNameDialog: (cfg: { title: string; placeholder?: string; initial?: string; onSubmit: (value: string) => void }) => void;
  closeNameDialog: () => void;

  /** 「新建项目向导」弹层是否打开（与 showSettings 一样由 App 懒加载挂载） */
  showNewProject: boolean;
  setShowNewProject: (v: boolean) => void;
  /**
   * 新建项目向导的创建编排；模板定义与纯函数生成逻辑在 src/lib/projectTemplates.ts。
   * 步骤：校验名称 → 重名探测/自动改名 → 建项目目录（project 模板）→ 逐个 POST /api/fs/write
   *      → 刷新文件树 + 打开主文件 + 终端打印创建摘要。
   * 已创建的文件不回滚（理由见实现处注释）。
   */
  createProject: (id: ProjectTemplateId, name: string) => Promise<CreateProjectResult>;

  refreshFiles: () => Promise<void>;
  loadWorkspace: () => Promise<void>;
  /** 重新探测构建系统（徽标点击时用；打开目录 / 增删 Makefile 走 refreshFiles 顺带刷新） */
  refreshBuildSystem: () => Promise<void>;
  /** 切换工作区；成功返回 undefined，失败返回中文错误信息 */
  openWorkspace: (path: string) => Promise<string | undefined>;
  /** 弹出系统原生目录选择框；取消 / 无桌面会话时返回 cancelled */
  pickWorkspace: () => Promise<PickDirResult>;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActive: (path: string) => void;
  setContent: (path: string, text: string) => void;
  saveFile: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  newFile: (path: string, isDir?: boolean) => Promise<string | undefined>;
  removeFile: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /**
   * 拖拽导入编排：把拖进来的条目（含目录项）逐个复制进工作区根目录。
   * 逐个 POST /api/fs/upload（base64）→ 全部处理完后 refreshFiles → 自动打开第一个导入成功的文件。
   * 单个文件失败不影响其它文件；结果按「成功 / 改名 / 跳过原因」返回给 UI，同时写进终端日志。
   */
  importDroppedFiles: (entries: DroppedEntry[]) => Promise<ImportSummary>;

  toggleBreakpoint: (file: string, line: number) => void;
  allBreakpoints: () => Breakpoint[];

  loadSettings: () => Promise<void>;
  updateSettings: (s: Settings) => Promise<void>;
  refreshToolchain: () => Promise<void>;
  setShowSettings: (v: boolean) => void;
  setBottomTab: (t: IdeState["bottomTab"]) => void;
  appendTerm: (kind: TermLine["kind"], text: string) => void;
  clearTerm: () => void;

  compile: (project: boolean) => Promise<CompileResult | null>;
  run: () => Promise<void>;
  buildAndRun: () => Promise<void>;
  sendInput: (text: string) => Promise<void>;
  kill: () => Promise<void>;

  startDebug: () => Promise<void>;
  debugControl: (op: "run" | "continue" | "next" | "step" | "finish" | "quit") => Promise<void>;
  debugEvalExpr: (expr: string) => Promise<string>;
  /** 请求把表达式按数据结构画图（vector/数组/链表），结果存 vizData */
  showViz: (expr: string) => Promise<void>;
  closeViz: () => void;
  addWatch: (expr: string) => void;
  removeWatch: (expr: string) => void;

  sendAi: (text: string) => Promise<void>;
  clearAi: () => void;

  /** 局部更新 AI 修复状态（编排层 src/lib/aiFix.ts 用它推进 loading/ready/error） */
  patchAiFix: (patch: Partial<AiFixState>) => void;
  /** 切换预览的文件 */
  setAiFixActive: (index: number) => void;
  /**
   * 接受修复：把每个文件的修正内容走既有写文件通道（/api/file PUT，与 saveFile 同一个 API）
   * 落盘，并同步编辑器内容与脏标记。有任何文件写失败时不关闭弹层，把中文错误展示出来。
   */
  applyAiFix: () => Promise<void>;
  /** 拒绝修复：丢弃全部修正，不改动任何文件、不改编辑器内容 */
  closeAiFix: () => void;
}

const MAX_TERM = 3000;
const FONT_KEY = "kimi-ide-fontsize";

function loadFontSize(): number {
  try {
    const v = parseFloat(localStorage.getItem(FONT_KEY) || "");
    if (Number.isFinite(v)) return Math.min(28, Math.max(10, v));
  } catch {
    /* ignore */
  }
  return 13.5;
}

// ---------------------------------------------------------------------------
// 布局尺寸（左右栏宽度 / 底部面板高度）：可拖动 + localStorage 持久化
// ---------------------------------------------------------------------------

/** 可拖动区域的尺寸（px） */
export interface Layout {
  left: number;
  right: number;
  bottom: number;
}

/** 默认尺寸与加入分隔条前完全一致：左栏 w-60=240px、右栏 w-64=256px、底部 h-60=240px */
export const LAYOUT_DEFAULTS: Layout = { left: 240, right: 256, bottom: 240 };

/** 各区域的可调范围（px） */
export const LAYOUT_LIMITS = {
  left: { min: 160, max: 480 },
  right: { min: 200, max: 560 },
  bottom: { min: 100, max: Number.POSITIVE_INFINITY },
} as const;

export const LAYOUT_KEY = "kimi-layout";

/** 底部面板高度上限 = 视口高度的 60%（按当前窗口实时计算） */
export function maxBottomHeight(): number {
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  return Math.max(LAYOUT_LIMITS.bottom.min, Math.round(vh * 0.6));
}

function clampSize(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 把布局尺寸夹取到合法范围（非数字回落到默认值） */
export function clampLayout(l: Layout): Layout {
  return {
    left: clampSize(l.left, LAYOUT_LIMITS.left.min, LAYOUT_LIMITS.left.max, LAYOUT_DEFAULTS.left),
    right: clampSize(l.right, LAYOUT_LIMITS.right.min, LAYOUT_LIMITS.right.max, LAYOUT_DEFAULTS.right),
    bottom: clampSize(l.bottom, LAYOUT_LIMITS.bottom.min, maxBottomHeight(), LAYOUT_DEFAULTS.bottom),
  };
}

/** 读取持久化布局；读不到 / 解析失败 / 越界时回落到默认值 */
function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...LAYOUT_DEFAULTS };
    const p = JSON.parse(raw) as Partial<Record<keyof Layout, unknown>>;
    const pick = (k: keyof Layout) =>
      typeof p[k] === "number" ? (p[k] as number) : LAYOUT_DEFAULTS[k];
    return clampLayout({ left: pick("left"), right: pick("right"), bottom: pick("bottom") });
  } catch {
    return { ...LAYOUT_DEFAULTS };
  }
}

function persistLayout(l: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* localStorage 不可用（隐私模式 / 配额满）时静默忽略，不影响使用 */
  }
}

export const useIde = create<IdeState>((set, get) => {
  let runEs: EventSource | null = null;
  let dbgEs: EventSource | null = null;
  let currentRunId: string | null = null;

  const push = (kind: TermLine["kind"], text: string) => {
    const lines = [...get().termLines];
    for (const t of text.replace(/\r\n/g, "\n").split("\n")) {
      lines.push({ kind, text: t });
    }
    if (lines.length > MAX_TERM) lines.splice(0, lines.length - MAX_TERM);
    set({ termLines: lines });
  };

  const closeStreams = () => {
    runEs?.close();
    dbgEs?.close();
    runEs = null;
    dbgEs = null;
    currentRunId = null;
  };

  return {
    tree: [],
    workspace: "",
    openFiles: [],
    activeFile: null,
    contents: {},
    dirty: {},
    breakpoints: {},
    problems: [],
    toolchain: null,
    buildSystem: null,
    settings: {},
    showSettings: false,
    runState: "idle",
    compilingProject: false,
    termLines: [],
    debugSessionId: null,
    debugStopped: null,
    callStack: [],
    watchExprs: [],
    watchValues: {},
    watchErrors: {},
    watchChanged: {},
    locals: [],
    vizData: null,
    vizExpr: null,
    vizBusy: false,
    aiMessages: [],
    aiBusy: false,
    compileOutput: "",
    aiFix: AI_FIX_IDLE,
    bottomTab: "terminal",
    editorFontSize: loadFontSize(),
    setEditorFontSize: (px) => {
      const v = Math.min(28, Math.max(10, Math.round(px * 2) / 2));
      try {
        localStorage.setItem(FONT_KEY, String(v));
      } catch {
        /* ignore */
      }
      set({ editorFontSize: v });
    },
    layout: loadLayout(),
    setLayout: (patch, commit = false) => {
      const cur = get().layout;
      const next = clampLayout({ ...cur, ...patch });
      // 尺寸真的变化才 set：拖到边界后继续拖动不再空转重渲染
      if (next.left !== cur.left || next.right !== cur.right || next.bottom !== cur.bottom) {
        set({ layout: next });
      }
      if (commit) persistLayout(next);
    },
    reveal: null,
    nameDialog: null,
    openNameDialog: (cfg) => set({ nameDialog: cfg }),
    closeNameDialog: () => set({ nameDialog: null }),
    showNewProject: false,
    setShowNewProject: (v) => set({ showNewProject: v }),
    requestReveal: (file, line) => set({ reveal: { file, line } }),
    clearReveal: () => set({ reveal: null }),

    refreshFiles: async () => {
      // /api/files 顺带返回构建系统探测结果：新建/删除/重命名文件后（含增删 Makefile）自动刷新徽标
      const { tree, buildSystem } = await api.files();
      set({ tree });
      if (buildSystem) set({ buildSystem });
    },

    loadWorkspace: async () => {
      try {
        const res = await fetch("/api/workspace");
        const data = (await res.json()) as { workspace?: string; buildSystem?: BuildSystemInfo };
        if (data.workspace) set({ workspace: data.workspace });
        if (data.buildSystem) set({ buildSystem: data.buildSystem });
      } catch {
        /* 忽略：拿不到只影响对话框预填 */
      }
    },

    refreshBuildSystem: async () => {
      try {
        const r = await api.buildSystem();
        if (r.buildSystem) set({ buildSystem: r.buildSystem });
      } catch {
        /* 忽略：探测失败不影响编译/运行 */
      }
    },

    openWorkspace: async (path) => {
      // 服务端切换时会终止运行/调试会话，本地 SSE 流必须同步断开
      closeStreams();
      let data: OpenWorkspaceResult;
      try {
        const res = await fetch("/api/workspace/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        data = (await res.json().catch(() => ({}))) as OpenWorkspaceResult;
        if (!res.ok) return data.error || `切换工作区失败 (${res.status})`;
      } catch (e) {
        return "切换工作区失败：" + (e instanceof Error ? e.message : String(e));
      }
      // 旧工作区的标签/内容/断点/终端/问题/调试面板全部作废，一并重置
      set({
        workspace: data.workspace || path,
        tree: data.tree || [],
        // 打开目录后构建系统会变：用服务端随本次响应带回的探测结果刷新徽标
        buildSystem: data.buildSystem ?? null,
        openFiles: [],
        activeFile: null,
        contents: {},
        dirty: {},
        breakpoints: {},
        problems: [],
        termLines: [],
        compileOutput: "",
        aiFix: AI_FIX_IDLE,
        bottomTab: "terminal",
        runState: "idle",
        compilingProject: false,
        debugSessionId: null,
        debugStopped: null,
        callStack: [],
        locals: [],
        watchValues: {},
        watchErrors: {},
        watchChanged: {},
      });
      return undefined;
    },

    pickWorkspace: async () => {
      try {
        const res = await fetch("/api/workspace/pick");
        return (await res.json().catch(() => ({}))) as PickDirResult;
      } catch (e) {
        return { cancelled: true, error: e instanceof Error ? e.message : String(e) };
      }
    },

    openFile: async (path) => {
      const st = get();
      if (!st.openFiles.includes(path)) {
        set({ openFiles: [...st.openFiles, path] });
      }
      set({ activeFile: path });
      if (!(path in st.contents)) {
        const r = await api.readFile(path);
        set((s) => ({ contents: { ...s.contents, [path]: r.content }, dirty: { ...s.dirty, [path]: false } }));
      }
    },

    closeFile: (path) => {
      const st = get();
      // 自动保存开启时：关闭标签页立即把未落盘的内容写盘（防抖窗口里还没存的部分一并保存）
      if (st.dirty[path] && st.settings.autoSave === true) void get().saveFile(path);
      const openFiles = st.openFiles.filter((p) => p !== path);
      const activeFile = st.activeFile === path ? (openFiles[openFiles.length - 1] ?? null) : st.activeFile;
      set({ openFiles, activeFile });
    },

    setActive: (path) => set({ activeFile: path }),

    setContent: (path, text) =>
      set((s) => ({ contents: { ...s.contents, [path]: text }, dirty: { ...s.dirty, [path]: true } })),

    saveFile: async (path) => {
      const st = get();
      if (st.dirty[path]) {
        await api.writeFile(path, st.contents[path] ?? "");
        set((s) => ({ dirty: { ...s.dirty, [path]: false } }));
      }
    },

    saveAll: async () => {
      const st = get();
      for (const path of Object.keys(st.dirty)) {
        if (st.dirty[path]) await api.writeFile(path, st.contents[path] ?? "");
      }
      set((s) => {
        const dirty = { ...s.dirty };
        for (const k of Object.keys(dirty)) dirty[k] = false;
        return { dirty };
      });
    },

    newFile: async (path, isDir = false) => {
      const r = await api.createFile(path, isDir);
      if (r.error) return r.error;
      await get().refreshFiles();
      return undefined;
    },

    // -------------------------------------------------------------------------
    // 新建项目向导（对话框：components/NewProjectDialog.tsx；模板：lib/projectTemplates.ts）
    // -------------------------------------------------------------------------
    createProject: async (id, name) => {
      const tpl = getTemplate(id);
      if (!tpl) return { ok: false, created: [], failed: [], error: `未知模板：${id}` };
      // 名称校验：对话框已经实时校验过，这里再兜一次（对话框只是 UI，编排层必须自洽）
      const bad = validateProjectName(name, tpl.kind);
      if (bad) return { ok: false, created: [], failed: [], error: bad };
      const { stem, ext } = splitRootName(tpl.kind, name);
      const originalRoot = `${stem}${ext}`;

      // ① 重名探测：直接用 /api/fs/list 读「工作区根目录」的真实条目（权威，不依赖前端文件树的
      //    缓存新鲜度：用户完全可能在 IDE 外面新建了同名文件/目录）。请求异常时退化为现有文件树。
      let entries: FsEntry[] = [];
      try {
        const r = await api.fsList("");
        entries = r.entries ?? [];
      } catch {
        entries = [];
      }
      if (entries.length === 0) {
        entries = get().tree.map((n) => ({ name: n.name, path: n.path, type: n.type }));
      }
      const taken = (rootName: string) => entries.some((e) => e.name.toLowerCase() === rootName.toLowerCase());

      // ② 重名自动改名（name → name-1），与拖拽导入完全一致；详见 uniqueRootName 的注释
      const uniq = uniqueRootName(stem, ext, taken);
      if (uniq.exhausted) {
        return { ok: false, created: [], failed: [], error: `同名「${name}」太多，无法自动改名（已尝试 999 次）` };
      }
      const plan = buildTemplate(id, uniq.root);

      // ③ project 模板先建项目目录：目录结构立刻出现在文件树里；此步失败时一个文件都还没写，直接返回
      if (plan.kind === "project") {
        const mk = await api.fsMkdir(plan.root);
        if (mk.error) {
          push("err", `✗ 创建目录 ${plan.root} 失败：${mk.error}`);
          return { ok: false, label: tpl.label, root: plan.root, created: [], failed: [], error: `创建目录「${plan.root}」失败：${mk.error}` };
        }
      }

      // ④ 逐文件写入 /api/fs/write（既有的工作区写接口，无服务端改动）。
      //    单个文件失败**不中断、不回滚**：
      //      - 回滚需要删除已写入的文件，而 /api/fs/delete 只允许删文件与空目录，多文件模板
      //        （含 include/、src/、.vscode/ 子目录）根本删不干净，强行回滚会留下残缺目录；
      //      - 部分成功对用户仍有价值（比如只有 README.md 写失败），直接把「已创建 / 失败」
      //        逐条列出来，用户手动删掉即可，比「全部删掉重来」信息量更大。
      const created: string[] = [];
      const failed: { path: string; reason: string }[] = [];
      for (const f of plan.files) {
        try {
          const r = await api.fsWrite(f.path, f.content);
          if (r.error) failed.push({ path: f.path, reason: r.error });
          else created.push(f.path);
        } catch (e) {
          failed.push({ path: f.path, reason: e instanceof Error ? e.message : String(e) });
        }
      }

      // ⑤ 刷新文件树 + 打开主文件（主文件没写成功时退化为打开第一个写成功的文件）
      try {
        await get().refreshFiles();
      } catch {
        /* 刷新失败不影响本次创建结果，用户可手动点刷新 */
      }
      const openPath = created.includes(plan.mainPath) ? plan.mainPath : created[0];
      if (openPath) {
        try {
          await get().openFile(openPath);
        } catch {
          /* 打开失败也不影响落盘，用户可在文件树里点开 */
        }
      }

      // ⑥ 终端摘要：逐条列出落盘文件（.vscode/* 被文件树的隐藏规则跳过，不列出来用户看不见）、
      //    改名情况与失败原因
      const where = plan.kind === "project" ? `目录 ${plan.root}/` : "工作区根目录";
      if (created.length > 0) {
        push("sys", `✓ 已创建「${tpl.label}」：${created.length}/${plan.files.length} 个文件（${where}）`);
        for (const p of created) push("sys", `  · ${p}`);
      }
      if (uniq.renamed) push("sys", `  · 已存在同名 ${originalRoot}，自动改名为 ${plan.root}`);
      for (const f of failed) push("err", `✗ 写入失败 ${f.path}：${f.reason}`);
      if (created.length === 0) push("err", `✗ 创建「${tpl.label}」失败：没有任何文件写入成功`);
      else if (failed.length > 0) push("err", `⚠ 部分文件写入失败（已创建的文件不回滚，可手动删除）`);

      return {
        ok: failed.length === 0 && created.length > 0,
        label: tpl.label,
        root: plan.root,
        renamed: uniq.renamed,
        originalRoot: uniq.renamed ? originalRoot : undefined,
        mainPath: openPath,
        created,
        failed,
        error:
          created.length === 0
            ? `没有任何文件写入成功（首个失败：${failed[0]?.reason ?? "未知原因"}）`
            : undefined,
      };
    },

    removeFile: async (path) => {
      await api.deleteFile(path);
      const st = get();
      const contents = { ...st.contents };
      const dirty = { ...st.dirty };
      const breakpoints = { ...st.breakpoints };
      delete contents[path];
      delete dirty[path];
      delete breakpoints[path];
      set({
        contents,
        dirty,
        breakpoints,
        openFiles: st.openFiles.filter((p) => p !== path),
        activeFile: st.activeFile === path ? null : st.activeFile,
      });
      await get().refreshFiles();
    },

    rename: async (from, to) => {
      await api.renameFile(from, to);
      const st = get();
      const contents: Record<string, string> = {};
      const dirty: Record<string, boolean> = {};
      const breakpoints: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(st.contents)) contents[k === from ? to : k] = v;
      for (const [k, v] of Object.entries(st.dirty)) dirty[k === from ? to : k] = v;
      for (const [k, v] of Object.entries(st.breakpoints)) breakpoints[k === from ? to : k] = v;
      set({
        contents,
        dirty,
        breakpoints,
        openFiles: st.openFiles.map((p) => (p === from ? to : p)),
        activeFile: st.activeFile === from ? to : st.activeFile,
      });
      await get().refreshFiles();
    },

    importDroppedFiles: async (entries) => {
      const imported: string[] = [];
      const renamed: { from: string; to: string }[] = [];
      const skipped: { name: string; reason: string }[] = [];

      for (const en of entries) {
        // ① 目录：暂不支持（webkitGetAsEntry 判定），给中文提示而不是静默丢弃
        if (en.isDir) {
          skipped.push({ name: en.name, reason: "暂不支持导入文件夹，请拖入单个文件" });
          continue;
        }
        const file = en.file;
        if (!file) {
          skipped.push({ name: en.name, reason: "无法读取该条目" });
          continue;
        }
        // ② 扩展名过滤：不支持的类型在前端就拦掉，不发请求
        if (!isSupportedImport(file.name)) {
          skipped.push({ name: file.name, reason: "不支持的文件类型（支持 .c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx/.txt/.md）" });
          continue;
        }
        // ③ 体积预检：与服务端 8MB 上限一致，避免给超大文件白做一次 base64 编码
        if (file.size > IMPORT_MAX_BYTES) {
          skipped.push({ name: file.name, reason: `文件 ${formatBytes(file.size)} 超过 ${formatBytes(IMPORT_MAX_BYTES)} 上限` });
          continue;
        }
        let b64: string;
        try {
          b64 = await readFileAsBase64(file);
        } catch (e) {
          skipped.push({ name: file.name, reason: e instanceof Error ? e.message : "读取文件失败" });
          continue;
        }
        // ④ 逐个上传：只传文件名，服务端落到工作区根目录；同名会自动改名（name.cpp → name-1.cpp）
        const r = await api.uploadFile(file.name.replace(/[\\/]/g, "_"), b64);
        if (r.error || !r.path) {
          skipped.push({ name: file.name, reason: r.error || "上传失败" });
          continue;
        }
        imported.push(r.path);
        if (r.renamed) renamed.push({ from: file.name, to: r.path });
      }

      // ⑤ 有成功项才刷新文件树 + 自动打开第一个导入的文件
      if (imported.length > 0) {
        await get().refreshFiles();
        await get().openFile(imported[0]);
        push("sys", `✓ 已导入 ${imported.length} 个文件到工作区：${imported.join("、")}`);
      }
      for (const r of renamed) push("sys", `  · ${r.from} 同名，已导入为 ${r.to}`);
      for (const s of skipped) push("err", `✗ 跳过 ${s.name}：${s.reason}`);

      return { imported, renamed, skipped };
    },

    toggleBreakpoint: (file, line) => {
      const st = get();
      const cur = st.breakpoints[file] || [];
      const next = cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b);
      const breakpoints = { ...st.breakpoints };
      if (next.length === 0) delete breakpoints[file];
      else breakpoints[file] = next;
      set({ breakpoints });
    },

    allBreakpoints: () => {
      const out: Breakpoint[] = [];
      for (const [file, lines] of Object.entries(get().breakpoints)) {
        for (const line of lines) out.push({ file, line });
      }
      return out;
    },

    loadSettings: async () => {
      set({ settings: await api.getSettings() });
    },
    updateSettings: async (s) => {
      set({ settings: await api.saveSettings(s) });
      await get().refreshToolchain();
    },
    refreshToolchain: async () => {
      set({ toolchain: await api.toolchain() });
    },
    setShowSettings: (v) => set({ showSettings: v }),
    setBottomTab: (t) => set({ bottomTab: t }),
    appendTerm: push,
    clearTerm: () => set({ termLines: [] }),

    compile: async (project) => {
      const st = get();
      if (!st.activeFile) {
        push("sys", "⚠ 请先打开一个源文件");
        return null;
      }
      set({ runState: "compiling", compilingProject: project, bottomTab: "terminal" });
      push("sys", project ? "── 编译工程…" : `── 编译 ${st.activeFile} …`);
      await get().saveAll();
      const res = await api.compile(st.activeFile, project, get().settings.std);
      // 保存编译器原始输出：AI 一键修复把它作为「完整编译错误文本」的一部分发给 AI
      set({ compileOutput: res.output || "" });
      // 构建系统可能随 Makefile/CMakeLists.txt 增删变化：用本次编译的探测结果刷新徽标
      if (res.buildSystem) set({ buildSystem: res.buildSystem });
      if (res.buildSystem && res.buildSystem.kind !== "single") {
        push("sys", `  构建系统: ${res.buildSystem.label}（${res.buildSystem.evidence}）`);
      }
      if (res.noCompiler) {
        push("err", `✗ 未找到编译器${res.need ? `（需要 ${res.need}）` : ""}。`);
        push("sys", "  请安装 MinGW-w64 / MSYS2（pacman -S mingw-w64-ucrt-x86_64-gcc gdb），");
        push("sys", "  或在「设置」中手动指定编译器路径。");
        set({ runState: "idle", problems: [] });
        set({ showSettings: true });
        return res;
      }
      if (res.error) {
        // 构建系统（CMake/Make）可能「命令成功但找不到 exe」：把构建日志一并显示，便于定位
        if (res.output?.trim()) push("err", res.output.trimEnd());
        push("err", "✗ " + res.error);
        set({ runState: "idle" });
        return res;
      }
      if (res.output?.trim()) push(res.ok ? "sys" : "err", res.output.trimEnd());
      const diags: Diagnostic[] = (res.diagnostics || []).map((d) => ({ ...d, hint: explainError(d) }));
      set({ problems: diags.filter((d) => d.severity !== "note") });
      if (res.ok) {
        push("sys", `✓ 编译成功 (${res.ms}ms)`);
        // 单文件流程沿用「编译器」措辞；CMake/Make 流程实际执行的是构建工具
        if (res.compiler) {
          const isBuildTool = res.buildSystem && res.buildSystem.kind !== "single";
          push("sys", `  ${isBuildTool ? "构建工具" : "编译器"}: ${res.compiler}`);
        }
      } else {
        push("err", `✗ 编译失败：${get().problems.filter((d) => d.severity === "error").length} 个错误`);
        set({ bottomTab: "problems" });
      }
      set({ runState: "idle" });
      return res;
    },

    run: async () => {
      const res = await get().compile(false);
      if (!res || !res.ok || !res.exe) return;
      const r = await api.run(res.exe);
      if (r.error) {
        push("err", "✗ " + r.error);
        return;
      }
      currentRunId = r.id;
      set({ runState: "running", bottomTab: "terminal" });
      push("sys", `── 运行 ${res.exe} ──`);
      runEs = openStream(`/api/run/${r.id}/stream`, {
        out: (d) => {
          const { stream, text } = d as { stream: string; text: string };
          push(stream === "stderr" ? "err" : "out", text);
        },
        exit: (d) => {
          const { code, error } = d as { code: number; error?: string };
          if (error) push("err", "✗ " + error);
          push("sys", `── 进程结束 (退出码 ${code}) ──`);
          set({ runState: "idle" });
          runEs?.close();
          runEs = null;
          currentRunId = null;
        },
      });
    },

    buildAndRun: async () => {
      const res = await get().compile(true);
      if (!res || !res.ok || !res.exe) return;
      const r = await api.run(res.exe);
      if (r.error) {
        push("err", "✗ " + r.error);
        return;
      }
      currentRunId = r.id;
      set({ runState: "running", bottomTab: "terminal" });
      push("sys", `── 运行 ${res.exe} ──`);
      runEs = openStream(`/api/run/${r.id}/stream`, {
        out: (d) => {
          const { stream, text } = d as { stream: string; text: string };
          push(stream === "stderr" ? "err" : "out", text);
        },
        exit: (d) => {
          const { code, error } = d as { code: number; error?: string };
          if (error) push("err", "✗ " + error);
          push("sys", `── 进程结束 (退出码 ${code}) ──`);
          set({ runState: "idle" });
          runEs?.close();
          runEs = null;
          currentRunId = null;
        },
      });
    },

    sendInput: async (text) => {
      push("in", "> " + text);
      if (currentRunId && get().runState === "running") {
        await api.runInput(currentRunId, text + "\n");
      }
    },

    kill: async () => {
      if (currentRunId) await api.runKill(currentRunId);
      if (get().debugSessionId) await api.debugCmd(get().debugSessionId!, "quit", get().watchExprs);
      closeStreams();
      set({ runState: "idle", debugSessionId: null, debugStopped: null, callStack: [], locals: [], watchValues: {}, watchErrors: {}, watchChanged: {}, vizData: null, vizExpr: null, vizBusy: false });
      push("sys", "── 已停止 ──");
    },

    startDebug: async () => {
      const res = await get().compile(false);
      if (!res || !res.ok || !res.exe) return;
      const st = get();
      const bps = st.allBreakpoints();
      if (bps.length === 0) {
        push("sys", "⚠ 尚未设置断点：点击编辑器行号左侧圆点添加断点（至少一个）");
      }
      const r = await api.debugStart(res.exe, bps, st.watchExprs);
      if (r.error) {
        push("err", "✗ " + r.error);
        return;
      }
      set({
        runState: "debugging",
        debugSessionId: r.id,
        bottomTab: "debug",
        debugStopped: null,
        callStack: [],
        watchValues: {},
        watchErrors: {},
        watchChanged: {},
        locals: [],
        vizData: null,
        vizExpr: null,
        vizBusy: false,
      });
      push("sys", `── 调试会话开始 (${res.exe}) ──`);
      dbgEs = openStream(`/api/debug/${r.id}/stream`, {
        console: (d) => push("out", (d as { text: string }).text),
        log: (d) => {
          const t = (d as { text: string }).text;
          if (!t.includes("(gdb)")) push("sys", t.trimEnd());
        },
        running: () => set({ debugStopped: null, vizBusy: false }),
        stopped: (d) => {
          const s = d as {
            reason: string;
            file: string;
            line: number;
            func: string;
            vars: WatchVar[];
            locals: { name: string; value: string }[];
            stack?: DebugFrame[];
          };
          const prev = get();
          const watchValues: Record<string, string> = {};
          const watchErrors: Record<string, string> = {};
          const watchChanged = { ...prev.watchChanged };
          for (const v of s.vars) {
            if (v.error) watchErrors[v.expr] = v.error;
            else watchValues[v.expr] = v.value ?? "";
            // 值变化（或错误状态变化）→ 计数 +1 触发闪烁
            const changed =
              v.error !== undefined
                ? prev.watchErrors[v.expr] !== v.error
                : prev.watchValues[v.expr] !== watchValues[v.expr] ||
                  prev.watchErrors[v.expr] !== undefined;
            if (changed && prev.debugStopped) watchChanged[v.expr] = (watchChanged[v.expr] || 0) + 1;
          }
          set({
            debugStopped: { file: s.file, line: s.line, func: s.func, reason: s.reason },
            callStack: s.stack || [],
            watchValues,
            watchErrors,
            watchChanged,
            locals: s.locals,
            bottomTab: "debug",
          });
          push("sys", `⏸ 停在 ${s.func || "?"} @ ${s.file || "?"}:${s.line} (${s.reason})`);
          // 正在展示的结构图随本次停止自动刷新
          const vz = get().vizExpr;
          if (vz) void get().showViz(vz);
        },
        exited: (d) => {
          const { reason } = d as { reason: string };
          push("sys", `── 调试结束 (${reason}) ──`);
          closeStreams();
          set({ runState: "idle", debugSessionId: null, debugStopped: null, callStack: [], locals: [], watchValues: {}, watchErrors: {}, watchChanged: {}, vizData: null, vizExpr: null, vizBusy: false });
        },
      });
      await get().debugControl("run");
    },

    debugControl: async (op) => {
      const id = get().debugSessionId;
      if (!id) return;
      if (op === "quit") {
        await get().kill();
        return;
      }
      await api.debugCmd(id, op, get().watchExprs);
    },

    debugEvalExpr: async (expr) => {
      const id = get().debugSessionId;
      if (!id) throw new Error("未在调试中");
      // 命中"忙"（停止处理中）时短暂重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await api.debugEval(id, expr);
        if (r.error === "忙") {
          await new Promise((res) => setTimeout(res, 150));
          continue;
        }
        if (r.error) throw new Error(r.error);
        return r.value ?? "";
      }
      throw new Error("求值超时，请重试");
    },

    showViz: async (expr) => {
      const id = get().debugSessionId;
      if (!id) return;
      set({ vizExpr: expr, vizBusy: true });
      let r: VizData = { kind: "error", error: "获取可视化数据超时" };
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await api.debugViz(id, expr);
        if (res.error === "忙") {
          await new Promise((res2) => setTimeout(res2, 150));
          continue;
        }
        r = res;
        break;
      }
      // 等待期间用户可能切换了可视化目标，只接受仍是当前目标的结果
      set((s) => (s.vizExpr === expr ? { vizData: r, vizBusy: false } : {}));
    },

    closeViz: () => set({ vizData: null, vizExpr: null, vizBusy: false }),

    addWatch: (expr) => {
      const e = expr.trim();
      if (!e || get().watchExprs.includes(e)) return;
      set((s) => ({ watchExprs: [...s.watchExprs, e] }));
      if (get().debugSessionId && get().debugStopped) {
        void api.debugCmd(get().debugSessionId!, "vars", get().watchExprs);
      }
    },

    removeWatch: (expr) => {
      set((s) => ({ watchExprs: s.watchExprs.filter((x) => x !== expr) }));
      if (get().debugSessionId && get().debugStopped) {
        void api.debugCmd(get().debugSessionId!, "vars", get().watchExprs);
      }
    },

    sendAi: async (text) => {
      const msgs = [...get().aiMessages, { role: "user" as const, content: text }];
      set({ aiMessages: msgs, aiBusy: true, bottomTab: "ai" });
      const r = await api.ai(msgs.slice(-20));
      set((s) => ({
        aiMessages: [...s.aiMessages, { role: "assistant", content: r.error ? "⚠ " + r.error : r.content || "(空回复)" }],
        aiBusy: false,
      }));
    },

    clearAi: () => set({ aiMessages: [] }),

    // -------------------------------------------------------------------------
    // AI 一键修复：这里只放「状态 + 写回」；收集上下文 / 请求 / 解析在 src/lib/aiFix.ts
    // -------------------------------------------------------------------------
    patchAiFix: (patch) => set((s) => ({ aiFix: { ...s.aiFix, ...patch } })),

    setAiFixActive: (index) =>
      set((s) => ({ aiFix: { ...s.aiFix, active: Math.max(0, Math.min(index, s.aiFix.files.length - 1)) } })),

    applyAiFix: async () => {
      const st = get();
      if (st.aiFix.status !== "ready" || st.aiFix.files.length === 0) return;
      const contents = { ...st.contents };
      const dirty = { ...st.dirty };
      const failed: string[] = [];
      for (const f of st.aiFix.files) {
        // 复用与 saveFile 完全相同的写文件接口（/api/file PUT），落盘语义一致
        const r = (await api.writeFile(f.path, f.fixed)) as { ok?: boolean; error?: string };
        if (r.error) {
          failed.push(`${f.path}：${r.error}`);
          continue;
        }
        // 编辑器已打开该文件时同步缓存内容并清除脏标记，避免与磁盘内容不一致
        contents[f.path] = f.fixed;
        dirty[f.path] = false;
      }
      set({ contents, dirty });
      if (failed.length > 0) {
        set((s) => ({
          aiFix: { ...s.aiFix, error: "部分文件写回失败：\n· " + failed.join("\n· ") },
        }));
        return;
      }
      push("sys", `✓ 已应用 AI 修复：${st.aiFix.files.map((f) => f.path).join("、")}`);
      set({ aiFix: AI_FIX_IDLE });
    },

    closeAiFix: () => set({ aiFix: AI_FIX_IDLE }),
  };
});
