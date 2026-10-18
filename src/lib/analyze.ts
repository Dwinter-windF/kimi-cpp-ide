import type { Diagnostic } from "@/types";
import { t } from "@/lib/i18n";

/** 根据编译器报错信息给出中文的可能原因分析 */
export function explainError(d: Diagnostic): string | undefined {
  const m = d.message;
  const rules: [RegExp, string][] = [
    [/expected ['‘];['’] before/, "analyze.missingSemicolon"],
    [/expected ['‘][}\)>]'’] before/, "analyze.unbalancedParen"],
    [/was not declared in this scope|undeclared identifier|未声明/, "analyze.undeclared"],
    [/No such file or directory/, "analyze.missingHeader"],
    [/no matching function for call to/, "analyze.argMismatch"],
    [/undefined reference to/, "analyze.undefinedRef"],
    [/multiple definition|redefinition/, "analyze.redefinition"],
    [/stray ['‘\\]/, "analyze.fullWidthPunct"],
    [/expected primary-expression/, "analyze.incompleteExpr"],
    [/lvalue required as/, "analyze.lvalue"],
    [/read-only|const/, "analyze.constModify"],
    [/cannot convert|conversion from/, "analyze.conversion"],
    [/expected (unqualified-)?id before/, "analyze.syntaxBefore"],
    [/expected declaration|expected ['‘][{}]'’] before/, "analyze.braceMismatch"],
    [/invalid types|request for member/, "analyze.memberAccess"],
    [/segmentation fault|Segmentation fault/, "analyze.segfault"],
    [/division by zero|Div.?by zero/, "analyze.divZero"],
    [/out of range/, "analyze.outOfRange"],
    [/unused variable/, "analyze.unusedVar"],
  ];
  for (const [re, hintKey] of rules) {
    if (re.test(m)) return t(hintKey);
  }
  return undefined;
}
