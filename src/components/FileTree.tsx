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
      placeholder: "文件名（可包含目录，如 src/util.h）",
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
      {isFile && item(<FileCode size={13} />, "打开", () => void openFile(ctx.node!.path))}
      {isFile && sep}
      {!ctx.node && item(<FolderOpen size={13} className="text-[color:var(--ide-warning)]" />, "打开其它目录…", onOpenDir)}
      {!ctx.node && sep}
      {item(<Braces size={13} className="text-[color:var(--ide-accent)]" />, "新建 C++ 源文件", () => create("新建 C++ 源文件", "untitled.cpp"))}
      {item(<Cog size={13} className="text-[color:var(--ide-warning)]" />, "新建 C 源文件", () => create("新建 C 源文件", "untitled.c"))}
      {item(<Boxes size={13} className="text-[color:var(--ide-cyan)]" />, "新建头文件", () => create("新建头文件", "untitled.h"))}
      {item(<FileText size={13} className="text-[color:var(--ide-success)]" />, "新建文本文件", () => create("新建文本文件", "untitled.txt"))}
      {item(<FilePlus2 size={13} />, "新建文件…", () => create("新建文件…", ""))}
      {item(<FolderPlus size={13} />, "新建文件夹", () =>
        openNameDialog({
          title: "新建文件夹",
          placeholder: "文件夹名",
          initial: "newfolder",
          onSubmit: (name) => {
            void newFile(joinPath(dir, name), true).then((err) => err && window.alert(err));
          },
        })
      )}
      {ctx.node && sep}
      {ctx.node &&
        item(<Pencil size={13} />, "重命名", () =>
          openNameDialog({
            title: `重命名「${ctx.node!.name}」`,
            initial: ctx.node!.name,
            onSubmit: (name) => void rename(ctx.node!.path, joinPath(parentOf(ctx.node!.path), name)),
          })
        )}
      {ctx.node &&
        item(<Copy size={13} />, "复制相对路径", () => {
          void navigator.clipboard?.writeText(ctx.node!.path);
        })}
      {ctx.node &&
        item(<Trash2 size={13} />, "删除", () => {
          if (window.confirm(`确定删除「${ctx.node!.name}」吗？${ctx.node!.type === "dir" ? "（整个目录都会被删除）" : ""}`)) {
            void removeFile(ctx.node!.path);
          }
        }, true)}
    </div>
  );
}

function TreeNode({ node, depth, onCtx }: { node: FileNode; depth: number; onCtx: (e: React.MouseEvent, node: FileNode) => void }) {
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
              （空）
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
        <span className="text-[12px] font-semibold tracking-wider text-[color:var(--ide-text-muted)] uppercase truncate" title={workspace || "当前工作区"}>
          工程文件
        </span>
        <div className="flex items-center gap-1">
          {/* 新建项目向导：与工具栏那个按钮同一个入口（store.showNewProject） */}
          <button
            title="新建项目…（模板向导：空文件 / 控制台 / 多文件工程 / 课程作业）"
            className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            onClick={() => useIde.getState().setShowNewProject(true)}
          >
            <PackagePlus size={14} />
          </button>
          <button
            title={workspace ? `打开目录（当前：${workspace}）` : "打开目录"}
            className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            onClick={() => setOpenDir(true)}
          >
            <FolderOpen size={14} />
          </button>
          <button
            title="新建文件"
            className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]"
            onClick={() =>
              openNameDialog({
                title: "新建文件",
                placeholder: "文件名（可包含目录，如 src/main.cpp）",
                initial: "untitled.cpp",
                onSubmit: (name) => void newFile(name).then((err) => err && window.alert(err)),
              })
            }
          >
            <FilePlus2 size={14} />
          </button>
          <button title="刷新" className="kimi-pop p-1 text-[color:var(--ide-text-muted)] hover:text-[color:var(--ide-text)]" onClick={() => void refreshFiles()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1" onContextMenu={onBlankCtx}>
        {tree.length === 0 && (
          <div className="text-[12px] text-[color:var(--ide-text-faint)] px-3 py-2">
            工作区为空。点击上方 + 或在此处右键新建文件。
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
