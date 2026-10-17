/**
 * Kimi C++ IDE — 独立服务模式（无 Vite 壳）
 *  - 静态托管 dist/（打包成 SEA exe 时优先读内嵌资源，单文件分发）
 *  - /api/* 与开发模式共用 dev-server.ts 的 handleApiRequest
 *  - 启动自动打开浏览器；端口被占用时自动向后找（最多 50 个）
 *  - 打包运行时工作根目录 = exe 所在目录（workspace/ 与 cpp-ide-data/ 自动生成在旁边）
 *
 * 用法:
 *   node standalone.ts [--port N] [--root <dir>] [--no-open]
 *   环境变量: PORT / CPP_IDE_ROOT / CPP_IDE_NO_OPEN=1
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// 兼容 esbuild 打成 cjs 的场景：import.meta.url 为空串时退化为一个合法文件路径
const require = createRequire((import.meta as { url?: string }).url || path.join(process.cwd(), "standalone.cjs"));
const args = process.argv.slice(2);
const argVal = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const NO_OPEN = args.includes("--no-open") || process.env.CPP_IDE_NO_OPEN === "1";

// 工作根目录：打包 exe 运行时 = exe 所在目录；node 直跑时 = 当前目录（可用 --root 覆盖）
const exeDir = path.dirname(process.execPath);
const isPackaged = !/^node(\.exe)?$/i.test(path.basename(process.execPath));
const ROOT = process.env.CPP_IDE_ROOT || argVal("--root") || (isPackaged ? exeDir : process.cwd());
if (path.resolve(ROOT) !== process.cwd()) process.chdir(ROOT);
const DIST = process.env.CPP_IDE_DIST || path.join(ROOT, "dist");

/**
 * 初始工作区目录：优先级 --root / CPP_IDE_ROOT（显式指定，最高）> settings.json 的 workspacePath > ROOT/workspace。
 * 结果通过环境变量 CPP_IDE_WORKSPACE 传给 dev-server（它在模块加载时读取一次；默认根目录由 dev-server 兜底）。
 */
function applyInitialWorkspace() {
  if (process.env.CPP_IDE_ROOT || argVal("--root")) {
    // 显式指定根目录时忽略上次记住的工作区，回到 ROOT/workspace
    process.env.CPP_IDE_WORKSPACE = path.join(ROOT, "workspace");
    return;
  }
  try {
    const settingsFile = path.join(ROOT, "cpp-ide-data", "settings.json");
    if (!fs.existsSync(settingsFile)) return;
    const s = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as { workspacePath?: string };
    const saved = (s.workspacePath || "").trim();
    if (saved && fs.existsSync(saved) && fs.statSync(saved).isDirectory()) {
      process.env.CPP_IDE_WORKSPACE = path.resolve(saved);
    }
  } catch {
    /* 读取失败则回退默认工作区 */
  }
}

// SEA 内嵌资源（打包进 exe 的 dist 内容；普通 node 环境下不可用）
let sea: { getAsset(key: string): Uint8Array } | null = null;
try {
  const seaMod = require("node:sea") as { getAsset(k: string): Uint8Array; isSea?: () => boolean };
  // node:sea 模块在非 SEA 的 node 下也能 require 成功，只有 isSea() 为真才真有内嵌资源
  if (typeof seaMod.isSea === "function" ? seaMod.isSea() : isPackaged) sea = seaMod;
} catch {
  sea = null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(res: http.ServerResponse, pathnameRaw: string) {
  let pathname = pathnameRaw;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep raw */
  }
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const rel = pathname.replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..")) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }
  const type = MIME[path.extname(rel).toLowerCase()] || "application/octet-stream";

  // 1) SEA 内嵌资源（单文件 exe 模式）
  if (sea) {
    try {
      const data = sea.getAsset("web/" + rel);
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
      return;
    } catch {
      /* fallthrough */
    }
  }

  // 2) 文件系统（开发 / exe + dist 目录模式）
  const file = path.join(DIST, rel);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // 3) SPA 回退
  if (!path.extname(rel)) {
    const index = path.join(DIST, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      fs.createReadStream(index).pipe(res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

function openBrowser(url: string) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", '""', url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* ignore */
  }
}

async function main() {
  // 必须在动态导入 dev-server 之前设置：它的模块级初始化会读取 CPP_IDE_WORKSPACE
  applyInitialWorkspace();

  // 动态导入：确保 chdir(ROOT) 之后再执行 dev-server 的模块级目录初始化
  const { handleApiRequest, seedWorkspace, shutdownAll } = await import("./dev-server.ts");
  seedWorkspace();

  const server = http.createServer(async (req, res) => {
    if (process.env.CPP_IDE_DEBUG) console.error(`[dbg] ${req.method} ${req.url} @${Date.now() % 100000}`);
    try {
      const u = new URL(req.url || "/", "http://localhost");
      if (u.pathname.startsWith("/api/")) {
        await handleApiRequest(req, res);
        return;
      }
      serveStatic(res, u.pathname);
      if (process.env.CPP_IDE_DEBUG) console.error(`[dbg] served ${req.url} @${Date.now() % 100000}`);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(e instanceof Error ? e.message : e));
    }
  });

  let port = parseInt(process.env.PORT || argVal("--port") || "3000", 10);
  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.removeListener("error", onErr);
        reject(e);
      };
      server.once("error", onErr);
      server.listen(p, () => {
        server.removeListener("error", onErr);
        resolve(p);
      });
    });

  for (let i = 0; i < 50; i++) {
    try {
      port = await listen(port);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        if (i === 49) throw e;
        port++;
        continue;
      }
      throw e;
    }
  }

  const seaNote = sea ? "（内嵌资源模式）" : fs.existsSync(DIST) ? "" : "（警告：找不到 dist/ 目录，前端将无法加载）";
  console.log(`Kimi C++ IDE 已启动${seaNote}: http://localhost:${port}/`);
  console.log(`工作目录: ${ROOT}`);
  console.log(`工作区: ${process.env.CPP_IDE_WORKSPACE || path.join(ROOT, "workspace")}`);
  if (!NO_OPEN) openBrowser(`http://localhost:${port}/`);

  const bye = () => {
    shutdownAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
