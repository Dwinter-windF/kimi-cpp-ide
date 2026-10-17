/**
 * 「从资源管理器拖文件进 IDE」的纯逻辑层：扩展名过滤 / FileReader 转 base64 / DataTransfer 解析。
 *
 * 分工：
 *  - 本文件：无 React、无 store 依赖，方便单测与复用；
 *  - store.ts 的 importDroppedFiles：编排「逐个上传 → 刷新文件树 → 打开第一个文件」；
 *  - components/FileDropZone.tsx：dragover/drop 事件、虚线高亮反馈、结果提示条。
 */

/**
 * 允许导入的扩展名（含点、小写比较）。
 * 选型说明：
 *  - .c/.cc/.cpp/.cxx：C/C++ 源文件，IDE 的主要用途；
 *  - .h/.hh/.hpp/.hxx：C/C++ 头文件（.hh/.hxx 是部分工程的习惯写法）；
 *  - .txt/.md：补充说明文档，导入后也能在编辑器里查看，成本几乎为零；
 *  - 其余（.exe/.zip/.png/.o 等二进制或无关文件）一律拒绝并给中文提示，
 *    避免把 IDE 工作区当垃圾桶，也避免 base64 传输大体积二进制。
 */
export const IMPORT_EXTS = [
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".txt",
  ".md",
] as const;

/** 中文提示里展示的支持列表 */
export const IMPORT_EXT_LABEL = IMPORT_EXTS.join(" / ");

/**
 * 前端预检的单文件上限：与服务端 FS_UPLOAD_LIMIT（8MB）保持一致。
 * 前端先拦一道是为了避免给超大文件做无谓的 base64 编码（要额外吃一份内存 + 时间）。
 */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/** 拖放解析出的一个条目：目录没有 File 对象，只有名字 */
export interface DroppedEntry {
  file: File | null;
  name: string;
  isDir: boolean;
}

/** 一次批量导入的结果（UI 展示「成功 N 个 / 跳过原因」用） */
export interface ImportSummary {
  /** 最终落盘的工作区相对路径（同名改名后是新路径） */
  imported: string[];
  /** 因同名而自动改名的记录 */
  renamed: { from: string; to: string }[];
  /** 被跳过的条目及中文原因（扩展名不支持 / 目录 / 超上限 / 读写失败） */
  skipped: { name: string; reason: string }[];
}

/** 是否是可导入的扩展名（大小写不敏感） */
export function isSupportedImport(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  const ext = name.slice(i).toLowerCase();
  return (IMPORT_EXTS as readonly string[]).includes(ext);
}

/** 人类可读的字节数（用于中文错误提示） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 用 FileReader 把文件读成纯 base64（不带 data URL 前缀）。
 * 用 readAsDataURL 而不是 readAsArrayBuffer + 手工 btoa：后者要自己分块处理二进制，
 * 前者是浏览器原生实现，且空文件的结果就是 "data:...;base64,"（payload 为空串）→ 空文件天然支持。
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = typeof fr.result === "string" ? fr.result : "";
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : "");
    };
    fr.onerror = () => reject(new Error("浏览器读取文件失败"));
    fr.readAsDataURL(file);
  });
}

/**
 * 解析 DataTransfer：优先用 items + webkitGetAsEntry 以识别「拖进来的是文件夹」，
 * 拿不到条目时退回 dt.files（老的 / 受限环境）。
 * 必须在 drop 事件同步阶段调用：DataTransferItem 在事件回调返回后会失效，
 * 异步（await 之后）再调 webkitGetAsEntry 一律拿到 null。
 */
export function collectDropEntries(dt: DataTransfer | null): DroppedEntry[] {
  if (!dt) return [];
  const out: DroppedEntry[] = [];
  const items = dt.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "file") continue;
      const entry = it.webkitGetAsEntry?.() ?? null;
      if (entry?.isDirectory) {
        out.push({ file: null, name: entry.name || "未命名文件夹", isDir: true });
        continue;
      }
      const f = it.getAsFile();
      if (f) out.push({ file: f, name: f.name, isDir: false });
    }
    if (out.length > 0) return out;
  }
  // 兜底：某些环境 items 为空（或全部非文件），退回 files 列表
  for (const f of Array.from(dt.files ?? [])) out.push({ file: f, name: f.name, isDir: false });
  return out;
}

/** 结果提示条 / 终端日志共用的文字行（首字符决定配色，见 FileDropZone） */
export function summaryLines(s: ImportSummary): string[] {
  const lines: string[] = [];
  if (s.imported.length > 0) lines.push(`✓ 成功导入 ${s.imported.length} 个文件`);
  for (const r of s.renamed) lines.push(`· ${r.from} 同名，已导入为 ${r.to}`);
  for (const k of s.skipped) lines.push(`✗ ${k.name}：${k.reason}`);
  if (lines.length === 0) lines.push("没有可导入的文件");
  return lines;
}
