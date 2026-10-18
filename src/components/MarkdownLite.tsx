import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// 轻量 Markdown 渲染： fenced code / 标题 / 列表 / 引用 / 段落 + 行内 code/bold/italic
// 不依赖外部库，AI 回复场景够用。
// ---------------------------------------------------------------------------

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-i${k++}`;
    if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="px-[4px] py-[1px] rounded bg-[color:var(--ide-bg-code)] text-[color:var(--ide-info)] font-mono text-[0.92em]">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={key} className="text-[color:var(--ide-warning)] font-semibold">
          {tok.slice(2, -2)}
        </strong>
      );
    } else {
      out.push(
        <em key={key} className="text-[color:var(--ide-purple-bright)]">
          {tok.slice(1, -1)}
        </em>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="rounded-md border border-[color:var(--ide-border-strong)] overflow-hidden my-1.5">
      <div className="flex items-center justify-between px-2.5 py-[3px] bg-[color:var(--ide-hover)] text-[10.5px] text-[color:var(--ide-text-muted)]">
        <span className="font-mono">{lang || "code"}</span>
        <button
          onClick={() => void copy()}
          className="flex items-center gap-1 hover:text-[color:var(--ide-text)] transition-colors"
          title={t("markdown.copyCode")}
        >
          {copied ? <Check size={11} className="text-[color:var(--ide-success)]" /> : <Copy size={11} />}
          {copied ? t("markdown.copied") : t("markdown.copy")}
        </button>
      </div>
      <pre className="px-3 py-2 overflow-x-auto bg-[color:var(--ide-bg-base)] text-[12px] leading-[1.55] font-mono text-[color:var(--ide-text)] m-0">
        <code>{code}</code>
      </pre>
    </div>
  );
}

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "p"; text: string };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      blocks.push({ type: "code", lang, code: buf.join("\n") });
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      blocks.push({ type: "heading", level: hm[1].length, text: hm[2] });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)、]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)、]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)、]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ type: "quote", text: line.replace(/^>\s?/, "") });
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // 段落：吞并到空行/其他块为止
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith("```") &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)、]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: buf.join("\n") });
  }
  return blocks;
}

const HEADING_CLS = ["", "text-[14px] font-bold text-[color:var(--ide-text)] mt-2", "text-[13px] font-bold text-[color:var(--ide-text)] mt-2", "text-[12.5px] font-semibold text-[color:var(--ide-accent)] mt-1.5", "text-[12.5px] font-semibold text-[color:var(--ide-accent)] mt-1"];

export function MarkdownLite({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-1">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case "code":
            return <CodeBlock key={key} lang={b.lang} code={b.code} />;
          case "heading":
            return (
              <div key={key} className={HEADING_CLS[b.level] || HEADING_CLS[4]}>
                {renderInline(b.text, key)}
              </div>
            );
          case "ul":
            return (
              <ul key={key} className="list-none space-y-[2px] my-0.5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-1.5">
                    <span className="text-[color:var(--ide-accent)] shrink-0">•</span>
                    <span className="min-w-0">{renderInline(it, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="list-none space-y-[2px] my-0.5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-1.5">
                    <span className="text-[color:var(--ide-accent)] shrink-0 font-mono">{j + 1}.</span>
                    <span className="min-w-0">{renderInline(it, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <div key={key} className="border-l-2 border-[color:var(--ide-purple)] pl-2 text-[color:var(--ide-text-dim)] italic">
                {renderInline(b.text, key)}
              </div>
            );
          default:
            return (
              <p key={key} className="whitespace-pre-wrap break-words my-0.5">
                {renderInline(b.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
