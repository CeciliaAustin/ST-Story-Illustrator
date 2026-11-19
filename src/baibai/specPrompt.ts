/**
 * 柏宝绘「自定义提示词」的读取与应用
 *
 * 为什么必须读它：
 * 柏宝绘读剧情时，system 顺序是 破限词 → 角色卡 → 人设 → 世界书 → **后端书写规范**
 * （设置页「自定义提示词 → NAI 规范」，存于 `autoTag.prompts.naiV5Spec`）→ 任务协议
 * → 思维链。那份规范里写的是「人物/服装/场景怎么取证、什么算自创、连续场景怎么
 * 保持同一套衣服」——用户会往里贴自己的规则（例如整份 NAI V5 IMAGE PROMPT
 * GENERATION RULES）。
 *
 * 我们自己的紧凑规则本来就是从它抄的，但**用户改了它，我们却只用自己的那份**，
 * 等于他写的规则对正文插图/小剧场完全无效：于是「人物对了，服装每格都不一样」。
 * 柏宝绘自己不会出这个问题，因为它每一张都过一遍这份规范。
 *
 * 所以纪律：**凡是我们要模型写 tag/nl 的地方（正文插图、漫画分镜、小剧场三套），
 * 都先把这份规范压在 system 前面。**
 *
 * 读不到（用户留空）就返回空串、退回我们自己那份紧凑规则——不能凭空发一段 16k 的空文。
 */

import { getContext } from '../host/sillytavern';

const SETTINGS_KEY = 'baibai_image';

export interface BaiBaiPromptSet {
  /** 破限词（置顶，降低副 API 拒答率） */
  jailbreak: string;
  /** NAI 书写规范（NAI4.5/V5 的 Base + Character Prompts 口径） */
  spec: string;
  /** 思维链（输出前检查清单，要求先 <thinking> 再给 JSON） */
  thinking: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 从柏宝绘设置里抠出三份提示词（纯函数）。
 *
 * 键名照柏宝绘自己的：`naiV5Spec` / `naiV5Thinking` 是 4.5/V5 那套（设置页叫
 * 「NAI 规范 / NAI 思维链」）；`naiSpec` / `naiThinking` 是 4 系以下的旧单串版，
 * 只在前者为空时兜底——绝大多数人只填一处。
 */
export function parsePromptSet(raw: unknown): BaiBaiPromptSet {
  const settings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const autoTag = settings.autoTag && typeof settings.autoTag === 'object'
    ? (settings.autoTag as Record<string, unknown>)
    : {};
  const prompts = autoTag.prompts && typeof autoTag.prompts === 'object'
    ? (autoTag.prompts as Record<string, unknown>)
    : {};
  return {
    jailbreak: str(prompts.jailbreak),
    spec: str(prompts.naiV5Spec) || str(prompts.naiSpec),
    thinking: str(prompts.naiV5Thinking) || str(prompts.naiThinking),
  };
}

/**
 * 展开自然语言条件段（与柏宝绘 autoTag/prompt.ts 的 expandNlSections 同一实现）。
 * `{{#nl}}…{{/nl}}` 只在开启「生成自然语言」时保留，`{{^nl}}…{{/nl}}` 只在关闭时保留。
 */
export function expandNlSections(text: string, nl: boolean): string {
  return String(text ?? '').replace(
    /\{\{([#^])nl\}\}([\s\S]*?)\{\{\/nl\}\}/g,
    (_match, kind: string, body: string) => ((kind === '#') === nl ? body : ''),
  );
}

/**
 * 输出契约优先声明。
 *
 * 规范的示例 JSON 用的是柏宝绘自己的字段（position / tag / characters[].tag / size），
 * 而我们每个模式要的字段不一样。不声明清楚，模型会照着规范的示例输出，
 * 我们的解析器就什么都拿不到。分工写明白：**格式听任务协议，画面内容听规范。**
 */
const CONTRACT_PRIORITY =
  '【本任务的输出契约优先】\n' +
  '上面是柏宝绘的写词规范，它约束的是**画什么、怎么写词**：人物与服装怎么取证、' +
  '什么算自创、连续场景怎么保持同一套衣服、Base 与角色块怎么分工。\n' +
  '规范里出现的示例 JSON（position / tag / characters[].tag / nl / size 等）只是柏宝绘自己的字段，' +
  '**不要照抄那些字段名**：本次输出的 JSON 只按下面【任务协议】里的字段来，' +
  '不要输出 position、size，也不要把整段 JSON 塞进 tag。\n' +
  '冲突时：**格式以任务协议为准，画面内容以规范为准。**';

/** 把三份提示词拼成一段可前置到 system 的文本（纯函数）。 */
export function buildSpecPreamble(set: BaiBaiPromptSet, options: { nl: boolean }): string {
  const parts: string[] = [];
  if (set.jailbreak) parts.push(expandNlSections(set.jailbreak, options.nl));
  if (set.spec) parts.push(expandNlSections(set.spec, options.nl));
  if (set.thinking) parts.push(expandNlSections(set.thinking, options.nl));
  const body = parts.map(p => p.trim()).filter(Boolean).join('\n\n');
  if (!body) return '';
  // 宏展开后可能留下连续空行，折叠掉（和柏宝绘同一手）
  return `${body.replace(/\n{3,}/g, '\n\n').trim()}\n\n${CONTRACT_PRIORITY}`;
}

/** 读当前柏宝绘设置里的提示词（每次现读，用户改了立刻生效）。 */
export function readPromptSet(): BaiBaiPromptSet {
  const ctx = getContext();
  return parsePromptSet(ctx.extensionSettings?.[SETTINGS_KEY]);
}

/** 直接拿到可前置的规范文本；用户没写就是空串。 */
export function specPreambleFor(nl: boolean): string {
  return buildSpecPreamble(readPromptSet(), { nl });
}

/**
 * 把规范压在 system 前面（所有「写 tag / 写 nl」的调用都走这里）。
 *
 * 顺序不能反：规范在前、任务协议在后，模型才是「先读规范再照格式交作业」；
 * 反过来它会先被格式束缚，把规范里的取证规则当耳边风。
 */
export function withSpecPreamble(system: string, nl: boolean): string {
  const preamble = specPreambleFor(nl);
  return preamble ? `${preamble}\n\n------\n\n${system}` : system;
}
