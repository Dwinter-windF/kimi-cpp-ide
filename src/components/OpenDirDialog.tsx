import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";

/**
 * 「打开目录」对话框：手动输入路径 + 「浏览…」调用系统原生选择框回填。
 * 原生对话框拿不到（取消 / 无桌面会话 / 无 PowerShell）时保持手输，不影响主流程。
 */
export function OpenDirDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const openWorkspace = useIde((s) => s.openWorkspace);
  const pickWorkspace = useIde((s) => s.pickWorkspace);
  const current = useIde((s) => s.workspace);
  const dirty = useIde((s) => s.dirty);

  const [val, setVal] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hint, setHint] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const browse = async () => {
    setErr("");
    setHint(t("openDir.waiting"));
    setBusy(true);
    const r = await pickWorkspace();
    setBusy(false);
    setHint("");
    if (r.path) {
      setVal(r.path);
      return;
    }
    // 取消是正常操作：保留手输内容；真失败才提示
    if (r.error && !r.cancelled) setErr(r.error);
    else if (r.error) setHint(r.error);
  };

  const submit = async () => {
    const v = val.trim();
    if (!v || busy) return;
    const unsaved = Object.values(dirty).filter(Boolean).length;
    if (unsaved > 0 && !window.confirm(t("openDir.unsavedConfirm", { count: unsaved }))) {
      return;
    }
    setErr("");
    setBusy(true);
    const e = await openWorkspace(v);
    setBusy(false);
    if (e) {
      setErr(e);
      return;
    }
    onClose();
  };

  return (
    <div
      className="kimi-overlay-in fixed inset-0 z-50 flex items-start justify-center pt-[18vh] bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="kimi-dialog-pop w-[460px] rounded-lg border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] shadow-2xl p-4">
        <div className="text-[13px] font-semibold mb-3 text-[color:var(--ide-text)]">{t("openDir.title")}</div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape" && !busy) onClose();
            }}
            placeholder={t("openDir.placeholder")}
            className="flex-1 min-w-0 bg-[color:var(--ide-bg-base)] border border-[color:var(--ide-border-strong)] rounded px-2.5 py-1.5 text-[13px] font-mono text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)]"
          />
          <button
            disabled={busy}
            title={t("openDir.browseTitle")}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)] disabled:opacity-40"
            onClick={() => void browse()}
          >
            <FolderOpen size={13} />
            {t("common.browse")}
          </button>
        </div>
        <div className="mt-2 min-h-[16px] text-[11.5px] leading-4">
          {err ? (
            <span className="text-[color:var(--ide-error)]">{err}</span>
          ) : hint ? (
            <span className="text-[color:var(--ide-text-muted)]">{hint}</span>
          ) : (
            <span className="text-[color:var(--ide-text-faint)]">{t("openDir.hint")}</span>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <button
            disabled={busy}
            className="px-3 py-1.5 rounded text-[12px] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)] disabled:opacity-40"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            disabled={!val.trim() || busy}
            className="px-4 py-1.5 rounded text-[12px] bg-[color:var(--ide-accent-strong)] text-white hover:bg-[color:var(--ide-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => void submit()}
          >
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
