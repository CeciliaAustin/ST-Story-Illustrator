/**
 * ST-Story-Illustrator — 创作工作流编排
 *
 * 把「确认选段」到「落盘挂载」的全链路串起来。
 * 五种模式（插画 / 漫画分镜 / QQ人状态 / 彩蛋 / 黑白漫）共用任务队列，
 * 各模式的差异封装在 runIllustration / runComic / runTheater 三个函数里。
 *
 * 依赖：LLM 生成（planGenerator）、出图 adapter、会话存储、卡片挂载。
 */

import type {
  CreationMode,
  StorySegment,
  VisualTask,
  VisualArtifact,
  VisualProfile,
  BaiBaiCharacter,
  StoryIllustratorSettings,
} from '../types';
import { getAnchorFloor, getSurroundingContext } from '../selection/storySegment';
import { buildAnchor } from '../selection/anchor';
import { extractPlainText } from '../selection/anchor';
import { getCharacters } from '../baibai/bridge';
import { generateQuietPrompt } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { generateIllustrationPlan, generateComicPlan, makeLlmCaller } from '../manga/planGenerator';
import { composeEnglishPrompt } from '../prompt/compose';
import { enforceForGeneration } from '../manga/panelEnforce';
import { createArtifactId, appendArtifact } from '../storage/repository';
import { mountFloor } from '../ui/floorCards';
import { insertImageIntoBody } from '../ui/bodyInserter';
import { mountTheater } from '../theater/mount';
import { defaultMountMode } from '../types';
import { runTheaterOne } from '../theater/runtime';
import { saveStory } from '../theater/store';
import type { QueueRunContext } from './taskQueue';

// ============================================================
// 类型与工具
// ============================================================

export interface WorkflowDeps {
  settings: VisualProfile[];
  fullSettings: StoryIllustratorSettings;
}

function pickProfile(profiles: VisualProfile[], mode: CreationMode): VisualProfile | undefined {
  return profiles.find(p => p.mode === mode);
}

function sceneFromSegment(segment: StorySegment) {
  const context = getSurroundingContext(segment, 1);
  return {
    selectedText: segment.text,
    ...(context.previousText ? { previousText: context.previousText } : {}),
    ...(context.nextText ? { nextText: context.nextText } : {}),
  };
}

function toNormalizedInput(prompt: string, nl: string | undefined, negative: string | undefined, profile?: VisualProfile) {
  return {
    prompt,
    ...(nl ? { nl } : {}),
    ...(negative ? { negative } : {}),
    save: true,
  };
}

// ============================================================
// 插画模式
// ============================================================

async function runIllustration(
  task: VisualTask,
  ctx: QueueRunContext,
  deps: WorkflowDeps,
): Promise<void> {
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error('无法确定挂载楼层。');

  ctx.report({ stage: 'reading' });
  const characters = await getCharacters(floor);
  const plan = await generateIllustrationPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: {
      includeChinese: deps.fullSettings.includeChinese,
      includeNl: deps.fullSettings.includeNl,
      includeNegative: true,
    },
    caller: makeLlmCaller(deps.fullSettings.llmSource ?? 'auto'),
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error ?? 'Tag 计划生成失败。');

  ctx.report({ stage: 'review' });
  // PromptSegment.chinese 可选，TagSegment.chinese 必需 → 补齐空数组后再组装
  const tagSegments = plan.data.segments.map(seg => ({
    ...seg,
    chinese: seg.chinese ?? [],
  }));
  const prompt = composeEnglishPrompt(tagSegments);
  if (!prompt.trim()) throw new Error('组装后的英文 prompt 为空。');

  const profile = pickProfile(deps.settings, 'illustration');
  ctx.report({ stage: 'generating' });
  const result = await baiBaiAdapter.generate(
    toNormalizedInput(prompt, plan.data.nl, plan.data.negative, profile),
    profile ?? fallbackProfile('illustration'),
  );
  const imagePath = result.path ?? result.dataUrl;
  if (!imagePath) throw new Error('出图未返回图片地址。');

  // 先把图片写进正文（选段之后），使其成为正文内容：编辑不丢、刷新仍在、导出带着。
  // 锚点用划线/选段文本；写入采用 CAS，排队期间消息变了就安全放弃。
  const anchorText = segment.text.slice(0, 120);
  const inserted = await insertImageIntoBody({
    floor,
    chatId: task.chatId,
    swipeId: segment.messages[0]?.swipeId ?? 0,
    sendDate: segment.messages[0]?.sendDate,
    imagePath,
    anchorText,
    alt: plan.data.nl ? plan.data.nl.slice(0, 60) : '配图',
  });
  console.log('[ST-Story-Illustrator] 正文插图写入:', inserted);

  const mesTextEl = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"] .mes_text`);
  const anchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : undefined;
  const artifact: VisualArtifact = {
    id: createArtifactId(),
    taskId: task.id,
    mode: 'illustration',
    chatId: task.chatId,
    sourceFloors: segment.floorIds,
    anchorFloor: floor,
    // 正文已嵌入图片时不再注入 DOM 卡片（避免重复显示）；写入失败才降级为 DOM 卡片
    mountMode: inserted.ok ? 'trailing' : defaultMountMode('illustration'),
    ...(anchor ? { textAnchor: anchor } : {}),
    imagePath,
    prompt,
    ...(plan.data.nl ? { nl: plan.data.nl } : {}),
    ...(plan.data.negative ? { negative: plan.data.negative } : {}),
    ...(result.seed !== undefined ? { seed: result.seed } : {}),
    metadata: { embeddedInBody: inserted.ok },
    createdAt: Date.now(),
  };
  appendArtifact(floor, artifact);

  mountFloor(floor);
  ctx.report({ stage: 'completed' });
}

function fallbackProfile(mode: CreationMode): VisualProfile {
  return {
    id: `default-${mode}`, name: '默认', mode, backend: 'nai',
    promptTemplateId: 'default', options: {},
  };
}

// ============================================================
// 漫画分镜模式
// ============================================================

async function runComic(
  task: VisualTask,
  ctx: QueueRunContext,
  deps: WorkflowDeps,
): Promise<void> {
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error('无法确定挂载楼层。');

  const modeSettings = deps.fullSettings.modes['comic'];
  ctx.report({ stage: 'reading' });
  const characters = await getCharacters(floor);
  const backendInfo = await baiBaiAdapter.id ? 'nai' : 'nai'; // 后端由 bridge 内部处理
  const plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: {
      panelMode: true,
      panelLayout: modeSettings.comicLayout ?? 'regular',
      pageType: modeSettings.comicPageType ?? 'auto',
      dialogue: deps.fullSettings.dialogueEnabled,
      dialoguePolicy: deps.fullSettings.dialoguePolicy,
      dialogueMode: 'tag',
      nl: deps.fullSettings.includeNl,
      backend: backendInfo,
      charPrompts: false,
      includeChinese: deps.fullSettings.includeChinese,
      maxPages: modeSettings.comicMaxPages ?? 1,
    },
    caller: makeLlmCaller(deps.fullSettings.llmSource ?? 'auto'),
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');

  const profile = pickProfile(deps.settings, 'comic');
  const totalPanels = plan.data.reduce((sum, page) => sum + page.panels.length, 0);
  let done = 0;

  for (const page of plan.data) {
    for (const panel of page.panels) {
      if (ctx.signal.aborted) return;
      ctx.report({ stage: 'generating', page: page.pageIndex + 1, panel: panel.index + 1, totalPages: plan.data.length, totalPanels });
      const enforced = enforceForGeneration({
        prompt: panel.tags,
        nl: panel.nl ?? '',
        panelMode: true,
        panelLayout: page.layout,
        chibiOn: false,
        storyImage: false,
      });
      const result = await baiBaiAdapter.generate(
        toNormalizedInput(enforced.prompt, enforced.nl || undefined, undefined, profile),
        profile ?? fallbackProfile('comic'),
      );
      const imagePath = result.path ?? result.dataUrl;
      if (!imagePath) continue;

      const artifact: VisualArtifact = {
        id: createArtifactId(),
        taskId: task.id,
        mode: 'comic',
        chatId: task.chatId,
        sourceFloors: segment.floorIds,
        anchorFloor: floor,
        mountMode: defaultMountMode('comic'),
        pageIndex: page.pageIndex,
        panelIndex: panel.index,
        imagePath,
        prompt: enforced.prompt,
        ...(panel.nl ? { nl: panel.nl } : {}),
        ...(panel.dialogue ? { dialogue: panel.dialogue } : {}),
        ...(result.seed !== undefined ? { seed: result.seed } : {}),
        metadata: { pageTitle: page.title, panelTitle: panel.title, layout: page.layout },
        createdAt: Date.now(),
      };
      appendArtifact(floor, artifact);
      done += 1;
    }
  }
  if (done === 0) throw new Error('所有分格出图均失败。');
  mountFloor(floor);
  ctx.report({ stage: 'completed' });
}

// ============================================================
// 小剧场三套（status / bonus / manga）
// ============================================================

async function runTheaterMode(
  task: VisualTask,
  ctx: QueueRunContext,
  deps: WorkflowDeps,
): Promise<void> {
  const segment = task.source;
  const mode = task.mode;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error('无法确定挂载楼层。');

  const kind = mode === 'chibi-status' ? 'status' : mode === 'chibi-bonus' ? 'bonus' : 'manga';
  const modeSettings = deps.fullSettings.modes[mode];
  const characters = await getCharacters(floor);

  ctx.report({ stage: 'reading' });
  const result = await runTheaterOne({
    kind,
    chatId: task.chatId,
    floor,
    swipe: segment.messages[0]?.swipeId ?? 0,
    characterName: segment.messages.find(m => !m.isUser)?.speaker ?? '',
    body: segment.text,
    shots: modeSettings.shots,
    chibi: kind !== 'manga' && (modeSettings.chibiStyle !== 'thumb'),
    mangaSafe: modeSettings.bwMangaSafeMode ?? true,
    backend: 'nai',
    profile: pickProfile(deps.settings, mode),
    llm: async (prompt) => {
      // 小剧场文本同样优先走副 API，失败回退主 API（makeLlmCaller('auto') 已实现回退）
      try {
        return await makeLlmCaller(deps.fullSettings.llmSource ?? 'auto')('', prompt);
      } catch {
        return await generateQuietPrompt(prompt);
      }
    },
    generate: async (input, profile) => {
      const r = await baiBaiAdapter.generate({
        prompt: input.prompt,
        ...(input.negative ? { negative: input.negative } : {}),
        seed: input.seed,
        size: input.size,
        save: true,
      }, profile ?? fallbackProfile(mode));
      return { path: r.path, dataUrl: r.dataUrl, seed: r.seed };
    },
    readLooks: (names) => {
      const lookup = new Map(characters.characters.map(c => [c.name, c]));
      return names.map(name => {
        const c = lookup.get(name);
        return c ? { name, tag: c.tag, ...(c.nl ? { nl: c.nl } : {}) } : { name, tag: '' };
      });
    },
  });

  if (!result.ok) throw new Error(result.error ?? '小剧场生成失败。');

  for (const story of result.stories) {
    saveStory(floor, kind, story);
  }

  mountTheater(floor);
  ctx.report({ stage: 'completed' });
}

// ============================================================
// 模式分派
// ============================================================

export function createTaskRunner(deps: WorkflowDeps) {
  return async (task: VisualTask, ctx: QueueRunContext): Promise<void> => {
    switch (task.mode) {
      case 'illustration': return runIllustration(task, ctx, deps);
      case 'comic': return runComic(task, ctx, deps);
      case 'chibi-status':
      case 'chibi-bonus':
      case 'bw-manga': return runTheaterMode(task, ctx, deps);
      default: throw new Error(`未知创作模式: ${task.mode}`);
    }
  };
}

export function createVisualTask(segment: StorySegment, mode: CreationMode): VisualTask {
  const now = Date.now();
  return {
    id: `task-${now}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: segment.chatId,
    source: segment,
    mode,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
}
