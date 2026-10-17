/**
 * 当前文件大纲：轻量正则+状态机提取函数/类/命名空间定义。
 * 先剥离注释与字符串（保留长度与换行），再逐行累计签名、在 '{' 处判定。
 */

export interface OutlineItem {
  name: string;
  line: number;
  kind: "function" | "class" | "struct" | "namespace" | "enum";
  depth: number;
}

const CTRL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "new",
  "delete", "sizeof", "case", "static_cast", "reinterpret_cast", "const_cast",
  "dynamic_cast", "alignof", "decltype", "using", "throw",
]);

/** 把注释与字符串内容替换为空格（保留换行与字符位置） */
export function stripCommentsAndStrings(source: string): string {
  const chars = source.split("");
  const n = chars.length;
  let inStr: string | null = null;
  let inBlock = false;
  for (let i = 0; i < n; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (inBlock) {
      if (ch === "*" && next === "/") {
        chars[i] = " ";
        chars[i + 1] = " ";
        inBlock = false;
        i++;
      } else if (ch !== "\n") chars[i] = " ";
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        chars[i] = " ";
        if (chars[i + 1] !== "\n") chars[i + 1] = " ";
        i++;
      } else if (ch === inStr) {
        chars[i] = " ";
        inStr = null;
      } else if (ch !== "\n") chars[i] = " ";
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && chars[i] !== "\n") {
        chars[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      chars[i] = " ";
      inStr = ch;
      continue;
    }
  }
  return chars.join("");
}

const GROUP_RE = /^\s*(class|struct|namespace|enum(?:\s+class|\s+struct)?)\s+([A-Za-z_]\w*)/;
const FUNC_RE = /([A-Za-z_~][\w:~]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:->\s*[^{}]*)?$/;

export function parseOutline(source: string): OutlineItem[] {
  const cleaned = stripCommentsAndStrings(source);
  const lines = cleaned.split("\n");
  const items: OutlineItem[] = [];
  let depth = 0;
  let buf = "";
  let bufLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const group = line.match(GROUP_RE);
    if (group && !/[=;]/.test(line.slice(0, (line.match(/\{/)?.index ?? line.length)))) {
      const kind = group[1].startsWith("enum") ? "enum" : (group[1].trim() as "class" | "struct" | "namespace");
      items.push({ name: group[2], line: lineNo, kind, depth });
    }

    if (!buf && line.trim()) bufLine = lineNo;
    buf = (buf + " " + line.trim()).trim();

    const hasBrace = line.includes("{");
    const semiIdx = line.indexOf(";");
    const closeIdx = line.indexOf("}");

    if (hasBrace) {
      // 只取首个 '{' 之前的部分作为待判定签名
      const sig = buf.slice(0, buf.indexOf("{"));
      const m = sig.match(FUNC_RE);
      if (m) {
        const name = m[1];
        const before = sig.slice(0, sig.length - m[0].length).trim();
        const prevToken = (before.match(/([A-Za-z_]\w*)\s*$/)?.[1] || "");
        const isFuncName = !CTRL_KEYWORDS.has(name) && (prevToken === "" || !CTRL_KEYWORDS.has(prevToken));
        if (isFuncName && !/[=,]\s*$/.test(before)) {
          items.push({ name, line: bufLine || lineNo, kind: "function", depth });
        }
      }
      buf = "";
    } else if (semiIdx >= 0 || closeIdx >= 0) {
      buf = "";
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return items;
}
