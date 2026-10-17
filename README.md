# Kimi C++ IDE

一款面向 **C/C++ 初学者** 的开源集成开发环境：帮你跳过繁琐的环境配置，快速上手、写出第一个程序；同时具备 **CMake 等中大型项目** 的开发能力，可以伴随你从第一课一路用到课程设计。

**Kimi C++ IDE** is an open-source IDE for **C/C++ beginners**: skip the tedious toolchain setup, get started quickly, and write your first program. It also handles **medium-to-large projects** built with CMake, so it can grow with you from lesson one to your course projects.

> ⚠️ 功能目前尚不全面，我们非常希望听到使用者的修改建议——有任何想法、问题或 bug，欢迎到 [Issues](../../issues) 提出。
> ⚠️ The feature set is still evolving. Feedback is very welcome — please open an [Issue](../../issues) for any ideas, questions, or bugs.

![License](https://img.shields.io/badge/license-MIT-blue)

## 功能特性 Features

| 模块 | 功能 |
|------|------|
| 编辑器 | 语法高亮、代码补全（含 AI 流式内联补全，Tab 接受）、查找替换、括号/同词高亮、亮/暗双主题、文件树、可拖拽分栏布局 |
| 构建运行 | 构建系统感知（单文件 g++ / Makefile / CMake+Ninja 自动识别降级），一键编译运行 |
| 调试 | gdb/MI 集成：断点、单步、监视变量、局部变量、调用栈 |
| 数据结构可视化 | 调试暂停时把 `vector` / 数组 / 链表实时画成图 |
| AI 辅助 | 流式代码补全、自然语言生成代码、从注释生成代码、编译错误 AI 一键修复（需自备 API key） |
| 工程管理 | 新建项目向导（空文件/控制台/多文件工程/课程作业模板）、文件拖拽导入、自动保存、可配置撤销步数、未保存关闭二次确认 |
| 桌面应用 | Windows 免安装包，解压即用，无需安装 Node.js |

| Module | Capabilities |
|--------|--------------|
| Editor | Syntax highlighting, code completion (incl. AI streaming inline completion, Tab to accept), find & replace, bracket/word match highlight, light/dark themes, file tree, draggable split layout |
| Build & Run | Build-system awareness (single-file g++ / Makefile / CMake+Ninja with automatic fallback), one-click compile & run |
| Debugging | gdb/MI integration: breakpoints, stepping, watch variables, locals, call stack |
| Visualization | Renders `vector` / arrays / linked lists as live diagrams while paused |
| AI assistance | Streaming completion, natural-language code generation, comment-to-code, one-click AI fix for compile errors (bring your own API key) |
| Project management | New-project wizard (empty / console / multi-file / coursework templates), drag-and-drop file import, autosave, configurable undo depth, unsaved-close confirmation |
| Desktop app | Windows portable package — unzip and run, no Node.js required |

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
