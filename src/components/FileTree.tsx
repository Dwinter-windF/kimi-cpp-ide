import { useEffect, useState } from "react";
import {
  Folder,
  FolderOpen,
  FileCode,
  FilePlus2,
  FolderPlus,
  Trash2,
  Pencil,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  FileText,
  Braces,
  Cog,
  Boxes,
  Copy,
  PackagePlus,
} from "lucide-react";
import { useIde } from "@/store";
import { useT } from "@/lib/i18n";
import { OpenDirDialog } from "@/components/OpenDirDialog";
import type { FileNode } from "@/types";

function joinPath(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name;
}

function parentOf(p: string) {
  return p.split("/").slice(0, -1).join("/");
}

interface CtxMenu {
  x: number;
  y: number;
  node: FileNode | null; // null = 工作区根目录
}

function ContextMenu({ ctx, onClose, onOpenDir }: { ctx: CtxMenu; onClose: () => void; onOpenDir: () => void }) {
  const t = useT();
  const openNameDialog = useIde((s) => s.openNameDialog);
  const newFile = useIde((s) => s.newFile);
  const removeFile = useIde((s) => s.removeFile);
  const rename = useIde((s) => s.rename);
  const openFile = useIde((s) => s.openFile);

  const dir = ctx.node && ctx.node.type === "dir" ? ctx.node.path : ctx.node ? parentOf(ctx.node.path) : "";
  const isFile = !!ctx.node && ctx.node.type === "file";

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const create = (label: string, initial: string) =>
    openNameDialog({
      title: label,
      placeholder: t("fileTree.fileNamePlaceholder"),
      initial,
      onSubmit: (name) => {
        void newFile(joinPath(dir, name)).then((err) => err && window.alert(err));
      },
    });

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    danger = false
  ) => (
    <button
      className={`w-full flex items-center gap-2 px-3 py-[6px] text-[12.5px] text-left hover:bg-[color:var(--ide-selected)] ${
        danger ? "text-[color:var(--ide-error)]" : "text-[color:var(--ide-text)]"
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
        onClose();
      }}
    >
      {icon}
      {label}
    </button>
  );

  const sep = <div className="my-1 border-t border-[color:var(--ide-border-strong)]" />;

  const x = Math.min(ctx.x, window.innerWidth - 210);
  const y = Math.min(ctx.y, window.innerHeight - 320);

  return (
    <div
      className="kimi-menu-in fixed z-50 w-52 rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-bg-panel)] shadow-2xl py-1"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isFile && item(<FileCode size={13} />, t("fileTree.open"), () => void openFile(ctx.node!.path))}
      {isFile && sep}
      {!ctx.node && item(<FolderOpen size={13} className="text-[color:var(--ide-warning)]" />, t("fileTree.openOtherDir"), onOpenDir)}
      {!ctx.node && sep}
      {item(<Braces size={13} className="text-[color:var(--ide-accent)]" />, t("fileTree.newCpp"), () => create(t("fileTree.newCpp"), "untitled.cpp"))}
      {item(<Cog size={13} className="text-[color:var(--ide-warning)]" />, t("fileTree.newC"), () => create(t("fileTree.newC"), "untitled.c"))}
      {item(<Boxes size={13} className="text-[color:var(--ide-cyan)]" />, t("fileTree.newHeader"), () => create(t("fileTree.newHeader"), "untitled.h"))}
      {item(<FileText size={13} className="text-[color:var(--ide-success)]" />, t("fileTree.newText"), () => create(t("fileTree.newText"), "untitled.txt"))}
      {item(<FilePlus2 size={13} />, t("fileTree.newFile"), () => create(t("fileTree.newFile"), ""))}
      {item(<FolderPlus size={13} />, t("fileTree.newFolder"), () =>
        openNameDialog({
          title: t("fileTree.newFolder"),
          placeholder: t("fileTree.folderName"),
          initial: "newfolder",
          onSubmit: (name) => {
            void newFile(joinPath(dir, name), true).then((err) => err && window.alert(err));
          },
        })
      )}
      {ctx.node && sep}
      {ctx.node &&
        item(<Pencil size={13} />, t("common.rename"), () =>
          openNameDialog({
            title: t("fileTree.renameTitle", { name: ctx.node!.name }),
            initial: ctx.node!.name,
            onSubmit: (name) => void rename(ctx.node!.path, joinPath(parentOf(ctx.node!.path), name)),
          })
        )}
      {ctx.node &&
        item(<Copy size={13} />, t("fileTree.copyPath"), () => {
          void navigator.clipboard?.writeText(ctx.node!.path);
        })}
      {ctx.node &&
        item(<Trash2 size={13} />, t("common.delete"), () => {
          if (window.confirm(t("fileTree.deleteConfirm", { name: ctx.node!.name, note: ctx.node!.type === "dir" ? t("fileTree.dirDeleteNote") : "" }))) {
            void removeFile(ctx.node!.path);
          }
        }, true)}
    </div>
  );
}

function TreeNode({ node, depth, onCtx }: { node: FileNode; depth: number; onCtx: (e: React.MouseEvent, node: FileNode) => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(depth < 1);
  const openFile = useIde((s) => s.openFile);
  const activeFile = useIde((s) => s.activeFile);
  const isDir = node.type === "dir";

  return (
    <div>
      <div
        className={`kimi-tree-row group flex items-center gap-1 px-2 py-[3px] pr-1 text-[13px] cursor-pointer select-none rounded-sm mx-1 ${
          !isDir && activeFile === node.path ? "bg-[color:var(--ide-selected)] text-[color:var(--ide-text)]" : "text-[color:var(--ide-text-dim)] hover:bg-[color:var(--ide-hover)]"
        }`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => (isDir ? setExpanded(!expanded) : void openFile(node.path))}
        onContextMenu={(e) => onCtx(e, node)}
      >
        {isDir ? (
          <>
            {expanded ? <ChevronDown size={13} className="shrink-0 text-[color:var(--ide-text-muted)]" /> : <ChevronRight size={13} className="shrink-0 text-[color:var(--ide-text-muted)]" />}
            {expanded ? <FolderOpen size={14} className="shrink-0 text-[color:var(--ide-warning)]" /> : <Folder size={14} className="shrink-0 text-[color:var(--ide-warning)]" />}
          </>
        ) : (
          <FileCode size={14} className="shrink-0 ml-[17px] text-[color:var(--ide-accent)]" />
        )}
        <span className="truncate flex-1">{node.name}</span>
      </div>
      {isDir && expanded && node.children && (
        <div>
          {node.children.length === 0 && (
            <div className="text-[12px] text-[color:var(--ide-text-faint)]" style={{ paddingLeft: 22 + depth * 14 }}>
              {t("fileTree.empty")}
            </div>
          )}
          {node.children.map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} onCtx={onCtx} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree() {
  const t = useT();
  const tree = useIde((s) => s.tree);
  const workspace = useIde((s) => s.workspace);
  const refreshFiles = useIde((s) => s.refreshFiles);
  const openNameDialog = useIde((s) => s.openNameDialog);
  const newFile = useIde((s) => s.newFile);
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [openDir, setOpenDir] = useState(false);

  const onRowCtx = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, node });
  };
  const onBlankCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, node: null });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--ide-border)]">
        <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase truncate" title={workspace || t("fileTree.currentWorkspace")}>
          {t("fileTree.header")}
        </span>
        <div className="flex items-center gap-1">
          {/* 新建项目向导：与工具栏那个按钮同一个入口（store.showNewProject） */}
          <button
            title={t("fileTree.newProjectTitle")}
            className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            onClick={() => useIde.getState().setShowNewProject(true)}
          >
            <PackagePlus size={14} />
          </button>
          <button
            title={workspace ? t("fileTree.openDirTitleCurrent", { path: workspace }) : t("fileTree.openDirTitle")}
            className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            onClick={() => setOpenDir(true)}
          >
            <FolderOpen size={14} />
          </button>
          <button
            title={t("fileTree.newFileTitle")}
            className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            onClick={() =>
              openNameDialog({
                title: t("fileTree.newFileTitle"),
                placeholder: t("fileTree.fileNamePlaceholder"),
                initial: "untitled.cpp",
                onSubmit: (name) => void newFile(name).then((err) => err && window.alert(err)),
              })
            }
          >
            <FilePlus2 size={14} />
          </button>
          <button title={t("common.refresh")} className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]" onClick={() => void refreshFiles()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1" onContextMenu={onBlankCtx}>
        {tree.length === 0 && (
          <div className="text-[12px] text-[color:var(--ide-text-faint)] px-3 py-2">
            {t("fileTree.emptyWorkspace")}
          </div>
        )}
        {tree.map((n) => (
          <TreeNode key={n.path} node={n} depth={0} onCtx={onRowCtx} />
        ))}
      </div>
      {ctx && <ContextMenu ctx={ctx} onClose={() => setCtx(null)} onOpenDir={() => setOpenDir(true)} />}
      {openDir && <OpenDirDialog onClose={() => setOpenDir(false)} />}
    </div>
  );
}
