import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RefreshCw } from "lucide-react";
import { useIde } from "@/store";
import { LANGUAGE_OPTIONS, useT, type LanguageId } from "@/lib/i18n";
import { FontSettings } from "@/components/FontSettings";
import {
  DEFAULT_MAX_UNDO_STEPS,
  MAX_UNDO_STEPS_RANGE,
  editorFlagOn,
  editorFontFamilyOf,
  editorFontSizeOf,
  editorTabSizeOf,
  languageOf,
  maxUndoStepsOf,
  themeOf,
  uiFontFamilyOf,
  uiFontSizeOf,
  type EditorFlag,
  type Settings,
  type ThemeName,
} from "@/types";

/** 补上旧 settings.json 缺失字段的默认值（编辑器开关默认开；字体字段回落到默认字体/字号） */
function withDefaults(s: Settings): Settings {
  return {
    ...s,
    highlightSelectionMatches: editorFlagOn(s, "highlightSelectionMatches"),
    highlightBracketPairs: editorFlagOn(s, "highlightBracketPairs"),
    aiInlineComplete: editorFlagOn(s, "aiInlineComplete"),
    uiFontFamily: uiFontFamilyOf(s),
    uiFontSize: uiFontSizeOf(s),
    editorFontFamily: editorFontFamilyOf(s),
    editorFontSize: editorFontSizeOf(s),
    editorTabSize: editorTabSizeOf(s),
  };
}

/** 配色方案可选项（暗色在前，缺省即暗色） */
const THEME_OPTIONS: { value: ThemeName; labelKey: string }[] = [
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "light", labelKey: "settings.themeLight" },
];

/** 页签（顺序即展示顺序） */
type TabId = "appearance" | "fonts" | "editor" | "toolchain" | "ai";
const TAB_OPTIONS: { value: TabId; labelKey: string }[] = [
  { value: "appearance", labelKey: "settings.tab.appearance" },
  { value: "fonts", labelKey: "settings.tab.fonts" },
  { value: "editor", labelKey: "settings.tab.editor" },
  { value: "toolchain", labelKey: "settings.tab.toolchain" },
  { value: "ai", labelKey: "settings.tab.ai" },
];

const INPUT_CLS =
  "mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]";

/** 设置分区卡片（统一 --ide-* 配色；宽屏两列、窄屏单列由外层 grid 控制） */
function Card({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`min-w-0 space-y-2 rounded-md border border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] p-3 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsDialog() {
  const t = useT();
  const show = useIde((s) => s.showSettings);
  const setShow = useIde((s) => s.setShowSettings);
  const settings = useIde((s) => s.settings);
  const toolchain = useIde((s) => s.toolchain);
  const updateSettings = useIde((s) => s.updateSettings);
  const refreshToolchain = useIde((s) => s.refreshToolchain);

  const [form, setForm] = useState<Settings>(() => withDefaults(settings));
  const [tab, setTab] = useState<TabId>("appearance");
  // 撤销步数输入框（字符串态，保存时转数字并收敛范围）
  const [undoSteps, setUndoSteps] = useState(() => String(maxUndoStepsOf(settings)));

  // 字体设置的 100ms 节流落盘：拖动滑块时本地表单立即更新（预览实时跟手），
  // 连续改动合并成一次 updateSettings；latestFonts 用于在慢请求返回后盖回最新值。
  const fontSaveTimer = useRef<number | null>(null);
  const latestFonts = useRef<Partial<Settings>>({});

  const cancelPendingFontSave = () => {
    if (fontSaveTimer.current !== null) {
      clearTimeout(fontSaveTimer.current);
      fontSaveTimer.current = null;
    }
  };

  const flushFontSave = useCallback(() => {
    if (fontSaveTimer.current === null) return;
    clearTimeout(fontSaveTimer.current);
    fontSaveTimer.current = null;
    const desired = latestFonts.current;
    void updateSettings({ ...useIde.getState().settings, ...desired }).then(() => {
      useIde.setState((s) => ({ settings: { ...s.settings, ...latestFonts.current } }));
    });
  }, [updateSettings]);

  useEffect(() => {
    if (show) {
      // 若上一次关闭的瞬间还有未落盘的字体改动，先提交，再按最新 store 值重置表单。
      flushFontSave();
      const current = useIde.getState().settings;
      // 以当前生效值作为「最新字体意图」的基线：即使有更早的保存请求稍后才返回，
      // 也能把 store 纠正回用户最后看到的那一组字体值，而不是被旧响应覆盖。
      latestFonts.current = {
        uiFontFamily: uiFontFamilyOf(current),
        uiFontSize: uiFontSizeOf(current),
        editorFontFamily: editorFontFamilyOf(current),
        editorFontSize: editorFontSizeOf(current),
        editorTabSize: editorTabSizeOf(current),
      };
      setForm(withDefaults(current));
      setUndoSteps(String(maxUndoStepsOf(current)));
      setTab("appearance");
    }
  }, [show, flushFontSave]);

  // 关闭（X / Esc / 取消）或卸载时把未落盘的字体改动立即提交，避免最后一次拖动丢失。
  useEffect(() => {
    if (!show) return;
    return () => flushFontSave();
  }, [show, flushFontSave]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setFlag = (k: EditorFlag, v: boolean) => setForm((f) => ({ ...f, [k]: v }));
  /** 配色方案：只改本地表单，点「保存」后走既有 updateSettings 通道落盘并全局生效 */
  const setTheme = (v: ThemeName) => setForm((f) => ({ ...f, theme: v }));

  /**
   * 字体类设置（五项）：本地表单 + store 立即生效（预览 / App / EditorPane 实时跟随），
   * 持久化走既有 updateSettings 通道并做 100ms 节流：拖动过程中只更新状态，
   * 连续改动结束后（或关闭对话框时）合并提交一次，避免每帧发请求。
   * 用已保存 settings 打底，避免把对话框里其它尚未保存的输入一起提交。
   */
  const commitFonts = (patch: Partial<Settings>) => {
    latestFonts.current = { ...latestFonts.current, ...patch };
    setForm((f) => ({ ...f, ...patch }));
    useIde.setState((s) => ({ settings: { ...s.settings, ...patch } }));
    cancelPendingFontSave();
    fontSaveTimer.current = window.setTimeout(() => {
      fontSaveTimer.current = null;
      const desired = latestFonts.current;
      void updateSettings({ ...useIde.getState().settings, ...desired }).then(() => {
        // updateSettings 会用服务端返回覆盖 store；若期间又拖出了新值，这里再盖回最新值。
        useIde.setState((s) => ({ settings: { ...s.settings, ...latestFonts.current } }));
      });
    }, 100);
  };

  /**
   * 语言：要求「切换即时生效并持久化」，因此立即写回 store（updateSettings 走原有保存通道）。
   * 用已保存的 settings 打底，避免把对话框里尚未保存的其它修改一起提交。
   */
  const setLanguage = (v: LanguageId) => {
    setForm((f) => ({ ...f, language: v }));
    // 先乐观更新 store：所有订阅 useT 的组件立即切换语言，不等服务端往返
    useIde.setState((s) => ({ settings: { ...s.settings, language: v } }));
    void updateSettings({ ...useIde.getState().settings, language: v });
  };

  const toolRow = (label: string, info?: { found: boolean; path?: string; version?: string }) => (
    <div className="flex min-w-0 items-center gap-2 text-[12px]">
      <span className={`w-2 h-2 rounded-full shrink-0 ${info?.found ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-error)]"}`} />
      <span className="text-[color:var(--ide-text-dim)] w-16 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--ide-text-muted)]" title={info?.path}>
        {info?.found ? (info.path || t("common.found")) : t("common.notFound")}
      </span>
    </div>
  );

  const radioRow = <T extends string,>(
    name: string,
    options: { value: T; labelKey: string }[],
    current: T,
    onSelect: (v: T) => void
  ) => (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {options.map((opt) => (
        <label
          key={opt.value}
          htmlFor={`opt-${name}-${opt.value}`}
          className="flex items-center gap-2 text-[12.5px] text-[color:var(--ide-text)] cursor-pointer"
        >
          <input
            id={`opt-${name}-${opt.value}`}
            type="radio"
            name={name}
            value={opt.value}
            checked={current === opt.value}
            onChange={() => onSelect(opt.value)}
            className="w-3.5 h-3.5 cursor-pointer accent-[color:var(--ide-accent)]"
          />
          {t(opt.labelKey)}
        </label>
      ))}
    </div>
  );

  return (
    <Dialog open={show} onOpenChange={setShow}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-3xl flex-col overflow-hidden border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)] sm:max-w-3xl supports-[height:100dvh]:max-h-[calc(100dvh-2rem)]">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-0.5 py-1">
          {/* 页签栏：sticky 置顶，滚动内容时仍可切换分类；样式全部走 --ide-* 变量 */}
          <div
            role="tablist"
            aria-label={t("settings.title")}
            className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-1 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-bg-panel)] pb-1.5"
          >
            {TAB_OPTIONS.map((opt) => {
              const active = tab === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  id={`settings-tab-${opt.value}`}
                  aria-selected={active}
                  aria-controls={`settings-panel-${opt.value}`}
                  onClick={() => setTab(opt.value)}
                  className={`kimi-tab rounded-t-md border-b-2 px-3 py-1.5 text-[12.5px] font-medium ${
                    active
                      ? "border-[color:var(--ide-accent)] bg-[color:var(--ide-selected)] text-[color:var(--ide-text)]"
                      : "border-transparent text-[color:var(--ide-text-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-dim)]"
                  }`}
                >
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>

          {/* 外观：语言 / 配色（字体设置已集中到「字体」页） */}
          {tab === "appearance" && (
            <div
              role="tabpanel"
              id="settings-panel-appearance"
              aria-labelledby="settings-tab-appearance"
              className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2"
            >
              <Card title={t("settings.language")}>
                {radioRow("language", LANGUAGE_OPTIONS, languageOf(form), setLanguage)}
                <div className="text-[11px] leading-5 text-[color:var(--ide-text-muted)] border-t border-[color:var(--ide-border)] pt-2 break-words">
                  {t("settings.languageHint")}
                </div>
              </Card>

              <Card title={t("settings.theme")}>
                {radioRow("theme", THEME_OPTIONS, themeOf(form), setTheme)}
                <div className="text-[11px] leading-5 text-[color:var(--ide-text-muted)] border-t border-[color:var(--ide-border)] pt-2 break-words">
                  {t("settings.themeNote")}
                </div>
              </Card>
            </div>
          )}

          {/* 字体：界面字体 / 界面字号 / 编辑器字体 / 编辑器字号 / Tab 宽集中在此，各带实时预览 */}
          {tab === "fonts" && (
            <div
              role="tabpanel"
              id="settings-panel-fonts"
              aria-labelledby="settings-tab-fonts"
            >
              <FontSettings settings={form} onChange={commitFonts} />
            </div>
          )}

          {/* 编辑器：既有编辑器开关与撤销步数（字体设置已集中到「字体」页） */}
          {tab === "editor" && (
            <div
              role="tabpanel"
              id="settings-panel-editor"
              aria-labelledby="settings-tab-editor"
              className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2"
            >
              <Card title={t("settings.editorBehavior")} className="min-[700px]:col-span-2">
                <div className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="opt-highlight-selection-matches"
                        checked={editorFlagOn(form, "highlightSelectionMatches")}
                        onCheckedChange={(v) => setFlag("highlightSelectionMatches", v === true)}
                        className="border-[color:var(--ide-border-strong)] data-[state=checked]:bg-[color:var(--ide-accent-strong)] data-[state=checked]:border-[color:var(--ide-accent-strong)] data-[state=checked]:text-white"
                      />
                      <Label
                        htmlFor="opt-highlight-selection-matches"
                        className="text-[12.5px] text-[color:var(--ide-text)] cursor-pointer"
                      >
                        {t("settings.highlightSel")}
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="opt-highlight-bracket-pairs"
                        checked={editorFlagOn(form, "highlightBracketPairs")}
                        onCheckedChange={(v) => setFlag("highlightBracketPairs", v === true)}
                        className="border-[color:var(--ide-border-strong)] data-[state=checked]:bg-[color:var(--ide-accent-strong)] data-[state=checked]:border-[color:var(--ide-accent-strong)] data-[state=checked]:text-white"
                      />
                      <Label
                        htmlFor="opt-highlight-bracket-pairs"
                        className="text-[12.5px] text-[color:var(--ide-text)] cursor-pointer"
                      >
                        {t("settings.highlightBracket")}
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="opt-ai-inline-complete"
                        checked={editorFlagOn(form, "aiInlineComplete")}
                        onCheckedChange={(v) => setFlag("aiInlineComplete", v === true)}
                        className="border-[color:var(--ide-border-strong)] data-[state=checked]:bg-[color:var(--ide-accent-strong)] data-[state=checked]:border-[color:var(--ide-accent-strong)] data-[state=checked]:text-white"
                      />
                      <Label
                        htmlFor="opt-ai-inline-complete"
                        className="text-[12.5px] text-[color:var(--ide-text)] cursor-pointer"
                      >
                        {t("settings.inlineComplete")}
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="opt-auto-save"
                        checked={form.autoSave === true}
                        onCheckedChange={(v) => setForm((f) => ({ ...f, autoSave: v === true }))}
                        className="border-[color:var(--ide-border-strong)] data-[state=checked]:bg-[color:var(--ide-accent-strong)] data-[state=checked]:border-[color:var(--ide-accent-strong)] data-[state=checked]:text-white"
                      />
                      <Label htmlFor="opt-auto-save" className="text-[12.5px] text-[color:var(--ide-text)] cursor-pointer">
                        {t("settings.autoSave")}
                      </Label>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <Label htmlFor="opt-max-undo" className="text-[12.5px] text-[color:var(--ide-text)] cursor-pointer shrink-0">
                        {t("settings.undoSteps")}
                      </Label>
                      <Input
                        id="opt-max-undo"
                        type="number"
                        min={MAX_UNDO_STEPS_RANGE.min}
                        max={MAX_UNDO_STEPS_RANGE.max}
                        value={undoSteps}
                        onChange={(e) => setUndoSteps(e.target.value)}
                        className="w-24 h-7 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                      />
                      <span className="min-w-0 text-[11px] text-[color:var(--ide-text-muted)]">
                        {t("settings.undoRange", {
                          min: MAX_UNDO_STEPS_RANGE.min,
                          max: MAX_UNDO_STEPS_RANGE.max,
                          default: DEFAULT_MAX_UNDO_STEPS,
                        })}
                      </span>
                    </div>
                    <div className="text-[11px] leading-5 text-[color:var(--ide-text-muted)] border-t border-[color:var(--ide-border)] pt-2 break-words">
                      {t("settings.helpSelection")}
                      <br />
                      {t("settings.helpInline")}
                      <br />
                      {t("settings.helpUndo")}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* 工具链：状态探测 + 编译器路径 */}
          {tab === "toolchain" && (
            <div
              role="tabpanel"
              id="settings-panel-toolchain"
              aria-labelledby="settings-tab-toolchain"
              className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2"
            >
              <Card
                title={t("settings.toolchain")}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    className="kimi-pop h-7 text-[12px] border-[color:var(--ide-border-strong)] bg-transparent text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
                    onClick={() => void refreshToolchain()}
                  >
                    <RefreshCw size={12} className="mr-1" /> {t("settings.redetect")}
                  </Button>
                }
              >
                <div className="space-y-1">
                  {toolRow(t("settings.toolC"), toolchain?.cc)}
                  {toolRow(t("settings.toolCpp"), toolchain?.cxx)}
                  {toolRow(t("settings.toolGdb"), toolchain?.gdb)}
                  {toolRow(t("settings.toolClangFormat"), toolchain?.clangFormat)}
                  {toolchain && !toolchain.cxx?.found && (
                    <div className="mt-2 border-t border-[color:var(--ide-border)] pt-2 text-[11.5px] leading-5 text-[color:var(--ide-text-muted)] break-words">
                      {t("settings.installHint1")}
                      <br />{t("settings.installMsys2Before")}{" "}
                      <code className="text-[color:var(--ide-info)]">pacman -S mingw-w64-ucrt-x86_64-gcc gdb</code>{t("settings.installMsys2After")}{" "}
                      <code className="text-[color:var(--ide-info)]">C:\msys64\ucrt64\bin</code> {t("settings.installMsys2Path")}
                      <br />{t("settings.installWinlibs")}
                      <br />{t("settings.installManual")}
                    </div>
                  )}
                </div>
              </Card>

              <Card title={t("settings.compilerPaths")}>
                <div className="space-y-3">
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.compilerC")}</Label>
                    <Input
                      value={form.compilerC || ""}
                      onChange={(e) => set("compilerC", e.target.value)}
                      placeholder="C:\msys64\ucrt64\bin\gcc.exe"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.compilerCpp")}</Label>
                    <Input
                      value={form.compilerCpp || ""}
                      onChange={(e) => set("compilerCpp", e.target.value)}
                      placeholder="C:\msys64\ucrt64\bin\g++.exe"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.gdb")}</Label>
                    <Input
                      value={form.gdbPath || ""}
                      onChange={(e) => set("gdbPath", e.target.value)}
                      placeholder="C:\msys64\ucrt64\bin\gdb.exe"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.clangFormat")}</Label>
                    <Input
                      value={form.clangFormatPath || ""}
                      onChange={(e) => set("clangFormatPath", e.target.value)}
                      placeholder="C:\Program Files\LLVM\bin\clang-format.exe"
                      className={INPUT_CLS}
                    />
                    <div className="text-[11px] text-[color:var(--ide-text-muted)] mt-1 break-words">
                      {t("settings.clangFormatHint")}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.std")}</Label>
                    <Input
                      value={form.std || ""}
                      onChange={(e) => set("std", e.target.value)}
                      placeholder={t("settings.stdPlaceholder")}
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.extraFlags")}</Label>
                    <Input
                      value={form.extraFlags || ""}
                      onChange={(e) => set("extraFlags", e.target.value)}
                      placeholder={t("settings.extraFlagsPlaceholder")}
                      className={INPUT_CLS}
                    />
                    <div className="text-[11px] text-[color:var(--ide-text-muted)] mt-1 break-words">
                      {t("settings.extraFlagsNote")}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* AI：接口 / 密钥 / 模型 */}
          {tab === "ai" && (
            <div
              role="tabpanel"
              id="settings-panel-ai"
              aria-labelledby="settings-tab-ai"
              className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2"
            >
              <Card title={t("settings.aiSection")} className="min-[700px]:col-span-2">
                <div className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2">
                  <div className="min-w-0 min-[700px]:col-span-2">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.endpoint")}</Label>
                    <Input
                      value={form.aiEndpoint || ""}
                      onChange={(e) => set("aiEndpoint", e.target.value)}
                      placeholder="https://api.moonshot.cn/v1"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.apiKey")}</Label>
                    <Input
                      type="password"
                      value={form.aiKey || ""}
                      onChange={(e) => set("aiKey", e.target.value)}
                      placeholder="sk-..."
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[12px] text-[color:var(--ide-text-muted)]">{t("settings.model")}</Label>
                    <Input
                      value={form.aiModel || ""}
                      onChange={(e) => set("aiModel", e.target.value)}
                      placeholder={t("settings.modelPlaceholder")}
                      className={INPUT_CLS}
                    />
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            className="kimi-pop border-[color:var(--ide-border-strong)] bg-transparent text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
            onClick={() => {
              // 字体是即时设置：取消也必须把最后一次未落盘的改动提交掉（其它表单项照旧丢弃）。
              flushFontSave();
              setShow(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            className="kimi-pop bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white"
            onClick={() => {
              // 保存会带上当前 form（含字体最新值），先取消待执行的字体落盘，避免重复请求。
              cancelPendingFontSave();
              const n = parseInt(undoSteps, 10);
              const maxUndoSteps = Number.isFinite(n)
                ? Math.min(MAX_UNDO_STEPS_RANGE.max, Math.max(MAX_UNDO_STEPS_RANGE.min, n))
                : DEFAULT_MAX_UNDO_STEPS;
              void updateSettings({ ...form, maxUndoSteps });
              setShow(false);
            }}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
