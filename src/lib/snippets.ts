/**
 * C++ 代码片段（snippet）表 + 轻量展开器 —— 纯数据 + 纯函数，不依赖 React / CodeMirror。
 *
 * 设计目标：
 *  1. **加一行就能扩展**：常用片段全部集中在下面的 CPP_SNIPPETS 数组里，
 *     新增片段只需追加 `{ prefix, descriptionKey, body }`，不用改编辑器代码；
 *  2. 模板语法刻意只实现 VSCode snippet 的最小子集：
 *       $1 / $2 …        占位跳转点（按编号从小到大跳）
 *       ${1:默认文本}     带默认文本的占位点
 *       \n \t            换行 / 缩进（\t 会按编辑器 Tab 宽度换成空格）
 *     不支持变量、选择项、正则变换等高级语法——本 IDE 不需要；
 *  3. 缩进由展开器按**当前行缩进**补齐：模板第一行接在光标处（行首缩进已存在），
 *     后续每一行统一加上当前行缩进；模板里的 \t 再展开为编辑器配置的 Tab 宽度，
 *     因此「在函数体里输入 for + Tab」得到的循环体比 for 深一层。
 */

/** 一个可展开的代码片段（纯数据） */
export interface CppSnippet {
  /** 触发前缀：输入完整前缀后按 Tab，或在补全下拉里选中 */
  readonly prefix: string;
  /** 描述文案的 i18n key（中英字典各一份） */
  readonly descriptionKey: string;
  /**
   * 模板体：`$1` / `$2` 为占位跳转点，`${1:默认值}` 可带默认文本；
   * `\t` 表示相对缩进，`\n` 表示换行。第一行不要写缩进（接在光标处）。
   */
  readonly body: string;
}

/**
 * 内置 C++ 常用片段（15 个）。
 * 新增片段 = 在数组里加一行；prefix 必须唯一（查找按数组顺序取第一个）。
 */
export const CPP_SNIPPETS: readonly CppSnippet[] = [
  {
    prefix: "for",
    descriptionKey: "editor.snippet.for",
    body: "for (int i = 0; i < $1; i++) {\n\t$2\n}",
  },
  {
    prefix: "fori",
    descriptionKey: "editor.snippet.forIndex",
    body: "for (int i = 0; i < $1; ++i) {\n\t$2\n}",
  },
  {
    prefix: "fore",
    descriptionKey: "editor.snippet.forRange",
    body: "for (const auto &$1 : $2) {\n\t$3\n}",
  },
  {
    prefix: "while",
    descriptionKey: "editor.snippet.while",
    body: "while ($1) {\n\t$2\n}",
  },
  {
    prefix: "do",
    descriptionKey: "editor.snippet.do",
    body: "do {\n\t$1\n} while ($2);",
  },
  {
    prefix: "if",
    descriptionKey: "editor.snippet.if",
    body: "if ($1) {\n\t$2\n}",
  },
  {
    prefix: "elseif",
    descriptionKey: "editor.snippet.elseif",
    body: "else if ($1) {\n\t$2\n}",
  },
  {
    prefix: "switch",
    descriptionKey: "editor.snippet.switch",
    body: "switch ($1) {\ncase $2:\n\t$3\n\tbreak;\ndefault:\n\tbreak;\n}",
  },
  {
    prefix: "cin",
    descriptionKey: "editor.snippet.cin",
    body: "std::cin >> $1;",
  },
  {
    prefix: "cout",
    descriptionKey: "editor.snippet.cout",
    body: "std::cout << $1 << std::endl;",
  },
  {
    prefix: "class",
    descriptionKey: "editor.snippet.class",
    body: "class $1 {\npublic:\n\t$2\n\nprivate:\n\t$3\n};",
  },
  {
    prefix: "struct",
    descriptionKey: "editor.snippet.struct",
    body: "struct $1 {\n\t$2\n};",
  },
  {
    prefix: "main",
    descriptionKey: "editor.snippet.main",
    body: "int main() {\n\t$1\n\treturn 0;\n}",
  },
  {
    prefix: "forv",
    descriptionKey: "editor.snippet.forVector",
    body: "for (size_t i = 0; i < $1.size(); ++i) {\n\t$2\n}",
  },
  {
    prefix: "vector",
    descriptionKey: "editor.snippet.vector",
    body: "std::vector<$1> $2;",
  },
];

/** 按前缀查找片段（大小写不敏感；找不到返回 undefined） */
export function findSnippet(prefix: string): CppSnippet | undefined {
  const p = prefix.trim().toLowerCase();
  if (!p) return undefined;
  return CPP_SNIPPETS.find((s) => s.prefix === p);
}

/** 一个已解析出的占位点：在展开后文本中的区间（from === to 表示空占位） */
export interface SnippetPlaceholder {
  index: number;
  from: number;
  to: number;
}

export interface ParsedSnippet {
  /** 去掉 $ 标记后的最终文本 */
  text: string;
  /** 按编号升序排列的占位点（编号相同的重复占位按出现顺序保留） */
  placeholders: SnippetPlaceholder[];
}

/**
 * 解析模板：把 $1 / ${1:默认} 替换成默认文本（没有默认文本就是空串），
 * 同时记录每个占位点在「结果文本」里的区间。
 *
 * 说明：
 *  · 只支持最小子集（需求允许自实现占位解析）；
 *  · 编号相同的重复占位会作为多个跳转点依次保留（本表刻意避免重复编号，便于阅读）；
 *  · $0 视为「最终位置」，但展开器统一用「插入文本末尾」作为最终位置，因此这里忽略它。
 */
export function parseSnippetTemplate(template: string): ParsedSnippet {
  const text = template.replace(/\r\n?/g, "\n");
  const re = /\$(\d+)|\$\{(\d+)(?::([^}]*))?\}/g;
  const out: string[] = [];
  const placeholders: SnippetPlaceholder[] = [];
  let last = 0;
  let written = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index);
    out.push(before);
    written += before.length;
    const index = Number(m[1] ?? m[2]);
    const fallback = m[3] ?? "";
    const from = written;
    out.push(fallback);
    written += fallback.length;
    if (index > 0) placeholders.push({ index, from, to: written });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  out.push(tail);
  placeholders.sort((a, b) => a.index - b.index);
  return { text: out.join(""), placeholders };
}

/**
 * 把片段模板渲染成可直接插入文档的文本，并按当前行缩进补齐后续行。
 *
 * @param snippet    片段定义
 * @param indent     当前行的缩进原文（空格 / Tab）
 * @param indentUnit 一级缩进字符串（通常为编辑器 Tab 宽度对应的空格，默认 4 空格）
 */
export function renderSnippet(snippet: CppSnippet, indent: string, indentUnit = "    "): ParsedSnippet {
  const lines = snippet.body.replace(/\r\n?/g, "\n").split("\n");
  const body = lines
    .map((line, i) => {
      // 模板里的 \t 只用于相对缩进：展开成编辑器当前配置的一级缩进宽度
      const expanded = line.replace(/\t/g, indentUnit);
      // 第一行接在光标处（行首缩进已在文档里），其余行补当前行的缩进
      return i === 0 ? expanded : indent + expanded;
    })
    .join("\n");
  return parseSnippetTemplate(body);
}
