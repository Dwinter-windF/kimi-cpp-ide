import { useEffect, useRef, useState } from "react";
import { Boxes, Check, ChevronLeft, FileCode2, FolderTree, GraduationCap, Loader2 } from "lucide-react";
import { useIde } from "@/store";
import {
  PROJECT_TEMPLATES,
  getTemplate,
  splitRootName,
  templatePaths,
  validateProjectName,
  type CreateProjectResult,
  type ProjectTemplate,
  type ProjectTemplateId,
} from "@/lib/projectTemplates";

/** 每个模板卡片的小图标（纯展示，不参与逻辑） */
const CARD_ICON: Record<ProjectTemplateId, React.ReactNode> = {
  empty: <FileCode2 size={15} />,
  console: <Boxes size={15} />,
  multi: <FolderTree size={15} />,
  homework: <GraduationCap size={15} />,
};

/**
 * 「新建项目向导」对话框：模板选择 → 名称输入 → 创建。
 *
 * 与 NameDialog / OpenDirDialog 保持一致的做法：自己画的浮层 + .kimi-* 动画类 + --ide-* 变量，
 * 不引入新的 UI 依赖；打开状态放在 store.showNewProject，由 App 懒加载挂载（同 SettingsDialog）。
 * 真正的落盘编排全在 store.createProject，这里只负责收集输入与展示中文结果。
 *
 * 状态重置用「打开时才挂载内部组件」实现（关掉就卸载 → 下次打开自然是全新状态），
 * 而不是在 useEffect 里 setState（既避免级联渲染，也让「向导每次都从头开始」这件事更直观）。
 */
export function NewProjectDialog() {
  const open = useIde((s) => s.showNewProject);
  if (!open) return null;
  return <NewProjectWizard />;
}

function NewProjectWizard() {
  const setOpen = useIde((s) => s.setShowNewProject);
  const createProject = useIde((s) => s.createProject);

  const [step, setStep] = useState<"pick" | "name">("pick");
  const [id, setId] = useState<ProjectTemplateId>(PROJECT_TEMPLATES[0].id);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 部分成功时留在弹层里展示明细（全部成功则直接关闭，摘要在终端里）
  const [result, setResult] = useState<CreateProjectResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tpl: ProjectTemplate = getTemplate(id) ?? PROJECT_TEMPLATES[0];

  useEffect(() => {
    if (step !== "name") return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
    return () => clearTimeout(t);
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, setOpen]);

  const nameError = step === "name" ? validateProjectName(name, tpl.kind) : undefined;
  // 预览：与实际创建用同一套纯函数（templatePaths），所以「将创建什么」不会和真实结果脱节
  const previewRoot = (() => {
    const { stem, ext } = splitRootName(tpl.kind, name.trim() || tpl.defaultName);
    return `${stem}${ext}`;
  })();
  const preview = templatePaths(tpl.id, previewRoot);

  const pickTemplate = (t: ProjectTemplate) => {
    setId(t.id);
    setName(t.defaultName);
    setError("");
    setResult(null);
  };

  const submit = async () => {
    if (busy) return;
    const bad = validateProjectName(name, tpl.kind);
    if (bad) {
      setError(bad);
      return;
    }
    setError("");
    setBusy(true);
    const r = await createProject(tpl.id, name);
    setBusy(false);
    // 全部成功：关闭弹层（创建摘要已经打进终端，文件树也已刷新并打开了主文件）
    if (r.ok) {
      setOpen(false);
      return;
    }
    // 一个文件都没写成功 / 目录建不出来：留在弹层显示中文原因
    if (r.created.length === 0) {
      setError(r.error || "创建失败");
      return;
    }
    // 部分成功：列出「已创建」与「失败」两栏，让用户自己决定怎么处理
    setResult(r);
  };

  return (
    <div
      className="kimi-overlay-in fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) setOpen(false);
      }}
    >
      <div className="kimi-dialog-pop w-[560px] max-h-[78vh] overflow-y-auto rounded-lg border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] shadow-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[13px] font-semibold text-[color:var(--ide-text)]">新建项目</span>
          <span className="text-[11.5px] text-[color:var(--ide-text-faint)]">
            {step === "pick" ? "第 1 步 / 2 · 选择模板" : `第 2 步 / 2 · ${tpl.nameLabel}`}
          </span>
        </div>

        {/* ---------------- 第 1 步：模板选择 ---------------- */}
        {step === "pick" && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {PROJECT_TEMPLATES.map((t) => {
                const active = t.id === id;
                return (
                  <button
                    key={t.id}
                    onClick={() => pickTemplate(t)}
                    onDoubleClick={() => {
                      pickTemplate(t);
                      setStep("name");
                    }}
                    className={`kimi-pop text-left rounded-md border px-3 py-2.5 transition-colors ${
                      active
                        ? "border-[color:var(--ide-accent)] bg-[color:var(--ide-selected)]"
                        : "border-[color:var(--ide-border-strong)] hover:bg-[color:var(--ide-hover)]"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[color:var(--ide-text)]">
                      <span className={active ? "text-[color:var(--ide-accent)]" : "text-[color:var(--ide-text-muted)]"}>
                        {CARD_ICON[t.id]}
                      </span>
                      {t.label}
                      {active && <Check size={13} className="ml-auto text-[color:var(--ide-accent)]" />}
                    </div>
                    <div className="mt-1 text-[11.5px] leading-4 text-[color:var(--ide-text-muted)]">{t.summary}</div>
                  </button>
                );
              })}
            </div>

            <ul className="mt-3 mb-1 text-[11.5px] leading-5 text-[color:var(--ide-text-dim)] list-disc pl-5">
              {tpl.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </>
        )}

        {/* ---------------- 第 2 步：名称 + 预览 ---------------- */}
        {step === "name" && !result && (
          <>
            <div className="text-[12px] text-[color:var(--ide-text-dim)] mb-2">
              模板：<span className="text-[color:var(--ide-accent)]">{tpl.label}</span>
              <span className="text-[color:var(--ide-text-faint)]"> · {tpl.summary}</span>
            </div>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder={tpl.namePlaceholder}
              className="w-full bg-[color:var(--ide-bg-base)] border border-[color:var(--ide-border-strong)] rounded px-2.5 py-1.5 text-[13px] font-mono text-[color:var(--ide-text)] placeholder-[color:var(--ide-text-faint)] focus:outline-none focus:border-[color:var(--ide-accent)]"
            />
            <div className="mt-2 min-h-[16px] text-[11.5px] leading-4">
              {nameError ? (
                <span className="text-[color:var(--ide-error)]">{nameError}</span>
              ) : (
                <span className="text-[color:var(--ide-text-faint)]">
                  {tpl.kind === "project"
                    ? "名称会作为项目目录名；已存在同名目录时自动改名为 name-1。"
                    : "名称作为文件名（自动补 .cpp）；已存在同名文件时自动改名为 name-1.cpp。"}
                </span>
              )}
            </div>

            <div className="mt-2 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-bg-base)] p-2">
              <div className="text-[11.5px] text-[color:var(--ide-text-muted)] mb-1">
                将创建 {preview.length} 个文件：
              </div>
              <div className="font-mono text-[11.5px] leading-5 text-[color:var(--ide-text-dim)] break-all">
                {preview.map((p) => (
                  <div key={p}>· {p}</div>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-[color:var(--ide-text-faint)]">
                提示：文件树按既有规则跳过点号开头的目录，因此 .vscode/* 不会出现在左侧树里（文件已真实落盘）。
              </div>
            </div>
          </>
        )}

        {/* ---------------- 部分成功的明细 ---------------- */}
        {result && (
          <div className="text-[12px] leading-5">
            <div className="text-[color:var(--ide-success)]">
              ✓ 已创建 {result.created.length} 个文件{result.root ? `（${result.root}）` : ""}
            </div>
            <div className="font-mono text-[11.5px] text-[color:var(--ide-text-dim)] break-all">
              {result.created.map((p) => (
                <div key={p}>· {p}</div>
              ))}
            </div>
            {result.failed.length > 0 && (
              <>
                <div className="mt-2 text-[color:var(--ide-error)]">✗ {result.failed.length} 个文件写入失败：</div>
                <div className="text-[color:var(--ide-error)] break-all">
                  {result.failed.map((f) => (
                    <div key={f.path}>
                      · {f.path}：{f.reason}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[11.5px] text-[color:var(--ide-text-faint)]">
                  已创建的文件不会回滚（避免删不干净留下残缺目录），可直接在文件树里右键删除。
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------- 底部按钮 ---------------- */}
        <div className="flex items-center gap-2 mt-4">
          {error && <span className="text-[11.5px] text-[color:var(--ide-error)] flex-1 break-all">{error}</span>}
          {!error && <span className="flex-1" />}

          {result ? (
            <button
              className="px-4 py-1.5 rounded text-[12px] bg-[color:var(--ide-accent-strong)] text-white hover:bg-[color:var(--ide-accent)]"
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          ) : (
            <>
              <button
                disabled={busy}
                className="px-3 py-1.5 rounded text-[12px] text-[color:var(--ide-text-dim)] hover:text-[color:var(--ide-text)] hover:bg-[color:var(--ide-selected)] disabled:opacity-40"
                onClick={() => (step === "pick" ? setOpen(false) : setStep("pick"))}
              >
                {step === "pick" ? "取消" : "上一步"}
              </button>
              {step === "pick" ? (
                <button
                  className="flex items-center gap-1 px-4 py-1.5 rounded text-[12px] bg-[color:var(--ide-accent-strong)] text-white hover:bg-[color:var(--ide-accent)]"
                  onClick={() => {
                    setName(tpl.defaultName);
                    setStep("name");
                  }}
                >
                  下一步
                </button>
              ) : (
                <button
                  disabled={busy || !!nameError}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded text-[12px] bg-[color:var(--ide-accent-strong)] text-white hover:bg-[color:var(--ide-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => void submit()}
                >
                  {busy && <Loader2 size={13} className="animate-spin" />}
                  {busy ? "创建中…" : "创建"}
                </button>
              )}
            </>
          )}
        </div>

        {/* 未进入第 2 步时也允许快速返回上一步（仅视觉提示，实际按钮在上面） */}
        {step === "name" && !result && (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-[color:var(--ide-text-faint)]">
            <ChevronLeft size={11} />
            Esc 取消并关闭
          </div>
        )}
      </div>
    </div>
  );
}
