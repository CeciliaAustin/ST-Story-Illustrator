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
  generateViaChannelId,
  resolveChannelId,
  type ModeChannelMap,
} from '../baibai/secondaryLlm';
import {
  buildIllustrationSystemPrompt,
  buildIllustrationUserPrompt,
  parseIllustrationResponse,
  buildComicSystemPrompt,
  buildComicUserPrompt,
  type IllustrationPromptOptions,
  type ComicPlanOptions,
  type SceneInput,
} from './planPrompts';
import { parseComicPagePlan } from './panelPlan';

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
  const viaSecondary = await generateViaSecondary(system, user);
  if (viaSecondary !== null) return viaSecondary;
  return await mainApiLlmCaller(system, user);
};

/** 按用户选择的来源构造调用器。 */
export function makeLlmCaller(source: 'auto' | 'secondary' | 'main'): LlmCaller {
  if (source === 'main') return mainApiLlmCaller;
  if (source === 'secondary') {
    return async (system, user) => {
      const viaSecondary = await generateViaSecondary(system, user);
      if (viaSecondary !== null) return viaSecondary;
      // 强制副 API 但没配好时，明确报错，不偷偷用主 API
      throw new Error('未配置柏宝绘副 API 渠道（或请求失败）。请在柏宝绘设置里指派 tagGen 渠道，或切换到主 API。');
    };
  }
  return defaultLlmCaller; // auto
}

/**
 * 按创作模式构造调用器：读该模式在弹窗里指派的渠道（柏宝绘共享渠道 id / tagGen / main）。
 * 指定渠道不可用时回退酒馆主 API，保证任务不中断。
 */
export function makeModeLlmCaller(
  settings: { modeChannels?: ModeChannelMap; llmSource?: 'auto' | 'main' | 'secondary' },
  mode: CreationMode,
): LlmCaller {
  const channelId = resolveChannelId(mode, settings.modeChannels, settings.llmSource);
  if (channelId === 'main') return mainApiLlmCaller;
  return async (system, user) => {
    const viaChannel = await generateViaChannelId(channelId, system, user);
    if (viaChannel !== null) return viaChannel;
    return await mainApiLlmCaller(system, user);
  };
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
}

export async function generateIllustrationPlan(
  input: GenerateIllustrationInput,
): Promise<GeneratePlanResult<GeneratePromptResponse>> {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildIllustrationSystemPrompt(input.options);
  const user = buildIllustrationUserPrompt(input.scene, input.characters ?? []);
  try {
    const raw = await caller(system, user);
    const parsed = parseIllustrationResponse(raw);
    if (!parsed) {
      return { ok: false, error: 'LLM 未返回可解析的结构化 Tag（JSON 解析失败或无有效片段）。' };
    }
    return { ok: true, data: parsed };
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
}

export async function generateComicPlan(
  input: GenerateComicPlanInput,
): Promise<GeneratePlanResult<ComicPagePlan[]>> {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildComicSystemPrompt(input.options);
  const user = buildComicUserPrompt(input.scene, input.characters ?? [], input.options.extraInstruction);
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
