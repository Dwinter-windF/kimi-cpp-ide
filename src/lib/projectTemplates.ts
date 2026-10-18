/**
 * 「新建项目向导」的模板定义 + 纯函数生成逻辑。
 *
 * 设计取舍（对照需求文档）：
 *  1. 本模块**零依赖**（不 import 任何项目内模块、不碰 DOM / fetch），因此可以用
 *     `node --experimental-strip-types` 或 `tsc` 单独编译后跑 harness 直接验证 4 个模板
 *     各自产出的相对路径清单，不需要起服务、不需要浏览器。
 *  2. 落盘路径一律「工作区相对路径 + POSIX 分隔符」，与服务端 /api/fs/write、文件树
 *     `FileNode.path` 的约定完全一致（服务端 toAbs 用 path.resolve 兼容 /）。
 *  3. 模板形态分两种（见 TemplateKind）：
 *     - file   ：在工作区根目录直接生成单文件（空文件模板 → `<名字>.cpp`）；
 *     - project：生成一个项目目录（控制台 / 多文件 / 课程作业）。
 *     这样「重名自动改名」既能命中需求里点名的 `name-1.cpp` 场景，也能覆盖
 *     「整个项目目录重名」的场景。
 *  4. 编译器路径写死为本机真实的 MSYS2 UCRT64 工具链（与 cpp-ide-data/settings.json 一致），
 *     由常量 TOOLCHAIN 统一维护，避免 4 个模板各写一份路径。
 */
import { t } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// 工具链路径（.vscode 风格的 tasks.json / launch.json 用）
// ---------------------------------------------------------------------------

/** 本机实际使用的 MSYS2 UCRT64 工具链；与「设置 → 编译器路径」保持同步 */
export const TOOLCHAIN = {
  gxx: "C:\\msys64\\ucrt64\\bin\\g++.exe",
  gdb: "C:\\msys64\\ucrt64\\bin\\gdb.exe",
  /** g++ 依赖的同目录 DLL（cc1plus 等）所在目录，写进 tasks.json 的 PATH 更稳 */
  binDir: "C:\\msys64\\ucrt64\\bin",
} as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 4 个模板的 id */
export type ProjectTemplateId = "empty" | "console" | "multi" | "homework";

/** 模板形态：file = 工作区根目录单文件；project = 一个项目目录 */
export type TemplateKind = "file" | "project";

/** 模板产出的单个文件（path 为工作区相对路径，POSIX 分隔符） */
export interface TemplateFile {
  path: string;
  content: string;
}

/** 生成结果：root 是「重名判定的单位」（file → 文件名；project → 目录名） */
export interface GeneratedProject {
  kind: TemplateKind;
  /** 最终落地的根名（可能已被自动改名，如 demo → demo-1） */
  root: string;
  /** 主文件的工作区相对路径（创建完成后自动打开它） */
  mainPath: string;
  /** 需要写入的全部文件（工作区相对路径） */
  files: TemplateFile[];
}

/** 模板元信息 + 生成函数 */
export interface ProjectTemplate {
  id: ProjectTemplateId;
  /** 卡片标题 */
  label: string;
  /** 卡片上的一句话简介 */
  summary: string;
  /** 卡片展开后的要点（逐行） */
  bullets: string[];
  kind: TemplateKind;
  /** 名称输入框的默认值 */
  defaultName: string;
  /** 名称输入框的标签 */
  nameLabel: string;
  /** 名称输入框的占位符 */
  namePlaceholder: string;
  /** 相对「模板根」的文件清单；调用方（buildTemplate）负责拼上项目目录前缀 */
  files: (root: string) => TemplateFile[];
  /** 相对「模板根」的主文件路径 */
  mainFile: string;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 生成 JSON 文件内容：交给 JSON.stringify 转义，杜绝手写反斜杠出错 */
function jsonFile(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** 把「相对模板根」的清单拼成「工作区相对路径」清单 */
function underProject(root: string, rel: TemplateFile[]): TemplateFile[] {
  return rel.map((f) => ({ path: `${root}/${f.path}`, content: f.content }));
}

function text(lines: string[]): string {
  // 统一以换行符结尾：Windows 记事本 / 部分工具对无尾换行的文件不友好
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 模板 1：空文件
// ---------------------------------------------------------------------------

/** 最简可编译骨架（int main + TODO），不带 iostream，保证 -Wall 下零警告 */
function emptyMain(name: string): string {
  return text([
    `// ${name} —— 空文件模板（由「新建项目向导」生成）`,
    "// 最简可编译骨架：直接点工具栏的编译/运行即可通过",
    "",
    "int main() {",
    "    // TODO: 在这里开始写你的代码",
    "    return 0;",
    "}",
  ]);
}

// ---------------------------------------------------------------------------
// 模板 2：控制台程序（main.cpp + .vscode 风格配置）
// ---------------------------------------------------------------------------

function consoleMain(root: string): string {
  return text([
    "#include <iostream>",
    "",
    `// 控制台程序模板：${root}（由「新建项目向导」生成）`,
    "int main() {",
    `    std::cout << "Hello, ${root}!" << std::endl;`,
    "    return 0;",
    "}",
  ]);
}

/**
 * VS Code 编译任务（.vscode/tasks.json）。
 * 取舍：
 *  - command 用本机真实的 g++ 绝对路径（TOOLCHAIN.gxx），不依赖 PATH；
 *  - 路径变量用 ${workspaceFolder}，把项目目录整个搬到别处/别的机器也能用；
 *  - options.env.PATH 补上 C:\msys64\ucrt64\bin：g++ 需要能找到同目录下的 cc1plus / DLL；
 *  - problemMatcher 用内置 $gcc，错误可被 VS Code 的「问题」面板解析。
 */
function tasksJson(projectName: string): string {
  return jsonFile({
    version: "2.0.0",
    tasks: [
      {
        label: `编译 ${projectName}`,
        type: "shell",
        command: TOOLCHAIN.gxx,
        args: [
          "-g",
          "-std=c++17",
          "-Wall",
          "main.cpp",
          "-o",
          `\${workspaceFolder}/build/\${workspaceFolderBasename}.exe`,
        ],
        options: {
          cwd: "${workspaceFolder}",
          env: { PATH: `${TOOLCHAIN.binDir};\${env:PATH}` },
        },
        group: { kind: "build", isDefault: true },
        problemMatcher: ["$gcc"],
        presentation: { reveal: "always", panel: "shared", clear: true },
      },
    ],
  });
}

/** VS Code 调试配置（.vscode/launch.json）：preLaunchTask 与上面的编译任务同名，F5 一键编译+调试 */
function launchJson(projectName: string): string {
  return jsonFile({
    version: "0.2.0",
    configurations: [
      {
        name: `调试 ${projectName} (gdb)`,
        type: "cppdbg",
        request: "launch",
        program: `\${workspaceFolder}/build/\${workspaceFolderBasename}.exe`,
        args: [],
        stopAtEntry: false,
        cwd: "${workspaceFolder}",
        environment: [{ name: "PATH", value: `${TOOLCHAIN.binDir};\${env:PATH}` }],
        externalConsole: false,
        MIMode: "gdb",
        miDebuggerPath: TOOLCHAIN.gdb,
        setupCommands: [
          { description: "为 gdb 启用整齐打印", text: "-enable-pretty-printing", ignoreFailures: true },
        ],
        preLaunchTask: `编译 ${projectName}`,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// 模板 3：多文件工程（三件式：main.cpp + src/*.cpp + include/*.h）
// ---------------------------------------------------------------------------

/**
 * 头文件包含路径的取舍：
 * 本 IDE 的「工程模式编译」固定用 `-I <工作区根>`（见 dev-server.ts compileSingleFile），
 * 而项目模板生成在 `<工作区根>/<项目名>/` 这一层，所以 `#include "calculator.h"` 是找不到的。
 * 这里统一写成「相对于包含它的源文件」的路径：
 *   - main.cpp（项目根）      → "include/calculator.h"
 *   - src/calculator.cpp     → "../include/calculator.h"
 * 这样无论项目放在工作区哪一层、有没有 -I，g++ 都能按「先搜当前文件所在目录」的规则找到头文件。
 */
function multiMain(): string {
  return text([
    "#include <iostream>",
    "",
    '#include "include/calculator.h"',
    "",
    "int main() {",
    "    Calculator calc;",
    "    std::cout << \"3 + 4 = \" << calc.add(3, 4) << std::endl;",
    "    std::cout << \"3 * 4 = \" << calc.mul(3, 4) << std::endl;",
    "    std::cout << \"3 - 4 = \" << calc.sub(3, 4) << std::endl;",
    "    std::cout << \"7 / 2 = \" << calc.div(7, 2) << std::endl;",
    "    return 0;",
    "}",
  ]);
}

/** 头文件用 #pragma once 而非 include guard：同一工作区里多个项目模板并存时不会宏冲突 */
function multiHeader(): string {
  return text([
    "#pragma once",
    "",
    "/** 计算器：多文件工程模板的示例类（声明放 include/，实现放 src/） */",
    "class Calculator {",
    "public:",
    "    int add(int a, int b) const;",
    "    int sub(int a, int b) const;",
    "    int mul(int a, int b) const;",
    "    /** 整数除法；除数为 0 时返回 0（避免崩溃，示例从简） */",
    "    int div(int a, int b) const;",
    "};",
  ]);
}

function multiSource(): string {
  return text([
    '#include "../include/calculator.h"',
    "",
    "int Calculator::add(int a, int b) const { return a + b; }",
    "int Calculator::sub(int a, int b) const { return a - b; }",
    "int Calculator::mul(int a, int b) const { return a * b; }",
    "int Calculator::div(int a, int b) const { return b == 0 ? 0 : a / b; }",
  ]);
}

// ---------------------------------------------------------------------------
// 模板 4：课程作业（多文件工程 + README.md）
// ---------------------------------------------------------------------------

/**
 * README.md：按「.vscode / VS Code 项目文档」的常见写法组织
 * （标题 → 作业要求占位 → 构建与运行 → 目录结构），方便学生直接当作业报告交。
 */
function homeworkReadme(root: string): string {
  return text([
    `# ${root}（课程作业）`,
    "",
    "> 本文件由 IDE「新建项目向导」生成。请把下面的占位内容替换成你的真实信息。",
    "",
    "## 一、作业要求",
    "",
    "- 题目：（在此填写题目 / 题目来源）",
    "- 输入说明：（在此填写程序接受的输入）",
    "- 输出说明：（在此填写程序的预期输出）",
    "- 提交截止时间：（在此填写）",
    "",
    "## 二、构建与运行",
    "",
    "在本目录下用 MSYS2 UCRT64 的 g++ 编译（本 IDE 的编译器路径）：",
    "",
    "```bash",
    `${TOOLCHAIN.gxx} -g -std=c++17 -Wall main.cpp src/*.cpp -o build/${root}.exe`,
    `./build/${root}.exe`,
    "```",
    "",
    "在本 IDE 里：打开 `main.cpp`，点工具栏「构建整个工程并运行」（工程模式会把工作区里所有",
    `\`.cpp\` 一起编译链接），或使用 VS Code 的「运行生成任务」（Ctrl+Shift+B → 编译 ${root}）。`,
    "",
    "## 三、目录结构",
    "",
    "```",
    `${root}/`,
    "├── main.cpp              # 主程序（程序入口，不要在这里写业务实现）",
    "├── include/",
    "│   └── calculator.h      # 头文件：类/函数的声明",
    "├── src/",
    "│   └── calculator.cpp    # 源文件：头文件里声明的实现",
    "└── README.md             # 本文件",
    "```",
    "",
    "## 四、提交说明（可选）",
    "",
    "1. 保留 `include/` 与 `src/` 分离的写法，评分时会看代码组织；",
    "2. 提交前确认 `构建整个工程并运行` 能通过，且没有编译警告。",
  ]);
}

// ---------------------------------------------------------------------------
// 模板表
// ---------------------------------------------------------------------------

/** 4 个模板（顺序 = 对话框里的卡片顺序） */
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "empty",
    label: "空文件",
    summary: "一个最小的 .cpp，只有 int main 骨架",
    bullets: ["在工作区根目录直接生成 <名字>.cpp", "内容只有 int main + TODO 注释", "适合练习语法 / 临时验证代码"],
    kind: "file",
    defaultName: "main",
    nameLabel: "文件名",
    namePlaceholder: "如 main（默认生成 main.cpp）",
    mainFile: "", // 由 buildTemplate 填成 <名字>.cpp
    files: (root) => [{ path: root, content: emptyMain(root) }],
  },
  {
    id: "console",
    label: "控制台程序",
    summary: "main.cpp + .vscode 编译/调试配置（tasks.json、launch.json）",
    bullets: [
      "生成项目目录：<名字>/main.cpp",
      ".vscode/tasks.json（g++ 编译任务）+ launch.json（gdb 调试）",
      "编译器路径按本机 MSYS2 UCRT64 写死，开箱可用",
    ],
    kind: "project",
    defaultName: "hello",
    nameLabel: "项目名",
    namePlaceholder: "如 hello（生成 hello/ 目录）",
    mainFile: "main.cpp",
    files: (root) => [
      { path: "main.cpp", content: consoleMain(root) },
      { path: ".vscode/tasks.json", content: tasksJson(root) },
      { path: ".vscode/launch.json", content: launchJson(root) },
    ],
  },
  {
    id: "multi",
    label: "多文件工程",
    summary: "main.cpp + include/xxx.h + src/xxx.cpp 三件式",
    bullets: [
      "生成项目目录：<名字>/（main.cpp、include/、src/）",
      "示例类 Calculator：声明与实现分离",
      "工程模式编译（g++ 编译所有 .cpp）可直接跑",
    ],
    kind: "project",
    defaultName: "calculator",
    nameLabel: "项目名",
    namePlaceholder: "如 calculator（生成 calculator/ 目录）",
    mainFile: "main.cpp",
    files: () => [
      { path: "main.cpp", content: multiMain() },
      { path: "include/calculator.h", content: multiHeader() },
      { path: "src/calculator.cpp", content: multiSource() },
    ],
  },
  {
    id: "homework",
    label: "课程作业模板",
    summary: "多文件工程 + README.md（作业要求 / 构建运行 / 目录结构）",
    bullets: [
      "多文件工程的完整三件式结构",
      "README.md：作业要求占位 + 构建运行说明 + 目录结构",
      "适合直接把目录打包当作课程作业提交",
    ],
    kind: "project",
    defaultName: "homework",
    nameLabel: "作业/项目名",
    namePlaceholder: "如 homework（生成 homework/ 目录）",
    mainFile: "main.cpp",
    files: (root) => [
      { path: "main.cpp", content: multiMain() },
      { path: "include/calculator.h", content: multiHeader() },
      { path: "src/calculator.cpp", content: multiSource() },
      { path: "README.md", content: homeworkReadme(root) },
    ],
  },
] as const;

/** 按 id 取模板；id 非法时返回 undefined（调用方负责中文报错） */
export function getTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// 名称校验 / 重名自动改名（纯函数，便于 harness 覆盖）
// ---------------------------------------------------------------------------

/** Windows 保留设备名：主名命中即不可用（CON / NUL / COM1…，带扩展名同样被占用） */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Windows 文件名非法字符（控制字符单独用 hasControlChar 判断，避免正则里出现 \x00-\x1f） */
const ILLEGAL_CHAR = /[<>:"/\\|?*]/;

/** 是否含 C0 控制字符（粘贴进来的换行 / 制表符等） */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    if ((ch.codePointAt(0) ?? 0) < 0x20) return true;
  }
  return false;
}
/** 空文件模板认可的后缀 */
const CPP_EXT = /\.(cpp|cc|cxx|c)$/i;

/**
 * 校验名称，非法时返回中文提示（合法返回 undefined）。
 * 规则与 Windows 实际文件系统一致，避免「明明非法却写到一半才失败」。
 */
export function validateProjectName(raw: string, kind: TemplateKind): string | undefined {
  const name = raw.trim();
  if (!name) return t("templateValidate.required");
  if (name.length > 60) return t("templateValidate.tooLong", { length: name.length });
  if (ILLEGAL_CHAR.test(name) || hasControlChar(name)) {
    return t("templateValidate.illegal");
  }
  if (/[. ]$/.test(name)) return t("templateValidate.endDot");
  if (/^\.+$/.test(name)) return t("templateValidate.onlyDots");
  if (kind === "file" && /\.[^.]*$/.test(name) && !CPP_EXT.test(name)) {
    return t("templateValidate.ext");
  }
  const stem = kind === "file" ? name.replace(CPP_EXT, "") : name;
  if (RESERVED_NAME.test(stem)) return t("templateValidate.reserved", { name: stem });
  return undefined;
}

/**
 * 把用户输入拆成「基名 + 扩展名」。
 *  - file   ：`main` → main + .cpp；`main.cpp` → main + .cpp（不重复加后缀）
 *  - project：目录名没有扩展名（`demo.v2` 里的点属于名字本身）
 */
export function splitRootName(kind: TemplateKind, raw: string): { stem: string; ext: string } {
  const name = raw.trim();
  if (kind === "file") {
    if (CPP_EXT.test(name)) return { stem: name.replace(CPP_EXT, ""), ext: name.slice(name.lastIndexOf(".")) };
    return { stem: name, ext: ".cpp" };
  }
  return { stem: name, ext: "" };
}

/**
 * 重名自动改名：name → name-1 → name-2 …（最多 999 次，与拖拽上传的 uniquePath 同规则）。
 *
 * 为什么选「自动改名」而不是「询问是否覆盖」：
 *  - 与既有的拖拽导入（/api/fs/upload）行为一致，用户不需要为新建项目再理解一套覆盖语义；
 *  - /api/fs/write 本身是「无条件覆盖」语义（AI 写文件用），一旦误判就会静默毁掉用户代码，
 *    自动改名把「误覆盖」这条路径彻底堵死，代价只是名字后面多个 -1。
 *
 * @param taken 判定「给定的根名是否已被占用」（大小写不敏感由调用方实现）
 */
export function uniqueRootName(
  stem: string,
  ext: string,
  taken: (rootName: string) => boolean,
  limit = 999
): { root: string; renamed: boolean; exhausted: boolean } {
  if (!taken(`${stem}${ext}`)) return { root: `${stem}${ext}`, renamed: false, exhausted: false };
  for (let i = 1; i <= limit; i++) {
    const root = `${stem}-${i}${ext}`;
    if (!taken(root)) return { root, renamed: true, exhausted: false };
  }
  return { root: `${stem}-${limit}${ext}`, renamed: true, exhausted: true };
}

// ---------------------------------------------------------------------------
// 生成入口
// ---------------------------------------------------------------------------

/**
 * 生成模板文件清单。
 * @param id   模板 id
 * @param root 最终根名：file 模板传完整文件名（`main.cpp`）；project 模板传目录名（`demo-1`）
 * @throws 模板 id 非法时抛错（调用方应先 getTemplate 校验）
 */
export function buildTemplate(id: string, root: string): GeneratedProject {
  const tpl = getTemplate(id);
  if (!tpl) throw new Error(`未知模板：${id}`);
  const kind = tpl.kind;
  const rel = tpl.files(root);
  const files = kind === "project" ? underProject(root, rel) : rel;
  const mainPath = kind === "project" ? `${root}/${tpl.mainFile}` : root;
  return { kind, root, mainPath, files };
}

/**
 * 只算路径清单（不含内容大小），给对话框做「将创建 N 个文件」预览与 harness 断言用。
 */
export function templatePaths(id: string, root: string): string[] {
  return buildTemplate(id, root).files.map((f) => f.path);
}

/**
 * 创建编排（store.createProject）的结果：对话框与终端摘要据此显示中文提示。
 */
export interface CreateProjectResult {
  /** true = 全部文件都写入成功 */
  ok: boolean;
  /** 模板标题 */
  label?: string;
  /** 最终落地的根名（file = 文件名；project = 目录名） */
  root?: string;
  /** 是否发生了重名自动改名 */
  renamed?: boolean;
  /** 改名前的原始根名（renamed = true 时有意义） */
  originalRoot?: string;
  /** 创建后自动打开的路径（主文件写失败时为第一个写成功的文件） */
  mainPath?: string;
  /** 写入成功的文件（工作区相对路径，按写入顺序） */
  created: string[];
  /** 写入失败的文件 + 中文原因 */
  failed: { path: string; reason: string }[];
  /** 整体失败（名称非法 / 目录建不出来 / 改名超限 / 一个文件都没写成功）时的中文原因 */
  error?: string;
}
