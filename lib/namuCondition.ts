export type NamuConditionValue = string | number | boolean | null;
export type NamuConditionContext = Record<string, NamuConditionValue | undefined>;

function stripOuterParens(source: string) {
  let value = source.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let quote = "";
    let closesAtEnd = false;
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (quote) {
        if (char === quote && value[i - 1] !== "\\") quote = "";
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = i === value.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitTopLevel(source: string, operator: "||" | "&&") {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < source.length - 1; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote && source[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") { depth += 1; continue; }
    if (char === ")" && depth > 0) { depth -= 1; continue; }
    if (depth === 0 && source.slice(i, i + 2) === operator) {
      parts.push(source.slice(start, i).trim());
      start = i + 2;
      i += 1;
    }
  }
  if (!parts.length) return null;
  parts.push(source.slice(start).trim());
  return parts;
}

type ResolvedOperand = { known: boolean; value: NamuConditionValue };

function operand(source: string, context: NamuConditionContext): ResolvedOperand {
  const token = stripOuterParens(source.trim());
  if (!token) return { known: false, value: null };
  if (/^null$/i.test(token)) return { known: true, value: null };
  if (/^true$/i.test(token)) return { known: true, value: true };
  if (/^false$/i.test(token)) return { known: true, value: false };
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return { known: true, value: Number(token) };
  const quoted = token.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) return { known: true, value: quoted[2].replace(/\\([\\"'])/g, "$1") };

  // Namu template parameters that were not supplied behave like null. This is
  // especially important for mirror leftovers such as `행정구 == null` where
  // the default branch is the visible content. Explicit context values can be
  // supplied later when include/template argument propagation is available.
  if (/^[^\s=!<>&|()]+$/u.test(token)) {
    if (Object.prototype.hasOwnProperty.call(context, token)) return { known: true, value: context[token] ?? null };
    return { known: true, value: null };
  }
  return { known: false, value: null };
}

function compare(left: NamuConditionValue, right: NamuConditionValue, operator: string) {
  if (operator === "==" || operator === "===") return left === right;
  if (operator === "!=" || operator === "!==") return left !== right;
  if (typeof left === "number" && typeof right === "number") {
    if (operator === ">") return left > right;
    if (operator === ">=") return left >= right;
    if (operator === "<") return left < right;
    if (operator === "<=") return left <= right;
  }
  return null;
}

/**
 * Evaluate the conservative subset of Namu #!if expressions that appears in
 * partially-rendered template fragments. Returns null for unsupported syntax
 * rather than guessing. Missing template arguments are treated as null, which
 * matches Namu's default-parameter branches.
 */
export function evaluateNamuCondition(source: string, context: NamuConditionContext = {}): boolean | null {
  const expression = stripOuterParens(String(source || "").trim());
  if (!expression) return null;

  const orParts = splitTopLevel(expression, "||");
  if (orParts) {
    let sawUnknown = false;
    for (const part of orParts) {
      const result = evaluateNamuCondition(part, context);
      if (result === true) return true;
      if (result === null) sawUnknown = true;
    }
    return sawUnknown ? null : false;
  }

  const andParts = splitTopLevel(expression, "&&");
  if (andParts) {
    let sawUnknown = false;
    for (const part of andParts) {
      const result = evaluateNamuCondition(part, context);
      if (result === false) return false;
      if (result === null) sawUnknown = true;
    }
    return sawUnknown ? null : true;
  }

  if (expression.startsWith("!") && !expression.startsWith("!=")) {
    const result = evaluateNamuCondition(expression.slice(1), context);
    return result === null ? null : !result;
  }

  const comparison = expression.match(/^([\s\S]+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*([\s\S]+)$/);
  if (comparison) {
    const left = operand(comparison[1], context);
    const right = operand(comparison[3], context);
    if (!left.known || !right.known) return null;
    return compare(left.value, right.value, comparison[2]);
  }

  const single = operand(expression, context);
  if (!single.known) return null;
  return Boolean(single.value);
}
