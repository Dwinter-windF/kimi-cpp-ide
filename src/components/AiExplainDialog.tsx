import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, CornerDownLeft, Loader2, TriangleAlert, X } from "lucide-react";
import { aiConfigHint, isAiConfigured } from "@/lib/ai";
import {
  EXPLAIN_CONTEXT_LINES,
  EXPLAIN_SELECTION_BYTES,
  requestExplanation,
  type ExplainContext,
} from "@/lib/aiExplain";
import type { InsertOutcome } from "@/lib/aiGen";
import { MarkdownLite } from "@/components/MarkdownLite";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";

type Phase = "idle" | "loading" | "streaming" | "done" | "error";

export interface AiExplainDialogProps {
  /** 打开对话框时冻结的选区现场（null = 对话框关闭） */
  ctx: ExplainContext | null;
  /** 当前文件（工作区相对路径），只用于提示词与标题 */
  file: string;
  /** 用户点「插入为注释」时执行：内部完成校验与单事务插入 */
  onInsert: (ctx: ExplainContext, markdown: string) => InsertOutcome;
  /** 关闭对话框（Esc / 点遮罩 / 关闭按钮 / 插入成功） */
  onClose: () => void;
}

/**
 * 「AI 解释代码」轻量对话框（仿 AiInsertDialog 的紧凑模式）。
 *
 *  · 打开即请求（流式），先显示「正在解释…」加载态，首个增量到达后立刻用 MarkdownLite 渲染；
 *  · 中途关闭 / Esc / 点遮罩都会 abort 在飞请求，不留孤儿连接；
 *  · 解释完成前「插入为注释」禁用；插入失败（例如等待期间文档被改过）在对话框内报错且不关闭；
 *  · 配色全部走 --ide-* 变量 + .kimi-* 动画类，亮暗主题自动适配。
 */
export function AiExplainDialog({ ctx, file, onInsert, onClose }: AiExplainDialogProps) {
  const tr = useT();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [inserting, setInserting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const open = ctx !== null;

  // 打开 / 换选区就发起一次新请求；关闭 / 切换时中止上一条
  useEffect(() => {
    if (!ctx) {
      abortRef.current?.abort();
      abortRef.current = null;
      setText("");
      setError("");
      setPhase("idle");
      setInserting(false);
      return;
    }

    const st = useIde.getState();
    if (!isAiConfigured(st.settings)) {
      setText("");
      setError(aiConfigHint(st.settings) || tr("aiFix.errNotConfigured"));
      setPhase("error");
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setText("");
    setError("");
    setPhase("loading");

    let acc = "";
    void requestExplanation({
      settings: st.settings,
      file,
      ctx,
      signal: ctrl.signal,
      onDelta: (delta) => {
        if (ctrl.signal.aborted) return;
        acc += delta;
        setText(acc);
        setPhase((p) => (p === "loading" ? "streaming" : p));
      },
    })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        if (abortRef.current === ctrl) abortRef.current = null;
        if (res.error) {
          if (res.text) setText(res.text);
          setError(res.error);
          setPhase("error");
          return;
        }
        setText(res.text);
        setPhase("done");
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (abortRef.current === ctrl) abortRef.current = null;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });

    return () => {
      ctrl.abort();
      if (abortRef.current === ctrl) abortRef.current = null;
    };
  }, [ctx, file, tr]);

  const requestClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    onClose();
  }, [onClose]);

  // Esc 关闭并中止请求
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  if (!ctx) return null;

  const busy = phase === "loading" || phase === "streaming";
  // 只有完整解释（done）才允许插入：流式中/失败时避免把半截内容写进源码
  const canInsert = phase === "done" && !inserting && !!text.trim();

  const insert = () => {
    if (!ctx || !canInsert) return;
    setInserting(true);
    try {
      const res = onInsert(ctx, text);
      if (res.ok) onClose();
      else setError(res.error);
    } finally {
      setInserting(false);
    }
  };

  const hint =
    phase === "loading"
      ? tr("explain.loading")
      : phase === "streaming"
        ? tr("explain.streaming")
        : phase === "error"
          ? tr("explain.errorHint")
          : tr("explain.doneHint");

  return (
    <div
      className="kimi-overlay-in fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={requestClose}
      role="presentation"
    >
      <div
        className="kimi-dialog-pop w-[min(720px,94vw)] max-h-[min(720px,88vh)] flex flex-col rounded-xl border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={tr("explain.title")}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[color:var(--ide-border)] shrink-0">
          <BookOpen size={15} className="text-[color:var(--ide-purple)] shrink-0" />
          <span className="text-[13px] font-semibold">{tr("explain.title")}</span>
          <span className="text-[11.5px] font-mono text-[color:var(--ide-text-muted)] truncate">{file}</span>
          {busy && <Loader2 size={13} className="animate-spin text-[color:var(--ide-purple-bright)] shrink-0" />}
          <button
            className="kimi-pop ml-auto p-1 rounded text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
            onClick={requestClose}
            title={tr("explain.closeTitle")}
          >
            <X size={14} />
          </button>
        </div>

        {/* 选区范围说明 */}
        <div className="px-4 pt-2.5 pb-1.5 text-[11.5px] leading-5 text-[color:var(--ide-text-muted)] shrink-0">
          <div>
            {tr("explain.selectionInfo", { from: ctx.startLine, to: ctx.endLine })}
            <span className="text-[color:var(--ide-text-faint)]">
              {" · "}
              {tr("explain.contextScope", {
                lines: EXPLAIN_CONTEXT_LINES,
                bytes: EXPLAIN_SELECTION_BYTES / 1024,
              })}
            </span>
          </div>
        </div>

        {/* 错误提示（等待期间文档被改 / 未配置 / 接口失败） */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-[color:var(--ide-error-soft)] bg-[color:var(--ide-bg-base)] px-3 py-2 shrink-0">
            <TriangleAlert size={14} className="mt-[2px] shrink-0 text-[color:var(--ide-error)]" />
            <span className="text-[12px] leading-5 whitespace-pre-wrap break-words text-[color:var(--ide-error)]">{error}</span>
          </div>
        )}

        {/* 内容区：加载态 / 流式 Markdown */}
        <div className="flex-1 min-h-[180px] overflow-y-auto bg-[color:var(--ide-bg-base)] px-4 py-2.5 text-[12.5px] leading-6">
          {phase === "loading" && !text ? (
            <div className="h-full min-h-[150px] flex flex-col items-center justify-center gap-3 text-[color:var(--ide-text-muted)] text-[12.5px]">
              <Loader2 size={22} className="animate-spin text-[color:var(--ide-purple)]" />
              {tr("explain.loading")}
            </div>
          ) : text ? (
            <MarkdownLite text={text} />
          ) : phase === "error" ? (
            <div className="text-[12px] text-[color:var(--ide-text-muted)]">{tr("explain.errorHint")}</div>
          ) : null}
        </div>

        {/* 底部动作 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[color:var(--ide-border)] shrink-0">
          <span className="text-[11.5px] text-[color:var(--ide-text-muted)] mr-auto">{hint}</span>
          <button
            className="px-3 py-1.5 rounded-md text-[12.5px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
            onClick={requestClose}
            title={tr("explain.closeTitle")}
          >
            {tr("common.close")}
          </button>
          <button
            className="kimi-pop flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12.5px] bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={insert}
            disabled={!canInsert}
            title={canInsert ? tr("explain.insertTitle") : tr("explain.insertDisabled")}
          >
            {inserting ? <Loader2 size={13} className="animate-spin" /> : <CornerDownLeft size={13} />}
            {tr("explain.insert")}
          </button>
        </div>
      </div>
    </div>
  );
}
