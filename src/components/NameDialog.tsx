import { useEffect, useRef, useState } from "react";
import { useIde } from "@/store";

/** 应用内命名对话框（替代浏览器原生 prompt，内嵌环境不支持） */
export function NameDialog() {
  const dlg = useIde((s) => s.nameDialog);
  const closeNameDialog = useIde((s) => s.closeNameDialog);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dlg) {
      setVal(dlg.initial ?? "");
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
      return () => clearTimeout(t);
    }
  }, [dlg]);

  if (!dlg) return null;

  const submit = () => {
    const v = val.trim();
    if (v) dlg.onSubmit(v);
    closeNameDialog();
  };

  return (
    <div
      className="kimi-overlay-in fixed inset-0 z-50 flex items-start justify-center pt-[18vh] bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeNameDialog();
      }}
    >
      <div className="kimi-dialog-pop w-[380px] rounded-lg border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] shadow-2xl p-4">
        <div className="text-[13px] font-semibold mb-3 text-[color:var(--ide-text)]">{dlg.title}</div>
        <input
          ref={inputRef}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") closeNameDialog();
          }}
          placeholder={dlg.placeholder}
          className="w-full bg-[color:var(--ide-bg-base)] border border-[color:var(--ide-border-strong)] rounded px-2.5 py-1.5 text-[13px] font-mono text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)]"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            className="px-3 py-1.5 rounded text-[12px] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)]"
            onClick={closeNameDialog}
          >
            取消
          </button>
          <button
            disabled={!val.trim()}
            className="px-4 py-1.5 rounded text-[12px] bg-[color:var(--ide-accent-strong)] text-white hover:bg-[color:var(--ide-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={submit}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
