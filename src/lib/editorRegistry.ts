import type { EditorView } from "@codemirror/view";

/**
 * 当前活动编辑器注册表：工具栏等组件需要拿到 EditorView 实例
 * （如打开查找替换面板），而 EditorPane 按文件 key 重挂载，故用模块级引用。
 */
let current: EditorView | null = null;

export function setActiveEditor(view: EditorView | null) {
  current = view;
}

export function getActiveEditor(): EditorView | null {
  return current;
}
