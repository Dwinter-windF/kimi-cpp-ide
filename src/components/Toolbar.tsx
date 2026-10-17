import {
  FilePlus2,
  FolderPlus,
  Save,
  Timer,
  Hammer,
  Play,
  Package,
  Bug,
  StepForward,
  ArrowDownToLine,
  ArrowUpFromLine,
  Square,
  Settings,
  Sparkles,
  Search,
} from "lucide-react";
import { openSearchPanel } from "@codemirror/search";
import { useIde } from "@/store";
import { getActiveEditor } from "@/lib/editorRegistry";

function ToolButton({
  title,
  onClick,
  disabled,
  children,
  accent,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`kimi-pop p-[7px] rounded-md transition-colors ${
        disabled
          ? "text-[color:var(--ide-text-faint)] cursor-not-allowed"
          : accent
            ? `${accent} text-white`
            : "text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
      }`}
    >
      {children}
    </button>
  );
}

export function Toolbar() {
  const runState = useIde((s) => s.runState);
  const activeFile = useIde((s) => s.activeFile);
  const toolchain = useIde((s) => s.toolchain);
  const dirty = useIde((s) => s.dirty);
  const buildMode = useIde((s) => s.settings.buildMode || "debug");
  const autoSave = useIde((s) => s.settings.autoSave === true);
  const updateSettings = useIde((s) => s.updateSettings);
  const s = useIde.getState();

  const busy = runState === "compiling";
  const running = runState === "running";
  const debugging = runState === "debugging";
  const hasDirty = Object.values(dirty).some(Boolean);

  const cxxOk = toolchain?.cxx?.found;
  const gdbOk = toolchain?.gdb?.found;

  return (
    <div className="flex items-center gap-1 px-2 h-11 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] shrink-0">
      <span className="text-[13px] font-bold text-[color:var(--ide-accent)] mr-2 select-none">⚡ Kimi C++ IDE</span>

      <ToolButton
        title="新建文件"
        onClick={() => {
          const st = useIde.getState();
          st.openNameDialog({
            title: "新建文件",
            placeholder: "文件名（可包含目录，如 src/main.cpp）",
            initial: "untitled.cpp",
            onSubmit: (name) => void st.newFile(name).then((err) => err && window.alert(err)),
          });
        }}
      >
        <FilePlus2 size={16} />
      </ToolButton>
      {/* 新建项目向导（对话框在 components/NewProjectDialog.tsx，编排在 store.createProject） */}
      <ToolButton title="新建项目…（模板向导）" onClick={() => s.setShowNewProject(true)}>
        <FolderPlus size={16} />
      </ToolButton>
      <ToolButton title="保存 (Ctrl+S)" onClick={() => void s.saveAll()} disabled={!hasDirty}>
        <Save size={16} />
      </ToolButton>
      {/* 自动保存开关：点击即持久化（服务端合并保存），开启后保存按钮旁高亮 */}
      <ToolButton
        title={autoSave ? "自动保存：开（停止输入约 0.8 秒后落盘，关闭文件时立即保存）" : "自动保存：关（点击开启）"}
        onClick={() => void updateSettings({ ...s.settings, autoSave: !autoSave })}
        accent={autoSave ? "bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)]" : undefined}
      >
        <Timer size={16} />
      </ToolButton>
      <ToolButton
        title="查找替换 (Ctrl+F / Ctrl+H)"
        onClick={() => {
          const view = getActiveEditor();
          if (view) {
            openSearchPanel(view);
            view.focus();
          }
        }}
        disabled={!activeFile}
      >
        <Search size={16} />
      </ToolButton>

      <span className="w-px h-5 bg-[color:var(--ide-hover)] mx-1" />

      <select
        title="Debug：-g -O0（调试友好，默认）；Release：-O2（运行更快）"
        value={buildMode}
        onChange={(e) => void updateSettings({ buildMode: e.target.value })}
        className="kimi-select bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] rounded-md text-[12px] text-[color:var(--ide-text)] px-1.5 py-[5px] focus:outline-none focus:border-[color:var(--ide-accent)] cursor-pointer"
      >
        <option value="debug">Debug (-g -O0)</option>
        <option value="release">Release (-O2)</option>
      </select>

      <ToolButton title="编译当前文件" onClick={() => void s.compile(false)} disabled={busy || !activeFile}>
        <Hammer size={16} />
      </ToolButton>
      <ToolButton title="编译并运行当前文件" onClick={() => void s.run()} disabled={busy || running || debugging || !activeFile} accent="bg-[color:var(--ide-purple)]">
        <Play size={16} />
      </ToolButton>
      <ToolButton title="构建整个工程并运行（编译所有源文件）" onClick={() => void s.buildAndRun()} disabled={busy || running || debugging || !activeFile}>
        <Package size={16} />
      </ToolButton>

      <span className="w-px h-5 bg-[color:var(--ide-hover)] mx-1" />

      <ToolButton title="开始调试（需先设置断点，需 GDB）" onClick={() => void s.startDebug()} disabled={busy || running || debugging || !activeFile}>
        <Bug size={16} />
      </ToolButton>
      <ToolButton title="下一步 (next)" onClick={() => void s.debugControl("next")} disabled={!debugging}>
        <StepForward size={16} />
      </ToolButton>
      <ToolButton title="单步进入 (step)" onClick={() => void s.debugControl("step")} disabled={!debugging}>
        <ArrowDownToLine size={16} />
      </ToolButton>
      <ToolButton title="跳出函数 (finish)" onClick={() => void s.debugControl("finish")} disabled={!debugging}>
        <ArrowUpFromLine size={16} />
      </ToolButton>
      <ToolButton title="继续运行 (continue)" onClick={() => void s.debugControl("continue")} disabled={!debugging}>
        <Play size={16} />
      </ToolButton>
      <ToolButton title="停止" onClick={() => void s.kill()} disabled={runState === "idle"}>
        <Square size={15} />
      </ToolButton>

      <span className="w-px h-5 bg-[color:var(--ide-hover)] mx-1" />

      <ToolButton title="AI 助手" onClick={() => s.setBottomTab("ai")}>
        <Sparkles size={16} />
      </ToolButton>

      <div className="flex-1" />

      <div className="flex items-center gap-3 text-[11px] text-[color:var(--ide-text-muted)] mr-2 select-none">
        <span className="flex items-center gap-1" title={cxxOk ? toolchain?.cxx?.version || "编译器可用" : "未找到 C++ 编译器"}>
          <span className={`w-2 h-2 rounded-full ${cxxOk ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-error)]"}`} />
          编译器
        </span>
        <span className="flex items-center gap-1" title={gdbOk ? toolchain?.gdb?.version || "GDB 可用" : "未找到 GDB（断点调试不可用）"}>
          <span className={`w-2 h-2 rounded-full ${gdbOk ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-warning)]"}`} />
          GDB
        </span>
      </div>

      <ToolButton title="设置" onClick={() => s.setShowSettings(true)}>
        <Settings size={16} />
      </ToolButton>
    </div>
  );
}
