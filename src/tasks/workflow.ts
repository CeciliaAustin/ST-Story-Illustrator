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
  BbiStatusInfo,
  StoryIllustratorSettings,
} from '../types';
import { ensureModeOutPlan, acquirePlanGuard, releasePlanGuard } from './modePlan';
import { runTheaterTask, bakeTheaterLines } from './theaterRun';
import { readOutConfig, activePlanModel } from '../baibai/planConfig';
import { resolveModeSettings, MODE_LABEL } from '../types';
import { getAnchorFloor, getSurroundingContext } from '../selection/storySegment';
import { buildAnchor } from '../selection/anchor';
import { extractPlainText } from '../selection/anchor';
import { getCharacters } from '../baibai/bridge';
import { saveChatSafe } from '../host/sillytavern';
import { generateIllustrationPlan, generateComicPlan, makeModeLlmCaller } from '../manga/planGenerator';
import { buildLibraryBlock, buildCastBlock, readCastContext } from '../theater/library';
import { composeEnglishPrompt } from '../prompt/compose';
import { enforceForGeneration } from '../manga/panelEnforce';
import { resolvePanelsPerPage } from '../manga/panelPlan';
import { hasStoryContent } from '../manga/panelRelevance';
import { composePagePrompt } from '../manga/pageCompose';
import { bakeDialogueIntoImage } from '../manga/bubbleBake';
import { panelSlots, layoutNoGoZones } from '../manga/panelSlots';
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
import { recordImageLog, recordLlmError, recordNotice } from '../log/imageLog';
import { saveSet, newSetId } from '../theater/store';
import type { QueueRunContext } from './taskQueue';

// ============================================================
// 类型与工具
// ============================================================

export interface WorkflowDeps {
  settings: VisualProfile[];
  fullSettings: StoryIllustratorSettings;
}

function sceneFromSegment(segment: StorySegment) {
  const context = getSurroundingContext(segment, 1);
  return {
    selectedText: segment.text,
    ...(context.previousText ? { previousText: context.previousText } : {}),
    ...(context.nextText ? { nextText: context.nextText } : {}),
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
  // 与柏宝绘自己读剧情同一套取证：整份角色库（发色/瞳色/体型/固定着装）+「谁是谁」。
  // 以前只发 `- 名字: tag`：条目里 tag 为空、只有字段的人，模型看到的就只剩一个名字，
  // 于是自己编一张脸——「人物都没填」就是这么来的。
  const cast = readCastContext(segment.messages.find(m => !m.isUser)?.speaker ?? '');
  const libraryBlock = buildLibraryBlock(characters.characters);
  const castBlock = buildCastBlock(cast);
  if (!libraryBlock) {
    recordNotice({
      mode: 'illustration',
      floor,
      text: '柏宝绘角色库是空的（或这一楼之前还没有档案）：这次插图没有任何外貌可抄，'
        + '画出来的人不会是故事里的角色。请到柏宝绘 →「角色」里确认条目存在。',
    });
  }
  const plan = await generateIllustrationPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    // nl 是柏宝绘的画面细节通道（它自己的每张图都带），以前这里读 includeNl，
    // 默认 false 且没有 UI → 生成的 tag 里没有 <nl>，看着就像「没走柏宝绘的流程」。
    options: {
      includeChinese: deps.fullSettings.includeChinese,
      includeNl: true,
      includeNegative: true,
    },
    ...(libraryBlock ? { libraryBlock } : {}),
    ...(castBlock ? { castBlock } : {}),
    caller: makeModeLlmCaller(deps.fullSettings, 'illustration'),
    promptOverrides: deps.fullSettings.promptOverrides,
  });
  if (!plan.ok || !plan.data) {
    recordLlmError({ mode: 'illustration', floor, error: plan.error ?? 'Tag 计划生成失败。' });
    throw new Error(plan.error ?? 'Tag 计划生成失败。');
  }

  ctx.report({ stage: 'review' });
  // PromptSegment.chinese 可选，TagSegment.chinese 必需 → 补齐空数组后再组装
  const tagSegments = plan.data.segments.map(seg => ({
    ...seg,
    chinese: seg.chinese ?? [],
  }));
  const prompt = composeEnglishPrompt(tagSegments);
  if (!prompt.trim()) throw new Error('组装后的英文 prompt 为空。');

  ctx.report({ stage: 'generating' });

  // 正文插图**不切方案**：柏宝绘卡片用的就是用户自己选的那套。
  // 以前这里会切到「正文插画」的模式方案，配合小剧场切走不切回，
  // 结果「选了 QQ 人，正文插图也跟着变 Q 版」。正文是用户的主画面，
  // 方案归用户管，插件不插手。

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
  if (inserted.position === 'appended') {
    // 兜底发生时要吭声：用户看到的是「图跑到最下面」，不说一句会以为是 bug。
    recordNotice({
      mode: 'illustration',
      floor,
      text: '没能在正文里定位到你划线的那段原文（可能选段被改过，或这一楼已有图片 tag），'
        + '这张图已追加到本楼末尾。',
    });
  }

  const triggered = await triggerCardGenerate(floor, inserted.seq);
  if (!triggered.ok) throw new Error(cardFailureMessage(triggered));

  // 等结果落库：拿到路径才好记进 artifact（也顺手把失败暴露出来）
  const imageStartedAt = Date.now();
  const waited = await waitForEntry(floor, segment.messages[0]?.swipeId ?? 0, hash, inserted.seq);
  if (!waited.ok) console.warn('[ST-Story-Illustrator] 插画结果未取到：', waited.reason, waited.message);
  recordImageLog({
    mode: 'illustration',
    floor,
    source: 'card',
    plan: readOutConfig().activePlanName,
    model: activePlanModel(),
    prompt,
    ...(plan.data.nl ? { nl: plan.data.nl } : {}),
    ...(plan.data.negative ? { negative: plan.data.negative } : {}),
    size: plan.data.size ?? 'portrait',
    ...(waited.ok && typeof waited.entry.seed === 'number' ? { seed: waited.entry.seed } : {}),
    status: waited.ok ? 'ok' : 'error',
    ...(waited.ok ? {} : { error: waited.message ?? waited.reason }),
    durationMs: Date.now() - imageStartedAt,
  });
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

  const modeSettings = resolveModeSettings(deps.fullSettings, 'comic');
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
    // 漫画页必须有对白：这是它区别于「一张插画」的一半信息量
    dialogue: true,
    dialoguePolicy,
    dialogueMode: 'json' as const,
    // nl 是唯一能分区描述「上格/下格」的通道，关掉就只能靠 tag 碰运气
    nl: true,
    backend: 'nai' as const,
    charPrompts: false,
    includeChinese: deps.fullSettings.includeChinese,
    maxPages: modeSettings.comicMaxPages ?? 1,
    panelsPerPage: resolvePanelsPerPage(layout, modeSettings.comicPanelsPerPage),
  };

  let plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: planOptions,
    caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
    promptOverrides: deps.fullSettings.promptOverrides,
  });
  if (!plan.ok || !plan.data) {
    recordLlmError({ mode: 'comic', floor, error: plan.error ?? '分镜计划生成失败。' });
    throw new Error(plan.error ?? '分镜计划生成失败。');
  }

  // 相关度兜底：整页 tag 只有构图词、没有画面内容时，出图必然与选段无关。
  if (!hasStoryContent(plan.data)) {
    console.warn('[ST-Story-Illustrator] 分镜 tag 缺少画面内容，重试一次。');
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      options: {
        ...planOptions,
        extraInstruction:
          '上一次的 tags 里只有构图词，没有任何人物、动作、场景——那样的图与剧情无关。' +
          '这次 page.tags 必须写出：角色外观（来自角色快照）、这个人正在做什么、在哪里、画面里的关键物件。',
      },
      caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
      promptOverrides: deps.fullSettings.promptOverrides,
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');
    if (!hasStoryContent(plan.data)) {
      throw new Error('分镜计划里只有构图词、没有人物与动作（出图会与选段无关）。请换用更有能力的写 tag 模型。');
    }
  }

  // 整本漫画用同一套出图方案，只在开始前切一次
  await ensureModeOutPlan('comic', deps.fullSettings);

  let done = 0;
  const totalPages = plan.data.length;

  // **一页 = 一张图**：构图词让 NAI 一次画出多格版面，各格内容只靠 nl 分区描述。
  // 按格各出一张图只会得到一堆单幅插画，永远不是漫画。
  for (const page of plan.data) {
    if (ctx.signal.aborted) return;
    ctx.report({ stage: 'generating', page: page.pageIndex + 1, totalPages });

    const composed = composePagePrompt(page, characters.characters);
    const enforced = enforceForGeneration({
      prompt: composed.prompt,
      nl: composed.nl,
      panelMode: true,
      panelLayout: page.layout,
      chibiOn: false,
      storyImage: false,
      panelsPerPage: resolvePanelsPerPage(page.layout, modeSettings.comicPanelsPerPage),
    });

    const tag = buildBbiTag({
      prompt: enforced.prompt,
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
      anchorText: segment.text.slice(0, 120),
    });
    if (!inserted.ok) throw new Error(insertFailureMessage(inserted.reason));

    const triggered = await triggerCardGenerate(floor, inserted.seq);
    if (!triggered.ok) throw new Error(cardFailureMessage(triggered));

    const pageStartedAt = Date.now();
    const waited = await waitForEntry(floor, swipeId, hash, inserted.seq);
    recordImageLog({
      mode: 'comic',
      floor,
      source: 'card',
      plan: readOutConfig().activePlanName,
      model: activePlanModel(),
      prompt: enforced.prompt,
      ...(enforced.nl ? { nl: enforced.nl } : {}),
      size: 'portrait',
      ...(waited.ok && typeof waited.entry.seed === 'number' ? { seed: waited.entry.seed } : {}),
      status: waited.ok ? 'ok' : 'error',
      ...(waited.ok ? {} : { error: waited.message ?? waited.reason }),
      durationMs: Date.now() - pageStartedAt,
    });
    if (!waited.ok) {
      console.warn('[ST-Story-Illustrator] 漫画页结果未取到：', waited.reason, waited.message);
      continue;
    }

    // 对白气泡：卡片只认一条图片路径，所以合成一次、把卡片指向带字版（原图留库）
    let imagePath = waited.entry.path;
    let bakedPath = '';
    if (showComposite && composed.dialogue.length) {
      // 气泡要落进「自己那一格」：格位由我们自己下发的版面反推（真漫画的第一条排版语法）
      const panelCount = resolvePanelsPerPage(page.layout, modeSettings.comicPanelsPerPage) || page.panels.length;
      const slots = panelSlots(page.layout, panelCount, modeSettings.comicPageType ?? 'auto');
      const noGo = layoutNoGoZones(page.layout, modeSettings.comicPageType ?? 'auto');
      const baked = await bakeDialogueIntoImage({
        imagePath,
        dialogue: composed.dialogue,
        style: bubbleStyle,
        font: bubbleFont,
        ...(slots.length ? { slots } : {}),
        ...(noGo.length ? { noGo } : {}),
        ...(slots.length ? {
          panelCast: page.panels.map(panel => (panel.characters ?? []).map(c => c.name).filter(Boolean)),
        } : {}),
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
      imagePath,
      prompt: enforced.prompt,
      ...(enforced.nl ? { nl: enforced.nl } : {}),
      ...(composed.dialogue.length ? { dialogue: composed.dialogue } : {}),
      metadata: {
        embeddedInBody: true,
        pageTitle: page.title,
        layout: page.layout,
        panelTitles: composed.panelTitles,
        panelCount: page.panels.length,
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

  await saveChatSafe();
  if (done === 0) throw new Error('所有漫画页出图均失败。');
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
  const characterName = segment.messages.find(m => !m.isUser)?.speaker ?? '';

  ctx.report({ stage: 'reading' });
  await ensureModeOutPlan(mode, deps.fullSettings);

  // 首次生成与「整条重出」走同一条链路（theaterRun.runTheaterTask），
  // 免得两处各拼一套出图词、行为悄悄分叉。
  const result = await runTheaterTask({
    mode,
    settings: deps.fullSettings,
    floor,
    chatId: task.chatId,
    swipe: segment.messages[0]?.swipeId ?? 0,
    body: segment.text,
    characterName,
    onPanel: (index, total) => ctx.report({ stage: 'generating', page: index + 1, totalPages: total }),
  });

  if (!result.ok) throw new Error(result.error ?? '小剧场生成失败。');

  // 角色库里没有的人，出图一定不像。这在成图上看不出来（只像「画风随便」），
  // 所以必须单独记一条，让用户知道该去柏宝绘补角色。
  // 角色库里没有的人，出图一定不像。成图上完全看不出来（只像「画风随便」），
  // 所以既记一条日志、也在收尾时告诉用户该去柏宝绘补角色。
  if (result.missingLooks?.length) {
    recordNotice({
      mode,
      floor,
      text: `柏宝绘角色库里没有：${result.missingLooks.join('、')}。`
        + '这几个人这次没有外貌 tag，画出来不会是他们的样子。'
        + '到柏宝绘 →「角色」里补上；如果整个角色库是空的，先让柏宝绘的自动打标跑一遍，'
        + '角色（发型/眼睛/服装）建好后再重出即可。',
    });
  }
  const warning = result.missingLooks?.length
    ? `角色库里没有 ${result.missingLooks.join('、')}：这几个人这次没带上外貌。`
    : '';

  // 一次生成的 N 格合成一张卡片：共用 setId，卡片头显示「黑白漫 · 4 格」+ 标题，
  // 格内可单独重画，整条可重出（都要靠这些字段还原当时的输入）。
  const setId = newSetId();
  const setTitle = result.stories[0]?.title ?? '';
  const total = result.stories.length;
  const stories: BbiStatusInfo[] = [];
  for (const story of result.stories) {
    let imagePath = story.imagePath;
    let originalPath: string | undefined;
    // 黑白漫带台词：把 lines 画成气泡叠上去。卡片只认一个路径，
    // 原图留在图库里（originalPath），带字版给卡片显示。
    if (kind === 'manga' && story.lines?.length && imagePath) {
      const baked = await bakeTheaterLines(imagePath, story.lines, deps.fullSettings, kind);
      if (baked.baked) {
        originalPath = imagePath;
        imagePath = baked.path;
      }
    }
    stories.push({
      ...story,
      imagePath,
      ...(originalPath ? { originalPath } : {}),
      setId,
      setTitle,
      setSize: total,
      sourceText: segment.text,
      characterName,
    });
  }
  if (!saveSet(floor, kind, stories)) throw new Error('小剧场已生成，但写不进本楼（聊天上下文不可用）。');
  await saveChatSafe();

  mountTheater(floor);
  ctx.report({ stage: 'completed', ...(warning ? { message: warning } : {}) });
}

// ============================================================
// 模式分派
// ============================================================

export function createTaskRunner(deps: WorkflowDeps) {
  return async (task: VisualTask, ctx: QueueRunContext): Promise<void> => {
    // 方案是柏宝绘的**全局**状态：本任务切走过，就必须切回用户原来那套，
    // 否则接下来正文插图会用 QQ 人/黑白漫的模型与画师串出图。
    // 用引用计数而不是「谁先结束谁还原」：重画可能插在任务中间跑，
    // 先退出的那个不能把还在出图的任务手里的方案抢走。
    acquirePlanGuard();
    try {
      switch (task.mode) {
        case 'illustration': return await runIllustration(task, ctx, deps);
        case 'comic': return await runComic(task, ctx, deps);
        case 'chibi-status':
        case 'chibi-bonus':
        case 'bw-manga': return await runTheaterMode(task, ctx, deps);
        default: throw new Error(`未知创作模式: ${task.mode}`);
      }
    } finally {
      // 最后一个交还的负责还原；失败会写进出图日志并弹提示（不吞掉任务结果）
      const restored = await releasePlanGuard(deps.fullSettings);
      if (!restored.ok && restored.message) {
        console.warn('[ST-Story-Illustrator]', restored.message);
      }
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

export { MODE_LABEL };
