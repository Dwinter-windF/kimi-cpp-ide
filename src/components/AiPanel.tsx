import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Sparkles, Send, Trash2, User, Bot, CircleAlert, Settings2 } from "lucide-react";
import { useIde } from "@/store";
import { runToolLoop, type ChatMessage } from "@/lib/ai";

// 气泡内的 Markdown 渲染只在有 AI 回复时才需要，拆成独立 chunk 懒加载。
const MarkdownLite = lazy(() =>
  import("@/components/MarkdownLite").then((m) => ({ default: m.MarkdownLite }))
);

// AI 请求 / 工作区文件工具 / 工具调用循环都抽到 src/lib/ai.ts，
// 与「AI 一键修复」（src/lib/aiFix.ts）共用同一份实现，这里只留 UI 与聊天记录维护。

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
    const t = input.trim();
    if (!t || aiBusy) return;
    setInput("");
    void runChat(t);
  };

  const quickAsk = (prompt: string) => {
    if (aiBusy) return;
    void runChat(prompt);
  };

  const quickCards = [
    {
      label: "解释当前代码",
      icon: "📖",
      disabled: !activeFile,
      run: () =>
        quickAsk(`请解释下面这段 C/C++ 代码的功能和关键逻辑（用中文，简明扼要）：\n\n\`\`\`cpp\n${(contents[activeFile || ""] || "").slice(0, 3000)}\n\`\`\``),
    },
    {
      label: "分析编译错误",
      icon: "🩺",
      disabled: problems.length === 0,
      run: () =>
        quickAsk(
          `我的 C/C++ 程序有以下编译问题，请分析原因并给出修改建议（用中文）：\n\n${problems
            .slice(0, 10)
            .map((p) => `${p.file}:${p.line}:${p.col} ${p.severity}: ${p.message}`)
            .join("\n")}`
        ),
    },
    {
      label: "检查代码问题",
      icon: "🐞",
      disabled: !activeFile,
      run: () =>
        quickAsk(`请检查下面这段 C/C++ 代码有没有 bug、内存安全隐患或可改进之处，并给出修改后的代码（用中文说明）：\n\n\`\`\`cpp\n${(contents[activeFile || ""] || "").slice(0, 3000)}\n\`\`\``),
    },
    {
      label: "帮我改工作区文件",
      icon: "🛠",
      disabled: false,
      run: () => setInput("请先列出当前工作区的文件，然后读取 main.cpp 并说明它的作用。"),
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
              已连接模型 <span className="text-[color:var(--ide-purple)] font-mono">{aiModel || "默认"}</span>
              <span className="text-[color:var(--ide-text-faint)]">· 可读写工作区文件</span>
            </>
          ) : (
            "未配置 AI 接口"
          )}
        </span>
        <div className="flex items-center gap-1">
          {!aiConfigured && (
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-1 px-2 py-[3px] rounded text-[11px] text-[color:var(--ide-warning)] hover:bg-[color:var(--ide-hover)]"
              title="打开设置配置 AI 接口"
            >
              <Settings2 size={12} /> 去配置
            </button>
          )}
          {aiMessages.length > 0 && (
            <button
              onClick={clearAi}
              className="flex items-center gap-1 px-2 py-[3px] rounded text-[11px] text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-error)] hover:bg-[color:var(--ide-hover)]"
              title="清空对话"
            >
              <Trash2 size={12} /> 清空
            </button>
          )}
        </div>
      </div>

      {/* 消息区 */}
      <div ref={boxRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-2 space-y-3">
        {aiMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-10 h-10 rounded-xl bg-[color:var(--ide-selected)] flex items-center justify-center mb-2">
              <Sparkles size={18} className="text-[color:var(--ide-purple)]" />
            </div>
            <div className="text-[13px] text-[color:var(--ide-text)] font-semibold mb-1">AI 编程助手</div>
            <div className="text-[11.5px] text-[color:var(--ide-text-muted)] mb-3 leading-5">
              解释代码、分析编译错误、查 bug、辅助写代码
              <br />
              {aiConfigured
                ? "可以直接让我读取 / 修改工作区里的文件。"
                : "先在「设置 → AI 接口」配置任意兼容 OpenAI 的 API。"}
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
          placeholder={aiConfigured ? "提问或描述需求，Enter 发送，Shift+Enter 换行" : "先在「设置 → AI 接口」配置后使用"}
          className="flex-1 resize-none bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] rounded-lg px-2.5 py-1.5 text-[12.5px] text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)] disabled:opacity-50 leading-relaxed"
          style={{ maxHeight: "120px" }}
        />
        <button
          className="kimi-pop p-2 rounded-lg bg-[color:var(--ide-accent-strong)] hover:bg-[color:var(--ide-accent)] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          disabled={!input.trim() || aiBusy || !aiConfigured}
          onClick={send}
          title="发送 (Enter)"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
