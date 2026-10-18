import { useState } from "react";
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { FontPicker } from "@/components/FontPicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import {
  DEFAULT_EDITOR_FONT_FAMILY,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_TAB_SIZE,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE,
  EDITOR_FONT_SIZE_RANGE,
  EDITOR_TAB_SIZE_RANGE,
  UI_FONT_SIZE_RANGE,
  editorFontFamilyOf,
  editorFontSizeOf,
  editorTabSizeOf,
  fontFamilyToCss,
  uiFontFamilyOf,
  uiFontSizeOf,
  type Settings,
} from "@/types";

/** 与设置对话框其它分区保持一致的卡片外壳（预览框单独用 --ide-bg-base） */
function FontCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-3 rounded-md border border-[color:var(--ide-border)] bg-[color:var(--ide-bg-panel)] p-3">
      <h3 className="text-[13px] font-semibold text-[color:var(--ide-text-dim)]">{title}</h3>
      {children}
    </section>
  );
}

/** 单项「恢复默认」文字按钮：样式仿工具链页的「重新检测」，但保持轻量文字按钮观感 */
function ResetButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("settings.restoreDefault")}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[11px] text-[color:var(--ide-text-muted)] hover:border-[color:var(--ide-border-strong)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-dim)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--ide-accent)]"
    >
      <RotateCcw size={11} aria-hidden />
      {t("settings.restoreDefault")}
    </button>
  );
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 字号数字输入框：与滑块双向同步，允许手动输入；
 * 输入过程中保留原始字符串（避免把 "1" 立刻夹成 "11" 导致无法继续输入），
 * 但解析出的数字会立即收敛到合法区间并驱动滑块 / 预览，失焦或回车时再回写到输入框。
 */
function SizeInput({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  const commit = () => {
    const n = Number(draft);
    const next = draft.trim() !== "" && Number.isFinite(n) ? clampSize(n, min, max) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={1}
      inputMode="numeric"
      // 未聚焦时直接展示受控值（滑块拖动可实时同步）；聚焦时展示正在编辑的原文。
      value={focused ? draft : String(value)}
      aria-label={`${label} (${min}–${max} px)`}
      onFocus={() => {
        setFocused(true);
        setDraft(String(value));
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        const n = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(n)) {
          setDraft(raw);
          return;
        }
        const clamped = clampSize(n, min, max);
        onChange(clamped);
        // 超过上限时输入框立即显示夹取后的值；低于下限时保留原文，
        // 以便继续输入第二位数字（如界面字号从 1 继续输入成 15）。
        setDraft(n > max ? String(clamped) : raw);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        }
      }}
      className="h-7 w-16 shrink-0 bg-[color:var(--ide-bg-base)] border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] font-mono text-[12px]"
    />
  );
}

/** 字号行：滑块 + 数字框 + 当前值，滑块拖动时由本地 state 直接驱动预览 */
function FontSizeRow({
  id,
  label,
  value,
  min,
  max,
  defaultHint,
  onChange,
  onReset,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  defaultHint: string;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={id} className="text-[12px] text-[color:var(--ide-text-muted)]">
          {label}
        </Label>
        <ResetButton onClick={onReset} />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={label}
          aria-valuetext={`${value} px`}
          onChange={(e) => onChange(Number(e.target.value))}
          className="min-w-0 flex-1 cursor-pointer accent-[color:var(--ide-accent)]"
        />
        <SizeInput id={`${id}-number`} label={label} value={value} min={min} max={max} onChange={onChange} />
        <span className="w-12 shrink-0 text-right font-mono text-[11px] text-[color:var(--ide-text-dim)]">
          {value} px
        </span>
      </div>
      <div className="text-[10.5px] text-[color:var(--ide-text-muted)]">
        {t("settings.fontSizeRange", { min, max })} · {defaultHint}
      </div>
    </div>
  );
}

/** 预览框顶栏：明确标注「预览」，右侧显示当前字体 / 字号 / Tab 宽 */
function PreviewHeader({ meta }: { meta: string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[color:var(--ide-border)] px-2.5 py-1.5">
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--ide-text-muted)]">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[color:var(--ide-success)]" />
        {t("settings.preview")}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-[10px] text-[color:var(--ide-text-faint)]" title={meta}>
        {meta}
      </span>
    </div>
  );
}

/** 界面字体 / 字号预览：正文 + 0.85 倍小字两档，都是中英混排的 i18n 文案 */
function UiFontPreview({ family, size }: { family: string; size: number }) {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t("settings.preview")}
      className="overflow-hidden rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-base)]"
    >
      <PreviewHeader meta={`${family} · ${size}px`} />
      <div
        className="space-y-2 p-3"
        style={{ fontFamily: fontFamilyToCss(family), fontSize: `${size}px`, lineHeight: 1.6 }}
      >
        <p className="break-words text-[color:var(--ide-text)]">{t("settings.uiPreviewBody")}</p>
        <p
          className="break-words text-[color:var(--ide-text-muted)]"
          style={{ fontSize: "0.85em", lineHeight: 1.55 }}
        >
          {t("settings.uiPreviewSmall")}
        </p>
      </div>
    </div>
  );
}

// 轻量 C++ 高亮：只服务预览，按注释 / 字符串 / 预处理 / 关键字 / std:: / 函数名着色。
// 颜色全部走 --ide-* 变量，亮暗主题自动跟随。
const CPP_TOKEN_RE =
  /(\/\/.*$)|("(?:\\.|[^"\\])*")|(^\s*#\s*\w+)|(\b(?:int|return|for|const|auto|void|if|else|while|class|struct|using|namespace|bool|true|false|nullptr|double|float|char|long|short|unsigned)\b)|(\bstd::\w+\b)|(\b[A-Za-z_]\w*(?=\s*\())/g;

function highlightCpp(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(CPP_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(line.slice(last, index));
    const text = match[0];
    let className = "text-[color:var(--ide-text)]";
    if (match[1]) className = "italic text-[color:var(--ide-text-muted)]";
    else if (match[2]) className = "text-[color:var(--ide-success)]";
    else if (match[3]) className = "text-[color:var(--ide-purple-bright)]";
    else if (match[4]) className = "font-medium text-[color:var(--ide-purple-bright)]";
    else if (match[5]) className = "text-[color:var(--ide-cyan)]";
    else if (match[6]) className = "text-[color:var(--ide-info)]";
    out.push(
      <span key={`${index}-${text}`} className={className}>
        {text}
      </span>
    );
    last = index + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** 编辑器字体 / 字号 / Tab 宽预览：C++ 代码（中英注释、缩进、括号），行号 + 语法配色 */
function EditorFontPreview({ family, size, tabSize }: { family: string; size: number; tabSize: number }) {
  const t = useT();
  const lines = t("settings.editorPreviewCode").split("\n");
  return (
    <div
      role="region"
      aria-label={t("settings.preview")}
      className="overflow-hidden rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-base)]"
    >
      <PreviewHeader meta={`${family} · ${size}px · Tab ${tabSize}`} />
      <div
        className="max-h-[320px] overflow-auto p-3"
        style={{
          fontFamily: fontFamilyToCss(family),
          fontSize: `${size}px`,
          lineHeight: 1.55,
          tabSize,
        }}
      >
        {lines.map((line, index) => (
          <div key={index} className="flex min-w-max">
            <span
              aria-hidden
              className="shrink-0 select-none pr-3 text-right text-[color:var(--ide-text-faint)]"
              style={{ minWidth: "2.5em" }}
            >
              {index + 1}
            </span>
            <code className="whitespace-pre text-[color:var(--ide-text)]" style={{ fontFamily: "inherit" }}>{highlightCpp(line)}</code>
          </div>
        ))}
      </div>
      <div className="border-t border-[color:var(--ide-border)] px-2.5 py-1.5 text-[10.5px] text-[color:var(--ide-text-muted)]">
        {t("settings.editorPreviewTabNote", { size: tabSize })}
      </div>
    </div>
  );
}

/**
 * 「字体」页签：界面字体 / 界面字号 / 编辑器字体 / 编辑器字号 / Tab 宽五项集中在此。
 * 每一项都有独立的恢复默认按钮；改动由父组件触发即时生效 + 100ms 节流持久化。
 */
export function FontSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const t = useT();
  const uiFamily = uiFontFamilyOf(settings);
  const uiSize = uiFontSizeOf(settings);
  const editorFamily = editorFontFamilyOf(settings);
  const editorSize = editorFontSizeOf(settings);
  const tabSize = editorTabSizeOf(settings);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] px-3 py-2 text-[11.5px] leading-5 text-[color:var(--ide-text-muted)]">
        {t("settings.fontsPageHint")}
      </div>

      <div className="grid grid-cols-1 items-start gap-3 min-[700px]:grid-cols-2">
        <FontCard title={t("settings.uiFontSection")}>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="opt-ui-font" className="text-[12px] text-[color:var(--ide-text-muted)]">
                {t("settings.uiFont")}
              </Label>
              <ResetButton onClick={() => onChange({ uiFontFamily: DEFAULT_UI_FONT_FAMILY })} />
            </div>
            <FontPicker
              id="opt-ui-font"
              value={uiFamily}
              onChange={(v) => onChange({ uiFontFamily: v })}
              placeholder={t("settings.fontFamilyPlaceholder")}
              hint={t("settings.uiFontHint")}
            />
          </div>

          <FontSizeRow
            id="opt-ui-font-size"
            label={t("settings.uiFontSize")}
            value={uiSize}
            min={UI_FONT_SIZE_RANGE.min}
            max={UI_FONT_SIZE_RANGE.max}
            defaultHint={`${t("common.default")} ${DEFAULT_UI_FONT_SIZE} px`}
            onChange={(v) => onChange({ uiFontSize: v })}
            onReset={() => onChange({ uiFontSize: DEFAULT_UI_FONT_SIZE })}
          />

          <UiFontPreview family={uiFamily} size={uiSize} />
        </FontCard>

        <FontCard title={t("settings.editorFontSection")}>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="opt-editor-font" className="text-[12px] text-[color:var(--ide-text-muted)]">
                {t("settings.editorFont")}
              </Label>
              <ResetButton onClick={() => onChange({ editorFontFamily: DEFAULT_EDITOR_FONT_FAMILY })} />
            </div>
            <FontPicker
              id="opt-editor-font"
              value={editorFamily}
              onChange={(v) => onChange({ editorFontFamily: v })}
              placeholder={t("settings.fontFamilyPlaceholder")}
              hint={t("settings.editorFontHint")}
            />
          </div>

          <FontSizeRow
            id="opt-editor-font-size"
            label={t("settings.editorFontSize")}
            value={editorSize}
            min={EDITOR_FONT_SIZE_RANGE.min}
            max={EDITOR_FONT_SIZE_RANGE.max}
            defaultHint={`${t("common.default")} ${DEFAULT_EDITOR_FONT_SIZE} px`}
            onChange={(v) => onChange({ editorFontSize: v })}
            onReset={() => onChange({ editorFontSize: DEFAULT_EDITOR_FONT_SIZE })}
          />

          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="opt-editor-tab-size" className="text-[12px] text-[color:var(--ide-text-muted)]">
                {t("settings.tabSize")}
              </Label>
              <ResetButton onClick={() => onChange({ editorTabSize: DEFAULT_EDITOR_TAB_SIZE })} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="opt-editor-tab-size"
                value={tabSize}
                onChange={(e) => onChange({ editorTabSize: Number(e.target.value) })}
                className="h-8 min-w-0 rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-base)] px-2 text-[12px] text-[color:var(--ide-text)] outline-none focus:border-[color:var(--ide-accent)]"
              >
                {Array.from(
                  { length: EDITOR_TAB_SIZE_RANGE.max - EDITOR_TAB_SIZE_RANGE.min + 1 },
                  (_, i) => EDITOR_TAB_SIZE_RANGE.min + i
                ).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-[color:var(--ide-text-muted)]">{t("settings.tabSizeHint")}</span>
            </div>
          </div>

          <EditorFontPreview family={editorFamily} size={editorSize} tabSize={tabSize} />
        </FontCard>
      </div>

      <div className="text-[11px] leading-5 text-[color:var(--ide-text-muted)]">
        {t("settings.fontImmediateNote")}
      </div>
    </div>
  );
}
