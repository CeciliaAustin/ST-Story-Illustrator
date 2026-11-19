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
 * 输出契约声明。
 *
 * 规范的示例 JSON 用的是柏宝绘自己的信封（position / images / changes），
 * 而我们每个模式要的信封不一样（我们不需要 position，插图要 negative 等）。
 * 这里只说清「信封听谁的」，绝不能说「规范里那些字段别照抄」——
 * **Base 与角色块的分工本身就是规范的核心条款**，顶掉它等于把规范废掉。
 */
const CONTRACT_PRIORITY =
  '【本任务的输出信封】\n' +
  '上面的规范管的是**画什么、怎么写词**：人物与服装怎么取证、什么算自创、' +
  '连续场景怎么保持同一套衣服、Base 与每个角色块怎么分工。这些规则全部有效。\n' +
  '信封（要不要 position / images / changes，有没有 negative、size 怎么给）以【任务协议】为准；' +
  '**但「Base 只写全局内容、单个角色的外貌服装表情动作只写进该角色自己那一块」这条分工不受影响**。\n' +
  '不要把整段 JSON 塞进 tag，也不要输出协议里没有的字段。';

/** 破限词 + 规范（压在最前面，柏宝绘的 system 顺序就是这样）。 */
export function buildSpecHead(set: BaiBaiPromptSet, options: { nl: boolean }): string {
  const parts: string[] = [];
  if (set.jailbreak) parts.push(expandNlSections(set.jailbreak, options.nl));
  if (set.spec) parts.push(expandNlSections(set.spec, options.nl));
  return parts.map(p => p.trim()).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 思维链（压在最后，紧跟任务协议之后——柏宝绘就是这么排的）。 */
export function buildThinking(set: BaiBaiPromptSet, options: { nl: boolean }): string {
  return set.thinking
    ? expandNlSections(set.thinking, options.nl).replace(/\n{3,}/g, '\n\n').trim()
    : '';
}

/** 把三份提示词拼成一段可前置到 system 的文本（纯函数）。 */
export function buildSpecPreamble(set: BaiBaiPromptSet, options: { nl: boolean }): string {
  const body = buildSpecHead(set, options);
  if (!body) return '';
  return `${body}\n\n${CONTRACT_PRIORITY}`;
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
 * 按柏宝绘的 system 顺序把规范压上去：
 *
 *   破限 → 规范 → **任务协议** → 思维链
 *
 * 思维链必须压在最后：它是「输出前检查清单」，离输出越近越生效；以前把它放在
 * 任务协议前面（其实和规范挤在同一段里），模型读完规范就被我们自己的协议打断，
 * 检查清单等于没读——用户看到的正是「没走我的思维链」。
 */
export function withSpecPreamble(system: string, nl: boolean): string {
  const set = readPromptSet();
  const head = buildSpecPreamble(set, { nl });
  const thinking = buildThinking(set, { nl });
  const middle = head ? `${head}\n\n------\n\n${system}` : system;
  return thinking ? `${middle}\n\n------\n\n${thinking}` : middle;
}
