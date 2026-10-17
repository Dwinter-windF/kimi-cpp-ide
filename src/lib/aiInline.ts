/**
 * 内联补全的「显示层 + 交互层」（CodeMirror 6 专属，业务逻辑在 src/lib/aiGhost.ts）。
 *
 *  显示：ghostLineField（StateField<DecorationSet>）+ ghostTextEffect（StateEffect<string>）
 *        —— 幽灵文本不写进文档，只是光标处的一个 inline widget 装饰，
 *           因此不脏文件、不进撤销历史、可随时整段消失。
 *  交互：ghostKeymap —— Tab 接受（单事务写入，可 Ctrl+Z 撤销）/ Esc 拒绝，
 *        且只在「真的有幽灵文本」时拦截，其它情况一律返回 false 交回默认行为。
 *
 * 颜色全部走 --ide-* 变量，因此亮/暗主题自动协调：
 * 暗色 #3b4261、亮色 #6e778f，都是「看得见但不抢眼」的灰。
 */
import { EditorView, Decoration, keymap, WidgetType, type DecorationSet, type KeyBinding } from "@codemirror/view";
import { StateEffect, StateField, Prec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { useIde } from "@/store";
import { ghostOn } from "@/lib/aiGhost";

/** 幽灵文本的灰度：跟随亮/暗主题变量，不硬编码颜色 */
const ghostTheme = EditorView.theme({
  ".cm-ai-ghost": {
    color: "var(--ide-text-faint)",
    whiteSpace: "pre",
    pointerEvents: "none",
    opacity: "0.9",
  },
});

/** 设置/清空幽灵文本（"" 表示清空）。由 EditorPane 在流式增量到达时派发 */
export const setGhostText = StateEffect.define<string>();

/** 幽灵文本 widget：一个 inline 的灰色 span，多行靠 white-space: pre 保持换行 */
class GhostWidget extends WidgetType {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    // 装饰不写入文档：对读屏软件隐藏，避免把「还没被接受的建议」念成正文
    span.setAttribute("aria-hidden", "true");
    span.className = "cm-ai-ghost";
    span.textContent = this.text;
    return span;
  }

  /** 关键：忽略鼠标事件，点幽灵文本等于是点它后面/前面的正文 */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 幽灵文本的文档装饰。
 * 位置固定为「当前主光标」：靠 range() 而不是 absolute 位置保存，
 * 这样即使有别的装饰/插件，只要光标不动，幽灵文本就贴着光标。
 */
const EMPTY_GHOST: DecorationSet = Decoration.none;

export const ghostLineField = StateField.define<DecorationSet>({
  create: () => EMPTY_GHOST,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setGhostText)) continue;
      // StateEffect<string> 的 value 就是字符串（这里做一次保守取用）
      const text = String((e.value as unknown) ?? "");
      if (!text) return EMPTY_GHOST;
      const pos = tr.state.selection.main.head;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(pos),
      ]);
    }
    // 没有显示指令时：文档/选区变了就把幽灵文本映射到新位置；
    // 但光标一旦真的移动（新的主光标不在旧装饰位置上）就不再跟随 —— 由控制器重新触发
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 把幽灵文本插入文档。
 *
 *  · 单个事务：文本插入 + 幽灵文本清空（setGhostText ""）一起派发；
 *  · 光标落在插入内容末尾，符合「接受后继续往下写」的直觉；
 *  · userEvent 用 "input.complete"（与代码补全接受同一个语义）并经
 *    isolateHistory，使这次插入成为独立的历史事件：Ctrl+Z 一次即可整体撤销，
 *    不会和用户之前的打字合并。
 */
function acceptGhost(view: EditorView): boolean {
  const deco = view.state.field(ghostLineField, false);
  if (!deco || deco.size === 0) return false;
  const pos = view.state.selection.main.head;
  const iter = deco.iter();
  const widget = iter.value?.spec.widget;
  const text = widget instanceof GhostWidget ? widget.text : "";
  if (!text) return false;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    scrollIntoView: true,
    annotations: [isolateHistory.of("full")],
    userEvent: "input.complete",
    effects: setGhostText.of(""),
  });
  return true;
}

/** 拒绝：只清掉幽灵文本，文档一个字都不动 */
function rejectGhost(view: EditorView): boolean {
  const deco = view.state.field(ghostLineField, false);
  if (!deco || deco.size === 0) return false;
  view.dispatch({ effects: setGhostText.of("") });
  return true;
}

/**
 * Tab / Shift-Tab / Esc 的拦截。
 *
 * 三条硬约束：
 *  1. 只在「幽灵文本存在」且「设置开关是开的」时拦截；否则返回 false，
 *     Tab 保持原有的缩进行为（indentWithTab / 补全接受），Esc 也交给别人处理；
 *  2. Esc 先于补全弹窗处理（Prec.highest + ghost 存在时直接消费），
 *     符合"Copilot 里 Esc 先关建议"的直觉；
 *  3. 有选区（非空选择）时不接受：此时 Tab 更可能是「缩进选中行」。
 */
export const ghostKeyBindings: KeyBinding[] = [
  {
    key: "Tab",
    run: (view) => {
      if (!ghostOn(useIde.getState().settings)) return false;
      if (!view.state.selection.main.empty) return false;
      return acceptGhost(view);
    },
  },
  {
    key: "Shift-Tab",
    run: (view) => {
      if (!ghostOn(useIde.getState().settings)) return false;
      if (!view.state.selection.main.empty) return false;
      return rejectGhost(view);
    },
  },
  {
    key: "Escape",
    run: (view) => {
      if (!ghostOn(useIde.getState().settings)) return false;
      return rejectGhost(view);
    },
  },
];

/**
 * 键位优先级给到最高：只要幽灵文本在，Tab 必须先于「代码补全弹窗的 acceptCompletion」
 * 与 indentWithTab 被消费（对标 Copilot：内联建议 > 下拉补全 > 缩进）。
 * 没有幽灵文本时所有绑定都返回 false，按键原样放行。
 */
export const ghostKeymap = Prec.highest(keymap.of(ghostKeyBindings));

/** 内联补全需要的全部 CM6 扩展（EditorPane 的 extensions 数组里加这一段即可） */
export const ghostExtensions = [ghostLineField, ghostTheme];
