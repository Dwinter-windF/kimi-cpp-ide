import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Sparkles, X, FileCode2, TriangleAlert } from "lucide-react";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";
import { collapseEqual, diffLines, type DiffItem } from "@/lib/diff";

/**
 * 「AI 一键修复」预览弹层。
 *
 * 设计要点：
 *  · 应用前必须有明确预览：只有点了「接受并写回」才会调用 store.applyAiFix 落盘，
 *    「拒绝」/ 点遮罩 / Esc 一律 closeAiFix，不改动任何文件（需求硬要求，不静默改文件）；
 *  · diff 由本地 src/lib/diff.ts 现算（零依赖行级对比），不做静默自动应用；
 *  · 配色全部走 --ide-* 变量 + .kimi-* 动画类，亮暗主题自动适配，动画 ≤250ms。
 */
export function AiFixDialog() {
  const t = useT();
  const aiFix = useIde((s) => s.aiFix);
  const closeAiFix = useIde((s) => s.closeAiFix);
  const applyAiFix = useIde((s) => s.applyAiFix);
  const setAiFixActive = useIde((s) => s.setAiFixActive);
  const [applying, setApplying] = useState(false);

  const open = aiFix.status !== "idle";
  const active = aiFix.files[Math.min(aiFix.active, aiFix.files.length - 1)];

  // Esc = 拒绝（关闭且不改动任何文件）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAiFix();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeAiFix]);

  // 弹层每次重新打开/换文件时重置「写回中」状态
  useEffect(() => {
    if (!open) setApplying(false);
  }, [open]);

  const diff = useMemo(() => {
    if (!active) return null;
    const d = diffLines(active.original, active.fixed);
    return { stats: { added: d.added, removed: d.removed, coarse: d.coarse }, items: collapseEqual(d.rows, 3) };
  }, [active]);

  if (!open) return null;

  const accept = async () => {
    if (applying) return;
    setApplying(true);
    try {
      await applyAiFix();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="kimi-overlay-in fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={closeAiFix}
      role="presentation"
    >
      <div
        className="kimi-dialog-pop w-[min(1100px,94vw)] h-[min(760px,90vh)] flex flex-col rounded-xl border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("bottom.aiFix")}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[color:var(--ide-border)] shrink-0">
          <Sparkles size={15} className="text-[color:var(--ide-purple)] shrink-0" />
          <span className="text-[13px] font-semibold">{t("bottom.aiFix")}</span>
          {aiFix.status === "ready" && diff && (
            <span className="text-[11.5px] text-[color:var(--ide-text-muted)] font-mono">
              {t("aiFix.fileCount", { count: aiFix.files.length })} · <span className="text-[color:var(--ide-success)]">+{diff.stats.added}</span>{" "}
              <span className="text-[color:var(--ide-error)]">−{diff.stats.removed}</span>
            </span>
          )}
          <button
            className="kimi-pop ml-auto p-1 rounded text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
            onClick={closeAiFix}
            title={t("aiFix.rejectTitle")}
          >
            <X size={14} />
          </button>
        </div>

        {/* 请求中 */}
        {aiFix.status === "loading" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[color:var(--ide-text-muted)] text-[12.5px]">
            <Loader2 size={22} className="animate-spin text-[color:var(--ide-purple)]" />
            {t("aiFix.sending")}
          </div>
        )}

        {/* 失败 / 无法解析 */}
        {aiFix.status === "error" && (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            <div className="flex items-start gap-2 rounded-lg border border-[color:var(--ide-error-soft)] bg-[color:var(--ide-bg-base)] px-3 py-2.5">
              <TriangleAlert size={15} className="mt-[2px] shrink-0 text-[color:var(--ide-error)]" />
              <div className="text-[12.5px] leading-6 whitespace-pre-wrap break-words text-[color:var(--ide-error)]">
                {aiFix.error}
              </div>
            </div>
            {aiFix.note && (
              <div className="mt-2 text-[11.5px] leading-5 whitespace-pre-wrap text-[color:var(--ide-text-muted)]">{aiFix.note}</div>
            )}
            <div className="mt-3 text-[12px] text-[color:var(--ide-text-muted)] leading-6">
              {t("aiFix.errorHintText")}
            </div>
          </div>
        )}

        {/* 预览 */}
        {aiFix.status === "ready" && active && diff && (
          <>
            <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-[color:var(--ide-border)] shrink-0 overflow-x-auto">
              {aiFix.files.map((f, i) => (
                <button
                  key={f.path}
                  onClick={() => setAiFixActive(i)}
                  title={f.path}
                  className={`kimi-tab flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-mono whitespace-nowrap ${
                    i === aiFix.active
                      ? "bg-[color:var(--ide-selected)] text-[color:var(--ide-text)]"
                      : "text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text-dim)] hover:bg-[color:var(--ide-hover)]"
                  }`}
                >
                  <FileCode2 size={12} />
                  {f.path}
                </button>
              ))}
              {diff.stats.coarse && (
                <span className="ml-2 text-[11px] text-[color:var(--ide-warning)] shrink-0">{t("aiFix.coarse")}</span>
              )}
            </div>

            {aiFix.error && (
              <div className="px-4 py-2 text-[12px] whitespace-pre-wrap text-[color:var(--ide-error)] border-b border-[color:var(--ide-border)] shrink-0">
                {aiFix.error}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto bg-[color:var(--ide-bg-base)] font-mono text-[12px] leading-[1.55]">
              {diff.items.map((it, i) => (
                <DiffLine key={i} item={it} />
              ))}
            </div>

            {aiFix.note && (
              <div className="px-4 py-1.5 text-[11.5px] leading-5 whitespace-pre-wrap text-[color:var(--ide-text-muted)] border-t border-[color:var(--ide-border)] shrink-0">
                {aiFix.note}
              </div>
            )}
          </>
        )}

        {/* 底部动作 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[color:var(--ide-border)] shrink-0">
          <span className="text-[11.5px] text-[color:var(--ide-text-muted)] mr-auto">
            {aiFix.status === "ready"
              ? t("aiFix.acceptHint")
              : aiFix.status === "loading"
                ? t("aiFix.requesting")
                : t("aiFix.nothingToApply")}
          </span>
          {aiFix.status === "ready" ? (
            <>
              <button
                className="px-3 py-1.5 rounded-md text-[12.5px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
                onClick={closeAiFix}
                disabled={applying}
              >
                {t("aiFix.reject")}
              </button>
              <button
                className="kimi-pop flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12.5px] bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => void accept()}
                disabled={applying}
                title={t("aiFix.acceptTitle", { count: aiFix.files.length })}
              >
                {applying ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {t("aiFix.accept")}
              </button>
            </>
          ) : (
            <button
              className="px-3 py-1.5 rounded-md text-[12.5px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
              onClick={closeAiFix}
            >
              {t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const BG = {
  add: "bg-[color:var(--ide-diff-add-bg)]",
  del: "bg-[color:var(--ide-diff-del-bg)]",
  equal: "",
} as const;

const FG = {
  add: "text-[color:var(--ide-success)]",
  del: "text-[color:var(--ide-error)]",
  equal: "text-[color:var(--ide-text)]",
} as const;

/** 单行 diff：两列行号 + 前缀 + 内容（等宽，长行横向滚动） */
function DiffLine({ item }: { item: DiffItem }) {
  const t = useT();
  if (item.kind === "skip") {
    return (
      <div className="flex items-center gap-2 px-3 py-[2px] text-[11px] text-[color:var(--ide-text-faint)] bg-[color:var(--ide-bg-panel)]">
        <span className="w-9 shrink-0" />
        <span className="w-9 shrink-0" />
        <span>{t("aiFix.skippedLines", { count: item.count })}</span>
      </div>
    );
  }
  const prefix = item.kind === "add" ? "+" : item.kind === "del" ? "−" : " ";
  return (
    <div className={`flex items-start ${BG[item.kind]}`}>
      <span className="w-11 shrink-0 select-none text-right pr-2 text-[color:var(--ide-text-faint)]">
        {item.oldNo ?? ""}
      </span>
      <span className="w-11 shrink-0 select-none text-right pr-2 text-[color:var(--ide-text-faint)]">
        {item.newNo ?? ""}
      </span>
      <span className={`w-4 shrink-0 select-none text-center ${FG[item.kind]}`}>{prefix}</span>
      <span className={`flex-1 whitespace-pre pr-4 ${FG[item.kind]}`}>{item.text || " "}</span>
    </div>
  );
}
