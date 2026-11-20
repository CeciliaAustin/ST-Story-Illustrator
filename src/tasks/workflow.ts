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
  ComicPanelPlan,
  PanelLayout,
  BbiStatusInfo,
  StoryIllustratorSettings,
} from '../types';
import { ensureModeOutPlan, acquirePlanGuard, releasePlanGuard } from './modePlan';
import { runTheaterTask, bakeTheaterLines, pickProfile, fallbackProfile } from './theaterRun';
import { readOutConfig, activePlanModel, nlForMode } from '../baibai/planConfig';
import { resolveModeSettings, MODE_LABEL } from '../types';
import { getAnchorFloor, getSurroundingContext } from '../selection/storySegment';
import { buildAnchor } from '../selection/anchor';
import { extractPlainText } from '../selection/anchor';
import { getCharacters } from '../baibai/bridge';
import { readBackendState, baiBaiAdapter } from '../baibai/imageAdapter';
import { readBookRoles } from '../baibai/bookMemory';
import { appendOutfit, buildOutfitBlock, outfitOf, resolveOutfits } from '../baibai/outfit';
import { saveChatSafe, readPersonaName, getSwipeId, uploadImageBase64, blobToBase64 } from '../host/sillytavern';
import { generateIllustrationPlan, generateComicPlan, makeModeLlmCaller } from '../manga/planGenerator';
import { buildLibraryBlock, buildCastBlock, readCastContext } from '../theater/library';
import { splitSegments, characterPromptsFromLibrary } from '../manga/tagSplit';
import { enforceForGeneration } from '../manga/panelEnforce';
import { resolvePanelsPerPage } from '../manga/panelPlan';
import { resolveLayoutStyle, resolvePanelCount, resolveWhitespaceIntent } from '../manga/layoutStyle';
import { buildBoardGeneration } from '../manga/stylePrompt';
import { enforcePanelPrompt } from '../manga/boardPrompt';
import { resolveSourceDialogue, reconcileDialogueDetailed } from '../manga/sourceDialogue';
import { hasStoryContent } from '../manga/panelRelevance';
import { composePagePrompt, findCastShortfall, buildDeclarativePageNl } from '../manga/pageCompose';
import { pageSlotsFor } from '../manga/pageSlots';
import { buildPanelShots } from '../manga/panelShot';
import { expandPanels } from '../manga/panelExpand';
import { assemblePageBlob } from '../manga/pageAssemble';
import { createArtifactId, appendArtifact, updateArtifact } from '../storage/repository';
import {
  buildManwaTag,
  insertManwaTag,
  ensureManwaRegexRegistered,
  isManwaRegexRegistered,
} from '../baibai/manwaTag';
import { mountFloor } from '../ui/floorCards';
import { waitForBaiBaiImages } from '../baibai/waitImages';
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

/**
 * 定妆块里要覆盖谁：先在选段正文里逐字点名的人（最多 4 个），
 * 一个都没点到时用角色库前几位。宁可少定，也不要把无关路人的衣服塞进去。
 */
function planIllustrationCast(text: string, library: readonly BaiBaiCharacter[]): string[] {
  const body = String(text ?? '');
  const named = library
    .map(c => String(c.name ?? '').trim())
    .filter(name => name && body.includes(name));
  const picked = named.slice(0, 4);
  if (picked.length) return picked;
  return library.slice(0, 4).map(c => String(c.name ?? '').trim()).filter(Boolean);
}

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
  // 柏宝书给的是「此刻穿什么、什么状态」，与角色库的「固定外貌」互补；
  // 正文里换过衣服、淋过雨、衣服破了，只有它知道。读不到就不发（不猜）。
  const book = readBookRoles(floor, segment.text, readPersonaName());
  // 本批定妆：柏宝书此刻穿什么 + 角色库固定着装，交给写 tag 的模型翻成英文。
  // 以前只把角色参考当文本发过去、模板又禁止写服装 → 角色块里一件衣服都没有。
  const illustrationOutfitBlock = buildOutfitBlock({
    ...(book?.outfits ? { bookOutfits: book.outfits } : {}),
    library: characters.characters,
    cast: planIllustrationCast(segment.text, characters.characters),
    personaName: readPersonaName(),
  });
  if (!libraryBlock) {
    recordNotice({
      mode: 'illustration',
      floor,
      text: '柏宝绘角色库是空的（或这一楼之前还没有档案）：这次插图没有任何外貌可抄，'
        + '画出来的人不会是故事里的角色。请到柏宝绘 →「角色」里确认条目存在。',
    });
  }
  // nl 是柏宝绘的画面细节通道，但**要跟方案的开关走**：方案关了 nl（或底模是
  // NAI4）时就不该写，写了也用不上。以前这里写死 true，等于替用户把方案开关打开了。
  const wantNl = nlForMode(deps.fullSettings, 'illustration');
  const plan = await generateIllustrationPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: {
      includeChinese: deps.fullSettings.includeChinese,
      includeNl: wantNl,
      includeNegative: true,
    },
    ...(book ? { bookBlock: book.text } : {}),
    ...(illustrationOutfitBlock ? { outfitBlock: illustrationOutfitBlock } : {}),
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
  // NAI 4.5/V5 有原生 Character Prompts：Base 只留全局，个人外貌走 <characters>。
  // 旧版把所有段拼成一串塞进 Base，两个人的头发衣服全糊在一起——那正是「人物不像」的来源。
  const nativeCharacters = (await readBackendState()).supportsCharacters !== false;
  const split = splitSegments(tagSegments, nativeCharacters);
  // 与柏宝绘同一条定妆链路：把模型翻出的英文着装逐字拼进每个角色块，
  // 一个人一批只穿一套。没有它，插图穿的衣服每次都由 NAI 随机决定。
  const illustrationPersona = readPersonaName();
  const illustrationOutfits = resolveOutfits(plan.data.outfits, illustrationPersona);
  const dressedCharacters = split.characters.map(block => {
    const outfit = outfitOf(block.name, illustrationOutfits, characters.characters, illustrationPersona);
    if (!outfit) return block;
    const tag = appendOutfit(block.tag, outfit);
    return tag === block.tag ? block : { ...block, tag };
  });
  const outfitBaseTags = dressedCharacters.length
    ? []
    : [...illustrationOutfits.values()].map(item => item.outfit);
  const baseWithOutfit = outfitBaseTags.length
    ? `${split.base.replace(/,\s*$/, '')}, ${outfitBaseTags.join(', ')}`
    : split.base;
  const prompt = baseWithOutfit;
  if (!prompt.trim()) throw new Error('组装后的英文 prompt 为空。');

  ctx.report({ stage: 'generating' });

  // 正文插图**不切方案**：出图用的就是用户自己选的那套。
  // 以前这里会切到「正文插画」的模式方案，配合小剧场切走不切回，
  // 结果「选了 QQ 人，正文插图也跟着变 Q 版」。正文是用户的主画面，
  // 方案归用户管，插件不插手。

  // 正文插图**不往正文里写 tag**（这一条是这次改的核心）。
  //
  // 以前写一条 <bbi_image> 再点它的卡片出图，看起来最省事，实际是在跟柏宝绘
  // 抢同一块正文：它扫到已有 tag 就整楼跳过（自动模式），用户点「重新生成本楼」
  // 时它又会 stripImageTags 把整楼 tag 一起清掉——我们那张跟着消失，序号也被重排。
  // 现在改调它的公开 API：同一个后端、同一套方案、同一道并发闸门、同样进
  // 「请求历史」与图库，但正文一个字都不碰。两边的命名空间彻底分开，
  // 物理上不存在「被替换」这件事。
  const galleryCharacter = segment.messages.find(m => !m.isUser)?.speaker ?? readPersonaName();
  const imageStartedAt = Date.now();
  let imagePath = '';
  let seed: number | undefined;
  try {
    const result = await baiBaiAdapter.generate(
      {
        prompt,
        // 方案不要 nl 时，即便模型自作主张写了也不发：柏宝绘不会用它，
        // 白白占掉 tag 权重，还会让「改词」面板显示一段其实没生效的描述。
        ...(wantNl && plan.data.nl ? { nl: plan.data.nl } : {}),
        ...(plan.data.negative ? { negative: plan.data.negative } : {}),
        ...(dressedCharacters.length ? { characters: dressedCharacters } : {}),
        ...(galleryCharacter ? { character: galleryCharacter } : {}),
        size: plan.data.size === 'landscape' ? 'landscape' : 'portrait',
        save: true,
      },
      pickProfile(deps.fullSettings.profiles ?? [], 'illustration') ?? fallbackProfile('illustration'),
    );
    imagePath = result.path ?? result.dataUrl ?? '';
    if (typeof result.seed === 'number') seed = result.seed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode: 'illustration',
      floor,
      source: 'api',
      plan: readOutConfig().activePlanName,
      model: activePlanModel(),
      prompt,
      ...(plan.data.nl ? { nl: plan.data.nl } : {}),
      ...(plan.data.negative ? { negative: plan.data.negative } : {}),
      size: plan.data.size ?? 'portrait',
      status: 'error',
      error: message,
      durationMs: Date.now() - imageStartedAt,
    });
    throw new Error(`柏宝绘出图失败：${message}`);
  }
  recordImageLog({
    mode: 'illustration',
    floor,
    source: 'api',
    plan: readOutConfig().activePlanName,
    model: activePlanModel(),
    prompt,
    ...(plan.data.nl ? { nl: plan.data.nl } : {}),
    ...(plan.data.negative ? { negative: plan.data.negative } : {}),
    size: plan.data.size ?? 'portrait',
    ...(seed !== undefined ? { seed } : {}),
    status: imagePath ? 'ok' : 'error',
    ...(imagePath ? {} : { error: '柏宝绘没有返回图片（后端可能未配置）。' }),
    durationMs: Date.now() - imageStartedAt,
  });
  if (!imagePath) throw new Error('柏宝绘没有返回图片：请到柏宝绘设置里确认出图后端已配置。');

  const mesTextEl = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"] .mes_text`);
  const anchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : undefined;
  const artifact: VisualArtifact = {
    id: createArtifactId(),
    taskId: task.id,
    mode: 'illustration',
    chatId: task.chatId,
    sourceFloors: segment.floorIds,
    anchorFloor: floor,
    // 记下这一版正文是第几条 swipe：换 swipe 后显示层据此隐藏属于别的 swipe 的作品，
    // 而 message.extra 本身不会随 swipe 重置（否则旧图会挂在新正文上）。
    swipeId: getSwipeId(floor),
    // 这张图由本插件自己挂（正文里没有它的 tag）：位置靠 textAnchor，
    // 存在与否靠 artifact 本身，正文里一个字符都不留。
    mountMode: 'inline',
    ...(anchor ? { textAnchor: anchor } : {}),
    imagePath,
    prompt,
    ...(plan.data.nl ? { nl: plan.data.nl } : {}),
    ...(plan.data.negative ? { negative: plan.data.negative } : {}),
    ...(seed !== undefined ? { seed } : {}),
    metadata: {
      // 显示层据此判定「这张不需要正文 tag 也能显示」（漫画的锚点才是 tag）
      anchorKind: 'text',
      source: 'baibai-api',
      ...(dressedCharacters.length ? { characters: dressedCharacters } : {}),
      ...(galleryCharacter ? { galleryCharacter } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
    createdAt: Date.now(),
  };
  appendArtifact(floor, artifact);
  await saveChatSafe();

  mountFloor(floor);
  ctx.report({ stage: 'completed' });
}

// ============================================================
// 漫画分镜模式
// ============================================================

/**
 * 这一页该锚到正文的哪一句话（任务书 §8：一页一个 source range，一个挂载点）。
 *
 * 优先用本页台词原文——它是从选段里逐字摘出来的，在楼层正文里找得到；
 * 台词可能是半句，取前 24 字足够定位又不至于跨过多个句子。没有台词时退回 beat.event
 * （模型对这一瞬间的概括，偶尔命中），最后才退回选段开头（旧行为）。
 */
export function pickPageAnchorText(page: ComicPagePlan, segmentText: string): string {
  const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
  const firstLine = (page.dialogue ?? []).map(d => clean(d.text)).find(Boolean);
  if (firstLine) return firstLine.slice(0, 24);
  const beatEvent = clean(page.beat?.event);
  if (beatEvent && segmentText.includes(beatEvent)) return beatEvent.slice(0, 24);
  return segmentText.slice(0, 120);
}

async function runComic(
  task: VisualTask,
  ctx: QueueRunContext,
  deps: WorkflowDeps,
): Promise<void> {
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error('无法确定挂载楼层。');

  const modeSettings = resolveModeSettings(deps.fullSettings, 'comic');
  // 出图落盘的分组名（柏宝绘图库里按角色分文件夹）；取本楼说话的角色
  const characterName = segment.messages.find(m => !m.isUser)?.speaker ?? '';
  // 版面档位：默认「自动」，由模型按每页剧情挑（用户钉死则以用户为准）
  const layout = modeSettings.comicLayout ?? 'auto';
  // 新版面三维度：用户 UI 选的「风格 / 格数 / 留白」。它们直接驱动出图词——
  // 不再经 layoutStyleToLegacy 拍回旧四档，否则「开放拼版」会被旧词表的
  // split screen 压成竖切屏、「固定三格」会退回 one-or-two 只画一格。
  const comicStyle = resolveLayoutStyle(modeSettings);
  const comicPanelCount = resolvePanelCount(modeSettings);
  const comicWhitespace = modeSettings.comicWhitespace ?? 'auto';
  // 留白偏好归一成具体意图（auto 时按风格默认）——版面判定要用它区分 inset / unframed
  const whitespaceIntent = resolveWhitespaceIntent(comicWhitespace, comicStyle);
  // 固定格数取新字段；旧字段只做兼容兜底（UI 现在两个都写）
  const fixedPanels = comicPanelCount === 'auto' ? 0 : comicPanelCount;
  // 台词 100% 原文：从用户选段里逐字抽出候选句，出图后按引用回填，LLM 不得改写
  const sourceDialogue = resolveSourceDialogue(segment.text);
  const dialoguePolicy = modeSettings.comicDialoguePolicy ?? deps.fullSettings.dialoguePolicy ?? 'auto';
  const showComposite = modeSettings.comicShowComposite !== false;
  // 这套漫画方案要不要写自然语言（读剧情与出图必须是同一个答案）
  const wantComicNl = nlForMode(deps.fullSettings, 'comic');

  // 漫画 tag 靠 ST 的托管正则换成锚点。正则没注册就写 tag，用户会看到一串裸文本，
  // 所以这里先确保注册成功，注册不上就不写（退回旧的行内挂载）。
  ensureManwaRegexRegistered();
  const manwaTagReady = isManwaRegexRegistered();

  ctx.report({ stage: 'reading' });
  const characters = await getCharacters(floor);
  // NAI 4.5/V5 才有原生 Character Prompts；没有它时外貌只能并进 Base
  const comicNativeCharacters = (await readBackendState()).supportsCharacters !== false;
  // 与插图、与柏宝绘自己同一套取证：柏宝书当前状态 + 整份角色库 + 谁是谁。
  // 漫画页人物最多，只发「名字: tag」时模型最容易自己编人。
  const personaName = readPersonaName();
  const comicBook = readBookRoles(floor, segment.text, personaName);
  const comicLibrary = buildLibraryBlock(characters.characters);
  const comicCast = buildCastBlock(readCastContext(segment.messages.find(m => !m.isUser)?.speaker ?? ''));
  const comicOutfitBlock = buildOutfitBlock({
    ...(comicBook?.outfits ? { bookOutfits: comicBook.outfits } : {}),
    library: characters.characters,
    cast: planIllustrationCast(segment.text, characters.characters),
    personaName,
  });
  const comicBlocks = {
    ...(comicBook ? { bookBlock: comicBook.text } : {}),
    ...(comicOutfitBlock ? { outfitBlock: comicOutfitBlock } : {}),
    ...(comicLibrary ? { libraryBlock: comicLibrary } : {}),
    ...(comicCast ? { castBlock: comicCast } : {}),
  };

  // 版面先落成柏宝绘四档：规划层与出图层必须用同一个答案。
  // 否则 LLM 按 auto 自由排（可能给 4 格），出图却是 inset 三格——图与计划必然对不上。
  const boardPlan = buildBoardGeneration({
    style: comicStyle,
    panelCount: comicPanelCount,
    whitespace: comicWhitespace,
  });

  const planOptions = {
    panelMode: true,
    panelLayout: boardPlan.layout,
    pageType: boardPlan.pageType,
    // 漫画页必须有对白：这是它区别于「一张插画」的一半信息量
    dialogue: true,
    dialoguePolicy,
    dialogueMode: 'json' as const,
    // nl 是唯一能分区描述「上格/下格」的通道，关掉就只能靠 tag 碰运气。
    // 但它同样是方案的属性：方案没有自然语言通道时，漫画只能靠 tags + panels 表达。
    nl: wantComicNl,
    backend: 'nai' as const,
    // 我们确实会给每个角色单独一块（<characters>），所以把「分格图不要写 pos」那条也带上
    charPrompts: comicNativeCharacters,
    includeChinese: deps.fullSettings.includeChinese,
    maxPages: modeSettings.comicMaxPages ?? 1,
    // 格数以版面解析结果为准：inset/unframed 最多三格、regular 由 koma 定，
    // 让模型按"这一档真的能画几格"来排，而不是按用户填的数字硬塞。
    panelsPerPage: boardPlan.panelCount,
    // 新版面系统三维度（老设置经 adapter 迁移而来，不覆盖用户偏好）
    layoutStyle: comicStyle,
    layoutPanelCount: comicPanelCount,
    layoutWhitespace: comicWhitespace,
    // 台词只从这些原文候选里引用，禁止 LLM 现编 / 改写
    sourceDialogue,
    // 一页多格各自出图：规划层不许再写页级构图词，版面由代码排版
    perPanel: true,
  };

  let plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: planOptions,
    ...comicBlocks,
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
      ...comicBlocks,
      options: {
        ...planOptions,
        extraInstruction:
          '上一次的 tags 里只有构图词，没有任何人物、动作、场景——那样的图与剧情无关。' +
          '这次 page.tags 必须写出：谁在做什么、在哪里、画面里的关键物件（外貌由角色库提供，不要写进 page.tags）。',
      },
      caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
      promptOverrides: deps.fullSettings.promptOverrides,
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');
    if (!hasStoryContent(plan.data)) {
      throw new Error('分镜计划里只有构图词、没有人物与动作（出图会与选段无关）。请换用更有能力的写 tag 模型。');
    }
  }

  // 人数体检（任务书 §3.3 新口径）：只在「某一格明确写了两人同框、其中一人却没有外貌
  // 约束」时重问。单人格 / 双人局部 / 物件格一律放过，不再拿页级人数词强制每格同人。
  // 代码能补的（人设进库 / 库内固定双人）上面 composePagePrompt 已经补了；
  // 补不出来的情况只能让模型补 `look`，所以这里重问一次，并把它错在哪讲清楚。
  const castGap = findCastShortfall(plan.data, characters.characters, {
    nativeCharacters: comicNativeCharacters,
    selectedText: segment.text,
    ...(personaName ? { personaName } : {}),
  });
  if (castGap) {
    console.warn(
      `[ST-Story-Illustrator] 第 ${castGap.pageIndex + 1} 页有一格明确写了 ${castGap.declared} 人同框，` +
        `但只建出 ${castGap.blocks} 个有外貌的角色块，重问一次分镜。`,
    );
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      ...comicBlocks,
      options: {
        ...planOptions,
        extraInstruction:
          `上一版第 ${castGap.pageIndex + 1} 页有一格写了 ${castGap.declared} 人同框，` +
          `但只有 ${castGap.blocks} 人有外貌约束——那个人会成为画得随便的陌生人。` +
          '只修这一格：要么给缺外貌的那位（通常是用户扮演的「你」）补 look' +
          '（英文短语：发色/瞳色/体型/当前着装，取自【角色参考】/人设摘要），' +
          '要么把这一格改成单人/局部镜头——**不要把两个人都塞进本页每一格**。' +
          '其它单人局部格、道具格保持原样。',
      },
      caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
      promptOverrides: deps.fullSettings.promptOverrides,
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');
    const after = findCastShortfall(plan.data, characters.characters, {
      nativeCharacters: comicNativeCharacters,
      selectedText: segment.text,
      ...(personaName ? { personaName } : {}),
    });
    if (after) {
      // 重问一次还是对不上：这条必须让用户看见，否则他只会看到「又是只有一个人」。
      recordNotice({
        mode: 'comic',
        floor,
        text:
          `第 ${after.pageIndex + 1} 页有一格写着 ${after.declared} 人同框，但只能给出 ${after.blocks} 个有外貌的角色词。` +
          `多半是柏宝绘角色库里没有「${personaName || '你'}」这一条（或没填外貌），模型也补不出英文外貌。` +
          '到柏宝绘「角色管理」给人设建一条（1girl/1boy + 发色/瞳色/体型），之后这一页就会有两个完整的人。',
      });
    }
  }

  // 格数体检：「三格却只出一格」的第二个根因。
  // 逐格出图时**格子数 = panels 的条数**，而 panels 是模型写的：它把三格写进
  // 一个 subject，代码就只有一张图可出（实测 expectedPanelCount 3 / rendered 1，
  // pageSlots 只剩一条）。规则里写着「必须正好 N 条」它也会漏，所以这里先重问一次。
  const wantPanels = Math.max(1, boardPlan.panelCount);
  const shortPage = plan.data.find(p => (p.panels ?? []).length < wantPanels);
  if (shortPage) {
    const got = (shortPage.panels ?? []).length;
    console.warn(
      `[ST-Story-Illustrator] 第 ${shortPage.pageIndex + 1} 页只排了 ${got} 格（应为 ${wantPanels} 格），重问一次分镜。`,
    );
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      ...comicBlocks,
      options: {
        ...planOptions,
        extraInstruction:
          `上一版第 ${shortPage.pageIndex + 1} 页的 panels 只有 ${got} 条，而这一页固定 ${wantPanels} 格。` +
          `panels 必须正好 ${wantPanels} 条，一条就是一张图——把「谁在做什么」按镜头切面拆成 ${wantPanels} 个瞬间，` +
          '每格写自己的 shot / subject / characters / nl，不要把三格内容塞进一条 subject。' +
          '仍是同一时刻、同一地点、同一件事，只是镜头在不同位置（谁的脸、谁的手、哪个道具、空间关系）。',
      },
      caller: makeModeLlmCaller(deps.fullSettings, 'comic'),
      promptOverrides: deps.fullSettings.promptOverrides,
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? '分镜计划生成失败。');
  }

  // 重问过还少格：代码补齐（不编新事件，只把镜头推近）。
  // 宁可三格里有两格是同一画面的不同景别，也不要用户要三格只拿到一格。
  for (const page of plan.data) {
    const before = (page.panels ?? []).length;
    if (before >= wantPanels) continue;
    page.panels = expandPanels(page, wantPanels);
    recordNotice({
      mode: 'comic',
      floor,
      text:
        `第 ${page.pageIndex + 1} 页模型只排了 ${before} 格（这一页固定 ${wantPanels} 格），` +
        `已按同一瞬间的镜头切面补到 ${wantPanels} 格。补出来的格是同一画面的推近，不是新剧情。`,
    });
  }

  // 整本漫画用同一套出图方案，只在开始前切一次
  await ensureModeOutPlan('comic', deps.fullSettings);

  // 划线锚点：**每页都挂在同一处**，多页自然按顺序叠在选段后面
  const mesTextEl = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"] .mes_text`);
  const inlineAnchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : undefined;
  if (!inlineAnchor) {
    // 读不到正文结构就只能挂楼末：不说一句，用户会以为「又跑到最下面了」
    recordNotice({
      mode: 'comic',
      floor,
      text: '这一楼的正文结构读不到，漫画卡片会挂在楼层末尾（不是插在你划线的地方）。',
    });
  }

  let done = 0;
  const totalPages = plan.data.length;

  // **一页 = 一张图**：构图词让 NAI 一次画出多格版面，各格内容只靠 nl 分区描述。
  //
  // 这里**不再往正文写 <bbi_image>**：正文插图与漫画都写同一种 tag 时，两张卡会互相
  // 抢同一个槽位（用户看到的就是「前一个被后一个顶掉」）。漫画改成直连柏宝绘的
  // 公开 generate(save:true)——图照样进柏宝绘图库、能按角色分组翻到，显示则由本插件
  // 的正文卡片负责，插在划线处。两条链路从此各走各的，谁也不会顶掉谁。
  for (const page of plan.data) {
    if (ctx.signal.aborted) return;
    ctx.report({ stage: 'generating', page: page.pageIndex + 1, totalPages });

    // 版面（柏宝绘四档）在规划前就算好了，规划层与出图层共用同一个答案。
    // 构图词由这一档决定：hero_insets + 大面积留白 → inset（白底居中 + 四周留白 + 特写格），
    // 它的词表里**没有 koma**，所以"三条等宽横带"在结构上不可能再出现。
    const board = boardPlan;
    if (board.note) recordNotice({ mode: 'comic', floor, text: board.note });

    const pageForCompose: ComicPagePlan = { ...page, layout: board.layout as PanelLayout };
    // 整页词仍要算一份：逐格失败时用它整页出一张，至少这一页有图（不让整页空着）
    const composed = composePagePrompt(pageForCompose, characters.characters, {
      nativeCharacters: comicNativeCharacters,
      selectedText: segment.text,
      ...(personaName ? { personaName } : {}),
    });
    // 整页兜底也要守住语义：**不再用 `white background` 和「无框插画」**。
    // 那是「整张白纸上画一张无框插画」的写法 —— 模型会把格内背景一起抹掉，
    // 主画面也退化成独立插画而不是一个漫画格。这里改成声明式：
    // 告诉模型「这一页由 N 个独立画格组成」，底色只出现在格间空隙（由代码画）。
    const fallbackEnforced = enforcePanelPrompt(
      composed.prompt,
      board.layout,
      {
        ...(board.koma ? { koma: board.koma } : {}),
        declarative: true,
      },
    );
    const fallbackPrompt = fallbackEnforced.prompt;
    const fallbackNl = wantComicNl
      ? buildDeclarativePageNl(
        {
          layout: board.layout,
          pageType: board.pageType,
          panelCount: board.panelCount,
          whitespace: whitespaceIntent,
          ...(board.diagonal ? { diagonal: true } : {}),
        },
        pageForCompose,
      )
      : '';

    // 台词 100% 原文（详细版：能知道这次有几条没找到出处，而不是整页静默没字）
    const dialogueResult = reconcileDialogueDetailed(composed.dialogue, sourceDialogue);
    const dialogue = dialogueResult.dialogue;
    if (dialogueResult.dropped > 0) {
      recordNotice({
        mode: 'comic',
        floor,
        text:
          `第 ${page.pageIndex + 1} 页有 ${dialogueResult.dropped} 句台词在原文里找不到逐字出处，已略过。` +
          '宁可少一句，也不把这句被改写的台词画上去。',
      });
    }

    // ★ 逐格出图：格子是代码排的，格数不需要模型"配合"。
    // 每格独立一张图 —— 每格都有自己完整的场景背景，白底只出现在页面留白处。
    const planPanels = (page.panels ?? []).slice(0, Math.max(1, board.panelCount));
    const shotPage: ComicPagePlan = {
      ...page,
      panels: planPanels.length ? planPanels : [{ index: 0, title: page.title } as ComicPanelPlan],
    };
    const slots = pageSlotsFor(board.layout, shotPage.panels.length, { whitespace: whitespaceIntent });
    const shots = buildPanelShots(shotPage, slots, characters.characters, {
      nativeCharacters: comicNativeCharacters,
      selectedText: segment.text,
      ...(personaName ? { personaName } : {}),
    });

    // 一页下来一个角色块都没有：正向词里就只剩 page.tags 的场景与衣服，
    // 柏宝绘的「角色（柏宝绘角色库）」会是空的，脸全靠 NAI 自由发挥。
    // 这不是能静默过去的降级——说出来，用户才知道该去补角色库还是换名字。
    if (shots.length && shots.every(shot => shot.characters.length === 0)) {
      recordNotice({
        mode: 'comic',
        floor,
        text: characters.characters.length
          ? `第 ${page.pageIndex + 1} 页没带上任何角色外貌：分镜里这一页的每一格都没点名到角色库里的条目，`
            + '整页只有场景与服装。把这一页重画一次；仍这样就检查角色库的名字与分镜里写的人名是否一致。'
          : `第 ${page.pageIndex + 1} 页没带上任何角色外貌：柏宝绘角色库是空的。`
            + '先在柏宝绘里把角色存进角色库（或让柏宝书挂上），再重画这一页。',
      });
    }

    const panelPaths: string[] = [];
    const panelPrompts: string[] = [];
    const panelNls: string[] = [];
    let panelFailure = '';
    let pageSeed: number | undefined;
    const pageStartedAt = Date.now();

    for (const shot of shots) {
      if (ctx.signal.aborted) return;
      const shotStartedAt = Date.now();
      const useNl = wantComicNl && shot.nl ? { nl: shot.nl } : {};
      let result;
      try {
        result = await baiBaiAdapter.generate(
          {
            prompt: shot.prompt,
            ...useNl,
            ...(shot.characters.length ? { characters: shot.characters } : {}),
            ...(characterName ? { character: characterName } : {}),
            size: 'portrait',
            // 图必须进图库：用户是在柏宝绘的图库里找图、复用、看提示词的
            save: true,
          },
          pickProfile(deps.settings, 'comic') ?? fallbackProfile('comic'),
        );
      } catch (err) {
        panelFailure = err instanceof Error ? err.message : String(err);
        recordImageLog({
          mode: 'comic', floor, source: 'api',
          plan: readOutConfig().activePlanName,
          prompt: shot.prompt,
          ...useNl,
          ...(shot.characters.length ? { characters: shot.characters } : {}),
          size: 'portrait',
          status: 'error',
          error: panelFailure,
          durationMs: Date.now() - shotStartedAt,
        });
        break;
      }
      const shotPath = result.path ?? result.dataUrl ?? '';
      recordImageLog({
        mode: 'comic',
        floor,
        source: 'api',
        plan: readOutConfig().activePlanName,
        model: activePlanModel(),
        prompt: shot.prompt,
        ...useNl,
        ...(shot.characters.length ? { characters: shot.characters } : {}),
        size: 'portrait',
        ...(typeof result.seed === 'number' ? { seed: result.seed } : {}),
        status: shotPath ? 'ok' : 'error',
        ...(shotPath ? {} : { error: '出图没有返回图片。' }),
        durationMs: Date.now() - shotStartedAt,
      });
      if (!shotPath) {
        panelFailure = '出图没有返回图片。';
        break;
      }
      if (pageSeed === undefined && typeof result.seed === 'number') pageSeed = result.seed;
      panelPaths.push(shotPath);
      panelPrompts.push(shot.prompt);
      panelNls.push(shot.nl);
    }

    // 合成整页：白纸 + 各格 + 细黑框（框外留白由页面空白提供）
    let rawPath = '';
    let pageAssembled = false;
    let usedPrompt = panelPrompts.join('\n---\n');
    let usedNl = panelNls.join('\n');

    if (!panelFailure && panelPaths.length === shots.length && panelPaths.length > 0) {
      if (panelPaths.length === 1) {
        rawPath = panelPaths[0];
      } else {
        const pageImage = await assemblePageBlob({ slots, images: panelPaths });
        if (pageImage) {
          const base64 = await blobToBase64(pageImage.blob);
          const uploaded = await uploadImageBase64(base64, {
            format: 'png',
            filename: `ST创作_漫画_${Date.now()}`,
          });
          if (uploaded) {
            rawPath = uploaded;
            pageAssembled = true;
          }
        }
        if (!rawPath) {
          // 合成或落盘失败：退回第一格，至少不是空白
          rawPath = panelPaths[0] ?? '';
          recordNotice({
            mode: 'comic',
            floor,
            text: `第 ${page.pageIndex + 1} 页的整页合成没成功，先显示第一格。刷新后仍不对就把这条告诉我。`,
          });
        }
      }
    }

    // 逐格出图失败 → 整页兜底（旧路径）。宁可版面不完美，也不要这一页空着
    if (!rawPath) {
      recordNotice({
        mode: 'comic',
        floor,
        text:
          `第 ${page.pageIndex + 1} 页逐格出图失败（${panelFailure || '没有返回图片'}），` +
          '已退回整页一次性出图；这一页的格数不保证。',
      });
      try {
        const whole = await baiBaiAdapter.generate(
          {
            prompt: fallbackPrompt,
            ...(fallbackNl ? { nl: fallbackNl } : {}),
            ...(composed.characters.length ? { characters: composed.characters } : {}),
            ...(characterName ? { character: characterName } : {}),
            size: 'portrait',
            save: true,
          },
          pickProfile(deps.settings, 'comic') ?? fallbackProfile('comic'),
        );
        rawPath = whole.path ?? whole.dataUrl ?? '';
        usedPrompt = fallbackPrompt;
        usedNl = fallbackNl;
        panelPaths.length = 0;
        if (typeof whole.seed === 'number') pageSeed = whole.seed;
        recordImageLog({
          mode: 'comic', floor, source: 'api',
          plan: readOutConfig().activePlanName,
          prompt: fallbackPrompt,
          ...(fallbackNl ? { nl: fallbackNl } : {}),
          size: 'portrait',
          status: rawPath ? 'ok' : 'error',
          ...(rawPath ? {} : { error: '整页兜底也没有返回图片。' }),
          durationMs: Date.now() - pageStartedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordImageLog({
          mode: 'comic', floor, source: 'api',
          plan: readOutConfig().activePlanName,
          prompt: fallbackPrompt,
          ...(fallbackNl ? { nl: fallbackNl } : {}),
          size: 'portrait',
          status: 'error',
          error: message,
          durationMs: Date.now() - pageStartedAt,
        });
        console.warn('[ST-Story-Illustrator] 漫画页整页兜底也失败：', message);
      }
    }
    if (!rawPath) continue;

    // 对白气泡走柏宝绘原版架构：**落盘无字原图，显示时才本地合成**。
    // 图库不再多出「ST创作_带字」烧录副本；改台词 / 挪气泡 / 换形态都在显示层做，
    // 不用重出图。台词与当时的版面元数据一起存进 artifact，显示层按它重放——
    // 合成失败就显示无字原图，绝不升级成生成失败。
    const panelCount = shots.length;
    const pageType = board.pageType;
    // 固定格数 QC：现在格数由代码决定，只有分镜计划本身给的格数不够才可能不等
    const expectedPanelCount = fixedPanels || undefined;
    const renderedPanelCount = shots.length;
    if (expectedPanelCount && renderedPanelCount !== expectedPanelCount) {
      recordNotice({
        mode: 'comic', floor,
        text: `第 ${page.pageIndex + 1} 页分镜只规划了 ${renderedPanelCount} 格（你选的是 ${expectedPanelCount} 格）。` +
          '这一页的格子已经按规划如实画出来了；要更多格就在提示词面板里重画这一页。',
      });
    }

    const artifact: VisualArtifact = {
      id: createArtifactId(),
      taskId: task.id,
      mode: 'comic',
      chatId: task.chatId,
      sourceFloors: segment.floorIds,
      anchorFloor: floor,
      // 这一页属于哪条 swipe：swipe 出新正文后旧页必须消失（切回来还要在）
      swipeId: getSwipeId(floor),
      // 插在划线处（本插件卡片），不再借柏宝绘的楼层卡片
      mountMode: 'inline',
      ...(inlineAnchor ? { textAnchor: inlineAnchor } : {}),
      pageIndex: page.pageIndex,
      imagePath: rawPath,
      prompt: usedPrompt,
      ...(usedNl ? { nl: usedNl } : {}),
      ...(showComposite && dialogue.length ? { dialogue } : {}),
      metadata: {
        // 重画要靠它还原「当时画的是谁」：没有角色块，重画一次就换人
        ...(composed.characters.length ? { characters: composed.characters } : {}),
        // 无字原图路径（带字版只在显示层合成，不落盘第二份）
        rawImagePath: rawPath,
        ...(characterName ? { characterName } : {}),
        pageTitle: page.title,
        // 版面元数据：显示层合成气泡要按「当时下发的格位」排，不能按今天的设置猜
        layout: board.layout,
        pageType,
        panelCount,
        // 柏宝绘四档 + 等分格数：重画/审计要看得出这一页当时走的是哪一档
        boardLayout: board.layout,
        ...(board.koma ? { boardKoma: board.koma } : {}),
        panelTitles: composed.panelTitles,
        // 逐格出图的证据链：每格原图、每格词、每格格位。
        // 重排/重合成/复盘都靠它，不再依赖"当时模型画了几格"这种不可复现的信息。
        ...(panelPaths.length ? { panelImages: panelPaths } : {}),
        ...(panelPrompts.length ? { panelPrompts } : {}),
        ...(panelNls.length ? { panelNls } : {}),
        pageSlots: slots,
        pageAssembled,
        // 新版面系统：把 LLM 的视觉方向 + 已校验几何随图存档。
        ...(page.direction ? { direction: page.direction } : {}),
        ...(page.layoutPlan ? { layoutPlan: page.layoutPlan } : {}),
        // 每格出场的人：显示层靠它把台词反查到正确的格（说话人证据 > 模型写的格号）
        panelCast: shots.map(shot => shot.cast),
        // 用户实际选择的版面三维（出图词就是按这三个生成的，供审计/重放）
        comicStyle,
        comicPanelCount,
        comicWhitespace,
        // 台词来源：原文回填 / 选段没抽到台词时用模型稿
        dialogueSource: dialogueResult.noSource ? 'model' : 'source',
        ...(dialogueResult.dropped ? { dialogueDropped: dialogueResult.dropped } : {}),
        // 格数 QC：不相等时不允许把这页静默当成功
        ...(expectedPanelCount !== undefined
          ? { expectedPanelCount, renderedPanelCount, panelCountMatched: renderedPanelCount === expectedPanelCount }
          : {}),
        ...(typeof pageSeed === 'number' ? { seed: pageSeed } : {}),
      },
      createdAt: Date.now(),
    };
    appendArtifact(floor, artifact);

    // 正文里写一条自己的 tag（`<bbi_manwa>`），卡片按它水合。
    // 这一步是「刷新后还在」「永远不跟 bbi_image 抢槽位」的关键：
    // 位置由 tag 决定，不再靠猜「选段落在哪一段」；柏宝绘重写 .mes_text 也打不掉它
    // （正则会在下一次渲染时把锚点重建出来）。
    const tag = manwaTagReady ? buildManwaTag(artifact.id) : '';
    // 每页各自锚到「本页对应的台词/动作结束处」，不再全页共用一个选段开头：
    // 用本页第一句台词的原文去楼层正文里定位（台词是原文里真实存在的字，最可靠）；
    // 没台词时退回本页 beat.event / 该格 subject，最后才退回选段开头。
    const pageAnchorText = pickPageAnchorText(page, segment.text);
    const inserted = tag ? await insertManwaTag({
      floor,
      chatId: task.chatId,
      swipeId: segment.messages[0]?.swipeId ?? 0,
      ...(segment.messages[0]?.sendDate ? { sendDate: segment.messages[0].sendDate } : {}),
      tag,
      anchorText: pageAnchorText,
    }) : { ok: false as const, reason: 'no-context' as const };
    if (inserted.ok) {
      // 记下「这一页的 tag 原文」：重画只换图，不重插 tag
      updateArtifact(floor, artifact.id, { metadata: { ...artifact.metadata, manwaTag: tag } });
    } else {
      // 写不进正文的页仍然要能用：打个标记，挂载时允许它走旧的行内插入。
      updateArtifact(floor, artifact.id, {
        metadata: { ...artifact.metadata, inlineFallback: true },
      });
      recordNotice({
        mode: 'comic',
        floor,
        text: `第 ${page.pageIndex + 1} 页已出图，但没能写进正文（${inserted.reason}）。`
          + '这一页会临时挂在楼层里；它不是靠正文 tag 定位的，刷新后位置可能变。',
      });
    }
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
      // 先让柏宝绘把它自己的正文插图画完，再动「当前方案」。
      // 顺序反了就会把它还没发出去的请求染成我们的方案（QQ 人/黑白漫）——
      // 用户看到的就是「正文插图忽然变成 Q 版」。等待有上限，等不到照常继续。
      const waitFloor = getAnchorFloor(task.source);
      if (waitFloor !== null) {
        const waited = await waitForBaiBaiImages(waitFloor, {
          onWait: ({ pending }) => ctx.report({ stage: 'waiting', message: `等柏宝绘先出完正文插图（还剩 ${pending} 张）` }),
        });
        if (waited.timedOut) {
          recordNotice({
            mode: task.mode,
            floor: waitFloor,
            text: `等了 ${Math.round(waited.waitedMs / 1000)} 秒，柏宝绘还有 ${waited.pending} 张正文插图没出完。`
              + '这次仍然继续生成，但它的那几张可能会用上本次切换的方案（画风可能不对）。',
          });
        }
      }
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
