import { useMemo, useState } from "react";
import { Plus, X, Eye, CircleDot, Box, Network } from "lucide-react";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";

const CPP_KEYWORDS = new Set([
  "auto", "break", "case", "catch", "char", "class", "const", "continue", "default", "delete",
  "do", "double", "else", "enum", "extern", "false", "float", "for", "goto", "if", "inline",
  "int", "long", "namespace", "new", "nullptr", "operator", "private", "protected", "public",
  "return", "short", "signed", "sizeof", "static", "struct", "switch", "template", "this",
  "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual",
  "void", "volatile", "while", "std", "include", "define", "iostream", "main",
]);

export function WatchPanel() {
  const t = useT();
  const watchExprs = useIde((s) => s.watchExprs);
  const watchValues = useIde((s) => s.watchValues);
  const watchErrors = useIde((s) => s.watchErrors);
  const addWatch = useIde((s) => s.addWatch);
  const removeWatch = useIde((s) => s.removeWatch);
  const breakpoints = useIde((s) => s.breakpoints);
  const toggleBreakpoint = useIde((s) => s.toggleBreakpoint);
  const openFile = useIde((s) => s.openFile);
  const requestReveal = useIde((s) => s.requestReveal);
  const debugStopped = useIde((s) => s.debugStopped);
  const runState = useIde((s) => s.runState);
  const locals = useIde((s) => s.locals);
  const watchChanged = useIde((s) => s.watchChanged);
  const showViz = useIde((s) => s.showViz);
  const activeFile = useIde((s) => s.activeFile);
  const contents = useIde((s) => s.contents);
  const [expr, setExpr] = useState("");

  const debugging = runState === "debugging";
  const stopped = debugging && debugStopped;

  // 候选变量：调试停止时来自 GDB 局部变量；否则从当前文件提取标识符
  const candidates = useMemo(() => {
    if (stopped && locals.length > 0) {
      return locals.map((l) => l.name).slice(0, 14);
    }
    const src = (activeFile && contents[activeFile]) || "";
    const found = new Set<string>();
    const re = /[A-Za-z_]\w{1,}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) && found.size < 40) {
      const w = m[0];
      if (!CPP_KEYWORDS.has(w)) found.add(w);
    }
    return [...found].slice(0, 12);
  }, [stopped, locals, activeFile, contents]);

  const add = (e?: string) => {
    const v = (e ?? expr).trim();
    if (v) {
      addWatch(v);
      setExpr("");
    }
  };

  const bpList = Object.entries(breakpoints).flatMap(([file, lines]) =>
    lines.map((line) => ({ file, line }))
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 监视变量 */}
      <div className="px-3 py-2 border-b border-[color:var(--ide-border)] flex items-center justify-between">
        <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase flex items-center gap-1">
          <Eye size={12} /> {t("watch.title")}
        </span>
      </div>
      <div className="px-2 py-2 border-b border-[color:var(--ide-border)] space-y-2">
        <div className="flex gap-1">
          <input
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder={t("watch.placeholder")}
            list="watch-candidates"
            className="flex-1 bg-[color:var(--ide-bg-panel)] border border-[color:var(--ide-border-strong)] rounded px-2 py-1 text-[12px] text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)]"
          />
          <datalist id="watch-candidates">
            {candidates.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button onClick={() => add()} className="kimi-pop px-2 rounded bg-[color:var(--ide-selected)] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-accent-strong)]" title={t("watch.addTitle")}>
            <Plus size={14} />
          </button>
        </div>
        {/* 候选变量: 点击即可加入监视 */}
        {candidates.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-[11px] text-[color:var(--ide-text-muted)] w-full">
              {stopped ? t("watch.candidatesStopped") : t("watch.candidatesCode")}
            </span>
            {candidates.map((c) => {
              const watched = watchExprs.includes(c);
              return (
                <button
                  key={c}
                  disabled={watched}
                  onClick={() => add(c)}
                  title={watched ? t("watch.alreadyWatched") : t("watch.watchExpr", { expr: c })}
                  className={`px-1.5 py-[2px] rounded text-[11px] font-mono border transition-colors ${
                    watched
                      ? "border-[color:var(--ide-selected)] text-[color:var(--ide-text-muted)] cursor-default"
                      : "border-[color:var(--ide-border-strong)] text-[color:var(--ide-cyan)] hover:border-[color:var(--ide-cyan)] hover:bg-[color:var(--ide-hover)]"
                  }`}
                >
                  {watched ? "✓ " : "+ "}
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {watchExprs.length === 0 && (
          <div className="text-[12px] text-[color:var(--ide-text-faint)] px-3 py-2">
            {t("watch.emptyHint")}
          </div>
        )}
        {watchExprs.map((e) => (
          <div key={e} className="flex items-center gap-2 px-3 py-[5px] text-[12px] hover:bg-[color:var(--ide-hover)] group">
            <Box size={11} className="shrink-0 text-[color:var(--ide-text-muted)]" />
            <span className="text-[color:var(--ide-cyan)] font-mono truncate flex-1">{e}</span>
            {debugging ? (
              watchErrors[e] ? (
                <span className="text-[color:var(--ide-error)] font-mono truncate max-w-[45%]" title={watchErrors[e]}>
                  {watchErrors[e]}
                </span>
              ) : (
                <span
                  key={watchChanged[e] || 0}
                  className={`font-mono truncate max-w-[45%] ${watchChanged[e] ? "kimi-watch-flash" : ""}`}
                  style={{ color: "var(--ide-success)" }}
                  title={watchValues[e]}
                >
                  {watchValues[e] ?? "…"}
                </span>
              )
            ) : (
              <span className="text-[color:var(--ide-text-faint)]">{t("watch.notDebugging")}</span>
            )}
            {stopped && (
              <button
                className="opacity-0 group-hover:opacity-100 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-accent)]"
                title={t("watch.visualize", { expr: e })}
                onClick={() => void showViz(e)}
              >
                <Network size={12} />
              </button>
            )}
            <button className="opacity-0 group-hover:opacity-100 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-error)]" onClick={() => removeWatch(e)}>
              <X size={12} />
            </button>
          </div>
        ))}

        {/* 当前局部变量 */}
        {stopped && locals.length > 0 && (
          <>
            <div className="px-3 py-2 border-t border-b border-[color:var(--ide-border)] mt-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase">{t("watch.localsTitle")}</span>
              <button
                className="text-[11px] text-[color:var(--ide-accent)] hover:text-[color:var(--ide-text)]"
                onClick={() => locals.forEach((l) => !watchExprs.includes(l.name) && addWatch(l.name))}
              >
                {t("watch.watchAll")}
              </button>
            </div>
            {locals.map((l) => (
              <div key={l.name} className="flex items-center gap-2 px-3 py-[5px] text-[12px] hover:bg-[color:var(--ide-hover)] group">
                <span className="text-[color:var(--ide-warning)] font-mono truncate flex-1">{l.name}</span>
                <span className="text-[color:var(--ide-success)] font-mono truncate max-w-[50%]" title={l.value}>
                  {l.value}
                </span>
                {!watchExprs.includes(l.name) && (
                  <button
                    className="opacity-0 group-hover:opacity-100 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-accent)]"
                    title={t("watch.watchExpr", { expr: l.name })}
                    onClick={() => addWatch(l.name)}
                  >
                    <Plus size={12} />
                  </button>
                )}
                {stopped && (
                  <button
                    className="opacity-0 group-hover:opacity-100 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-accent)]"
                    title={t("watch.visualize", { expr: l.name })}
                    onClick={() => void showViz(l.name)}
                  >
                    <Network size={12} />
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {/* 断点列表 */}
        <div className="px-3 py-2 border-t border-b border-[color:var(--ide-border)] mt-2 flex items-center gap-1">
          <CircleDot size={12} className="text-[color:var(--ide-error)]" />
          <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase">{t("watch.breakpoints", { count: bpList.length })}</span>
        </div>
        {bpList.length === 0 && <div className="text-[12px] text-[color:var(--ide-text-faint)] px-3 py-2">{t("watch.breakpointsEmpty")}</div>}
        {bpList.map((bp) => (
          <div
            key={bp.file + ":" + bp.line}
            className="flex items-center gap-2 px-3 py-[5px] text-[12px] hover:bg-[color:var(--ide-hover)] group cursor-pointer"
            onClick={() => {
              void openFile(bp.file);
              requestReveal(bp.file, bp.line);
            }}
          >
            <span className="w-2 h-2 rounded-full bg-[color:var(--ide-error)] shrink-0" />
            <span className="text-[color:var(--ide-text-dim)] font-mono truncate flex-1">
              {bp.file}:{bp.line}
            </span>
            <button
              className="opacity-0 group-hover:opacity-100 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-error)]"
              onClick={(e) => {
                e.stopPropagation();
                toggleBreakpoint(bp.file, bp.line);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}

        {/* 当前停止位置 */}
        {debugStopped && (
          <>
            <div className="px-3 py-2 border-t border-[color:var(--ide-border)] mt-2">
              <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase">{t("watch.currentPos")}</span>
            </div>
            <div className="px-3 py-1 text-[12px] text-[color:var(--ide-warning)] font-mono">
              {debugStopped.func || "?"}
              <span className="text-[color:var(--ide-text-muted)]"> @ </span>
              {debugStopped.file.split("/").pop()}:{debugStopped.line}
            </div>
            <div className="px-3 text-[11px] text-[color:var(--ide-text-muted)]">{debugStopped.reason}</div>
          </>
        )}
      </div>
    </div>
  );
}
