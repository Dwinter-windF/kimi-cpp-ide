import { lazy, memo, Suspense, useEffect } from "react";
import { X } from "lucide-react";
import { LAYOUT_LIMITS, maxBottomHeight, useIde } from "@/store";
import { Toolbar } from "@/components/Toolbar";
import { FileTree } from "@/components/FileTree";
import { FileDropZone } from "@/components/FileDropZone";
import { EditorPane } from "@/components/EditorPane";
import { OutlinePanel } from "@/components/OutlinePanel";
import { BottomPanel } from "@/components/BottomPanel";
import { Splitter } from "@/components/Splitter";
import { themeOf, type FileNode } from "@/types";

// 拖动分隔条时 App 每帧都会重渲染；编辑器（内含 CodeMirror）与 App 的其余状态无关，
// 用 memo 隔断，避免整棵编辑器子树跟着重渲染影响拖动流畅度。
const MemoEditorPane = memo(EditorPane);

// 非首屏必要组件：项目无路由，用 React.lazy 做组件级懒加载（命名导出包一层 default）。
const WatchPanel = lazy(() =>
  import("@/components/WatchPanel").then((m) => ({ default: m.WatchPanel }))
);
const SettingsDialog = lazy(() =>
  import("@/components/SettingsDialog").then((m) => ({ default: m.SettingsDialog }))
);
const NameDialog = lazy(() =>
  import("@/components/NameDialog").then((m) => ({ default: m.NameDialog }))
);
// 「新建项目向导」：只有点了工具栏/文件树上的「新建项目…」才需要，懒加载
const NewProjectDialog = lazy(() =>
  import("@/components/NewProjectDialog").then((m) => ({ default: m.NewProjectDialog }))
);
// 「AI 一键修复」预览弹层：只有真的发起修复后才需要，懒加载
const AiFixDialog = lazy(() =>
  import("@/components/AiFixDialog").then((m) => ({ default: m.AiFixDialog }))
);

function firstSource(nodes: FileNode[]): string | null {
  for (const n of nodes) {
    if (n.type === "file" && /\.(c|cc|cpp|cxx|h|hpp)$/i.test(n.name)) return n.path;
    if (n.type === "dir" && n.children) {
      const r = firstSource(n.children);
      if (r) return r;
    }
  }
  for (const n of nodes) {
    if (n.type === "file") return n.path;
  }
  return null;
}

export default function App() {
  const openFiles = useIde((s) => s.openFiles);
  const activeFile = useIde((s) => s.activeFile);
  const setActive = useIde((s) => s.setActive);
  const closeFile = useIde((s) => s.closeFile);
  const dirty = useIde((s) => s.dirty);
  const layout = useIde((s) => s.layout);
  const setLayout = useIde((s) => s.setLayout);
  // 配色方案：settings 里缺字段 / 非法值一律按 dark（见 types.themeOf）
  const theme = useIde((s) => themeOf(s.settings));

  // 有未保存文件时拦截页面关闭/刷新：浏览器会弹出二次确认（Electron 窗口关闭同样生效）。
  // 监听挂在 window 上、每次读最新 dirty，不依赖 React 渲染时机。
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (Object.values(useIde.getState().dirty).some(Boolean)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  // 主题落到 <html data-theme>：index.css 的 [data-theme="light"] 覆盖 :root 的暗色变量。
  // 只改一个属性 → 全部 var(--ide-*) 同时生效，无需刷新页面；settings 一变（保存后）立即重跑。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 拖动中只 set 状态（每帧实时跟手），松手时 commit=true 才写 localStorage
  const commitLayout = () => setLayout({}, true);
  // 底部面板上限随时按视口高度算（拖动会触发重渲染，因此无需监听 resize）
  const bottomMax = maxBottomHeight();

  useEffect(() => {
    void (async () => {
      const st = useIde.getState();
      await st.loadSettings();
      await st.refreshToolchain();
      await st.loadWorkspace();
      await st.refreshFiles();
      const first = firstSource(useIde.getState().tree);
      if (first) await useIde.getState().openFile(first);
    })();
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-[color:var(--ide-bg-base)] text-[color:var(--ide-text)] overflow-hidden">
      <Toolbar />
      {/* 拖拽导入区：覆盖「文件树 + 编辑器 + 右侧面板」整块主工作区
          （不含工具栏与底部面板：底部是终端 / AI 输入框，拖文件到那里不应触发导入） */}
      <FileDropZone>
        {/* 左侧：工程文件（宽度由 layout.left 控制；lg 以下沿用原有 hidden 行为，不显示分隔条） */}
        <aside
          className="border-r border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] shrink-0 hidden md:block"
          style={{ width: layout.left }}
        >
          <FileTree />
        </aside>
        <Splitter
          orientation="vertical"
          className="hidden lg:block"
          value={layout.left}
          onChange={(v) => setLayout({ left: v })}
          onCommit={commitLayout}
          min={LAYOUT_LIMITS.left.min}
          max={LAYOUT_LIMITS.left.max}
          title={`拖动调节文件树宽度（${LAYOUT_LIMITS.left.min}–${LAYOUT_LIMITS.left.max}px）`}
          label="调节文件树宽度"
        />

        {/* 中间：标签页 + 编辑器 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center overflow-x-auto border-b border-[color:var(--ide-border)] shrink-0 min-h-9">
            {openFiles.length === 0 && (
              <span className="text-[12px] text-[color:var(--ide-text-faint)] px-3 py-2">从左侧选择一个文件开始编辑</span>
            )}
            {openFiles.map((f) => (
              <div
                key={f}
                onClick={() => setActive(f)}
                className={`kimi-tab group flex items-center gap-1.5 pl-3 pr-2 py-2 text-[12.5px] cursor-pointer border-r border-[color:var(--ide-border)] whitespace-nowrap ${
                  activeFile === f ? "bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)] border-t-2 border-t-[color:var(--ide-accent)]" : "text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text-dim)]"
                }`}
              >
                {dirty[f] && <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ide-warning)] shrink-0" title="未保存" />}
                <span>{f.split("/").pop()}</span>
                <button
                  className="kimi-pop opacity-0 group-hover:opacity-100 p-[2px] rounded hover:bg-[color:var(--ide-selected)] text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    // 未保存时二次确认；自动保存开启时关闭会先落盘（store.closeFile 兜底），不必确认
                    if (dirty[f] && useIde.getState().settings.autoSave !== true) {
                      if (!window.confirm(`「${f.split("/").pop()}」有未保存的修改，关闭将丢弃这些修改。确定关闭吗？`)) return;
                    }
                    closeFile(f);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {activeFile ? (
              <MemoEditorPane key={activeFile} file={activeFile} />
            ) : (
              <div className="h-full flex items-center justify-center text-[color:var(--ide-text-faint)] text-[13px]">
                <div className="text-center leading-7">
                  <div className="text-3xl mb-2">⚡</div>
                  Kimi C++ IDE
                  <br />
                  <span className="text-[12px]">新建或打开一个文件开始编程</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：大纲 + 监视变量 + 断点（宽度由 layout.right 控制） */}
        <Splitter
          orientation="vertical"
          invert
          className="hidden lg:block"
          value={layout.right}
          onChange={(v) => setLayout({ right: v })}
          onCommit={commitLayout}
          min={LAYOUT_LIMITS.right.min}
          max={LAYOUT_LIMITS.right.max}
          title={`拖动调节右侧面板宽度（${LAYOUT_LIMITS.right.min}–${LAYOUT_LIMITS.right.max}px）`}
          label="调节右侧面板宽度"
        />
        <aside
          className="border-l border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] shrink-0 hidden lg:flex lg:flex-col"
          style={{ width: layout.right }}
        >
          <OutlinePanel />
          <div className="flex-1 min-h-0 flex flex-col">
            <Suspense fallback={null}>
              <WatchPanel />
            </Suspense>
          </div>
        </aside>
      </FileDropZone>
      {/* 底部面板：上方一根横向分隔条，高度由 layout.bottom 控制 */}
      <Splitter
        orientation="horizontal"
        invert
        className="hidden lg:block"
        value={layout.bottom}
        onChange={(v) => setLayout({ bottom: v })}
        onCommit={commitLayout}
        min={LAYOUT_LIMITS.bottom.min}
        max={bottomMax}
        title={`拖动调节底部面板高度（${LAYOUT_LIMITS.bottom.min}px – 视口 60%）`}
        label="调节底部面板高度"
      />
      <BottomPanel height={layout.bottom} />
      <Suspense fallback={null}>
        <SettingsDialog />
      </Suspense>
      <Suspense fallback={null}>
        <NameDialog />
      </Suspense>
      <Suspense fallback={null}>
        <NewProjectDialog />
      </Suspense>
      <Suspense fallback={null}>
        <AiFixDialog />
      </Suspense>
    </div>
  );
}
