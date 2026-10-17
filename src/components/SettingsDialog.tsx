import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RefreshCw } from "lucide-react";
import { useIde } from "@/store";
import { editorFlagOn, maxUndoStepsOf, DEFAULT_MAX_UNDO_STEPS, MAX_UNDO_STEPS_RANGE, themeOf, type EditorFlag, type Settings, type ThemeName } from "@/types";

/** 补上编辑器开关的默认值（旧 settings.json 缺字段 → 勾选） */
function withEditorFlags(s: Settings): Settings {
  return {
    ...s,
    highlightSelectionMatches: editorFlagOn(s, "highlightSelectionMatches"),
    highlightBracketPairs: editorFlagOn(s, "highlightBracketPairs"),
    aiInlineComplete: editorFlagOn(s, "aiInlineComplete"),
  };
}

/** 配色方案可选项（暗色在前，缺省即暗色） */
const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: "dark", label: "暗色（默认）" },
  { value: "light", label: "亮色" },
];

export function SettingsDialog() {
  const show = useIde((s) => s.showSettings);
  const setShow = useIde((s) => s.setShowSettings);
  const settings = useIde((s) => s.settings);
  const toolchain = useIde((s) => s.toolchain);
  const updateSettings = useIde((s) => s.updateSettings);
  const refreshToolchain = useIde((s) => s.refreshToolchain);

  const [form, setForm] = useState<Settings>(() => withEditorFlags(settings));
  // 撤销步数输入框（字符串态，保存时转数字并收敛范围）
  const [undoSteps, setUndoSteps] = useState(() => String(maxUndoStepsOf(settings)));
  useEffect(() => {
    if (show) {
      setForm(withEditorFlags(useIde.getState().settings));
      setUndoSteps(String(maxUndoStepsOf(useIde.getState().settings)));
    }
  }, [show]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setFlag = (k: EditorFlag, v: boolean) => setForm((f) => ({ ...f, [k]: v }));
  /** 配色方案：只改本地表单，点「保存」后走既有 updateSettings 通道落盘并全局生效 */
  const setTheme = (v: ThemeName) => setForm((f) => ({ ...f, theme: v }));

  const toolRow = (label: string, t?: { found: boolean; path?: string; version?: string }) => (
    <div className="flex items-center gap-2 text-[12px]">
      <span className={`w-2 h-2 rounded-full shrink-0 ${t?.found ? "bg-[color:var(--ide-success)]" : "bg-[color:var(--ide-error)]"}`} />
      <span className="text-[color:var(--ide-text-dim)] w-16 shrink-0">{label}</span>
      <span className="text-[color:var(--ide-text-muted)] truncate font-mono" title={t?.path}>
        {t?.found ? (t.path || "已找到") : "未找到"}
      </span>
    </div>
  );

  return (
    <Dialog open={show} onOpenChange={setShow}>
      <DialogContent className="max-w-xl bg-[color:var(--ide-bg-panel)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* 外观：亮色 / 暗色配色方案（保存后全局生效，含编辑器与终端，重启后保持） */}
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">外观</h3>
            <div className="space-y-2 rounded-md bg-[color:var(--ide-bg-base)] p-3">
              <div className="text-[12.5px] text-[color:var(--ide-text)]">
                配色方案（点「保存」后立即生效，无需刷新页面；重启后保持）
              </div>
              <div className="flex items-center gap-6">
                {THEME_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    htmlFor={`opt-theme-${opt.value}`}
                    className="flex items-center gap-2 text-[12.5px] text-[color:var(--ide-text)] cursor-pointer"
                  >
                    <input
                      id={`opt-theme-${opt.value}`}
                      type="radio"
                      name="kimi-theme"
                      value={opt.value}
                      checked={themeOf(form) === opt.value}
                      onChange={() => setTheme(opt.value)}
                      className="w-3.5 h-3.5 cursor-pointer accent-[color:var(--ide-accent)]"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              <div className="text-[11px] text-[color:var(--ide-text-muted)] leading-5 border-t border-[color:var(--ide-border)] pt-2">
                两套方案覆盖主界面、编辑器（含语法高亮、行号、选区、补全、搜索命中）与底部终端输出；
                未设置过时按暗色处理。
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">工具链状态</h3>
              <Button
                size="sm"
                variant="outline"
                className="kimi-pop h-7 text-[12px] border-[color:var(--ide-border-strong)] bg-transparent text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
                onClick={() => void refreshToolchain()}
              >
                <RefreshCw size={12} className="mr-1" /> 重新检测
              </Button>
            </div>
            <div className="space-y-1 rounded-md bg-[color:var(--ide-bg-base)] p-3">
              {toolRow("C 编译器", toolchain?.cc)}
              {toolRow("C++ 编译器", toolchain?.cxx)}
              {toolRow("GDB 调试器", toolchain?.gdb)}
              {toolchain && !toolchain.cxx?.found && (
                <div className="text-[11.5px] text-[color:var(--ide-text-muted)] leading-5 mt-2 border-t border-[color:var(--ide-border)] pt-2">
                  💡 未检测到编译器。推荐安装（任选其一）：
                  <br />• MSYS2（推荐）：安装后在终端执行{" "}
                  <code className="text-[color:var(--ide-info)]">pacman -S mingw-w64-ucrt-x86_64-gcc gdb</code>，并把{" "}
                  <code className="text-[color:var(--ide-info)]">C:\msys64\ucrt64\bin</code> 加入系统 PATH；
                  <br />• WinLibs：从 winlibs.com 下载解压即用版；
                  <br />• 也可以直接在下方填写 g++.exe / gdb.exe 的完整路径。
                </div>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">编译器路径（留空则自动从 PATH 查找）</h3>
            <div className="space-y-2">
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">C 编译器 (gcc.exe)</Label>
                <Input
                  value={form.compilerC || ""}
                  onChange={(e) => set("compilerC", e.target.value)}
                  placeholder="C:\msys64\ucrt64\bin\gcc.exe"
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">C++ 编译器 (g++.exe)</Label>
                <Input
                  value={form.compilerCpp || ""}
                  onChange={(e) => set("compilerCpp", e.target.value)}
                  placeholder="C:\msys64\ucrt64\bin\g++.exe"
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">GDB 调试器 (gdb.exe)</Label>
                <Input
                  value={form.gdbPath || ""}
                  onChange={(e) => set("gdbPath", e.target.value)}
                  placeholder="C:\msys64\ucrt64\bin\gdb.exe"
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">C++ 标准</Label>
                <Input
                  value={form.std || ""}
                  onChange={(e) => set("std", e.target.value)}
                  placeholder="c++17（默认）"
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">自定义编译参数（空格分隔，可选）</Label>
                <Input
                  value={form.extraFlags || ""}
                  onChange={(e) => set("extraFlags", e.target.value)}
                  placeholder='如 -DDEBUG -lm -Wall'
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
                <div className="text-[11px] text-[color:var(--ide-text-muted)] mt-1">
                  Debug/Release 切换在工具栏下拉框；此处参数每次编译都会附加。
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">AI 接口（兼容 OpenAI /chat/completions，可留空）</h3>
            <div className="space-y-2">
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">接口地址</Label>
                <Input
                  value={form.aiEndpoint || ""}
                  onChange={(e) => set("aiEndpoint", e.target.value)}
                  placeholder="https://api.moonshot.cn/v1"
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">API Key</Label>
                <Input
                  type="password"
                  value={form.aiKey || ""}
                  onChange={(e) => set("aiKey", e.target.value)}
                  placeholder="sk-..."
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
              <div>
                <Label className="text-[12px] text-[color:var(--ide-text-muted)]">模型</Label>
                <Input
                  value={form.aiModel || ""}
                  onChange={(e) => set("aiModel", e.target.value)}
                  placeholder="如 moonshot-v1-8k / deepseek-chat / gpt-4o-mini"
                  className="mt-1 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
                />
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">编辑器</h3>
            <div className="space-y-2 rounded-md bg-[color:var(--ide-bg-base)] p-3">
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
                  划词相同词高亮（仅变量名/函数名/关键字等标识符）
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
                  括号匹配高亮（光标旁配对的 () [] {}）
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
                  AI 内联补全（打字停顿后以灰色幽灵文本给出建议，Tab 接受 / Esc 拒绝）
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
                  自动保存（停止输入约 0.8 秒后落盘；工具栏保存按钮旁也有开关）
                </Label>
              </div>
              <div className="flex items-center gap-3">
                <Label htmlFor="opt-max-undo" className="text-[12.5px] text-[color:var(--ide-text)] cursor-pointer shrink-0">
                  撤销历史最大步数
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
                <span className="text-[11px] text-[color:var(--ide-text-muted)]">
                  {MAX_UNDO_STEPS_RANGE.min}–{MAX_UNDO_STEPS_RANGE.max}，默认 {DEFAULT_MAX_UNDO_STEPS}
                </span>
              </div>
              <div className="text-[11px] text-[color:var(--ide-text-muted)] leading-5 border-t border-[color:var(--ide-border)] pt-2">
                划词高亮只在选中的是完整单词且语法上是标识符/关键字时生效；选中数字、字符串、注释、运算符或任意子串不会高亮。
                <br />
                内联补全需要先在「AI 接口」里填好地址与密钥；只在代码文件（.c/.cpp/.h 等）中触发，
                停止输入约 0.15 秒后请求，两次请求至少间隔 0.8 秒，关闭本开关后完全不发起请求。
                <br />
                调整撤销步数后，已打开文件的撤销历史会重置（CodeMirror 无法只截断最旧的记录）。
              </div>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="kimi-pop border-[color:var(--ide-border-strong)] bg-transparent text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
            onClick={() => setShow(false)}
          >
            取消
          </Button>
          <Button
            className="kimi-pop bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white"
            onClick={() => {
              const n = parseInt(undoSteps, 10);
              const maxUndoSteps = Number.isFinite(n)
                ? Math.min(MAX_UNDO_STEPS_RANGE.max, Math.max(MAX_UNDO_STEPS_RANGE.min, n))
                : DEFAULT_MAX_UNDO_STEPS;
              void updateSettings({ ...form, maxUndoSteps });
              setShow(false);
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
