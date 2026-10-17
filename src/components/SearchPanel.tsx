import { useEffect, useRef, useState } from "react";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { ChevronDown, ChevronUp, X } from "lucide-react";

/** 自定义查找替换面板：中文 + --ide-* 主题
 *  （CM 默认面板是英文按钮、硬编码色、位于底部，且层级会盖过设置对话框） */
export function SearchPanel({ view }: { view: EditorView }) {
  const [q, setQ] = useState(() => {
    const cur = getSearchQuery(view.state);
    return {
      search: cur.search,
      replace: cur.replace,
      caseSensitive: cur.caseSensitive,
      regexp: cur.regexp,
      wholeWord: cur.wholeWord,
    };
  });
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = searchRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = (patch: Partial<typeof q>) => {
    const next = { ...q, ...patch };
    setQ(next);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(next)) });
  };

  const inputCls =
    "flex-1 min-w-[140px] bg-[color:var(--ide-bg-base)] border border-[color:var(--ide-border-strong)] rounded px-2 py-[3px] text-[12px] font-mono text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)]";
  const btnCls =
    "px-1.5 py-[3px] rounded text-[12px] border border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)] hover:border-[color:var(--ide-accent)]";
  const optCls = (on: boolean) =>
    `px-1.5 py-[3px] rounded text-[11px] font-mono border ${
      on
        ? "border-[color:var(--ide-accent)] bg-[color:var(--ide-selected)] text-[color:var(--ide-text)]"
        : "border-[color:var(--ide-border-strong)] text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)] hover:border-[color:var(--ide-accent)]"
    }`;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-bg-panel)] text-[color:var(--ide-text)]">
      <div className="flex items-center gap-1.5">
        <input
          ref={searchRef}
          value={q.search}
          onChange={(e) => commit({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) findPrevious(view);
              else findNext(view);
            }
          }}
          placeholder="查找"
          className={inputCls}
        />
        <button className={btnCls} title="上一个 (Shift+Enter)" onClick={() => findPrevious(view)}>
          <ChevronUp size={13} />
        </button>
        <button className={btnCls} title="下一个 (Enter)" onClick={() => findNext(view)}>
          <ChevronDown size={13} />
        </button>
        <button className={btnCls} title="选中全部匹配" onClick={() => selectMatches(view)}>
          全选
        </button>
        <button
          className={optCls(q.caseSensitive)}
          title="区分大小写"
          onClick={() => commit({ caseSensitive: !q.caseSensitive })}
        >
          Aa
        </button>
        <button
          className={optCls(q.regexp)}
          title="正则表达式"
          onClick={() => commit({ regexp: !q.regexp })}
        >
          .*
        </button>
        <button
          className={optCls(q.wholeWord)}
          title="全词匹配"
          onClick={() => commit({ wholeWord: !q.wholeWord })}
        >
          ⌷
        </button>
        <div className="flex-1" />
        <button className={btnCls} title="关闭 (Esc)" onClick={() => closeSearchPanel(view)}>
          <X size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={q.replace}
          onChange={(e) => commit({ replace: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              replaceNext(view);
            }
          }}
          placeholder="替换"
          className={inputCls}
        />
        <button className={btnCls} onClick={() => replaceNext(view)}>
          替换
        </button>
        <button className={btnCls} onClick={() => replaceAll(view)}>
          全部替换
        </button>
      </div>
    </div>
  );
}
