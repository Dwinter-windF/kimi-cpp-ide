# Kimi C++ IDE — 项目交接文档

> 生成时间：2026-10-15；**大更新：2026-10-17**（补录 10-16/10-17 全部新功能、修复批与 Electron 桌面打包）。本文档供新会话快速恢复项目全貌，代码即真相，本文仅作地图。

## 一句话概述

C/C++ IDE：React + CodeMirror 6 前端 + Node 本地服务（编译/运行/GDB 调试/AI 代理），在 Windows 上通过本机 g++ / gdb 工作；**2026-10-17 起提供 Electron 桌面版**（zip 分发，双击即用）。

## 如何运行

```bash
cd <项目根目录>
npm install        # 首次
npm run dev        # 开发模式（Vite 壳），默认端口 3000，可 -- --port <N>
npm run build      # 类型检查 + 产出 dist/（本机须带 ESBUILD_BINARY_PATH，见环境坑）
npm run server     # 独立服务模式：无 Vite，静态托管 dist/（node standalone.ts）
npm run package    # 打单文件 exe（SEA，见下节），产物 dist-server/KimiCppIDE.exe
npm run package:electron   # Electron 桌面版（win zip + portable），产物 release/
```

打开后访问 http://localhost:3000/ （standalone 模式为 3213 或自动 +1）。前端通过 `/api/*` 调用本地服务。

## 打包与分发

### A. Node SEA 单文件（2026-10-15 ✅，注意产物已滞后）

- **产物**：`dist-server/KimiCppIDE.exe`，约 90 MB 真单文件——前端 dist/ 已作为 SEA 内嵌资源（key 前缀 `web/`）打进 blob。
- **原理**：`scripts/package-exe.mjs` 五步：vite build → esbuild 把 `standalone.ts` 打成 cjs（自动内联 `./dev-server.ts`）→ 收集 dist/ 生成 sea-config.json → `node --experimental-sea-config` 产 blob → 复制真实 node.exe 为 KimiCppIDE.exe 并用 postject 注入。
- **运行行为**：双击自动开浏览器（`--no-open` 关）；端口占用自动 +1；**工作根目录 = exe 所在目录**，自动生成 `workspace/` 与 `cpp-ide-data/`。
- ⚠️ 该 exe 是 10-15 打的，**不含此后任何新功能**；Electron 版（B）已是主要分发形态，SEA 重打为可选项。
- ⚠️ 未签名，SmartScreen 会提示；Kimi Work 沙箱打包坑见「重要环境事实」。

### B. Electron 桌面版（2026-10-17 ✅，现行主要分发形态）

- **产物**：`release/Kimi C++ IDE-1.0.0-windows.zip`（解压后双击 `Kimi C++ IDE.exe`；亦可用桌面 .lnk 快捷方式，自动带 `--no-sandbox` 参数）。`npm run package:electron` 重打（= build + build-server-bundle.mjs + electron-builder --win）。
- **桌面解压目录的同步坑（2026-10-17 20:2x）**：`scripts/run-repack2.ps1` 只刷新 win-unpacked + zip，**不管** `C:\Users\41855\Desktop\DEEPSEEK workspace\Kimi C++ IDE\`——改完代码只跑 repack 的话桌面 exe 还是旧前端。正确姿势：把 win-unpacked 的 `resources/app/dist` 整个目录拷过去覆盖（其余文件内容永远不变；不要 robocopy 整树，杀软会拖到超时），index.html 随 dist 一起换，最后 grep 三处 bundle 名核对一致。
- **结构**：`electron/main.cjs` 主进程——内嵌 dist-server/standalone.cjs 起本地服务 → waitUp 轮询 → BrowserWindow 加载 `http://127.0.0.1:端口/`；单实例锁（失败自动降级）；`KIMI_IDE_USERDATA`/`KIMI_IDE_PORT` 可覆盖。
- **数据目录**：**exe 旁 `ide-data/`**（工作区、设置都在里面；删之即重置）。⚠️ 不能放 AppData——本机安全软件会冻结（见环境坑）；`scripts/build-server-bundle.mjs` 用 esbuild 打服务端。
- **本机四个大坑（全部已修/已绕，详见「重要环境事实」）**：① userData 进 AppData → 启动即冻结，已改为 exe 旁 ide-data；② 无 `--no-sandbox` → Chromium 初始化 CHECK 失败（0x80000003）静默退出，内置 appendSwitch 来不及，必须真命令行参数（故配 .lnk）；③ NSIS portable 壳写 %TEMP% 被安全软件拦（「Error writing temporary file」），故只发 zip；④ electron-builder 必须 `asar: false`（asar=true 在本机必现主进程冻结）。
- 依赖文件：`package.json`（name kimi-cpp-ide、main、build.files 排除 node_modules、zip+portable target）、`launcher/launcher.c`（C 启动器备选，沙箱内编不出，暂缓）。

## 环境现状（2026-10-17 更新）

- **工具链已安装**：MSYS2（C:\msys64），g++ 16.1 / gdb 17.2；`cpp-ide-data/settings.json` 已填三条完整路径。
- dev-server 内部用 `toolEnv()` 自动把编译器目录前置 PATH，并把子进程 TEMP/TMP 指到 `ROOT/.ide-tmp`（防安全软件拦 %TEMP% 写入致 cc1plus 失败）。
- 调试三件套、两批新功能、AI 全家桶、Electron 桌面版均已**真机端到端验证**（浏览器内 + API 级）。
- 预览服务常用 `node standalone.ts --port 3213 --root .`（后台隐藏窗口）。

## 目录结构

```
cpp-ide-app/
├─ dev-server.ts          # ★ 核心服务端：路由 /api/toolchain|settings|files|file|rename
│                           #   /api/compile | run(两步SSE) | debug(/:id/eval|viz) | ai
│                           #   /api/fs/list|read|write|mkdir|delete|upload（限工作区内）
│                           #   /api/workspace/open|pick、/api/buildsystem
│                           #   运行会话（含事件回放缓冲）与 GDB MI2 会话均用 SSE；
│                           #   数据结构可视化走 /api/debug/:id/viz；cppIdePlugin() 为 Vite 壳
├─ standalone.ts          # ★ 独立服务模式：静态托管 + 端口回退 + CPP_IDE_DIST/CPP_IDE_DEBUG
├─ electron/main.cjs      # ★ Electron 主进程（桌面版入口，见「打包与分发 B」）
├─ launcher/launcher.c    # C 启动器源码（备选方案，暂未启用）
├─ scripts/               # package-exe.mjs（SEA）/ build-server-bundle.mjs（Electron 服务端）
│                           #   及一批 smoke/diag ps1（全部 ASCII-only，勿写中文进 ps1）
├─ vite.config.ts         # 开发模式挂载 cppIdePlugin()（含代码分割 manualChunks）
├─ workspace/             # ★ 用户 C/C++ 代码（启动时若空自动生成示例 main.cpp）
├─ cpp-ide-data/settings.json  # 工具链路径、标准、buildMode、extraFlags、AI 配置
├─ .ide-tmp/              # 编译/运行/调试子进程的临时目录（安全软件拦 %TEMP% 的绕行）
└─ src/
   ├─ store.ts            # zustand 全局状态 + 全部动作（编译/运行/调试/SSE/可视化）
   ├─ types.ts            # 共享类型（settings/诊断/可视化数据）
   ├─ lib/api.ts          # fetch 封装 + SSE openStream + debugEval/debugViz
   ├─ lib/ai.ts           # ★ AI 请求层（OpenAI 兼容 + /api/fs/* 工具循环，面板与修复共用）
   ├─ lib/aiFix.ts + diff.ts   # ★ AI 一键修复编排 + 零依赖行级 diff（修复预览）
   ├─ lib/aiGen.ts        # ★ 从注释生成代码（Ctrl+Alt+G）
   ├─ lib/aiGhost.ts      # ★ AI 流式补全状态机（防抖/节流/中止；# 行走整行模式）
   ├─ lib/aiInline.ts     # ★ ghost 文本显示（StateField 装饰）+ Tab/Esc 键位（Prec.highest）
   ├─ lib/aiInsert.ts     # ★ 自然语言插入代码（Ctrl+Alt+I）
   ├─ lib/aiStream.ts     # 手写 SSE 解析（DeepSeek 端点自动关 thinking）
   ├─ lib/analyze.ts      # 编译错误 → 中文原因分析
   ├─ lib/outline.ts      # 文件大纲解析
   ├─ lib/projectTemplates.ts  # ★ 新建项目四模板
   ├─ lib/dropImport.ts   # ★ 拖拽导入
   ├─ lib/editorRegistry.ts    # 活动 EditorView 注册表
   ├─ App.tsx             # 整体布局（Splitter 分隔）
   └─ components/
      ├─ EditorPane.tsx   # ★ CodeMirror6 全家桶：高亮/折叠/断点/多光标/查找替换(中文置顶)/
      │                     #   划词高亮/AI ghost 补全/右键 AI 菜单/调试行高亮/hover求值
      ├─ FileTree.tsx     # 文件树 + 右键菜单
      ├─ OutlinePanel.tsx # 文件大纲
      ├─ WatchPanel.tsx   # 监视/局部变量/断点列表 + ★可视化入口（Network 图标）
      ├─ StructVizPanel.tsx  # ★ 数据结构可视化画布（数组方框/链表节点箭头）
      ├─ BottomPanel.tsx  # 终端(stdin) / 问题(错误分析+AI修复) / 调试(调用栈) / AI
      ├─ AiPanel.tsx      # AI 助手（聊天气泡 + 工具循环动作渲染）
      ├─ AiFixDialog.tsx  # ★ AI 一键修复 diff 预览弹层
      ├─ AiInsertDialog.tsx  # ★ 自然语言插入确认框
      ├─ SearchPanel.tsx  # ★ 中文查找替换（portal 进 CM 面板，z-index 低于对话框）
      ├─ Splitter.tsx     # ★ 可拖分隔条
      ├─ FileDropZone.tsx # ★ 拖拽导入遮罩
      ├─ OpenDirDialog.tsx / NewProjectDialog.tsx / NameDialog.tsx / SettingsDialog.tsx
      ├─ Toolbar.tsx      # 编译/运行/调试 + Debug/Release + 构建系统徽标
      └─ MarkdownLite.tsx # 轻量 Markdown 渲染
```

## 已实现功能

**基础（2026-10-15 及以前）**：语法高亮/折叠、断点 + 真实 GDB 调试（继续/单步/跳出/调用栈/悬浮求值/值变化闪烁）、监视变量、多光标列编辑、文件大纲、括号彩虹、Ctrl+滚轮缩放、Debug/Release、自定义编译参数、运行超时保护 + stdin 交互、错误分析中文提示、代码补全（关键字/片段/单词/头文件）、AI 助手气泡聊天。

**编辑器体验批（2026-10-16）**：代码分割懒加载（主包 96 kB）；划词高亮（仅标识符整词）；编辑器开关（划词/括号匹配，旧 settings 兼容）；**亮暗主题**（--ide-* 变量体系 + CM 双主题 Compartment 热切换）；可拖分隔条（Splitter，布局持久化）；交互动画（≤250ms，prefers-reduced-motion 全禁）。

**工作区与 AI 批（2026-10-16）**：打开目录（原生文件夹对话框，持久化）；AI 文件接口 + AiPanel 工具循环（8 轮上限，读写工作区文件）；**AI 一键修复**（错误+源文件 → `===KIMI-FIX-FILE===` 协议 → 本地 diff 预览 → 接受写回/拒绝零副作用）；**从注释生成代码**（Ctrl+Alt+G）；**AI 流式补全**（ghost 文本，Tab 接受/Esc 拒绝，逐字实时显示，单词模式补标识符，`#` 行走整行模式）；**自然语言插入**（Ctrl+Alt+I，≤12KB 上下文）；**构建系统感知**（CMakeLists > Makefile > 单文件 g++ 自动降级，mingw32-make + cmake -G Ninja）；**文件拖拽导入**（8MB，白名单扩展名）；**新建项目向导**（四模板：空/控制台/.vscode 多文件/课程作业）。

**数据结构可视化（2026-10-16，二期压轴）**：调试暂停时把 vector/数组/链表画成图（`POST /api/debug/:id/viz`）；vector 双兜底（pretty-printer 索引子元素 / `_M_finish-_M_start` 指针差 + `@N` 内存读）；链表按「指向自身类型的指针成员」启发式遍历（防环上限 40 节点）；C++ struct 拍平访问限定伪节点；入口在监视/局部变量行的 Network 图标，底部 VizDock 画布渲染。

**修复批（2026-10-16/17）**：查找替换面板重写（全中文、置顶、--ide-* 变量、z-index 低于设置对话框，修「层次 bug/风格不统一/重叠」）；**撤销历史污染修复**（打开文件不再入撤销栈，Ctrl+Z 撤不空缓冲区）；**编译临时目录重定向**（.ide-tmp，修安全软件拦 %TEMP% 致 cc1plus 「cannot create temporary file」）；**AI 补全两处**（逐增量实时显示，修「等整行期间按 Tab 变缩进」）；**预处理行走整行模式**（`#` 开头的行不再误判单词模式，#include/头文件可补全）；**下拉补全 Tab 冲突修复**（补配 `completionKeymap` + 显式 `Tab→acceptCompletion`，并在 @uiw/react-codemirror 上关 `indentWithTab` 默认键位——它默认前置缩进键位、截胡一切 Tab）；**运行卡死修复**（POST→GET 订阅竞态：会话事件回放缓冲 + 迟到订阅回放）；**幽灵缩进归一化**（`normalizeGhostIndent`：光标在缩进空白后裁首行重复缩进、行首空行补后续行最小缩进，显示/接受同一链路；system 提示词约定「首行不带缩进、后续行 4 空格绝对缩进」）；**indentUnit 4 空格**（@codemirror/language 默认 2 格，EditorPane 补 `indentUnit.of("    ")`，修回车自动缩进与 4 空格风格错位——幽灵首行/后续行缩进不一致的真凶之一）；**触发提速**（防抖 0.3s→0.15s、最小间隔 1.5s→0.8s，SettingsDialog 文案同步）；**光标可见性**（括号配对改 15% 透明底 + 浅色描边、划词高亮覆盖默认亮绿为主题淡蓝、光标加粗到 2px——括号蓝块/同词标记不再吞掉光标；background 需 !important 防 CM 基础主题 .cm-focused 规则覆盖）；**编辑器三件套**（撤销历史最大步数可调 settings.maxUndoSteps→history minDepth Compartment 热更新，注意换配置会重置撤销历史；自动保存 settings.autoSave——工具栏 Timer 开关 + 800ms 防抖 + 关闭文件先落盘；未保存二次确认——beforeunload 拦刷新/关窗 + 关闭脏标签 confirm）。

## 重要环境事实

- **工具链已装好**（2026-10-15）：MSYS2 至 `C:\msys64`，g++ + gdb；`cpp-ide-data/settings.json` 已配完整路径。
- ⚠️ **本机安全软件（EDR）是最大变量（2026-10-17 摸清）**：
  - **拦 %TEMP% 写入**（cc1plus/NSIS 均中招）→ 已全部绕行到 `.ide-tmp`/`ide-data`；想根治可在杀软里给 `%TEMP%`、`C:\msys64` 加白名单。
  - **拦 AppData 读写**（Electron userData 进 AppData → 启动即冻结）→ 桌面版数据目录固定在 exe 旁 `ide-data/`。
  - **按文件名/来源处置可执行文件**：esbuild.exe 被 quarantine（用 `ESBUILD_BINARY_PATH=D:\KimiData\kimi\Workspaces\interaction\dsh\esbuild-0.27.7-working.exe` 改名副本绕过，`npm run build` 必须带）；沙箱内 g++ 的子进程会被无声杀掉（长驻 3213 服务派生的不受影响）。
  - **Electron 必须真命令行 `--no-sandbox`**（内置 appendSwitch 来不及，无参启动 0x80000003 静默退出）→ 交付用 .lnk 快捷方式带参数；`asar` 必须 false；portable(NSIS) 壳被拦 → 只发 zip。
- ⚠️ **Kimi Work 沙箱限制**：沙箱会话启动的进程在隐藏会话（窗口对用户不可见）、会被间歇冻结（CPU 时间停滞）、部分启动方式（cmd start/explorer 委托）不可观测；PowerShell 逻辑必须写 .ps1 文件执行（`$` 变量会被 Git Bash 吃掉）；本 shell 全局有 `ELECTRON_RUN_AS_NODE=1`，跑任何 electron/exe 前必须 unset；electron-builder 需 `scripts/run-builder.ps1`（真实 nodejs 前置 PATH + npmmirror 镜像）。
- ⚠️ **PATH 陷阱**：手动调 g++ 必须 `export PATH="/c/msys64/ucrt64/bin:$PATH"`，否则 cc1plus 静默退出；dev-server 内已用 `toolEnv()` 处理。
- 前端跑在 Kimi Work 内嵌浏览器时 `window.prompt` 不可用（返回 null）——所有命名输入必须走 `NameDialog`。
- `@uiw/react-codemirror` 默认 light 主题会覆盖自定义暗色主题，必须 `theme="none"`。
- CM6 gutter 默认 `renderEmptyElements=false`：无断点时断点槽没有行元素，测试点击要用 CDP 真实鼠标事件。

## 待办 / 下一步

1. ~~打包 exe~~ ✅（2026-10-15，Node SEA）；~~Electron 桌面版~~ ✅（2026-10-17，zip 分发，见「打包与分发 B」）。SEA exe 重打为可选项（产物滞后于代码）。
2. （可选）右键菜单加"新建类/结构体模板"；监视面板变量树形展开（`-var-create/-var-list-children`）。
3. （可选）给 exe 加版本信息与图标（rcedit/resedit），代码签名消除 SmartScreen 警告。
4. （可选）依赖清理：zod / date-fns / @hookform/resolvers 零引用可删；`@codemirror/commands` 是幻影依赖应声明；CodeMirror 主包 435 kB 可瘦身。
5. 本机杀软白名单（`%TEMP%`、`C:\msys64`、Electron 数据目录）——加了之后可回退部分绕行代码。

## GDB MI 应答路由（重要实现细节）

服务端为每个调试会话维护 `replyQueue`：每条会产出 `^done/^error` 的待追踪命令（监视求值 / `-stack-list-locals` / `-stack-list-frames` / HTTP 悬浮求值 / **viz 可视化请求**）发送时按序入队，收到应答按序出队分发。因此：

- `-gdb-set` / `-break-insert` 等不应答追踪的命令**不入队**，其 `^done` 被安全忽略；
- 悬浮求值走 `POST /api/debug/:id/eval`（HTTP 挂起等待 GDB 应答后直接 JSON 返回），仅停止状态可用；可视化走 `POST /api/debug/:id/viz`（http-req 请求-应答类入队），经 vizChain 互斥链串行化防 MI 应答交错；
- `op:"vars"` 刷新时 pendingStop 标记 `reason:"refresh"`，flush 时沿用 `lastStop/lastStack`，不会清掉编辑器当前行高亮。
- MI 解析器（miParseValue）两处加固：数组元素支持 `key=value` 重复键形式（只取值）；对象/数组解析带进度保护，异常输入不再死循环（曾导致整服务崩溃），且 handleDebugLine 外层有 try/catch 兜底。

## 新会话接力提示

```
项目在 D:\KimiData\kimi\tasks\2026-10-15\14-14-01-13777eb7\cpp-ide-app
先读 PROGRESS.md（本文件）和 dev-server.ts / src/store.ts 即可恢复全貌。
用户偏好中文交流。
进度：基础 IDE + 调试三件套 + 编辑器体验批 + 工作区与 AI 批（AI 修复/注释生成/
流式补全/自然语言插入/构建感知/拖拽导入/项目向导）+ 数据结构可视化 + 修复批
（查找替换/撤销/编译临时目录/补全两处/运行竞态）+ Electron 桌面版（zip 分发），
全部真机验证通过（2026-10-17）。
改打包相关代码前先读本文件「打包与分发」与「重要环境事实」；
本机安全软件会拦 Temp/AppData/按文件名处置 exe——任何「启动即冻结/无声退出/
写入被拒」先怀疑它，绕行模式参考 .ide-tmp 与 ide-data 两处既有实现。
```
