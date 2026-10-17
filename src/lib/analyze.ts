import type { Diagnostic } from "@/types";

/** 根据编译器报错信息给出中文的可能原因分析 */
export function explainError(d: Diagnostic): string | undefined {
  const m = d.message;
  const rules: [RegExp, string][] = [
    [/expected ['‘];['’] before/, "缺少分号：请检查上一行语句末尾是否漏写了 ;"],
    [/expected ['‘][}\)>]'’] before/, "括号可能不配对：检查这一行附近是否多写或漏写了括号"],
    [/was not declared in this scope|undeclared identifier|未声明/, "标识符未声明：检查拼写、是否忘记 #include 对应头文件，或变量不在当前作用域内"],
    [/No such file or directory/, "找不到头文件：检查文件名拼写，或在编译参数中添加 -I 包含路径"],
    [/no matching function for call to/, "函数调用参数不匹配：检查参数个数与类型是否和函数声明一致"],
    [/undefined reference to/, "链接错误：函数只有声明没有实现（缺少函数体），或编译时漏掉了某个源文件"],
    [/multiple definition|redefinition/, "重复定义：同一变量/函数被定义了多次，检查是否把头文件里的定义当成了声明"],
    [/stray ['‘\\]/, "代码中混入了全角标点（中文引号、分号等），请切换为英文半角符号"],
    [/expected primary-expression/, "表达式不完整：可能漏了操作数、少了括号，或把声明写在了错误位置"],
    [/lvalue required as/, "赋值号左边必须是可修改的变量；若想比较是否相等，请确认写的是 == 而不是 ="],
    [/read-only|const/, "试图修改 const 常量或只读对象"],
    [/cannot convert|conversion from/, "类型转换失败：检查赋值/传参两边的类型是否需要强制转换"],
    [/expected (unqualified-)?id before/, "这一行前可能有语法错误（比如类/函数声明格式不对），或上一行末尾多了符号"],
    [/expected declaration|expected ['‘][{}]'’] before/, "大括号不配对：检查 { 和 } 是否成对出现"],
    [/invalid types|request for member/, "类型使用错误：对不合适的类型做了 . 或 -> 成员访问"],
    [/segmentation fault|Segmentation fault/, "运行时段错误：常见原因是数组越界、使用了未初始化的指针、或访问了悬垂指针"],
    [/division by zero|Div.?by zero/, "除以零：检查除法运算的除数是否可能为 0"],
    [/out of range/, "数值超出类型表示范围"],
    [/unused variable/, "变量已声明但从未使用（不影响运行，可删除或检查逻辑是否遗漏）"],
  ];
  for (const [re, hint] of rules) {
    if (re.test(m)) return hint;
  }
  return undefined;
}
