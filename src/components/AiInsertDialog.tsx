import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { aiConfigHint, isAiConfigured } from "@/lib/ai";
import {
  buildInsertContext,
  requestCodeFromInstruction,
  CONTEXT_SCOPE_HINT,
  type InsertContext,
  type InsertResult,
} from "@/lib/aiInsert";
import { useIde } from "@/store";

/** 对话框宽度与行数上限（上下文说明里展示） */
const PREVIEW_MAX_CHARS = 90;

/**
 * 「AI 插入代码…」对话框（自然语言加功能）。
 *
 * 设计要点：
 *  · 现场在**打开对话框时**由父组件抓取（InsertContext：光标 / 选区 / 文档快照），
 *    用户在对话框里打字、点按钮都不会移动光标，因此插入校验天然稳定；
 *  · 生成中按钮转 loading 并可「取消」（AbortController 传进 requestChat），
 *    Esc / 点遮罩在生成中一律先取消再关闭，不留孤儿请求；
 *  · 失败（未配置 / 空指令 / 超时 / 解析不出代码 / 插入前校验不过）一律在对话框内显示中文
 *    错误且**不改动文档**，对话框不关闭，用户可以改指令直接重试；
 *  · 配色全部走 --ide-* 变量 + .kimi-* 动画类，亮暗主题自动适配，动画 ≤250ms。
 */
export interface AiInsertDialogProps {
  /** 打开对话框时抓取的现场（null = 对话框关闭） */
  ctx: InsertContext | null;
  /** 当前文件（工作区相对路径），只用于提示词与标题 */
  file: string;
  /** 用户点「生成并插入」时执行：内部完成校验与单事务插入 */
  onInsert: (ctx: InsertContext, code: string) => InsertResult;
  /** 关闭对话框（取消 / 成功 / Esc / 点遮罩） */
  onClose: () => void;
}

export function AiInsertDialog({ ctx, file, onInsert, onClose }: AiInsertDialogProps) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const open = ctx !== null;

  // 每次打开都是一次新对话：清空指令与上一次的错误，并聚焦输入框
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(false);
      return;
    }
    setInstruction("");
    setError("");
    setBusy(false);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // 卸载（切换文件 / 关闭标签）时中止在飞请求
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setError("已取消 AI 请求。");
  }, []);

  const requestClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  /** 生成并插入：未配置 / 空指令不发请求；失败只在对话框内报错、不动文档 */
  const submit = useCallback(async () => {
    if (!ctx || busy) return;
    const text = instruction.trim();
    if (!text) {
      setError("请先输入一句指令，例如「给这个类加一个打印函数」。");
      inputRef.current?.focus();
      return;
    }
    const st = useIde.getState();
    if (!isAiConfigured(st.settings)) {
      setError(aiConfigHint(st.settings) || "未配置 AI 接口。");
      return;
    }
    const { text: context } = buildInsertContext(ctx, file);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setError("");
    try {
      const res = await requestCodeFromInstruction({
        settings: useIde.getState().settings,
        file,
        context,
        instruction: text,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return; // 已取消：不再提示，也不再插入
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // 插入：校验不过（等待期间光标/文件变了）时返回中文错误，文档零改动
      const inserted = onInsert(ctx, res.code);
      if (inserted.ok) onClose();
      else setError(inserted.error);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (!ctrl.signal.aborted) setBusy(false);
    }
  }, [ctx, busy, instruction, file, onInsert, onClose]);

  // Esc 关闭（生成中先取消再关闭）；Ctrl/Cmd+Enter 直接生成
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose, submit]);

  if (!ctx) return null;

  const line = ctx.doc.slice(0, Math.min(ctx.cursor, ctx.doc.length)).split("\n").length;
  const truncLine = (ctx.doc.split("\n")[line - 1] ?? "").trim();
  const preview = truncLine.length > PREVIEW_MAX_CHARS ? `${truncLine.slice(0, PREVIEW_MAX_CHARS)}…` : truncLine;

  return (
    <div
      className="kimi-overlay-in fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={requestClose}
      role="presentation"
    >
      <div
        className="kimi-dialog-pop w-[min(620px,94vw)] flex flex-col rounded-xl border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="AI 插入代码"
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[color:var(--ide-border)] shrink-0">
          <Sparkles size={15} className="text-[color:var(--ide-purple)] shrink-0" />
          <span className="text-[13px] font-semibold">AI 插入代码</span>
          <span className="text-[11.5px] font-mono text-[color:var(--ide-text-muted)] truncate">{file}</span>
          <button
            className="kimi-pop ml-auto p-1 rounded text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
            onClick={requestClose}
            title="关闭（Esc）"
          >
            <X size={14} />
          </button>
        </div>

        {/* 指令输入 */}
        <div className="px-4 pt-3 pb-2">
          <label className="block text-[12px] text-[color:var(--ide-text-dim)] mb-1.5" htmlFor="ai-insert-instruction">
            用一句自然语言描述要加的功能
          </label>
          <textarea
            id="ai-insert-instruction"
            ref={inputRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder="给这个类加一个打印函数"
            className="w-full resize-none rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-base)] px-2.5 py-2 text-[12.5px] leading-5 text-[color:var(--ide-text)] placeholder:text-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)] disabled:opacity-60"
          />
        </div>

        {/* 上下文范围说明：自动带上当前文件 + 行数 / 截断策略 */}
        <div className="px-4 pb-2 text-[11.5px] leading-5 text-[color:var(--ide-text-muted)]">
          <div>
            上下文：<span className="font-mono text-[color:var(--ide-text-dim)]">{file}</span>
            {" · 插入位置：第 "}
            {line}
            {" 行（光标处）"}
          </div>
          <div className="text-[color:var(--ide-text-faint)]">{CONTEXT_SCOPE_HINT}</div>
          {preview && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-[color:var(--ide-text-faint)]">
              该行：{preview}
            </div>
          )}
        </div>

        {/* 中文错误 / 取消提示 */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-[color:var(--ide-error-soft)] bg-[color:var(--ide-bg-base)] px-3 py-2">
            <TriangleAlert size={14} className="mt-[2px] shrink-0 text-[color:var(--ide-error)]" />
            <span className="text-[12px] leading-5 whitespace-pre-wrap break-words text-[color:var(--ide-error)]">
              {error}
            </span>
          </div>
        )}

        {/* 底部动作 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[color:var(--ide-border)] shrink-0">
          <span className="text-[11.5px] text-[color:var(--ide-text-muted)] mr-auto">
            {busy ? "请求进行中…（30 秒超时）" : "生成后插入到光标处，可一次 Ctrl+Z 撤销。"}
          </span>
          {busy && (
            <button
              className="px-3 py-1.5 rounded-md text-[12.5px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
              onClick={cancel}
            >
              取消
            </button>
          )}
          <button
            className="px-3 py-1.5 rounded-md text-[12.5px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
            onClick={requestClose}
            title={busy ? "关闭并取消正在进行的生成" : "关闭（Esc）"}
          >
            关闭
          </button>
          <button
            className="kimi-pop flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12.5px] bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => void submit()}
            disabled={busy || !instruction.trim()}
            title="生成并插入到光标处（Ctrl+Enter）"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <CornerDownLeft size={13} />}
            {busy ? "生成中…" : "生成并插入"}
          </button>
        </div>
      </div>
    </div>
  );
}
