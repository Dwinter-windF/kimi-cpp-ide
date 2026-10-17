/**
 * Kimi C++ IDE — Electron 主进程
 *  - 内嵌 Node 服务：require 打包好的 dist-server/standalone.cjs（其内部再内联 dev-server.ts）
 *  - 工作根目录 = userData/ide-root（首次运行自动生成 workspace/ 与 cpp-ide-data/）
 *  - 端口：先探测系统空闲端口再启动服务，避免与占用 3213/3000 的实例冲突
 *  - 单一实例：第二次启动只聚焦已有窗口
 */
const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");

// 本机打包 exe 无 --no-sandbox 参数时会早期静默退出：内置等价开关，双击即无需参数。
// 须在 app ready 之前设置。
app.commandLine.appendSwitch("no-sandbox");

// 用户数据目录：默认 exe 旁的 ide-data（本机安全软件会拦 AppData\Roaming 与 AppData\Local 下的
// Chromium 缓存初始化，冻结发生在任何输出之前；exe 旁目录不受此限）；
// 可用 KIMI_IDE_USERDATA 覆盖（冒烟测试 / 便携模式）；须在单实例锁之前设置
if (process.env.KIMI_IDE_USERDATA) {
  app.setPath("userData", process.env.KIMI_IDE_USERDATA);
} else {
  app.setPath("userData", path.join(path.dirname(process.execPath), "ide-data"));
}

// 兜底：默认目录不可写（如装在 Program Files）时降级到用户主目录，避免直接启动失败
(function ensureWritableUserData() {
  const dir = app.getPath("userData");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, ".write-test");
    fs.writeFileSync(t, "1");
    fs.unlinkSync(t);
    return; // 可写，保持默认
  } catch { /* fallthrough */ }
  const fallback = path.join(app.getPath("home"), "kimi-cpp-ide");
  app.setPath("userData", fallback);
  fs.mkdirSync(fallback, { recursive: true });
})();

  let gotLock = true;
  try {
    gotLock = app.requestSingleInstanceLock();
  } catch (e) {
    // 某些机器上安全软件会拦 Roaming 下创建单实例锁文件（0x5），此时降级为不启用单实例，保证能启动
    console.error("单实例锁获取失败（已降级为不启用）:", e && e.message);
    gotLock = true; // 继续启动，仅失去单实例保护
  }
  if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  let mainWindow = null;

  /** 探测一个系统空闲端口 */
  function pickPort() {
    if (process.env.KIMI_IDE_PORT) return Promise.resolve(parseInt(process.env.KIMI_IDE_PORT, 10));
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(0, () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }

  /** 轮询等待服务起来 */
  function waitUp(port, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", () => {
          if (Date.now() > deadline) reject(new Error("服务启动超时"));
          else setTimeout(tick, 200);
        });
      };
      tick();
    });
  }

  async function boot() {
    // 工作根目录：装在 Program Files 时 exe 旁不可写，必须放用户数据目录
    const rootDir = path.join(app.getPath("userData"), "ide-root");
    fs.mkdirSync(rootDir, { recursive: true });
    process.env.CPP_IDE_ROOT = rootDir;
    process.env.CPP_IDE_NO_OPEN = "1"; // 浏览器打开由 Electron 窗口代替
    // 前端资源在 asar 内（standalone 默认找 ROOT/dist，需要显式指过去）
    process.env.CPP_IDE_DIST = path.join(__dirname, "..", "dist");

    const port = await pickPort();
    process.env.PORT = String(port);

    // 启动内嵌服务（模块级立即运行；会自行 seedWorkspace / 端口监听 / 注册退出钩子）
    require(path.join(__dirname, "..", "dist-server", "standalone.cjs"));
    await waitUp(port);

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "Kimi C++ IDE",
      backgroundColor: "#16161e",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // 外部链接交给系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }

  app.whenReady().then(() => {
    boot().catch((e) => {
      console.error("启动失败:", e);
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    app.quit(); // 内嵌服务随进程退出（standalone 注册了 SIGTERM/SIGINT 清理）
  });
}
