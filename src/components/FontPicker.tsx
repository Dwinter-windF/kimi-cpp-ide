import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { fontFamilyToCss } from "@/types";

/**
 * 内置兜底字体：/api/fonts 不可用（非 Windows / 服务端异常）时仍能选择常见字体。
 * 与系统字体合并后去重排序；也允许用户手动输入任意字体名。
 */
export const BUILTIN_FONT_FAMILIES = [
  "Segoe UI",
  "Microsoft YaHei",
  "微软雅黑",
  "Consolas",
  "Courier New",
  "JetBrains Mono",
  "SimSun",
  "NSimSun",
  "SimHei",
  "KaiTi",
  "FangSong",
  "DengXian",
  "等线",
  "Arial",
  "Calibri",
  "Cambria",
  "Tahoma",
  "Verdana",
  "Times New Roman",
  "Cascadia Code",
  "Cascadia Mono",
  "Fira Code",
  "Source Code Pro",
  "Noto Sans SC",
  "PingFang SC",
];

/** 系统字体只请求一次：两个选择器（界面字体 / 编辑器字体）共用同一个 Promise */
let systemFontsPromise: Promise<string[]> | null = null;

function loadSystemFonts(): Promise<string[]> {
  if (!systemFontsPromise) {
    systemFontsPromise = api
      .fonts()
      .then((list) =>
        Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && f.trim().length > 0) : []
      )
      .catch(() => []);
  }
  return systemFontsPromise;
}

/** 合并系统字体与内置兜底，大小写不敏感去重，并按字母序排序 */
function mergeFonts(systemFonts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...systemFonts, ...BUILTIN_FONT_FAMILIES]) {
    const name = raw.trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return out;
}

interface FontPickerProps {
  id?: string;
  /** 当前字体族（可能是单个族名，也可能是 Consolas, 'Microsoft YaHei', monospace 这样的栈） */
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** 输入框下方的小字说明 */
  hint?: string;
}

/**
 * 可搜索字体选择器：输入即过滤，支持手动输入任意字体名；
 * 每个候选项用该字体实时渲染「英文 + 中文」示例，方便直接比较字形。
 */
export function FontPicker({ id, value, onChange, placeholder, hint }: FontPickerProps) {
  const t = useT();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    let alive = true;
    void loadSystemFonts().then((fonts) => {
      if (!alive) return;
      setSystemFonts(fonts);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const allFonts = useMemo(() => mergeFonts(systemFonts), [systemFonts]);
  const filtered = useMemo(() => {
    // 当前值可能是 "Consolas, 'Microsoft YaHei', monospace" 这样的字体栈：
    // 按整串过滤会一条都匹配不到，此时直接展示完整列表，方便重新挑选。
    const q = query.includes(",") ? "" : query.trim().toLocaleLowerCase();
    const list = q ? allFonts.filter((f) => f.toLocaleLowerCase().includes(q)) : allFonts;
    // 极端情况下系统字体很多：只渲染前 200 项，继续输入可缩小范围
    return list.slice(0, 200);
  }, [allFonts, query]);
  const sample = t("settings.fontSample");

  return (
    <div className="min-w-0">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // 点击候选项时 mousedown 已 preventDefault，这里只处理真正的失焦
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // 先只关下拉，不让 Radix Dialog 把整个设置框一起关掉
            e.stopPropagation();
            setOpen(false);
            e.currentTarget.blur();
          } else if (e.key === "Enter") {
            setOpen(false);
          }
        }}
        className="w-full h-8 rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-base)] px-2 text-[12px] text-[color:var(--ide-text)] outline-none focus:border-[color:var(--ide-accent)]"
        style={{ fontFamily: fontFamilyToCss(value || query) }}
      />
      {open && (
        <div
          role="listbox"
          aria-label={placeholder}
          className="mt-1 max-h-56 overflow-y-auto rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] py-1 shadow-lg"
        >
          <div className="px-2 py-1 text-[10.5px] text-[color:var(--ide-text-muted)]">
            {loading
              ? t("settings.fontsLoading")
              : t("settings.fontsAvailable", { count: allFonts.length })}
          </div>
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-[11.5px] text-[color:var(--ide-text-muted)]">
              {t("settings.fontsNoMatch")}
            </div>
          )}
          {filtered.map((font) => (
            <button
              key={font}
              type="button"
              role="option"
              aria-selected={font === value}
              title={font}
              // 防止 input 失焦：否则 blur 的延时关闭会抢在 click 之前
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery(font);
                onChange(font);
                setOpen(false);
              }}
              className={`flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-[12px] ${
                font === value
                  ? "bg-[color:var(--ide-selected)] text-[color:var(--ide-text)]"
                  : "text-[color:var(--ide-text-dim)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text)]"
              }`}
              style={{ fontFamily: fontFamilyToCss(font) }}
            >
              <span className="min-w-0 flex-1 truncate">{font}</span>
              <span className="shrink-0 text-[10.5px] text-[color:var(--ide-text-muted)]">{sample}</span>
            </button>
          ))}
        </div>
      )}
      {hint && (
        <div className="mt-1 text-[11px] leading-4 text-[color:var(--ide-text-muted)] break-words">{hint}</div>
      )}
    </div>
  );
}
