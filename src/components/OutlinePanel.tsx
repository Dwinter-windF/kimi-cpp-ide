import { useMemo } from "react";
import { ListTree, ChevronRight } from "lucide-react";
import { useIde } from "@/store";
import { parseOutline } from "@/lib/outline";
import type { OutlineItem } from "@/lib/outline";

const KIND_STYLE: Record<OutlineItem["kind"], { icon: string; color: string }> = {
  function: { icon: "ƒ", color: "text-[color:var(--ide-accent)]" },
  class: { icon: "◆", color: "text-[color:var(--ide-cyan)]" },
  struct: { icon: "◇", color: "text-[color:var(--ide-cyan)]" },
  namespace: { icon: "▣", color: "text-[color:var(--ide-warning)]" },
  enum: { icon: "ℯ", color: "text-[color:var(--ide-success)]" },
};

export function OutlinePanel() {
  const activeFile = useIde((s) => s.activeFile);
  const content = useIde((s) => (s.activeFile ? (s.contents[s.activeFile] ?? "") : ""));
  const requestReveal = useIde((s) => s.requestReveal);

  const items = useMemo(() => parseOutline(content), [content]);

  return (
    <div className="border-b border-[color:var(--ide-border)] flex flex-col shrink-0 max-h-56">
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase flex items-center gap-1">
          <ListTree size={12} /> 大纲
          {activeFile && <span className="normal-case tracking-normal font-normal">· {activeFile.split("/").pop()}</span>}
        </span>
        <span className="text-[11px] text-[color:var(--ide-text-faint)]">{items.length > 0 ? `${items.length} 项` : ""}</span>
      </div>
      <div className="overflow-y-auto min-h-0 pb-1">
        {items.length === 0 ? (
          <div className="text-[11.5px] text-[color:var(--ide-text-faint)] px-3 pb-2">当前文件暂无函数 / 类 / 命名空间定义。</div>
        ) : (
          items.map((it, i) => {
            const st = KIND_STYLE[it.kind];
            return (
              <button
                key={i}
                onClick={() => activeFile && requestReveal(activeFile, it.line)}
                title={`跳转到第 ${it.line} 行`}
                className="w-full flex items-center gap-1.5 px-3 py-[3px] text-[12px] hover:bg-[color:var(--ide-hover)] text-left"
                style={{ paddingLeft: `${12 + Math.min(it.depth, 4) * 12}px` }}
              >
                <ChevronRight size={11} className="shrink-0 text-[color:var(--ide-text-faint)]" />
                <span className={`${st.color} font-mono shrink-0 w-3 text-center`}>{st.icon}</span>
                <span className="font-mono text-[color:var(--ide-text)] truncate">{it.name}</span>
                <span className="ml-auto text-[10.5px] text-[color:var(--ide-text-faint)] shrink-0">:{it.line}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
