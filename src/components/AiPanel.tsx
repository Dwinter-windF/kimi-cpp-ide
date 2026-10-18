import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Sparkles, Send, Trash2, User, Bot, CircleAlert, Settings2 } from "lucide-react";
import { useIde } from "@/store";
import { runToolLoop, type ChatMessage } from "@/lib/ai";
import { getActiveEditor } from "@/lib/editorRegistry";
import { useT } from "@/lib/i18n";
import type { AiContext } from "@/types";

// 气泡内的 Markdown 渲染只在有 AI 回复时才需要，拆成独立 chunk 懒加载。
const MarkdownLite = lazy(() =>
  import("@/components/MarkdownLite").then((m) => ({ default: m.MarkdownLite }))
);

// AI 请求 / 工作区文件工具 / 工具调用循环都抽到 src/lib/ai.ts，
// 与「AI 一键修复」（src/lib/aiFix.ts）共用同一份实现，这里只留 UI 与聊天记录维护。

/** 选中文本按 UTF-8 字节截断到 2KB（避免中文按字符切片超限） */
const CONTEXT_SELECTION_LIMIT = 2048;
function clipSelection(text: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= CONTEXT_SELECTION_LIMIT) return text;
  return new TextDecoder().decode(bytes.slice(0, CONTEXT_SELECTION_LIMIT)).replace(/\uFFFD+$/, "");
}

/**
 * 采集当前打开文件上下文：文件名 + 工作区相对路径 + 当前选中文本（若有，≤2KB）。
 * 没有打开文件时返回 undefined，聊天请求与旧版完全一致。
 */
function collectAiContext(): AiContext | undefined {
  const st = useIde.getState();
  if (!st.activeFile) return undefined;
  let selection = "";
  const view = getActiveEditor();
  if (view) {
    const range = view.state.selection.main;
    if (!range.empty) selection = clipSelection(view.state.sliceDoc(range.from, range.to));
  }
  return { file: st.activeFile, ...(selection.trim() ? { selection } : {}) };
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-[color:var(--ide-purple)] animate-bounce"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

export function AiPanel() {
  const t = useT();
  const aiMessages = useIde((s) => s.aiMessages);
  const aiBusy = useIde((s) => s.aiBusy);
  const clearAi = useIde((s) => s.clearAi);
  const activeFile = useIde((s) => s.activeFile);
  const contents = useIde((s) => s.contents);
  const problems = useIde((s) => s.problems);
  const aiConfigured = useIde((s) => !!s.settings.aiEndpoint);
  const aiModel = useIde((s) => s.settings.aiModel);
  const setShowSettings = useIde((s) => s.setShowSettings);

  const [input, setInput] = useState("");
  /** 本轮正在执行的工具动作（打字气泡上方的小字） */
  const [pendingActions, setPendingActions] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [aiMessages, aiBusy, pendingActions]);

  // textarea 自适应高度（1–6 行）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }, [input]);

  /**
   * 发送：把用户消息 + 历史（最近 20 条）交给 src/lib/ai.ts 的 runToolLoop，
   * 由它完成「请求模型 → 执行工作区文件工具 → 结果回灌」的最多 8 轮循环，
   * 这里只负责维护聊天记录与「🔧 正在做什么」的实时小字。
   */
  const runChat = async (text: string) => {
    const st = useIde.getState();
    const history: ChatMessage[] = st.aiMessages
      .filter((m) => m.role !== "system" && m.content.trim().length > 0)
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: "user", content: text });
    useIde.setState((s) => ({
      aiMessages: [...s.aiMessages, { role: "user" as const, content: text }],
      aiBusy: true,
      bottomTab: "ai" as const,
    }));
    setPendingActions([]);

    const out = await runToolLoop({
      settings: st.settings,
      history,
      // 当前文件 + 选中文本作为 system 附加消息随每次请求发送（不写入聊天历史）
      context: collectAiContext(),
      onAction: (actions) => setPendingActions(actions),
    });

    useIde.setState((s) => ({
      aiMessages: [
        ...s.aiMessages,
        {
          role: "assistant" as const,
          content: out.error ? "⚠ " + out.error : out.text,
          toolActions: out.actions.length > 0 ? out.actions : undefined,
        },
      ],
      aiBusy: false,
    }));
    setPendingActions([]);
  };

  const send = () => {
    const text = input.trim();
    if (!text || aiBusy) return;
    setInput("");
    void runChat(text);
  };

  const quickAsk = (prompt: string) => {
    if (aiBusy) return;
    void runChat(prompt);
  };

  const quickCards = [
    {
      label: t("ai.quick.explain"),
      icon: "📖",
      disabled: !activeFile,
      run: () =>
        quickAsk(t("ai.prompt.explain", { code: (contents[activeFile || ""] || "").slice(0, 3000) })),
    },
    {
      label: t("ai.quick.analyze"),
      icon: "🩺",
      disabled: problems.length === 0,
      run: () =>
        quickAsk(
          t("ai.prompt.analyze", {
            errors: problems
              .slice(0, 10)
              .map((p) => `${p.file}:${p.line}:${p.col} ${p.severity}: ${p.message}`)
              .join("\n"),
          })
        ),
    },
    {
      label: t("ai.quick.check"),
      icon: "🐞",
      disabled: !activeFile,
      run: () =>
        quickAsk(t("ai.prompt.check", { code: (contents[activeFile || ""] || "").slice(0, 3000) })),
    },
    {
      label: t("ai.quick.edit"),
      icon: "🛠",
      disabled: false,
      run: () => setInput(t("ai.prompt.edit")),
    },
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 头部：配置状态 + 清空 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[color:var(--ide-border)] shrink-0">
        <span className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--ide-text-muted)]">
          <Sparkles size={12} className="text-[color:var(--ide-purple)]" />
          {aiConfigured ? (
            <>
              {t("ai.connected", { model: aiModel || t("ai.defaultModel") })}
              <span className="text-[color:var(--ide-text-faint)]">{t("ai.workspaceAccess")}</span>
            </>
          ) : (
            t("ai.notConfigured")
          )}
        </span>
        <div className="flex items-center gap-1">
          {!aiConfigured && (
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1 px-2 py-[3px] rounded text-[11px] text-[color:var(--ide-warning)] hover:bg-[color:var(--ide-hover)]"
              title={t("ai.openSettings")}
            >
              <Settings2 size={12} /> {t("ai.gotoConfig")}
            </button>
          )}
          {aiMessages.length > 0 && (
            <button
              onClick={clearAi}
              className="flex items-center gap-1 px-2 py-[3px] rounded text-[11px] text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-error)] hover:bg-[color:var(--ide-hover)]"
              title={t("ai.clearTitle")}
            >
              <Trash2 size={12} /> {t("ai.clear")}
            </button>
          )}
        </div>
      </div>

      {/* 当前文件上下文（静态小字，随当前打开文件实时更新） */}
      <div
        className="px-3 py-[3px] border-b border-[color:var(--ide-border)] text-[10.5px] leading-4 text-[color:var(--ide-text-muted)] font-mono truncate shrink-0"
        title={activeFile || t("ai.context.noFile")}
      >
        {t("ai.context.currentFile", { file: activeFile || t("ai.context.noFile") })}
      </div>

      {/* 消息区 */}
      <div ref={boxRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-2 space-y-3">
        {aiMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-10 h-10 rounded-xl bg-[color:var(--ide-selected)] flex items-center justify-center mb-2">
              <Sparkles size={18} className="text-[color:var(--ide-purple)]" />
            </div>
            <div className="text-[13px] text-[color:var(--ide-text)] font-semibold mb-1">{t("ai.title")}</div>
            <div className="text-[11.5px] text-[color:var(--ide-text-muted)] mb-3 leading-5">
              {t("ai.subtitle")}
              <br />
              {aiConfigured
                ? t("ai.canReadWrite")
                : t("ai.configFirst")}
            </div>
            <div className="grid grid-cols-2 gap-1.5 w-full max-w-md">
              {quickCards.map((c) => (
                <button
                  key={c.label}
                  disabled={c.disabled || aiBusy}
                  onClick={c.run}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] text-[12px] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:border-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-hover)] transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {aiMessages.map((m, i) => {
          const isUser = m.role === "user";
          const isErr = !isUser && m.content.startsWith("⚠");
          const actions = !isUser && m.toolActions ? m.toolActions : [];
          return (
            <div key={i} className={`kimi-bubble-in flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
              {/* 头像 */}
              <div
                className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-[1px] ${
                  isUser ? "bg-[color:var(--ide-selected)]" : isErr ? "bg-[color:var(--ide-error-bg)]" : "bg-[color:var(--ide-bg-elevated)]"
                }`}
              >
                {isUser ? (
                  <User size={13} className="text-[color:var(--ide-accent)]" />
                ) : isErr ? (
                  <CircleAlert size={13} className="text-[color:var(--ide-error)]" />
                ) : (
                  <Bot size={13} className="text-[color:var(--ide-purple)]" />
                )}
              </div>
              {/* 气泡（AI 气泡上方先用一行小字列出工具动作） */}
              <div className={`flex flex-col min-w-0 max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
                {actions.length > 0 && (
                  <div className="flex flex-col gap-[2px] mb-1 px-0.5">
                    {actions.map((a, k) => (
                      <span key={k} className="text-[10.5px] leading-4 text-[color:var(--ide-text-muted)] font-mono break-all">
                        {a}
                      </span>
                    ))}
                  </div>
                )}
                <div
                  className={`max-w-full rounded-lg px-2.5 py-1.5 text-[12.5px] leading-relaxed min-w-0 ${
                    isUser
                      ? "bg-[color:var(--ide-selected)] text-[color:var(--ide-text)] rounded-tr-none"
                      : isErr
                        ? "bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-error-soft)] text-[color:var(--ide-error)] rounded-tl-none"
                        : "bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text)] rounded-tl-none"
                  }`}
                >
                  {isUser ? (
                    <span className="whitespace-pre-wrap break-words">{m.content}</span>
                  ) : (
                    <Suspense fallback={null}>
                      <MarkdownLite text={m.content} />
                    </Suspense>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {aiBusy && (
          <div className="flex flex-col gap-1">
            {pendingActions.length > 0 && (
              <div className="flex flex-col gap-[2px] pl-8">
                {pendingActions.map((a, k) => (
                  <span key={k} className="text-[10.5px] leading-4 text-[color:var(--ide-text-muted)] font-mono break-all">
                    {a}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <div className="w-6 h-6 rounded-md bg-[color:var(--ide-bg-elevated)] flex items-center justify-center shrink-0">
                <Bot size={13} className="text-[color:var(--ide-purple)]" />
              </div>
              <div className="bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] rounded-lg rounded-tl-none px-3 py-1.5">
                <TypingDots />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="flex items-end gap-2 px-3 py-2 border-t border-[color:var(--ide-border)] shrink-0">
        <textarea
          ref={taRef}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={aiConfigured ? t("ai.placeholder") : t("ai.placeholderUnconfigured")}
          className="flex-1 resize-none bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] rounded-lg px-2.5 py-1.5 text-[12.5px] text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)] disabled:opacity-50 leading-relaxed"
          style={{ maxHeight: "120px" }}
        />
        <button
          className="kimi-pop p-2 rounded-lg bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          disabled={!input.trim() || aiBusy || !aiConfigured}
          onClick={send}
          title={t("ai.send")}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
