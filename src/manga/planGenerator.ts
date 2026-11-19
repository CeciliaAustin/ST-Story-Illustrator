/**
 * ST-Story-Illustrator — 分镜/Tag 计划生成器（异步编排）
 *
 * 职责（任务 #6）：
 * - 读剧情 → 组装 system/user prompt → 调 ST generateQuietPrompt → 解析为结构化计划
 * - 插画：GeneratePromptResponse（英文 Tag 段）
 * - 漫画：ComicPagePlan[]（经 parseComicPagePlan）
 *
 * 关键设计：LLM 调用通过 `LlmCaller` 注入，纯组装/解析仍走 planPrompts.ts。
 * 这样可在测试里塞 mock caller，无需真实 ST 环境；也符合 ANALYSIS.md 的「mock adapter」策略。
 */

import type { GeneratePromptResponse, ComicPagePlan, BaiBaiCharacter, CreationMode } from '../types';
import { generateQuietPrompt as stGenerateQuietPrompt } from '../host/sillytavern';
import {
  generateViaSecondary,
  readTagGenChannelId,
  generateViaChannelId,
  resolveChannelId,
  type ModeChannelMap,
  generateViaChannelStrict,
} from '../baibai/secondaryLlm';
import {
  buildIllustrationSystemPrompt,
  buildIllustrationUserPrompt,
  parseIllustrationResponse,
  ensureCharacterSegments,
  buildComicSystemPrompt,
  buildComicUserPrompt,
  type IllustrationPromptOptions,
  type ComicPlanOptions,
  type SceneInput,
} from './planPrompts';
import { parseComicPagePlan } from './panelPlan';
import type { PromptOverrideMap } from '../prompt/presets';
import { withSpecPreamble } from '../baibai/specPrompt';
import { nlForMode } from '../baibai/planConfig';

// ============================================================
// 可注入的 LLM 调用器
// ============================================================

export type LlmCaller = (system: string, user: string) => Promise<string>;

/** 主 API 调用器：把 system + user 合成一条 quiet prompt 发给 ST 当前 API。 */
export const mainApiLlmCaller: LlmCaller = async (system, user) => {
  const prompt = `${system}\n\n---\n\n${user}`;
  return await stGenerateQuietPrompt(prompt);
};

/**
 * 默认调用器：优先走柏宝绘副 API（tagGen 指派渠道），失败/未配置回退 ST 主 API。
 * 这样用户设好的副 API 渠道真正被用于写 tag，而不是每次都惊动主 API。
 */
export const defaultLlmCaller: LlmCaller = async (system, user) => {
  const tagGen = readTagGenChannelId();
  if (!tagGen) return await mainApiLlmCaller(system, user);
  return await generateViaChannelStrict('tagGen', system, user);
};

/** 按用户选择的来源构造调用器。 */
export function makeLlmCaller(source: 'auto' | 'secondary' | 'main'): LlmCaller {
  if (source === 'main') return mainApiLlmCaller;
  if (source === 'secondary') {
    return async (system, user) => generateViaChannelStrict('tagGen', system, user);
  }
  return defaultLlmCaller; // auto
}

/**
 * 按创作模式构造调用器：读该模式在弹窗里指派的渠道（柏宝绘共享渠道 id / tagGen / main）。
 * 指定渠道不可用时回退酒馆主 API，保证任务不中断。
 */
export function makeModeLlmCaller(
  settings: {
    modeChannels?: ModeChannelMap;
    llmSource?: 'auto' | 'main' | 'secondary';
    modeOutPlans?: Partial<Record<string, string>>;
    /** @deprecated 已改为跟随出图方案（方案里的「生成自然语言」开关），这里不再生效 */
    includeNl?: boolean;
  },
  mode: CreationMode,
): LlmCaller {
  const channelId = resolveChannelId(mode, settings.modeChannels, settings.llmSource);
  // 指派了主 API 才算「用主 API」；指派了副渠道就**只走副渠道**，报错即停（不偷偷回退）
  const base: LlmCaller = channelId === 'main'
    ? mainApiLlmCaller
    : async (system, user) => generateViaChannelStrict(channelId, system, user);

  // 每一次「写 tag / 写 nl」的调用都先过一遍柏宝绘的【自定义提示词】：
  // 人物与服装怎么取证、什么算自创、连续场景怎么沿用同一套衣服，全写在那份规范里。
  // 用户改过它而我们只用自己的紧凑规则，等于他写的规则对本插件完全无效
  // ——「人物对了，服装每格都不一样」就是这么来的。柏宝绘每一张都过一遍，我们也过。
  //
  // nl 段跟着**这套方案**的开关走：方案开了自然语言才展开规范里的 {{#nl}}，
  // 否则那段规则（以及它对模型「必须写 nl」的要求）本身就不该发出去。
  // 以前这里写死 true，等于替用户把 4.5 方案上的开关打开了。
  return async (system, user) => base(withSpecPreamble(system, nlForMode(settings, mode)), user);
}

// ============================================================
// 结果类型
// ============================================================

export interface GeneratePlanResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

// ============================================================
// 插画 Tag 计划
// ============================================================

export interface GenerateIllustrationInput {
  scene: SceneInput;
  characters?: BaiBaiCharacter[];
  options: IllustrationPromptOptions;
  caller?: LlmCaller;
  /** 用户在「提示词」标签页里改过的模板 */
  promptOverrides?: PromptOverrideMap;
  /** 柏宝书角色参考（当前外貌/着装/状态） */
  bookBlock?: string;
  /** 柏宝绘角色库全文（含发色/瞳色/固定着装） */
  libraryBlock?: string;
  /** 「谁是谁」：用户扮演谁、角色卡是谁 */
  castBlock?: string;
}

export async function generateIllustrationPlan(
  input: GenerateIllustrationInput,
): Promise<GeneratePlanResult<GeneratePromptResponse>> {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildIllustrationSystemPrompt(input.options, input.promptOverrides);
  const user = buildIllustrationUserPrompt(input.scene, input.characters ?? [], {
    ...(input.bookBlock ? { bookBlock: input.bookBlock } : {}),
    ...(input.libraryBlock ? { libraryBlock: input.libraryBlock } : {}),
    ...(input.castBlock ? { castBlock: input.castBlock } : {}),
  });
  try {
    const raw = await caller(system, user);
    const parsed = parseIllustrationResponse(raw);
    if (!parsed) {
      return { ok: false, error: 'LLM 未返回可解析的结构化 Tag（JSON 解析失败或无有效片段）。' };
    }
    // 外貌是确定信息，不该听模型记性：它一个 character 段都没写就由代码补上
    const data = ensureCharacterSegments(
      parsed,
      input.characters ?? [],
      input.scene.selectedText,
      input.options.includeChinese,
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// 漫画分镜计划
// ============================================================

export interface GenerateComicPlanInput {
  scene: SceneInput;
  characters?: BaiBaiCharacter[];
  options: ComicPlanOptions;
  caller?: LlmCaller;
  /** 用户在「提示词」标签页里改过的模板 */
  promptOverrides?: PromptOverrideMap;
  /** 柏宝书角色参考（当前外貌/着装/状态） */
  bookBlock?: string;
}

export async function generateComicPlan(
  input: GenerateComicPlanInput,
): Promise<GeneratePlanResult<ComicPagePlan[]>> {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildComicSystemPrompt(input.options, input.promptOverrides);
  const user = buildComicUserPrompt(
    input.scene,
    input.characters ?? [],
    input.options.extraInstruction,
    { ...(input.bookBlock ? { bookBlock: input.bookBlock } : {}) },
  );
  try {
    const raw = await caller(system, user);
    const parsed = parseComicPagePlan(raw);
    if (parsed.pages.length === 0) {
      return {
        ok: false,
        error: 'LLM 未返回可解析的分镜计划。',
        warnings: parsed.warnings,
      };
    }
    return { ok: true, data: parsed.pages, warnings: parsed.warnings };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
