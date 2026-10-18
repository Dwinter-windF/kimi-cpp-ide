# Kimi C++ IDE

一款面向 **C/C++ 初学者** 的开源集成开发环境：帮你跳过繁琐的环境配置，快速上手、写出第一个程序；同时具备 **CMake 等中大型项目** 的开发能力，可以伴随你从第一课一路用到课程设计。

**Kimi C++ IDE** is an open-source IDE for **C/C++ beginners**: skip the tedious toolchain setup, get started quickly, and write your first program. It also handles **medium-to-large projects** built with CMake, so it can grow with you from lesson one to your course projects.

> ⚠️ 功能目前尚不全面，我们非常希望听到使用者的修改建议——有任何想法、问题或 bug，欢迎到 [Issues](../../issues) 提出。
> ⚠️ The feature set is still evolving. Feedback is very welcome — please open an [Issue](../../issues) for any ideas, questions, or bugs.

![License](https://img.shields.io/badge/license-MIT-blue)

## 功能特性 Features

| 模块 | 功能 |
|------|------|
| 编辑器 | 语法高亮、代码补全（含 AI 流式内联补全，Tab 接受）、**15 个内置代码片段**（for/class/main 等，Tab 占位跳转）、查找替换、括号/同词高亮、亮/暗双主题、**界面/编辑器独立字体与字号设置（系统字体库实时预览）**、文件树、可拖拽分栏布局 |
| 构建运行 | 构建系统感知（单文件 g++ / Makefile / CMake+Ninja 自动识别降级），一键编译运行 |
| 调试 | gdb/MI 集成：断点、单步、监视变量、局部变量、调用栈、**中断态即时求值控制台**（调试前可选开启） |
| 数据结构可视化 | 调试暂停时把 `vector` / 数组 / 链表实时画成图；`std::map`/`std::set` 键值表、手写二叉树（left/right 启发式）与二维数组网格 |
| 代码格式化 | clang-format 一键格式化（编辑器右键「格式化文档」/ `Shift+Alt+F`），自动探测 PATH 与设置页路径，支持工作区 `.clang-format`；格式化前自动保存未保存修改，结果单事务可撤销 |
| AI 辅助 | 流式代码补全、自然语言生成代码、从注释生成代码、编译错误 AI 一键修复、**AI 解释选区代码**（可插入为注释）、**自动感知当前打开文件与选区**、**AI 工具操控 IDE**（编译/运行/读取诊断/打开文件）（需自备 API key） |
| 多语言 | 界面中英双语一键切换，全部文案字典化 |
| 工程管理 | 新建项目向导（空文件/控制台/多文件工程/课程作业模板）、文件拖拽导入、自动保存、可配置撤销步数、未保存关闭二次确认 |
| 桌面应用 | Windows 免安装包，解压即用，无需安装 Node.js |

| Module | Capabilities |
|--------|--------------|
| Editor | Syntax highlighting, code completion (incl. AI streaming inline completion, Tab to accept), **15 built-in snippets** (for/class/main etc. with Tab stop navigation), find & replace, bracket/word match highlight, light/dark themes, **separate UI/editor font & size settings with live preview from the system font library**, file tree, draggable split layout |
| Build & Run | Build-system awareness (single-file g++ / Makefile / CMake+Ninja with automatic fallback), one-click compile & run |
| Debugging | gdb/MI integration: breakpoints, stepping, watch variables, locals, call stack, **in-console expression evaluation while paused** (opt-in before debug start) |
| Visualization | Renders `vector` / arrays / linked lists as live diagrams while paused; `std::map`/`std::set` key/value tables, hand-written binary trees (left/right heuristic) and 2D array grids |
| Formatting | One-click clang-format (editor context menu “Format Document” / `Shift+Alt+F`), PATH auto-detection plus a Settings path override, workspace `.clang-format` support; unsaved edits are saved first and the result is a single undoable transaction |
| AI assistance | Streaming completion, natural-language code generation, comment-to-code, one-click AI fix for compile errors, **AI explains selected code** (insertable as comment), **awareness of the current file & selection**, **AI tool control of the IDE** (compile/run/read diagnostics/open file) (bring your own API key) |
| Languages | One-click UI language switch between Chinese and English, fully dictionary-driven |
| Project management | New-project wizard (empty / console / multi-file / coursework templates), drag-and-drop file import, autosave, configurable undo depth, unsaved-close confirmation |
| Desktop app | Windows portable package — unzip and run, no Node.js required |

## 更新日志 What's New

### v1.1.0

- 🌐 **界面多语言**：中英双语一键切换，全部界面文案字典化 / UI language switch (Chinese ↔ English), all strings dictionary-driven
- 🔤 **字体系统**：设置页新增「字体」页签，界面字体与编辑器字体完全独立，字号滑块+数字输入，候选来自系统已安装字体库（300+），每项带实时预览面板与「恢复默认」 / New **Fonts** settings tab: independent UI/editor font & size, slider + numeric input, candidates from the installed system fonts (300+), live preview panels and per-item reset
- 🧩 **代码片段**：15 个内置 C++ 片段（for/fori/fore/while/do/if/elseif/switch/cin/cout/class/struct/main/forVector），Tab 展开、占位跳转 / **Snippets**: 15 built-in C++ snippets with Tab expansion and placeholder navigation
- 🤖 **AI 增强**：解释选区代码（流式讲解、可插入为注释）；自动感知当前打开文件与选区；新增 compile/run/get_problems/open_file 工具让 AI 自主操控 IDE / **AI upgrades**: explains selected code (streaming, insertable as comment); aware of the current file & selection; new compile/run/get_problems/open_file tools let the AI drive the IDE
- 🐞 **调试求值控制台**：程序中断时输入表达式即时求值（调试启动前可选开启）/ **Debug eval console**: evaluate expressions while paused (opt-in before starting debug)
- 📊 **可视化扩展**：`std::map`/`std::set` 键值表格、手写二叉树自动布局、二维数组/嵌套 vector 网格 / **Visualization**: `std::map`/`std::set` tables, auto-laid-out binary trees, 2D arrays / nested `vector` grids
- 🎨 **格式化**：clang-format 一键格式化（`Shift+Alt+F`），支持 `.clang-format` 配置 / **Formatting**: one-click clang-format (`Shift+Alt+F`), `.clang-format` support
- ⚙️ **设置页 2.0**：768px 加宽、分类页签（外观/字体/编辑器/工具链/AI）、双列自适应 / **Settings 2.0**: wider dialog (768px), categorized tabs, responsive two-column layout

## 下载 Download

从 [Releases](../../releases) 页面下载最新的 `windows.zip`，解压后运行 `Kimi C++ IDE.exe`。

Download the latest `windows.zip` from [Releases](../../releases), unzip, and run `Kimi C++ IDE.exe`.

> ⚠️ 当前版本暂未代码签名，Windows SmartScreen 可能提示「Windows 已保护你的电脑」，请选择「更多信息 → 仍要运行」。代码签名（SignPath Foundation 开源计划）申请中。
> ⚠️ This release is unsigned; SmartScreen may warn — choose "More info → Run anyway". Code signing via the SignPath Foundation OSS program is pending.

## 技术栈 Tech Stack

Electron · React 19 · TypeScript · CodeMirror 6 · Tailwind CSS · gdb/MI（ucrt64 工具链）

## 构建 Build

```bash
npm ci
npm run build
node scripts/build-server-bundle.mjs
npx electron-builder --win zip
```

CI（GitHub Actions）每次推送自动完成构建，产物见 [Actions](../../actions)。

## 代码格式化 Formatting

- **入口**：编辑器右键菜单「格式化文档」，或快捷键 `Shift+Alt+F`（VSCode 惯例）。UI 不新增工具栏按钮。
- **检测链路**：`GET /api/toolchain` 用 `where`/`which` 探测 `clang-format`；设置 → 工具链页签可填写 `clangFormatPath`（留空自动从 PATH 查找），工具栏与工具链状态区会显示是否可用。
- **风格选择**：`POST /api/format` 收到 `{file, style?}`。未显式传 `style` 时，若工作区（或文件所在目录向上）存在 `.clang-format` / `_clang-format`，使用 `-style=file` 并带 `-fallback-style=LLVM`；否则使用 `-style=LLVM`。也可显式传 `style`（如 `Google`）。
- **安全**：只格式化工作区内文件，单文件上限 2MB，clang-format 超时 10 秒；服务端只返回格式化全文、不写盘。前端在格式化前先按保存语义落盘未保存修改，成功后用单个 CodeMirror 事务替换全文（`isolateHistory` 隔离，`Ctrl+Z` 一次撤销）；失败时用提示条给出 i18n 原因。

- **Entry point**: editor context menu “Format Document” or `Shift+Alt+F` (VSCode convention). No new toolbar button.
- **Detection**: `GET /api/toolchain` probes `clang-format` with `where`/`which`; Settings → Toolchain exposes `clangFormatPath` (blank = PATH). The toolbar and toolchain status show availability.
- **Style**: `POST /api/format` accepts `{file, style?}`. Without an explicit style, a `.clang-format`/`_clang-format` found in the workspace (or above the file) selects `-style=file` with `-fallback-style=LLVM`; otherwise `-style=LLVM`. An explicit style (e.g. `Google`) is honored.
- **Safety**: workspace-only paths, 2MB file limit, 10s timeout; the server returns formatted text without writing the file. The frontend saves unsaved edits first, then replaces the document in one CodeMirror transaction (isolated history, one `Ctrl+Z`); failures are shown as localized toast messages.

## 贡献与反馈 Contributing & Feedback

本项目功能仍在持续完善中，非常欢迎：

- 到 [Issues](../../issues) 提交 bug 报告、功能建议或使用反馈
- Fork 后提交 Pull Request

Features are still being refined. Contributions are very welcome — bug reports, feature requests, and pull requests alike.

## 致谢 Credits

本项目由 **Kimi（Moonshot AI）** 与 **DSH** 协作实现。

This project was built collaboratively by **Kimi (Moonshot AI)** and **DSH**.

## 许可 License

[MIT](LICENSE)
