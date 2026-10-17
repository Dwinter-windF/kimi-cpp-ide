import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

/**
 * 可复用的拖拽分隔条（基于 Pointer Events，不使用 mouse 事件）。
 *
 * - vertical：竖直分隔条（6px 宽），拖动改变左右两侧宽度，光标 col-resize；
 * - horizontal：水平分隔条（6px 高），拖动改变上下两侧高度，光标 row-resize。
 *
 * 组件本身只负责「指针位移 → 新尺寸」的换算与夹取，尺寸状态由调用方持有（受控），
 * 因此可以自由接到 zustand / useState 上；拖动中按帧回调 onChange，
 * 落盘等副作用统一放在 onCommit（pointerup）里，避免高频 IO 拖慢拖动。
 */
export type SplitterOrientation = "vertical" | "horizontal";

export interface SplitterProps {
  orientation: SplitterOrientation;
  /** 当前尺寸（px，受控）。 */
  value: number;
  /** 尺寸变化回调：拖动中实时触发（已取整并按 min/max 夹取）。 */
  onChange: (value: number) => void;
  /** 拖动结束（pointerup / pointercancel）或键盘微调后的回调：用于把最终尺寸落盘 localStorage。 */
  onCommit?: () => void;
  /** 尺寸下限（px），默认 0。 */
  min?: number;
  /** 尺寸上限（px），默认不限。 */
  max?: number;
  /**
   * 目标面板位于分隔条的右侧 / 下方时置 true：
   * 指针往右（往下）移动意味着目标面板变小，位移取反。
   */
  invert?: boolean;
  /** 方向键微调步长（px），默认 8。 */
  step?: number;
  /** 外部样式/可见性（例如响应式隐藏：hidden lg:block）。 */
  className?: string;
  /** 悬停提示。 */
  title?: string;
  /** 无障碍名称。 */
  label?: string;
}

export function Splitter({
  orientation,
  value,
  onChange,
  onCommit,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  invert = false,
  step = 8,
  className = "",
  title,
  label,
}: SplitterProps) {
  const vertical = orientation === "vertical";
  const [dragging, setDragging] = useState(false);
  // 一次拖动会话：记录指针起点与「拖动开始时的尺寸」。
  // 用起点值 + 总位移计算，而不是累加每帧增量，避免夹取到边界后产生累计误差。
  const sessionRef = useRef<{ startPos: number; startValue: number } | null>(null);

  // 拖动中：整页统一光标 + 禁止选中，避免指针扫过面板时选中文字 / 出现 I 型光标。
  useEffect(() => {
    if (!dragging) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging, vertical]);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, Math.round(v))),
    [min, max]
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // 只响应鼠标左键
    e.preventDefault();
    // 指针捕获：拖出分隔条（甚至拖出窗口）后仍能收到 move/up，松手不会“卡住”
    e.currentTarget.setPointerCapture(e.pointerId);
    sessionRef.current = { startPos: vertical ? e.clientX : e.clientY, startValue: value };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sessionRef.current;
    if (!s) return;
    const delta = (vertical ? e.clientX : e.clientY) - s.startPos;
    onChange(clamp(invert ? s.startValue - delta : s.startValue + delta));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!sessionRef.current) return;
    sessionRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
    onCommit?.();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const dec = vertical ? "ArrowLeft" : "ArrowUp";
    const inc = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const dir = e.key === inc ? 1 : -1;
    onChange(clamp(value + (invert ? -dir : dir) * step));
    onCommit?.();
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label ?? (vertical ? "拖动调节左右宽度" : "拖动调节上下高度")}
      tabIndex={0}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={`shrink-0 relative select-none touch-none outline-none transition-colors ${
        vertical ? "w-1.5 cursor-col-resize" : "h-1.5 w-full cursor-row-resize"
      } ${
        dragging
          ? "bg-[color:var(--ide-accent)]"
          : "bg-transparent hover:bg-[color:var(--ide-accent-strong)] focus-visible:bg-[color:var(--ide-accent-strong)]"
      } ${className}`}
    />
  );
}
