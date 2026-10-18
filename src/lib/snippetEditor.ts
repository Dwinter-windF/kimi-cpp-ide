/**
 * 代码片段的「编辑器接线层」：状态、装饰、键位、补全选项。
 * 片段数据与纯文本展开在 src/lib/snippets.ts（加片段只改那张表）。
 *
 * 一次展开的完整过程（单事务）：
 *   ① 用当前行缩进渲染模板（renderSnippet）；
 *   ② 删除已输入的前缀、插入模板文本；
 *   ③ 光标选中第一个占位点（$1），同时把「剩余跳转点 + 末尾落点」存进 StateField；
 *   ④ 之后按 Tab 依次跳到 $2、$3…，最后一个占位点之后按 Tab 落到插入内容末尾并结束；
 *      Esc 随时取消跳转序列（只清状态，不动文档）。
 *
 * 优先级（从高到低）：AI 幽灵文本 > 补全下拉 > 片段展开 > 缩进。
 *  · 幽灵 Tab 在 aiInline.ghostKeymap（Prec.highest）；
 *  · 补全下拉 Tab 在 EditorPane 里排在 tryExpandSnippet 之前；
 *  · 占位序列激活时，本文件的 snippetKeymap（Prec.highest）先消费 Tab，保证「再按 Tab 跳下一个」；
 *  · 都不匹配时返回 false，最终落回 indentWithTab。
 */
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";
import { pickedCompletion, type Completion } from "@codemirror/autocomplete";
import { CPP_SNIPPETS, findSnippet, renderSnippet, type CppSnippet } from "@/lib/snippets";
import { t } from "@/lib/i18n";

interface SnippetStop {
  from: number;
  to: number;
}

interface SnippetSession {
  /** 所有跳转点，最后一项固定为「插入内容末尾」的落点 */
  stops: SnippetStop[];
  /** 当前停在 stops 的哪个下标 */
  index: number;
}

const setSnippetSession = StateEffect.define<SnippetSession | null>();

/** 空占位点的可视标记（2px 主题色竖线），让用户看得见「这里还要填内容」 */
class SnippetFieldWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-snippet-empty";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const fieldWidget = new SnippetFieldWidget();

/** 只装饰当前占位点：有文本 → 主题色描边；空占位 → 主题色细竖线 */
function decorationsFor(session: SnippetSession | null): DecorationSet {
  if (!session) return Decoration.none;
  const stop = session.stops[session.index];
  if (!stop) return Decoration.none;
  if (stop.to > stop.from) {
    return Decoration.set([Decoration.mark({ class: "cm-snippet-placeholder" }).range(stop.from, stop.to)]);
  }
  return Decoration.set([Decoration.widget({ widget: fieldWidget, side: 1 }).range(stop.from)]);
}

const snippetSessionField = StateField.define<SnippetSession | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSnippetSession)) return e.value;
    }
    if (!value) return null;
    if (!tr.docChanged) return value;
    // 用户可能在占位点里打字：位置映射后仍然可继续 Tab 跳转
    const stops = value.stops.map((s) => ({
      from: tr.changes.mapPos(s.from, -1),
      to: tr.changes.mapPos(s.to, 1),
    }));
    return { stops, index: Math.min(value.index, stops.length - 1) };
  },
  provide: (f) => EditorView.decorations.from(f, decorationsFor),
});

/** 主题色描边 / 空占位竖线 / 补全下拉里的立方块图标（与普通单词补全区分） */
const snippetTheme = EditorView.theme({
  ".cm-snippet-placeholder": {
    outline: "1px solid var(--ide-accent)",
    outlineOffset: "-1px",
    borderRadius: "2px",
    backgroundColor: "var(--ide-selected)",
  },
  ".cm-snippet-empty": {
    display: "inline-block",
    width: "2px",
    height: "1.15em",
    verticalAlign: "text-bottom",
    backgroundColor: "var(--ide-accent)",
  },
  ".cm-completionIcon-snippet::after": {
    content: '"■"',
    color: "var(--ide-accent)",
  },
});

/** 选中某个跳转点（空占位就是落点，不产生选区） */
function selectionFor(stop: SnippetStop) {
  return stop.to > stop.from ? { anchor: stop.from, head: stop.to } : { anchor: stop.from };
}

/**
 * 展开片段：删除 [from, to) 的已输入前缀，插入渲染后的模板，并选中第一个占位点。
 * picked 传入时给事务补 pickedCompletion 注解（从补全下拉选中时用，语义与内置 snippet 一致）。
 */
export function expandSnippet(
  view: EditorView,
  snippet: CppSnippet,
  from: number,
  to: number,
  picked?: Completion
): boolean {
  const state = view.state;
  if (from < 0 || to < from || to > state.doc.length) return false;
  const line = state.doc.lineAt(from);
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
  const unit = " ".repeat(Math.max(1, getIndentUnit(state)));
  const rendered = renderSnippet(snippet, indent, unit);
  const end = from + rendered.text.length;
  const stops: SnippetStop[] = rendered.placeholders.map((p) => ({ from: from + p.from, to: from + p.to }));
  const first = stops[0];
  // 末尾落点：最后一个占位点跳完后，光标回到插入内容的行尾
  const session: SnippetSession | null =
    stops.length > 0 ? { stops: [...stops, { from: end, to: end }], index: 0 } : null;

  view.dispatch({
    changes: { from, to, insert: rendered.text },
    selection: first ? selectionFor(first) : { anchor: end },
    scrollIntoView: true,
    userEvent: "input.complete",
    effects: setSnippetSession.of(session),
    ...(picked ? { annotations: pickedCompletion.of(picked) } : {}),
  });
  return true;
}

/**
 * 普通 Tab 的片段展开入口（补全下拉没有消费 Tab 时才会走到这里）：
 * 只认「光标前是一个完整标识符、且正好等于某个片段前缀」。
 */
export function tryExpandSnippet(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  const line = view.state.doc.lineAt(pos);
  const before = view.state.sliceDoc(line.from, pos);
  const m = /([A-Za-z_]\w*)$/.exec(before);
  if (!m) return false;
  const snippet = findSnippet(m[1]);
  if (!snippet) return false;
  return expandSnippet(view, snippet, pos - m[1].length, pos);
}

/** 占位序列激活时：Tab 跳下一个（最后一个跳完回到插入内容末尾并结束序列） */
function nextSnippetField(view: EditorView): boolean {
  const session = view.state.field(snippetSessionField, false);
  if (!session) return false;
  const next = session.index + 1;
  if (next >= session.stops.length) {
    const current = session.stops[session.index];
    view.dispatch({
      selection: { anchor: current ? current.to : view.state.selection.main.head },
      effects: setSnippetSession.of(null),
      scrollIntoView: true,
    });
    return true;
  }
  const stop = session.stops[next];
  const atEnd = next === session.stops.length - 1;
  view.dispatch({
    selection: selectionFor(stop),
    effects: setSnippetSession.of(atEnd ? null : { stops: session.stops, index: next }),
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  return true;
}

/** Esc：取消占位跳转序列（文档内容保持已展开的片段，不再拦截后续 Tab） */
function cancelSnippet(view: EditorView): boolean {
  const session = view.state.field(snippetSessionField, false);
  if (!session) return false;
  view.dispatch({ effects: setSnippetSession.of(null) });
  return true;
}

/**
 * 占位序列的键位（Prec.highest）：只在状态存在时消费 Tab / Esc，
 * 其余情况返回 false，完全不影响默认键位。
 */
export const snippetKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: nextSnippetField },
    { key: "Escape", run: cancelSnippet },
  ])
);

/** 片段需要的全部 CM6 扩展（状态 + 装饰 + 主题） */
export const snippetExtensions = [snippetSessionField, snippetTheme];

/**
 * 供 cppCompletions 使用的片段补全项：
 * 图标类型为 "snippet"（主题里画成 ■），描述走 i18n，选中后走与 Tab 相同的展开逻辑。
 */
export function snippetCompletionOptions(): Completion[] {
  return CPP_SNIPPETS.map((snippet) => ({
    label: snippet.prefix,
    detail: t(snippet.descriptionKey),
    type: "snippet",
    boost: 2,
    apply: (view, completion, from, to) => {
      expandSnippet(view, snippet, from, to, completion);
    },
  }));
}
