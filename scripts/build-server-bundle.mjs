/**
 * 把 standalone.ts 打包成 dist-server/standalone.cjs（Electron 主进程内嵌用）
 * 与 scripts/package-exe.mjs 的第 2 步相同，只是不做 SEA 后续步骤。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-server");
const cjsPath = path.join(outDir, "standalone.cjs");

const nodeExe = process.env.NODE_EXE || "C:\\Program Files\\nodejs\\node.exe";
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
console.log(`[bundle] ${cjsPath}`);
