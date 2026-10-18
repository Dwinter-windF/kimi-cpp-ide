import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";
import {
  IMPORT_EXT_LABEL,
  collectDropEntries,
  summaryLines,
  type ImportSummary,
} from "@/lib/dropImport";

/** 导入结果提示条的自动消失时间（ms） */
const RESULT_TTL = 8000;

/**
 * 事件目标判断：拖到这些元素上方时不响应导入（需求⑤「不在对话框/输入框上方误触发」）。
 *  - 对话框 / 弹层：Radix 的 portal 其实挂在 document.body 上，本区域本就收不到事件，
 *    这里再判一次是为了防止以后有人把 dialog 放进布局树，或拖到内联 popover 上；
 *  - input / textarea / select：让元素自己处理（例如往 AI 输入框里拖文本），不弹导入提示；
 *  - 其它 contenteditable 富文本区域：同上；
 *  - 例外：CodeMirror 的 .cm-content 也是 contenteditable，而「编辑器空白区拖入文件」正是
 *    本功能要覆盖的场景，所以 .cm-editor 内部的 contenteditable 不算输入框。
 */
function isGuardedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.closest(
      '[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]'
    )
  ) {
    return true;
  }
  if (target.closest("input, textarea, select")) return true;
  const editable = target.closest<HTMLElement>('[contenteditable="true"]');
  if (editable && !editable.closest(".cm-editor")) return true;
  return false;
}

/** 拖的是文件而不是选中的文本 */
function hasFiles(e: DragEvent<HTMLDivElement>): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

/** 结果行配色：✓ 绿、✗ 红、其余弱化 */
function lineClass(line: string): string {
  if (line.startsWith("✓")) return "text-[color:var(--ide-success)]";
  if (line.startsWith("✗")) return "text-[color:var(--ide-error)]";
  return "text-[color:var(--ide-text-dim)]";
}

/**
 * 拖拽导入区：包住「文件树 + 编辑器 + 右侧面板」整块主工作区（不含工具栏与底部面板）。
 * 为什么不覆盖整个窗口：底部面板是终端 / AI 对话输入区，往输入框拖东西不该触发导入，
 * 这里从布局上就隔开，事件目标判断（isGuardedTarget）再兜一层。
 * dragover 时显示 kimi-drop-* 虚线高亮框（配色全部取自 --ide-* 变量），松手后显示结果提示条。
 */
export function FileDropZone({ children }: { children: ReactNode }) {
  const t = useT();
  const importDroppedFiles = useIde((s) => s.importDroppedFiles);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  // dragenter/dragleave 会在子元素之间反复触发：用计数器判定「真的离开了本区域」
  const depth = useRef(0);
  const hideTimer = useRef<number | null>(null);

  // 拖到窗口任何位置都阻止浏览器默认行为（默认是导航到 file:// 把当前页面顶掉）；
  // 真正执行导入的只有下面主区域自己的 onDrop。
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    },
    []
  );

  const reset = () => {
    depth.current = 0;
    setDragActive(false);
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (isGuardedTarget(e.target)) return;
    depth.current += 1;
    setDragActive(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 不 preventDefault 就不会触发 drop
    if (isGuardedTarget(e.target)) return;
    e.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };

  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    reset();
    if (isGuardedTarget(e.target)) return;
    // 必须在同步阶段解析 DataTransfer（webkitGetAsEntry 在事件回调结束后失效）
    const entries = collectDropEntries(e.dataTransfer);
    if (entries.length === 0) return;
    void (async () => {
      setBusy(true);
      try {
        const s = await importDroppedFiles(entries);
        setSummary(s);
        if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setSummary(null), RESULT_TTL);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div
      className="relative flex-1 flex min-h-0"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}

      {dragActive && (
        /* 覆盖层 pointer-events-none：dragover/drop 仍由底层容器接收，否则覆盖层一出现就把
           dragleave 引到自己身上，造成高亮框闪烁 */
        <div className="kimi-drop-overlay absolute inset-0 z-40 flex items-center justify-center">
          <div className="kimi-drop-card flex flex-col items-center gap-1.5 rounded-xl px-9 py-7">
            <FileUp size={30} className="text-[color:var(--ide-accent)]" />
            <div className="text-[13.5px] text-[color:var(--ide-text)]">{t("fileDrop.release")}</div>
            <div className="text-[12px] text-[color:var(--ide-text-muted)] max-w-[330px] text-center leading-5">
              {t("fileDrop.support", { exts: IMPORT_EXT_LABEL })}
              <br />
              {t("fileDrop.note")}
            </div>
          </div>
        </div>
      )}

      {(summary || busy) && (
        <div className="absolute top-3 left-0 right-0 z-40 flex justify-center pointer-events-none">
          <div className="kimi-drop-result rounded-md px-3 py-2 max-w-[560px]">
            {busy ? (
              <div className="text-[12.5px] text-[color:var(--ide-text-dim)]">{t("fileDrop.importing")}</div>
            ) : (
              summary &&
              summaryLines(summary).map((line, i) => (
                <div key={i} className={`text-[12.5px] leading-5 ${lineClass(line)}`}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
