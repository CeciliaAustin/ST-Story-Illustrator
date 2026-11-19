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
  ComicPagePlan,
  StoryIllustratorSettings,
} from '../types';
import { getAnchorFloor, getSurroundingContext } from '../selection/storySegment';
import { buildAnchor } from '../selection/anchor';
import { extractPlainText } from '../selection/anchor';
import { getCharacters } from '../baibai/bridge';
import { generateQuietPrompt, saveChatSafe } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { readOutConfig } from '../baibai/planConfig';
import { switchBaiBaiPlan } from '../baibai/planSwitch';
import { generateIllustrationPlan, generateComicPlan, makeModeLlmCaller } from '../manga/planGenerator';
import { composeEnglishPrompt } from '../prompt/compose';
import { enforceForGeneration } from '../manga/panelEnforce';
import { hasStoryContent, mergeCharacterTags } from '../manga/panelRelevance';
import { bakeDialogueIntoImage } from '../manga/bubbleBake';
import { createArtifactId, appendArtifact } from '../storage/repository';
import { mountFloor } from '../ui/floorCards';
import {
  buildBbiTag,
  insertImageTag,
  triggerCardGenerate,
  waitForEntry,
  replaceEntryPath,
  promptHash,
} from '../baibai/bbiTag';
import { mountTheater } from '../theater/mount';
import { runTheaterOne } from '../theater/runtime';
import { saveSet, newSetId } from '../theater/store';
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

/**
 * 出图前把柏宝绘切到该模式指定的方案。
 *
 * 柏宝绘公开出图接口不接受 planId，只能改它自己的「当前方案」。任务队列是串行的，
 * 所以「切一次 → 出图 → 下个任务再按需切」不会互相干扰。切换失败不中断出图，
 * 只降级为「用当前方案」并记日志。
 */
async function ensureModeOutPlan(mode: CreationMode, deps: WorkflowDeps): Promise<void> {
  const planId = deps.fullSettings.modeOutPlans?.[mode];
  if (!planId) return;

  const snap = readOutConfig();
  if (!snap.plans.some(p => p.id === planId)) {
    console.warn(`[ST-Story-Illustrator] ${mode} 指定的出图方案已不存在，改用当前方案。`);
    return;
  }
  if (snap.activePlanId === planId) return;

  try {
    const result = await switchBaiBaiPlan(planId);
    if (!result.ok && result.reason !== 'already') {
      console.warn(`[ST-Story-Illustrator] 切换出图方案失败（继续用当前方案）：${result.message}`);
    }
  } catch (e) {
    console.warn('[ST-Story-Illustrator] 切换出图方案异常（继续用当前方案）:', e);
  }
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
    caller: makeModeLlmCaller(deps.fullSettings, 'illustration'),
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

  ctx.report({ stage: 'generating' });
  await ensureModeOutPlan('illustration', deps);

  // 图片不再由本插件直接出、也不写 markdown：
  // 写一条柏宝绘的 <bbi_image> tag 进正文，点卡片上的「生成图片」，其余全交给柏宝绘
  // ——显示与它自己出的图一模一样（重绘/改词/下载/删除/灯箱），刷新后仍在，
  // 请求也会进它的「请求历史」页。
  const tag = buildBbiTag({
    prompt,
    ...(plan.data.nl ? { nl: plan.data.nl } : {}),
    ...(plan.data.negative ? { negative: plan.data.negative } : {}),
    size: plan.data.size === 'landscape' ? 'landscape' : 'portrait',
  });
  const hash = promptHash(tag);
  const inserted = await insertImageTag({
    floor,
    chatId: task.chatId,
    swipeId: segment.messages[0]?.swipeId ?? 0,
    ...(segment.messages[0]?.sendDate ? { sendDate: segment.messages[0].sendDate } : {}),
    tag,
    anchorText: segment.text.slice(0, 120),
  });
  if (!inserted.ok) throw new Error(insertFailureMessage(inserted.reason));

  const triggered = await triggerCardGenerate(floor, inserted.seq);
  if (!triggered.ok) throw new Error(cardFailureMessage(triggered));

  // 等结果落库：拿到路径才好记进 artifact（也顺手把失败暴露出来）
  const waited = await waitForEntry(floor, segment.messages[0]?.swipeId ?? 0, hash, inserted.seq);
  if (!waited.ok) console.warn('[ST-Story-Illustrator] 插画结果未取到：', waited.reason, waited.message);
  const imagePath = waited.ok ? waited.entry.path : '';

  const mesTextEl = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"] .mes_text`);
  const anchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : undefined;
  const artifact: VisualArtifact = {
    id: createArtifactId(),
    taskId: task.id,
    mode: 'illustration',
    chatId: task.chatId,
    sourceFloors: segment.floorIds,
    anchorFloor: floor,
    // 图片已经是正文内容（柏宝绘卡片），不再注入本插件卡片，避免重复与多余的说明文字
    mountMode: 'trailing',
    ...(anchor ? { textAnchor: anchor } : {}),
    imagePath,
    prompt,
    ...(plan.data.nl ? { nl: plan.data.nl } : {}),
    ...(plan.data.negative ? { negative: plan.data.negative } : {}),
    metadata: {
      embeddedInBody: true,
      bbiTag: tag,
      bbiHash: hash,
      bbiSlotSeq: inserted.seq,
      ...(waited.ok ? { bbiGenerationId: waited.entry.generationId } : {}),
      ...(waited.ok && typeof waited.entry.seed === 'number' ? { seed: waited.entry.seed } : {}),
    },
    createdAt: Date.now(),
  };
  appendArtifact(floor, artifact);
  await saveChatSafe();

  mountFloor(floor);
  ctx.report({ stage: 'completed' });
}

/** 插入失败时的可读原因。 */
function insertFailureMessage(reason: string): string {
  switch (reason) {
    case 'chat-changed': return '排队期间切换了聊天，已放弃写入（不覆盖别人的编辑）。';
    case 'floor-changed': return '排队期间楼层内容变了，已放弃写入。';
    case 'swipe-changed': return '排队期间楼层滑动到了别的版本，已放弃写入。';
    case 'save-failed': return '正文写入后保存聊天失败，已回滚。';
    default: return '无法写入正文（SillyTavern 上下文不可用）。';
  }
}

/** 卡片触发失败时的可读原因。 */
function cardFailureMessage(result: { reason: string; message?: string }): string {
  if (result.reason === 'blocked') return result.message || '柏宝绘未配置出图后端。';
  if (result.reason === 'no-card') {
    return '正文已写入 tag，但楼层卡片没有出现。请确认柏宝绘已启用（它负责把 tag 显示成卡片）。';
  }
  return '正文已写入 tag，但没能自动点开柏宝绘的「生成图片」，请在楼层卡片上手动点一下。';
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
  const swipeId = segment.messages[0]?.swipeId ?? 0;
  const sendDate = segment.messages[0]?.sendDate;
  const layout = modeSettings.comicLayout ?? 'regular';
  const dialoguePolicy = modeSettings.comicDialoguePolicy ?? deps.fullSettings.dialoguePolicy ?? 'auto';
  const bubbleStyle = modeSettings.comicBubbleStyle ?? deps.fullSettings.bubbleStyle;
  const bubbleFont = modeSettings.comicBubbleFont ?? deps.fullSettings.bubbleFont;
  const showComposite = modeSettings.comicShowComposite !== false;

  ctx.report({ stage: 'reading' });
  const characters = await getCharacters(floor);

  const planOptions = {
    panelMode: true,
    panelLayout: layout,
    pageType: modeSettings.comicPageType ?? 'auto',
    // 漫画页必须有对白：这是它区别于「一张插画」的一半信息量，不给模型就永远没有
    dialogue: true,
    dialoguePolicy,
    dialogueMode: 'json' as const,
    // nl 是唯一能分区描述「上格/下格」的通道，关掉就只能靠 tag 碰运气
    nl: true,
    backend: 'nai' as const,
    charPrompts: false,
    includeChinese: deps.fullSettings.includeChinese,
    maxPages: modeSettings.comicMaxPages ?? 1,
  };

  let plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: planOptions,
    caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');

  // 相关度兜底：整页 tag 里只有构图词、没有任何画面内容时，出图必然与选段无关。
  // 这种情况再问一次（把「必须写人和动作」显式塞进 user prompt），仍旧不行才报错。
  if (!hasStoryContent(plan.data)) {
    console.warn('[ST-Story-Illustrator] 分镜 tag 缺少画面内容，重试一次。');
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      options: {
        ...planOptions,
        extraInstruction:
          '上一次的分镜 tags 里只有构图词，没有任何人物、动作、场景——那样的图与剧情无关。' +
          '这次每格的 tags 必须写出：角色外观（来自角色快照）、这个人正在做什么、在哪里、画面里的关键物件。',
      },
      caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');
    if (!hasStoryContent(plan.data)) {
      throw new Error('分镜计划里每格都只有构图词、没有人物与动作（出图会与选段无关）。请换用更有能力的写 tag 模型。');
    }
  }

  const totalPanels = plan.data.reduce((sum, page) => sum + page.panels.length, 0);
  let done = 0;

  // 整本漫画用同一套出图方案，只在开始前切一次
  await ensureModeOutPlan('comic', deps);

  // 上一格插进去的 tag：下一格以它为锚点，保证多格按顺序排在一起
  let previousTag: string | null = null;

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
      // 角色外观由角色库兜底注入：模型漏写时至少人还是那个人
      const prompt = mergeCharacterTags(
        enforced.prompt,
        panel.characters.map(c => c.name),
        characters.characters,
      );

      const tag = buildBbiTag({
        prompt,
        ...(enforced.nl ? { nl: enforced.nl } : {}),
        size: 'portrait',
      });
      const hash = promptHash(tag);
      const inserted = await insertImageTag({
        floor,
        chatId: task.chatId,
        swipeId,
        ...(sendDate ? { sendDate } : {}),
        tag,
        anchorText: previousTag ?? segment.text.slice(0, 120),
      });
      if (!inserted.ok) throw new Error(insertFailureMessage(inserted.reason));
      previousTag = tag;

      const triggered = await triggerCardGenerate(floor, inserted.seq);
      if (!triggered.ok) throw new Error(cardFailureMessage(triggered));

      const waited = await waitForEntry(floor, swipeId, hash, inserted.seq);
      if (!waited.ok) {
        console.warn('[ST-Story-Illustrator] 分格结果未取到：', waited.reason, waited.message);
        done += 1;
        continue;
      }

      // 对白气泡：柏宝绘卡片只认一条图片路径，没有显示时加工的钩子，
      // 所以合成一次、把卡片指向带字版，原图仍留在图库。
      let imagePath = waited.entry.path;
      let bakedPath = '';
      if (showComposite && panel.dialogue?.length) {
        const baked = await bakeDialogueIntoImage({
          imagePath,
          dialogue: panel.dialogue,
          style: bubbleStyle,
          font: bubbleFont,
        });
        if (baked && (await replaceEntryPath(floor, swipeId, hash, waited.entry.generationId, baked))) {
          bakedPath = baked;
          imagePath = baked;
        }
      }

      const artifact: VisualArtifact = {
        id: createArtifactId(),
        taskId: task.id,
        mode: 'comic',
        chatId: task.chatId,
        sourceFloors: segment.floorIds,
        anchorFloor: floor,
        mountMode: 'trailing',
        pageIndex: page.pageIndex,
        panelIndex: panel.index,
        imagePath,
        prompt,
        ...(panel.nl ? { nl: panel.nl } : {}),
        ...(panel.dialogue ? { dialogue: panel.dialogue } : {}),
        metadata: {
          // 图的显示交给柏宝绘卡片，本插件不再挂卡片
          embeddedInBody: true,
          pageTitle: page.title,
          panelTitle: panel.title,
          layout: page.layout,
          bbiTag: tag,
          bbiHash: hash,
          bbiSlotSeq: inserted.seq,
          bbiGenerationId: waited.entry.generationId,
          ...(bakedPath ? { bubbleBakedPath: bakedPath } : {}),
          ...(typeof waited.entry.seed === 'number' ? { seed: waited.entry.seed } : {}),
        },
        createdAt: Date.now(),
      };
      appendArtifact(floor, artifact);
      done += 1;
    }
  }
  await saveChatSafe();
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
  await ensureModeOutPlan(mode, deps);
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
      // 小剧场文本按该模式指派的渠道生成，失败回退主 API
      const caller = makeModeLlmCaller(deps.fullSettings, mode);
      try {
        return await caller('', prompt);
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

  // 一次生成的 N 格合成一张卡片：共用 setId，卡片头显示「黑白漫 · 4 格」+ 标题，
  // 格内可单独重画，整条可重出（都要靠这些字段还原当时的输入）。
  const setId = newSetId();
  const characterName = segment.messages.find(m => !m.isUser)?.speaker ?? '';
  const setTitle = result.stories[0]?.title ?? '';
  const total = result.stories.length;
  const stories = result.stories.map(story => ({
    ...story,
    setId,
    setTitle,
    setSize: total,
    sourceText: segment.text,
    characterName,
  }));
  if (!saveSet(floor, kind, stories)) throw new Error('小剧场已生成，但写不进本楼（聊天上下文不可用）。');
  await saveChatSafe();

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
