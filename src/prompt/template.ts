/**
 * ST-Story-Illustrator — 提示词模板渲染（纯函数）
 *
 * 内置提示词现在是一份**可见、可改**的文本。为了让它同时能表达
 * 「单格 / 多格」「要不要台词」「安全模式」这些差异，模板支持三样东西：
 *
 *   {{name}}           变量替换（字符串/数字）
 *   {{#name}}…{{/name}} 条件成立才保留
 *   {{^name}}…{{/name}} 条件不成立才保留
 *
 * 刻意做得比 Handlebars 简单：没有嵌套同名、没有 else、没有表达式。
 * 用户手改模板时，越少语法越不容易改坏。
 */

export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateVars = Record<string, TemplateValue>;

function truthy(v: TemplateValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return false;
}

const CONDITION_RE = /\{\{([#^])([a-zA-Z0-9_-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VAR_RE = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

/**
 * 渲染模板。未知变量替换成空串（手改模板漏了变量不会把 `{{xxx}}` 发给模型），
 * 条件段递归处理，支持同一模板里多组条件。
 */
export function renderTemplate(template: string, vars: TemplateVars = {}): string {
  const source = String(template ?? '');
  if (!source) return '';

  let text = source;
  // 递归到没有条件段为止（最多 8 层，防手写死循环）
  for (let depth = 0; depth < 8; depth += 1) {
    let changed = false;
    text = text.replace(CONDITION_RE, (_all, sigil: string, name: string, inner: string) => {
      changed = true;
      const on = truthy(vars[name]);
      const keep = sigil === '#' ? on : !on;
      return keep ? inner : '';
    });
    if (!changed) break;
  }

  text = text.replace(VAR_RE, (_all, name: string) => {
    const value = vars[name];
    if (value === null || value === undefined) return '';
    return String(value);
  });

  return text;
}

/**
 * 清掉条件段留下的空行。
 *
 * 提示词是按行写的；条件不成立时那一行会变成空行。theater 的原始提示词
 * 本来就没有空行，留着会让模型以为「分段了，规则结束了」。
 */
export function collapseBlankLines(text: string): string {
  return String(text ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 渲染 + 收尾（去空行）。模板自身没有要求保留空行时用这个。 */
export function renderCompact(template: string, vars: TemplateVars = {}): string {
  return collapseBlankLines(renderTemplate(template, vars));
}
