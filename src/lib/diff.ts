/**
 * 极简行级 diff（零依赖：不引 diff 库，硬约束要求自己实现）。
 *
 * 算法：先剥掉首尾公共行，再对中间块做 LCS（动态规划 + 方向表回溯）。
 * 超过 MAX_DIFF_CELLS 的超大块直接退化成「整块删除 + 整块新增」（结果仍然正确，只是不够精细），
 * 保证任何输入都是 O(可控) 而不是卡死界面。
 *
 * 用途：AI 一键修复的结果预览（src/components/AiFixDialog.tsx）——把 AI 返回的完整文件
 * 与当前文件逐行对比，生成可读的 +/− 视图。
 */

export type DiffKind = "equal" | "add" | "del";

export interface DiffRow {
  kind: DiffKind;
  /** 旧文件行号（新增行为 null） */
  oldNo: number | null;
  /** 新文件行号（删除行为 null） */
  newNo: number | null;
  text: string;
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** 是否因为块太大而退化成整块替换 */
  coarse: boolean;
}

/** LCS 动态规划表的最大格子数：4M 格 ≈ 4MB Uint32Array，超过则退化为整块替换 */
const MAX_DIFF_CELLS = 4_000_000;

/** 按行切分；统一 CRLF→LF，空文本视为 0 行，并忽略「文件末尾换行」带来的那个空行（仅用于展示） */
export function splitLines(text: string): string[] {
  const norm = text.replace(/\r\n?/g, "\n");
  if (norm === "") return [];
  const lines = norm.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsRows(a: string[], b: string[]): { rows: Omit<DiffRow, "oldNo" | "newNo">[]; coarse: boolean } {
  const n = a.length;
  const m = b.length;
  const cells = (n + 1) * (m + 1);
  if (cells > MAX_DIFF_CELLS) {
    // 退化：整块删除 + 整块新增
    const rows: Omit<DiffRow, "oldNo" | "newNo">[] = [];
    for (const t of a) rows.push({ kind: "del", text: t });
    for (const t of b) rows.push({ kind: "add", text: t });
    return { rows, coarse: true };
  }
  const w = m + 1;
  const dp = new Uint32Array(cells);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const rows: Omit<DiffRow, "oldNo" | "newNo">[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      rows.push({ kind: "del", text: a[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++] });
  while (j < m) rows.push({ kind: "add", text: b[j++] });
  return { rows, coarse: false };
}

/** 生成 oldText → newText 的行级差异 */
export function diffLines(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 剥掉首尾公共行：绝大多数修复只改动中间几行，能显著缩小 LCS 规模
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const mid = lcsRows(midA, midB);

  const raw: Omit<DiffRow, "oldNo" | "newNo">[] = [
    ...a.slice(0, prefix).map((t) => ({ kind: "equal" as const, text: t })),
    ...mid.rows,
    ...(suffix > 0 ? a.slice(a.length - suffix).map((t) => ({ kind: "equal" as const, text: t })) : []),
  ];

  // 统一编号：oldNo/newNo 分别按 equal+del / equal+add 递增
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  for (const r of raw) {
    const o = r.kind === "add" ? null : ++oldNo;
    const nn = r.kind === "del" ? null : ++newNo;
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
    rows.push({ kind: r.kind, oldNo: o, newNo: nn, text: r.text });
  }
  return { rows, added, removed, coarse: mid.coarse };
}

/** 折叠后的展示项：普通行，或「省略了 N 行未变化内容」 */
export type DiffItem = DiffRow | { kind: "skip"; count: number };

/**
 * 只保留改动附近 context 行的上下文，其余相同行折叠成一条「⋯ 省略 N 行」，
 * 避免大文件把整个 diff 面板塞满（也减少 DOM 节点数）。
 */
export function collapseEqual(rows: DiffRow[], context = 3): DiffItem[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "equal") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  }
  const out: DiffItem[] = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ kind: "skip", count: skipped });
        skipped = 0;
      }
      out.push(rows[i]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}
