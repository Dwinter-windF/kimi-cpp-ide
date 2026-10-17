import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { Terminal, CircleAlert, Bug, Sparkles, Trash2, Wand2, Hammer } from "lucide-react";
import { LAYOUT_DEFAULTS, useIde } from "@/store";
import { aiConfigHint } from "@/lib/ai";
import { runAiFix } from "@/lib/aiFix";
import { StructVizPanel } from "@/components/StructVizPanel";
import type { BuildSystemKind, TermLine } from "@/types";

// AI 面板非首屏必要：仅在底部切到「AI 助手」页签时才渲染，改为懒加载。
const AiPanel = lazy(() =>
  import("@/components/AiPanel").then((m) => ({ default: m.AiPanel }))
);

// 终端/输出区配色全部走变量：暗色下取值与原硬编码色一致，
// 亮色下 --ide-term-bg 是浅底、上面四种 kind 都是深色，保证可读。
const KIND_COLOR: Record<TermLine["kind"], string> = {
  in: "text-[color:var(--ide-info)]",
  out: "text-[color:var(--ide-text)]",
  err: "text-[color:var(--ide-error)]",
  sys: "text-[color:var(--ide-purple)]",
};

// 构建系统徽标配色：三种构建系统各取一个 --ide-* 变量（暗色/亮色主题自动跟随）
const BUILD_BADGE_CLASS: Record<BuildSystemKind, string> = {
  cmake: "border-[color:var(--ide-info)] text-[color:var(--ide-info)]",
  make: "border-[color:var(--ide-success)] text-[color:var(--ide-success)]",
  single: "border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-muted)]",
};

/**
 * 构建系统徽标：显示服务端探测到的构建系统（「CMake」/「Make」/「g++ 单文件」）。
 * 工具缺失导致降级时改用警示色并加 ⚠（hover 看原因）；点击重新探测（打开目录/增删 Makefile 会自动刷新）。
 */
const BuildSystemBadge = memo(function BuildSystemBadge() {
  const buildSystem = useIde((s) => s.buildSystem);
  const refreshBuildSystem = useIde((s) => s.refreshBuildSystem);
  if (!buildSystem) return null;
  const warning = buildSystem.warning;
  const toolLines = (["cmake", "make", "ninja"] as const)
    .map((n) => `${n}: ${buildSystem.tools[n].found ? buildSystem.tools[n].path ?? "可用" : "未找到"}`)
    .join("\n");
  return (
    <button
      type="button"
      title={`当前构建系统：${buildSystem.label}\n判定依据：${buildSystem.evidence}\n${toolLines}${warning ? `\n⚠ ${warning}` : ""}\n（点击重新探测）`}
      onClick={() => void refreshBuildSystem()}
      className={`kimi-pop flex items-center gap-1 mr-2 px-2 py-[2px] rounded-full border text-[11px] whitespace-nowrap select-none ${
        warning ? "border-[color:var(--ide-warning)] text-[color:var(--ide-warning)]" : BUILD_BADGE_CLASS[buildSystem.kind]
      }`}
    >
      <Hammer size={11} />
      {buildSystem.label}
      {warning && <span>⚠</span>}
    </button>
  );
});

// 三个视图都不接收 props、各自订阅 store：用 memo 隔断父组件的重渲染，
// 拖分隔条调高度时（height 每帧变化导致 BottomPanel 重渲染）不会跟着重渲染整屏输出。
const TerminalView = memo(function TerminalView() {
  const termLines = useIde((s) => s.termLines);
  const runState = useIde((s) => s.runState);
  const sendInput = useIde((s) => s.sendInput);
  const clearTerm = useIde((s) => s.clearTerm);
  const [input, setInput] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [termLines]);

  const canInput = runState === "running";

  return (
    <div className="h-full flex flex-col">
      <div ref={boxRef} className="flex-1 overflow-y-auto bg-[color:var(--ide-term-bg)] px-3 py-2 font-mono text-[12.5px] leading-[1.5] whitespace-pre-wrap break-all">
        {termLines.map((l, i) => (
          <div key={i} className={KIND_COLOR[l.kind]}>
            {l.text || " "}
          </div>
        ))}
        {runState === "idle" && termLines.length === 0 && (
          <div className="text-[color:var(--ide-text-faint)]">终端输出将显示在这里。点击工具栏 ▶ 编译并运行程序。</div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-[color:var(--ide-border)]">
        <span className="text-[color:var(--ide-success)] font-mono text-[12px] shrink-0">{canInput ? ">" : "$"}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canInput) {
              void sendInput(input);
              setInput("");
            }
          }}
          disabled={!canInput}
          placeholder={canInput ? "输入内容并回车发送给程序（stdin）" : "程序运行时此处可输入"}
          className="flex-1 bg-transparent text-[12.5px] font-mono text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          title="清空终端"
          className="kimi-pop text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)] p-1"
          onClick={() => {
            clearTerm();
            setInput("");
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
});

const ProblemsView = memo(function ProblemsView() {
  const problems = useIde((s) => s.problems);
  const openFile = useIde((s) => s.openFile);
  const requestReveal = useIde((s) => s.requestReveal);
  const aiConfigured = useIde((s) => !!s.settings.aiEndpoint);
  const settings = useIde((s) => s.settings);
  const sendAi = useIde((s) => s.sendAi);
  const aiFixStatus = useIde((s) => s.aiFix.status);

  // 「AI 一键修复」：必须有编译错误（error 级），且 AI 接口地址与密钥都已配置
  const errorCount = problems.filter((p) => p.severity === "error").length;
  const configHint = aiConfigHint(settings);
  const canFix = errorCount > 0 && !configHint;
  const fixHint = errorCount === 0 ? "没有编译错误（error 级），无需修复" : configHint;

  if (problems.length === 0) {
    return <div className="px-4 py-3 text-[12.5px] text-[color:var(--ide-text-faint)]">✓ 没有发现问题。编译错误、警告会列在这里，并给出可能的原因分析。</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      {problems.map((p, i) => {
        const short = (p.file || "链接阶段").split("/").pop();
        return (
          <div
            key={i}
            className="flex items-start gap-2 px-4 py-1.5 text-[12.5px] hover:bg-[color:var(--ide-hover)] cursor-pointer border-b border-[color:var(--ide-bg-panel)]"
            onClick={() => {
              if (p.file) {
                void openFile(p.file);
                requestReveal(p.file, p.line);
              }
            }}
          >
            <CircleAlert
              size={14}
              className={`mt-[2px] shrink-0 ${p.severity === "error" ? "text-[color:var(--ide-error)]" : "text-[color:var(--ide-warning)]"}`}
            />
            <div className="min-w-0">
              <div className="text-[color:var(--ide-text)] break-all">
                <span className="text-[color:var(--ide-text-muted)]">
                  {short}
                  {p.line > 0 ? `:${p.line}:${p.col}` : ""} -{" "}
                </span>
                {p.message}
              </div>
              {p.hint && <div className="text-[color:var(--ide-success)] mt-[2px]">💡 {p.hint}</div>}
            </div>
          </div>
        );
      })}
      {/* AI 修复入口：有 error 级编译错误时可点；未配置 AI 时禁用并说明缺哪一项 */}
      <div className="px-4 py-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            className="kimi-pop flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md bg-[color:var(--ide-accent-strong)] text-white hover:bg-[color:var(--ide-accent)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[color:var(--ide-accent-strong)]"
            disabled={!canFix || aiFixStatus === "loading"}
            title={canFix ? `把 ${errorCount} 个编译错误与相关源文件发给 AI，修正结果以 diff 预览后再决定是否写回` : fixHint}
            onClick={() => void runAiFix()}
          >
            <Wand2 size={13} />
            {aiFixStatus === "loading" ? "AI 修复中…" : "AI 一键修复"}
          </button>
          {aiConfigured && (
            <button
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md bg-[color:var(--ide-selected)] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-accent-strong)]"
              onClick={() => {
                const errText = problems
                  .slice(0, 10)
                  .map((p) => `${p.file}:${p.line}:${p.col} ${p.severity}: ${p.message}`)
                  .join("\n");
                void sendAi(
                  `我的 C/C++ 程序编译出现以下问题，请帮我分析根本原因并给出具体修改建议（请用中文）：\n\n${errText}\n\n另外请提醒我如何避免这类错误。`
                );
              }}
            >
              <Sparkles size={13} /> 让 AI 深度分析这些错误
            </button>
          )}
        </div>
        {!canFix && <span className="text-[11.5px] text-[color:var(--ide-warning)]">{fixHint}</span>}
      </div>
    </div>
  );
});

const DebugView = memo(function DebugView() {
  const runState = useIde((s) => s.runState);
  const debugStopped = useIde((s) => s.debugStopped);
  const locals = useIde((s) => s.locals);
  const watchExprs = useIde((s) => s.watchExprs);
  const watchValues = useIde((s) => s.watchValues);
  const watchErrors = useIde((s) => s.watchErrors);
  const callStack = useIde((s) => s.callStack);
  const watchChanged = useIde((s) => s.watchChanged);
  const openFile = useIde((s) => s.openFile);
  const requestReveal = useIde((s) => s.requestReveal);

  if (runState !== "debugging") {
    return (
      <div className="px-4 py-3 text-[12.5px] text-[color:var(--ide-text-faint)] leading-6">
        未在调试中。使用方式：
        <br />1. 点击编辑器行号左侧空白处设置断点（红点）；
        <br />2. 在右侧「监视变量」区添加想观察的表达式；
        <br />3. 点击工具栏 🐞 开始调试，用「下一步 / 单步进入 / 跳出 / 继续」控制执行，变量值会实时刷新；
        <br />4. 调试停在断点时：编辑器悬浮变量可查看当前值，下方可查看调用栈。
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-2 text-[12.5px]">
      <div className="text-[color:var(--ide-warning)] font-mono mb-2">
        {debugStopped
          ? `⏸ 停在 ${debugStopped.func || "?"} @ ${debugStopped.file.split("/").pop()}:${debugStopped.line}（${debugStopped.reason}）`
          : "▶ 程序运行中…（命中断点后自动暂停）"}
      </div>
      {callStack.length > 0 && (
        <>
          <div className="text-[color:var(--ide-text-muted)] uppercase text-[11px] tracking-wider mb-1">调用栈</div>
          <table className="w-full font-mono">
            <tbody>
              {callStack.map((f) => (
                <tr
                  key={f.level}
                  className={`border-b border-[color:var(--ide-bg-panel)] ${f.file ? "cursor-pointer" : ""} ${f.level === 0 ? "" : "opacity-80"}`}
                  title={f.file ? `${f.file}:${f.line}` : undefined}
                  onClick={() => {
                    if (!f.file) return;
                    void openFile(f.file);
                    requestReveal(f.file, f.line);
                  }}
                >
                  <td className="py-[3px] pr-3 text-[color:var(--ide-text-muted)] align-top w-6">#{f.level}</td>
                  <td className={`py-[3px] pr-4 align-top ${f.level === 0 ? "text-[color:var(--ide-warning)]" : "text-[color:var(--ide-accent)]"}`}>{f.func || "?"}</td>
                  <td className="py-[3px] text-[color:var(--ide-text-dim)] break-all">
                    {f.file ? `${f.file.split("/").pop()}:${f.line}` : "(无源码信息)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {locals.length > 0 && (
        <>
          <div className="text-[color:var(--ide-text-muted)] uppercase text-[11px] tracking-wider mt-3 mb-1">当前作用域局部变量</div>
          <table className="w-full font-mono">
            <tbody>
              {locals.map((l) => (
                <tr key={l.name} className="border-b border-[color:var(--ide-bg-panel)]">
                  <td className="py-[3px] pr-4 text-[color:var(--ide-cyan)] align-top">{l.name}</td>
                  <td className="py-[3px] text-[color:var(--ide-success)] break-all">{l.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {watchExprs.length > 0 && (
        <>
          <div className="text-[color:var(--ide-text-muted)] uppercase text-[11px] tracking-wider mt-3 mb-1">监视表达式</div>
          <table className="w-full font-mono">
            <tbody>
              {watchExprs.map((e) => (
                <tr key={e} className="border-b border-[color:var(--ide-bg-panel)]">
                  <td className="py-[3px] pr-4 text-[color:var(--ide-cyan)] align-top">{e}</td>
                  <td className="py-[3px] break-all">
                    {watchErrors[e] ? (
                      <span className="text-[color:var(--ide-error)]">⚠ {watchErrors[e]}</span>
                    ) : (
                      <span key={watchChanged[e] || 0} className={watchChanged[e] ? "kimi-watch-flash text-[color:var(--ide-success)]" : "text-[color:var(--ide-success)]"}>
                        {watchValues[e] ?? "…"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
});

/**
 * 可视化停靠区：有可视化目标时占据调试页签底部固定高度，无目标时完全不占空间。
 */
function VizDock() {
  const vizExpr = useIde((s) => s.vizExpr);
  if (!vizExpr) return null;
  return (
    <div className="h-56 shrink-0 border-t border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)]">
      <StructVizPanel />
    </div>
  );
}

/**
 * 底部面板。
 * @param height 面板高度（px）。由外部（App 的 layout.bottom）控制，省略时用默认高度 240px（h-60）。
 */
export function BottomPanel({ height = LAYOUT_DEFAULTS.bottom }: { height?: number }) {
  const bottomTab = useIde((s) => s.bottomTab);
  const setBottomTab = useIde((s) => s.setBottomTab);
  const problemCount = useIde((s) => s.problems.length);
  const runState = useIde((s) => s.runState);

  const tabs = [
    { id: "terminal" as const, label: "终端", icon: <Terminal size={13} /> },
    { id: "problems" as const, label: `问题${problemCount > 0 ? ` (${problemCount})` : ""}`, icon: <CircleAlert size={13} /> },
    { id: "debug" as const, label: "调试", icon: <Bug size={13} /> },
    { id: "ai" as const, label: "AI 助手", icon: <Sparkles size={13} /> },
  ];

  return (
    <div className="h-60 border-t border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] flex flex-col shrink-0" style={{ height }}>
      <div className="flex items-center gap-1 px-2 border-b border-[color:var(--ide-border)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setBottomTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] border-b-2 -mb-px ${
              bottomTab === t.id
                ? "text-[color:var(--ide-text)] border-[color:var(--ide-accent)]"
                : "text-[color:var(--ide-text-muted)] border-transparent hover:text-[color:var(--ide-text-dim)]"
            } ${t.id === "debug" && runState === "debugging" ? "text-[color:var(--ide-warning)]" : ""}`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        {/* 右侧：当前构建系统徽标（CMake / Make / g++ 单文件） */}
        <div className="flex-1" />
        <BuildSystemBadge />
      </div>
      {/* key 让页签内容每次切换重新挂载，从而触发一次 .kimi-tab-fade 淡入；
          终端输出行、问题列表行本身依旧零动画（只做一次性容器淡入）。 */}
      <div key={bottomTab} className="kimi-tab-fade flex-1 min-h-0">
        {bottomTab === "terminal" && <TerminalView />}
        {bottomTab === "problems" && <ProblemsView />}
        {bottomTab === "debug" && (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-hidden">
              <DebugView />
            </div>
            <VizDock />
          </div>
        )}
        {bottomTab === "ai" && (
          <Suspense fallback={null}>
            <AiPanel />
          </Suspense>
        )}
      </div>
    </div>
  );
}
