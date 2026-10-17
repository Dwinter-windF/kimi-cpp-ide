/**
 * 单文件 exe 打包脚本（Node SEA）
 *  1. npm run build            → 产 dist/
 *  2. esbuild 打包 standalone.ts → dist-server/standalone.cjs（内联 ./dev-server.ts）
 *  3. 生成 sea-config.json（dist/ 全部文件以内嵌资源形式塞进 blob，key = web/相对路径）
 *  4. node --experimental-sea-config → sea-prep.blob
 *  5. 复制 node.exe → KimiCppIDE.exe，postject 注入 blob + sentinel fuse
 *
 * 产物: dist-server/KimiCppIDE.exe（真单文件，前端资源已内嵌）
 * 运行: 双击即可（自动开浏览器）；或 KimiCppIDE.exe --port 3200 --no-open
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const outDir = path.join(root, "dist-server");
const seaConfigPath = path.join(outDir, "sea-config.json");
const cjsPath = path.join(outDir, "standalone.cjs");
const blobPath = path.join(outDir, "sea-prep.blob");
const exePath = path.join(outDir, "KimiCppIDE.exe");

const log = (s) => console.log(`[package] ${s}`);

// 在 Kimi Work 沙箱内 process.execPath 是宿主程序而非 node，需探测真实 node.exe。
// 所有 node 调用（esbuild / sea-config / postject）都必须用这个真实 node 来跑。
const nodeExe = process.env.NODE_EXE || findNodeExe();
log(`使用 node.exe: ${nodeExe} (${execFileSync(nodeExe, ["--version"]).toString().trim()})`);

function findNodeExe() {
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && c.toLowerCase().endsWith("node.exe")) return c;
    } catch { /* keep looking */ }
  }
  // PATH 里找 node.exe（排除 .cmd/.sh shim）
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, "node.exe");
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* keep looking */ }
  }
  throw new Error("找不到 node.exe，请设置环境变量 NODE_EXE 指向它");
}

// 1) 前端构建
log("1/5 构建前端 (npm run build) ...");
execSync("npm run build", { cwd: root, stdio: "inherit" });

// 2) esbuild 打 standalone 为 cjs
log("2/5 esbuild 打包 standalone.ts ...");
fs.mkdirSync(outDir, { recursive: true });
execFileSync(
  nodeExe,
  [
    path.join(root, "node_modules", "esbuild", "bin", "esbuild"),
    "standalone.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node20",
    `--outfile=${cjsPath}`,
    "--log-level=warning",
  ],
  { cwd: root, stdio: "inherit" },
);

// 3) 收集 dist/ 资源 → sea-config.json
log("3/5 收集 dist/ 内嵌资源清单 ...");
const assets = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else assets["web/" + path.relative(distDir, p).split(path.sep).join("/")] = p;
  }
})(distDir);
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify({ main: cjsPath, output: blobPath, assets }, null, 2),
);
log(`  内嵌资源 ${Object.keys(assets).length} 个`);

// 4) 生成 SEA blob
log("4/5 生成 sea-prep.blob ...");
execFileSync(nodeExe, ["--experimental-sea-config", seaConfigPath], {
  cwd: root,
  stdio: "inherit",
});

// 5) 复制 node.exe 并注入 blob
log("5/5 注入 KimiCppIDE.exe ...");
fs.copyFileSync(nodeExe, exePath);
execFileSync(
  nodeExe,
  [
    path.join(root, "node_modules", "postject", "dist", "cli.js"),
    exePath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { cwd: root, stdio: "inherit" },
);

const size = fs.statSync(exePath).size;
log(`完成: ${exePath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
log("双击运行即可；首次运行 Windows SmartScreen 可能提示未签名，点“仍要运行”。");
