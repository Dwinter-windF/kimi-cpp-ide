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
import { useT } from "@/lib/i18n";
import { evalConsoleOf } from "@/types";

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
  const t = useT();
  const runState = useIde((s) => s.runState);
  const activeFile = useIde((s) => s.activeFile);
  const toolchain = useIde((s) => s.toolchain);
  const dirty = useIde((s) => s.dirty);
  const buildMode = useIde((s) => s.settings.buildMode || "debug");
  const autoSave = useIde((s) => s.settings.autoSave === true);
  const evalConsole = useIde((s) => evalConsoleOf(s.settings));
  const updateSettings = useIde((s) => s.updateSettings);
  const s = useIde.getState();

  const busy = runState === "compiling";
  const running = runState === "running";
  const debugging = runState === "debugging";
  const hasDirty = Object.values(dirty).some(Boolean);

  const cxxOk = toolchain?.cxx?.found;
  const gdbOk = toolchain?.gdb?.found;
  const clangFormatOk = toolchain?.clangFormat?.found;

  return (
    <div className="flex items-center gap-1 px-2 h-11 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] shrink-0">
      <span className="text-[13px] font-bold text-[color:var(--ide-accent)] mr-2 select-none">⚡ Kimi C++ IDE</span>

      <ToolButton
        title={t("toolbar.newFile")}
        onClick={() => {
          const st = useIde.getState();
          st.openNameDialog({
            title: t("toolbar.newFile"),
            placeholder: t("toolbar.newFileNamePlaceholder"),
            initial: "untitled.cpp",
            onSubmit: (name) => void st.newFile(name).then((err) => err && window.alert(err)),
          });
        }}
      >
        <FilePlus2 size={16} />
      </ToolButton>
      {/* 新建项目向导（对话框在 components/NewProjectDialog.tsx，编排在 store.createProject） */}
      <ToolButton title={t("toolbar.newProject")} onClick={() => s.setShowNewProject(true)}>
        <FolderPlus size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.save")} onClick={() => void s.saveAll()} disabled={!hasDirty}>
        <Save size={16} />
      </ToolButton>
      {/* 自动保存开关：点击即持久化（服务端合并保存），开启后保存按钮旁高亮 */}
      <ToolButton
        title={autoSave ? t("toolbar.autoSaveOn") : t("toolbar.autoSaveOff")}
        onClick={() => void updateSettings({ ...s.settings, autoSave: !autoSave })}
        accent={autoSave ? "bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)]" : undefined}
      >
        <Timer size={16} />
      </ToolButton>
      <ToolButton
        title={t("toolbar.findReplace")}
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
        title={t("toolbar.buildModeHint")}
        value={buildMode}
        onChange={(e) => void updateSettings({ buildMode: e.target.value })}
        className="kimi-select bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] rounded-md text-[12px] text-[color:var(--ide-text)] px-1.5 py-[5px] focus:outline-none focus:border-[color:var(--ide-accent)] cursor-pointer"
      >
        <option value="debug">Debug (-g -O0)</option>
        <option value="release">Release (-O2)</option>
      </select>

      <ToolButton title={t("toolbar.compile")} onClick={() => void s.compile(false)} disabled={busy || !activeFile}>
        <Hammer size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.compileRun")} onClick={() => void s.run()} disabled={busy || running || debugging || !activeFile} accent="bg-[color:var(--ide-purple)]">
        <Play size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.buildRun")} onClick={() => void s.buildAndRun()} disabled={busy || running || debugging || !activeFile}>
        <Package size={16} />
      </ToolButton>

      <span className="w-px h-5 bg-[color:var(--ide-hover)] mx-1" />

      <ToolButton title={t("toolbar.debug")} onClick={() => void s.startDebug()} disabled={busy || running || debugging || !activeFile}>
        <Bug size={16} />
      </ToolButton>
      {/* 求值控制台门控：开始调试前选择，调试/运行期间不可改；值会随设置持久化 */}
      <label
        title={t("toolbar.evalConsole")}
        className={`flex items-center gap-1 px-1 text-[11px] select-none ${
          runState === "idle" ? "cursor-pointer text-[color:var(--ide-text-muted)]" : "cursor-not-allowed text-[color:var(--ide-text-faint)]"
        }`}
      >
        <input
          type="checkbox"
          checked={evalConsole}
          disabled={runState !== "idle"}
          onChange={(e) =>
            void updateSettings({ ...useIde.getState().settings, evalConsole: e.target.checked })
          }
          style={{ accentColor: "var(--ide-accent)" }}
          className="w-3 h-3"
        />
        <span className="whitespace-nowrap">{t("toolbar.evalConsoleShort")}</span>
      </label>
      <ToolButton title={t("toolbar.next")} onClick={() => void s.debugControl("next")} disabled={!debugging}>
        <StepForward size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.stepIn")} onClick={() => void s.debugControl("step")} disabled={!debugging}>
        <ArrowDownToLine size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.stepOut")} onClick={() => void s.debugControl("finish")} disabled={!debugging}>
        <ArrowUpFromLine size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.continue")} onClick={() => void s.debugControl("continue")} disabled={!debugging}>
        <Play size={16} />
      </ToolButton>
      <ToolButton title={t("toolbar.stop")} onClick={() => void s.kill()} disabled={runState === "idle"}>
        <Square size={15} />
      </ToolButton>

      <span className="w-px h-5 bg-[color:var(--ide-hover)] mx-1" />

      <ToolButton title={t("toolbar.ai")} onClick={() => s.setBottomTab("ai")}>
        <Sparkles size={16} />
      </ToolButton>

      <div className="flex-1" />

      <div className="flex items-center gap-3 text-[11px] text-[color:var(--ide-text-muted)] mr-2 select-none">
        <span className="flex items-center gap-1" title={cxxOk ? toolchain?.cxx?.version || t("toolbar.compilerOk") : t("toolbar.compilerMissing")}>
          <span className={`w-2 h-2 rounded-full ${cxxOk ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-error)]"}`} />
          {t("toolbar.compiler")}
        </span>
        <span className="flex items-center gap-1" title={gdbOk ? toolchain?.gdb?.version || t("toolbar.gdbOk") : t("toolbar.gdbMissing")}>
          <span className={`w-2 h-2 rounded-full ${gdbOk ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-warning)]"}`} />
          GDB
        </span>
        <span
          className="flex items-center gap-1"
          title={clangFormatOk ? toolchain?.clangFormat?.version || t("toolbar.clangFormatOk") : t("toolbar.clangFormatMissing")}
        >
          <span className={`w-2 h-2 rounded-full ${clangFormatOk ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-text-faint)]"}`} />
          {t("toolbar.clangFormat")}
        </span>
      </div>

      <ToolButton title={t("toolbar.settings")} onClick={() => s.setShowSettings(true)}>
        <Settings size={16} />
      </ToolButton>
    </div>
  );
}
