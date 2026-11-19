/**
 * 剥掉模型的思考块。
 *
 * 为什么需要：我们把柏宝绘的「思维链」提示词也一并压进了 system（它要求在
 * `<thinking>…</thinking>` 之间先做检查点判断，再输出最终 JSON）。那是它自己
 * 解析端就配套处理的动作，我们这边要是不剥，`<thinking>` 里随手出现的花括号
 * 就会把「取第一个 { 到最后一个 }」式的解析带偏，整条结果变成解析失败。
 */

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;

/** 去掉思考块（含没闭合的那种：一直吃到结尾）。 */
export function stripThinkingBlocks(raw: string): string {
  const text = String(raw ?? '');
  if (!/<think/i.test(text)) return text;
  return text.replace(THINK_BLOCK, '').trim();
}
