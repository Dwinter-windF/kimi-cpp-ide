/**
 * 「AI 一键修复」的编排层：收集编译错误 + 相关源文件 → 请求 AI → 解析返回 → 落进 store 供弹层预览。
 *
 * ── 返回值协议（为什么选「完整文件」而不是 unified diff）────────────────────────
 * 需求允许「返回修正后的完整文件」或「unified diff」二选一，这里**选择完整文件**：
 *   1. 解析不依赖 diff 行号/上下文，模型少写一个 hunk 头也不会把补丁打歪（更抗幻觉）；
 *   2. 完整文件可以直接落到 /api/file，写回路径与既有保存流程 100% 一致；
 *   3. 预览用的 diff 由本地 src/lib/diff.ts 现算（零依赖行级对比），不依赖模型输出格式。
 * 代价是 token 更多，因此下面用「文件个数 + 单文件字节数」硬上限控制上下文规模。
 *
 * ── 上下文上限（token 量控制）──────────────────────────────────────────────
 *   · 编译器原始输出：最多 AI_FIX_ERROR_BYTES(8KB)，超出按「头 70% + 尾 30%」截断；
 *   · 结构化错误列表：最多 AI_FIX_MAX_ERRORS(40) 条，其余折叠成一行说明；
 *   · 源文件：最多 AI_FIX_MAX_FILES(3) 个（报错文件优先，其次当前文件），
 *     单文件超过 AI_FIX_FILE_BYTES(24KB) 一律**整份跳过**（绝不发半截文件，
 *     否则模型返回的「完整文件」会缺内容，写回即毁代码）；跳过的文件在 note 里说明；
 *   · 合计上限约 80KB，约 2 万 token，主流 32K 上下文模型可用。
 */
import { api } from "@/lib/api";
import { AI_FIX_TIMEOUT_MS, aiConfigHint, isAiConfigured, requestChat, clipBytes, type ChatMessage } from "@/lib/ai";
import { useIde } from "@/store";
import { t } from "@/lib/i18n";
import type { AiFixFile, AiFixState, Diagnostic } from "@/types";

/** 一次最多发给 AI 的源文件个数 */
export const AI_FIX_MAX_FILES = 3;
/** 单个源文件的大小上限（字节）：超过则整份跳过，不发送半截内容 */
export const AI_FIX_FILE_BYTES = 24 * 1024;
/** 编译器原始输出（原始报错文本）上限（字节） */
export const AI_FIX_ERROR_BYTES = 8 * 1024;
/** 结构化错误条数上限 */
export const AI_FIX_MAX_ERRORS = 40;

/** AI 返回内容的标记（提示词里要求模型严格照抄；解析器对多余空白/引号/代码块围栏容错） */
const FIX_FILE_BEGIN = "===KIMI-FIX-FILE:";
const FIX_FILE_END = "===KIMI-FIX-END===";
const FIX_NONE = "===KIMI-FIX-NONE===";

/** 只把源码/头文件当候选（避免把 .exe/.o 之类发出去） */
const SOURCE_RE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp)$/i;

interface ContextFile {
  path: string;
  content: string;
}

interface FixContext {
  /** 编译器原始输出（已按上限截断） */
  rawOutput: string;
  /** 结构化错误文本（已按条数上限折叠） */
  errorList: string;
  /** 发送给 AI 的完整源文件 */
  files: ContextFile[];
  /** 因过大被跳过的文件说明（拼进 note 展示给用户） */
  skipped: string;
}

function setAiFix(patch: Partial<AiFixState>): void {
  useIde.getState().patchAiFix(patch);
}

/** 读取文件内容：优先用编辑器里（可能还没保存）的版本，其次读磁盘 */
async function readSource(path: string): Promise<string> {
  const cached = useIde.getState().contents[path];
  if (typeof cached === "string") return cached;
  try {
    const r = await api.readFile(path);
    return typeof r.content === "string" ? r.content : "";
  } catch {
    return "";
  }
}

/**
 * 挑选要发给 AI 的文件：报错文件优先（按错误出现顺序去重），再补上当前编辑文件；
 * 过滤非源码文件、读不到的文件、超过单文件上限的文件。
 */
async function collectFiles(errors: Diagnostic[]): Promise<{ files: ContextFile[]; skipped: string[] }> {
  const st = useIde.getState();
  const wanted: string[] = [];
  for (const d of errors) {
    if (d.file && SOURCE_RE.test(d.file) && !wanted.includes(d.file)) wanted.push(d.file);
  }
  if (st.activeFile && !wanted.includes(st.activeFile)) wanted.push(st.activeFile);

  const files: ContextFile[] = [];
  const skipped: string[] = [];
  for (const path of wanted) {
    if (files.length >= AI_FIX_MAX_FILES) break;
    if (!SOURCE_RE.test(path)) continue;
    const content = await readSource(path);
    if (!content) {
      skipped.push(t("aiFix.skippedRead", { path }));
      continue;
    }
    const bytes = new TextEncoder().encode(content).length;
    if (bytes > AI_FIX_FILE_BYTES) {
      skipped.push(t("aiFix.skippedLarge", { path, size: (bytes / 1024).toFixed(1), limit: AI_FIX_FILE_BYTES / 1024 }));
      continue;
    }
    files.push({ path, content });
  }
  return { files, skipped };
}

async function buildContext(): Promise<{ ok: true; ctx: FixContext } | { ok: false; error: string }> {
  const st = useIde.getState();
  const errors = st.problems.filter((d) => d.severity === "error");
  if (errors.length === 0) {
    return { ok: false, error: t("aiFix.errNoCompile") };
  }
  // 原始报错文本：compile() 里保存的编译器输出；若为空则退化为结构化错误文本
  const rawAll = st.compileOutput || errors.map((d) => d.raw).join("\n");
  const { files, skipped } = await collectFiles(errors);
  if (files.length === 0) {
    return {
      ok: false,
      error:
        t("aiFix.errNoFiles") +
        (skipped.length ? t("aiFix.errNoFilesDetail", { files: skipped.join("\n· ") }) : t("aiFix.errNoFilesHint")),
    };
  }
  const shown = errors.slice(0, AI_FIX_MAX_ERRORS);
  const more = errors.length - shown.length;
  const lines = shown.map((d) => {
    const loc = d.file ? `${d.file}:${d.line}:${d.col}` : t("aiFix.linkStage");
    return `${loc} [${d.severity}] ${d.message}${d.hint ? t("aiFix.errorHint", { hint: d.hint }) : ""}`;
  });
  if (more > 0) lines.push(t("aiFix.moreErrors", { count: more }));
  return {
    ok: true,
    ctx: {
      rawOutput: clipBytes(rawAll.trim(), AI_FIX_ERROR_BYTES, 0.7, t("aiFix.clipNote")),
      errorList: lines.join("\n"),
      files,
      skipped: skipped.length ? t("aiFix.noteSkipped", { files: skipped.join("；") }) : "",
    },
  };
}

/** 提示词：明确要求「只返回修正后的完整文件」，并用固定标记包裹，便于稳定解析 */
function buildMessages(ctx: FixContext): ChatMessage[] {
  const system = [
    "你是一名严谨的 C/C++ 代码修复助手。用户会给出编译器的报错信息，以及相关源文件的完整内容。",
    "请只做「让程序编译通过」所必需的修改，保持原有风格、注释与缩进，不要顺手重构、不要改无关代码。",
    "输出要求（必须严格遵守）：",
    "1. 不要输出任何解释性文字，不要使用 Markdown 代码块围栏（不要写 ```）。",
    `2. 每个需要修改的文件，用下面两行标记包裹，标记必须独占一行、原样照抄：`,
    `${FIX_FILE_BEGIN} 相对路径===`,
    "（该文件的完整新内容，一行都不能省略）",
    FIX_FILE_END,
    "3. 路径必须与用户给出的文件路径完全一致；只返回需要修改的文件，没有修改的文件不要返回。",
    `4. 如果根据所给信息无法确定修复方案（例如缺少关键文件、报错来自链接阶段而源码未提供），只回复一行：${FIX_NONE}，并在其后用一句中文说明原因。`,
  ].join("\n");

  const parts: string[] = [];
  parts.push("【编译器错误】");
  parts.push(ctx.errorList);
  if (ctx.rawOutput) {
    parts.push("");
    parts.push("【编译器原始输出】");
    parts.push("```");
    parts.push(ctx.rawOutput);
    parts.push("```");
  }
  parts.push("");
  parts.push("【相关源文件（工作区相对路径）】");
  for (const f of ctx.files) {
    parts.push(`--- ${f.path} ---`);
    parts.push("```cpp");
    parts.push(f.content);
    parts.push("```");
  }
  parts.push("");
  parts.push("请按系统提示要求的标记格式，返回修正后的完整文件内容。");
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/** 把 AI 返回的一块内容里可能多余的 Markdown 围栏剥掉（模型偶尔不听话） */
function stripFence(lines: string[]): string[] {
  let out = lines;
  while (out.length > 0 && out[0].trim() === "") out = out.slice(1);
  while (out.length > 0 && out[out.length - 1].trim() === "") out = out.slice(0, -1);
  if (out.length >= 2 && /^```[A-Za-z0-9+#-]*$/.test(out[0].trim()) && out[out.length - 1].trim() === "```") {
    return out.slice(1, -1);
  }
  return out;
}

/** 规范化模型给出的路径：反斜杠→斜杠、去掉 ./ 与首尾引号/反引号 */
function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  p = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return p;
}

/**
 * 解析 AI 回复 → 待写回的文件列表。
 * 容错：多余空白/围栏/引号、路径写成绝对路径（按后缀匹配回工作区相对路径）。
 * 解析不出任何文件时给出中文错误，绝不抛异常。
 */
export function parseFixReply(
  text: string,
  allowedPaths: string[]
): { ok: true; files: { path: string; content: string }[]; note: string } | { ok: false; error: string } {
  const norm = (text || "").replace(/\r\n?/g, "\n");
  if (!norm.trim()) return { ok: false, error: t("aiFix.empty") };
  const noneIdx = norm.indexOf(FIX_NONE);
  if (noneIdx >= 0) {
    const reason = norm.slice(noneIdx + FIX_NONE.length).trim().slice(0, 300);
    return { ok: false, error: t("aiFix.refused", { reason: reason || t("aiFix.refusedNoReason") }) };
  }

  const lines = norm.split("\n");
  const blocks: { path: string; lines: string[] }[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(FIX_FILE_BEGIN)) {
      if (cur) blocks.push(cur);
      cur = { path: trimmed.slice(FIX_FILE_BEGIN.length).replace(/=+\s*$/, ""), lines: [] };
      continue;
    }
    if (trimmed.replace(/\s/g, "") === FIX_FILE_END) {
      if (cur) {
        blocks.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);

  const files: { path: string; content: string }[] = [];
  const unknown: string[] = [];
  for (const b of blocks) {
    const path = resolvePath(normalizePath(b.path), allowedPaths);
    if (!path) {
      unknown.push(b.path || t("aiFix.emptyPath"));
      continue;
    }
    const content = stripFence(b.lines).join("\n");
    if (!content.trim()) continue;
    if (files.some((f) => f.path === path)) continue;
    files.push({ path, content });
  }

  // 兜底：模型完全没写标记时，退化为「整条回复就是一个文件的完整内容」，路径取第一个候选文件
  if (files.length === 0 && unknown.length === 0 && allowedPaths.length > 0) {
    const body = stripFence(norm.split("\n"));
    const content = body.join("\n");
    if (content.trim()) {
      return {
        ok: true,
        files: [{ path: allowedPaths[0], content }],
        note: t("aiFix.noteUnmarked", { path: allowedPaths[0] }),
      };
    }
  }

  if (files.length === 0) {
    return {
      ok: false,
      error: unknown.length
        ? t("aiFix.errUnknownPaths", { paths: unknown.join("、") })
        : t("aiFix.errNoMarkers"),
    };
  }
  return { ok: true, files, note: unknown.length ? t("aiFix.noteIgnoredPaths", { paths: unknown.join("、") }) : "" };
}

/** 把模型给的路径匹配回工作区相对路径（大小写不敏感、允许绝对路径按后缀匹配） */
function resolvePath(raw: string, allowedPaths: string[]): string | null {
  if (!raw) return null;
  const low = raw.toLowerCase();
  for (const a of allowedPaths) if (a.toLowerCase() === low) return a;
  // 模型偶尔给出绝对路径（如 C:/ws/main.cpp）：按后缀匹配回 allowedPaths 里的相对路径
  for (const a of allowedPaths) if (low.endsWith("/" + a.toLowerCase())) return a;
  return null;
}

/**
 * 「AI 修复」入口：收集上下文 → 请求（30s 超时、不带工具）→ 解析 → 写入 store 供弹层预览。
 * 任何环节失败都落到 aiFix.status === "error"（弹层里显示中文提示），不会静默改文件。
 */
export async function runAiFix(): Promise<void> {
  const st = useIde.getState();
  if (!isAiConfigured(st.settings)) {
    setAiFix({ status: "error", error: aiConfigHint(st.settings) || t("aiFix.errNotConfigured"), note: "", files: [], active: 0 });
    return;
  }
  setAiFix({ status: "loading", error: "", note: "", files: [], active: 0 });
  try {
    const built = await buildContext();
    if (!built.ok) {
      setAiFix({ status: "error", error: built.error });
      return;
    }
    const ctx = built.ctx;
    // 重新取一次 settings：收集上下文期间用户可能刚保存了新的 AI 配置
    const out = await requestChat(useIde.getState().settings, buildMessages(ctx), {
      tools: false,
      temperature: 0.1,
      timeoutMs: AI_FIX_TIMEOUT_MS,
    });
    if (out.error) {
      setAiFix({ status: "error", error: out.error, note: ctx.skipped });
      return;
    }
    const allowed = ctx.files.map((f) => f.path);
    const parsed = parseFixReply(out.message?.content ?? "", allowed);
    if (!parsed.ok) {
      setAiFix({ status: "error", error: parsed.error, note: ctx.skipped });
      return;
    }
    // 只保留真正有变化的文件（AI 原样返回整份内容时视为无修改）
    const originals = new Map(ctx.files.map((f) => [f.path, f.content]));
    const files: AiFixFile[] = parsed.files
      .map((f) => ({ path: f.path, original: originals.get(f.path) ?? "", fixed: f.content }))
      .filter((f) => f.original !== f.fixed);
    if (files.length === 0) {
      setAiFix({
        status: "error",
        error: t("aiFix.errNoChanges"),
        note: [ctx.skipped, parsed.note].filter(Boolean).join("\n"),
      });
      return;
    }
    const notes = [ctx.skipped, parsed.note].filter(Boolean);
    setAiFix({
      status: "ready",
      error: "",
      note: notes.join("\n"),
      files,
      active: 0,
    });
  } catch (e) {
    setAiFix({
      status: "error",
      error: t("aiFix.errFailed", { message: e instanceof Error ? e.message : String(e) }),
    });
  }
}
