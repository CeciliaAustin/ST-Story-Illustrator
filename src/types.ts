/**
 * ST-Story-Illustrator — 全局类型定义
 */

// ============================================================
// 柏宝绘公开 API 类型（对齐 PUBLIC_API.md v1）
// ============================================================

/** 柏宝绘公开能力标志 */
export interface BaiBaiCapabilities {
  globalApi: boolean;
  characterLibrary: boolean;
  generate: boolean;
  saveToGallery: boolean;
  events: boolean;
}

/** 柏宝绘公开 API 对象（globalThis.STBaiBaiImage） */
export interface BaiBaiApi {
  readonly apiVersion: 1;
  readonly pluginVersion: string;
  readonly capabilities: BaiBaiCapabilities;
  getCharacters(options?: { floor?: number }): BaiBaiCharacterList | Promise<BaiBaiCharacterList>;
  getBackendStatus(): BaiBaiBackendStatus | Promise<BaiBaiBackendStatus>;
  generate(request: BaiBaiGenerateRequest, options?: BaiBaiGenerateOptions): Promise<BaiBaiGenerateResult>;
  subscribe(listener: (notice: BaiBaiChangeNotice) => void): () => void;
}

/** 角色库列表返回 */
export interface BaiBaiCharacterList {
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  floor: number | null;
  characters: BaiBaiCharacter[];
}

/** 角色快照 */
export interface BaiBaiCharacter {
  name: string;
  tag: string;
  fields?: {
    fandom?: string;
    sex?: string;
    hair?: string;
    eyes?: string;
    skin?: string;
    body?: string;
    extra?: string;
    outfit?: string;
  };
  nl?: string;
  source?: 'manual' | 'ai' | 'book';
  scope?: 'chat' | 'global';
  desc?: string;
}

/** 后端状态 */
export interface BaiBaiBackendStatus {
  apiVersion: 1;
  pluginVersion: string;
  backend: 'nai' | 'comfyui';
  configured: boolean;
  model: string;
  supportsCharacters: boolean;
  reason: string;
}

/** 出图请求参数 */
export interface BaiBaiGenerateRequest {
  prompt: string;
  nl?: string;
  negative?: string;
  characters?: Array<{
    name: string;
    tag: string;
    nl?: string;
  }>;
  size?: 'portrait' | 'landscape';
  seed?: number;
  save?: boolean;
  character?: string;
}

export interface BaiBaiGenerateOptions {
  signal?: AbortSignal;
  onProgress?: (p: {
    phase: 'queued' | 'generating' | 'queued-remote' | 'retrying' | 'saving';
    ahead?: number;
    attempt?: number;
    max?: number;
  }) => void;
}

export interface BaiBaiGenerateResult {
  apiVersion: 1;
  pluginVersion: string;
  dataUrl: string;
  format: string;
  path: string | null;
  seed: number;
  backend: 'nai' | 'comfyui';
  charactersApplied: boolean;
}

/** 角色库变更通知 */
export interface BaiBaiChangeNotice {
  type: 'ready' | 'changed';
  revision: number;
  chatId?: string;
}

// ============================================================
// LLM Tag 生成提案接口（来自 BAIBAI_API_PROPOSAL.md）
// ============================================================

export interface GeneratePromptRequest {
  type: 'selected-scene';
  context: {
    selectedText: string;
    floorText: string;
    previousText?: string;
    nextText?: string;
  };
  characters?: Array<{
    name: string;
    tag?: string;
    nl?: string;
  }>;
  options?: {
    includeChinese?: boolean;
    includeNl?: boolean;
    includeNegative?: boolean;
    size?: 'portrait' | 'landscape' | string;
  };
}

export interface PromptSegment {
  id: string;
  source: 'character' | 'scene' | 'global';
  characterName?: string;
  english: string[];
  chinese?: string[];
  enabled: boolean;
  order: number;
}

export interface GeneratePromptResponse {
  segments: PromptSegment[];
  nl?: string;
  negative?: string;
  size?: string;
  meta?: {
    modelLabel?: string;
    generatedAt?: number;
    warnings?: string[];
  };
}

// ============================================================
// 选段与楼层定位
// ============================================================

export interface SelectionAnchor {
  selectedText: string;
  beforeAnchor: string;
  afterAnchor: string;
  paragraphIndex: number;
  startOffset?: number;
  endOffset?: number;
}

export interface FloorLocation {
  chatId: string;
  mesId: number;
  swipeId: number;
  mesElement: HTMLElement | null;
}

export interface SelectionResult {
  anchor: SelectionAnchor;
  floor: FloorLocation;
  selectedText: string;
}

// ============================================================
// 上下文
// ============================================================

export interface SceneContext {
  selectedText: string;
  floorText: string;
  previousText?: string;
  nextText?: string;
  chatId: string;
  mesId: number;
  swipeId: number;
}

// ============================================================
// Tag 数据模型
// ============================================================

export type TagSource = 'character' | 'scene' | 'global';

export interface TagSegment {
  id: string;
  source: TagSource;
  characterName?: string;
  english: string[];
  chinese: string[];
  enabled: boolean;
  order: number;
}

export interface IllustrationPrompt {
  id: string;
  segments: TagSegment[];
  nl?: string;
  negative?: string;
  size?: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// 任务与图片
// ============================================================

export interface IllustrationImage {
  id: string;
  promptId: string;
  path?: string;
  dataUrl?: string;
  seed?: number;
  createdAt: number;
}

export type TaskStatus =
  | 'draft'
  | 'generating_prompt'
  | 'ready'
  | 'generating_image'
  | 'completed'
  | 'failed'
  | 'orphaned';

export interface StoryIllustration {
  id: string;
  chatId: string;
  mesId: number;
  swipeId: number;
  selection: SelectionAnchor;
  context: SceneContext;
  prompts: IllustrationPrompt[];
  activePromptId: string;
  images: IllustrationImage[];
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

// ============================================================
// 漫画分镜类型
// ============================================================

export type PanelLayout = 'regular' | 'irregular' | 'inset' | 'unframed';
export type PanelPageType = 'auto' | 'a' | 'b' | 'c' | 'd';
export type DialoguePolicy = 'auto' | 'always' | 'eager';
export type PanelBubbleArea = 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br';

export interface PanelDialogueItem {
  text: string;
  speaker?: string;
  area?: PanelBubbleArea;
  x?: number;
  y?: number;
  dir?: 'h' | 'v';
  mood?: 'calm' | 'shout' | 'whisper';
}

export type BubbleStyleId =
  | 'classic' | 'bubble-vertical' | 'bubble-glow' | 'bubble-ink' | 'bubble-subtitle'
  | 'blend' | 'blend-vertical' | 'blend-glow' | 'blend-ink' | 'blend-subtitle';

export type BubbleFontId = 'sans' | 'serif' | 'kai' | 'round';

// ============================================================
// 小剧场类型
// ============================================================

export type StoryKind = 'status' | 'bonus' | 'manga';

export interface StatusLine {
  speaker: string;
  text: string;
}

export interface StatusRole {
  name: string;
  act: string;
}

export interface StatusFrame {
  title: string;
  characters: string[];
  roles: StatusRole[];
  mood: string;
  tags: string;
  lines?: StatusLine[];
  nl: string;
}

export interface StatusReading extends StatusFrame {
  panels: StatusFrame[];
}

export interface BbiStatusInfo {
  storyId: string;
  index: number;
  storyAt?: number;
  title?: string;
  story?: string;
  mood?: string;
  cast?: string[];
  lines?: StatusLine[];
  bonus?: boolean;
  manga?: boolean;
  /** 出图结果地址（path 或 dataUrl），供楼层卡片显示 */
  imagePath?: string;

  // ── 卡片分组（一次生成的 N 格共用一个 setId，卡片按它合并成一张）──
  /** 同一次生成的格共用一个 setId；旧数据没有这个字段，视为单格卡片 */
  setId?: string;
  /** 卡片标题（整条） */
  setTitle?: string;
  /** 这条卡片一共有几格（渲染「2/4」角标用） */
  setSize?: number;
  /** 整条重出用：当时的选段原文 */
  sourceText?: string;
  /** 整条重出用：主角名（小剧场读剧情需要） */
  characterName?: string;
  /** 这一格属于哪套小剧场 */
  kind?: StoryKind;
  /** 重画这张用：当时实际发出去的出图词与种子 */
  prompt?: string;
  negative?: string;
  seed?: number;
  /** 当时用的出图 profile id（重画沿用同一套参数） */
  profileId?: string;
}

// ============================================================
// 统一选段入口（第二阶段）
// ============================================================

export type StorySourceKind = 'single' | 'range' | 'picked' | 'manual';

export interface StorySegmentMessage {
  floor: number;
  speaker: string;
  isUser: boolean;
  sendDate?: string;
  swipeId: number;
  text: string;
}

export interface StorySegment {
  chatId: string;
  sourceKind: StorySourceKind;
  floorIds: number[];
  startFloor?: number;
  endFloor?: number;
  text: string;
  messages: StorySegmentMessage[];
  createdAt: number;
}

// ============================================================
// 创作模式
// ============================================================

export type CreationMode =
  | 'illustration'    // 正文插画
  | 'comic'           // 正文漫画分镜
  | 'chibi-status'    // QQ 人状态栏
  | 'chibi-bonus'     // QQ 人彩蛋
  | 'bw-manga';       // 黑白漫小剧场

// ============================================================
// 统一任务队列
// ============================================================

export type VisualTaskStatus =
  | 'queued'
  | 'reading'
  | 'review'
  | 'generating'
  | 'compositing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VisualTask {
  id: string;
  chatId: string;
  source: StorySegment;
  mode: CreationMode;
  profileId?: string;
  status: VisualTaskStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  progress?: {
    stage: string;
    page?: number;
    panel?: number;
    totalPages?: number;
    totalPanels?: number;
  };
}

// ============================================================
// 漫画分镜计划（第二阶段任务书 §2.3）
// ============================================================

export interface ComicDialogue {
  text: string;
  speaker?: string;
  area?: PanelBubbleArea;
  dir?: 'h' | 'v';
  mood?: 'calm' | 'shout' | 'whisper';
}

export interface ComicPanelPlan {
  index: number;
  title: string;
  characters: Array<{ name: string; act: string }>;
  mood: string;
  tags: string;
  nl?: string;
  dialogue?: ComicDialogue[];
}

export interface ComicPagePlan {
  pageIndex: number;
  title: string;
  layout: PanelLayout;
  panels: ComicPanelPlan[];
}

// ============================================================
// Visual Profile（第二阶段任务书 §4.1）
// ============================================================

export interface VisualProfile {
  id: string;
  name: string;
  mode: CreationMode;
  backend: 'nai' | 'comfyui' | 'other';
  generationProfileId?: string;
  endpointId?: string;
  artistPresetId?: string;
  workflowId?: string;
  llmProfileId?: string;
  promptTemplateId: string;
  options: Record<string, unknown>;
}

// ============================================================
// 多后端适配层（第二阶段任务书 §4.4）
// ============================================================

export interface NormalizedGenerationInput {
  prompt: string;
  nl?: string;
  negative?: string;
  characters?: Array<{ name: string; tag: string; nl?: string }>;
  size?: string;
  seed?: number;
  save?: boolean;
}

export interface GenerationResult {
  path?: string;
  dataUrl?: string;
  seed?: number;
  meta?: Record<string, unknown>;
}

export interface ImageBackendAdapter {
  id: string;
  capabilities: {
    supportsWeightedTags: boolean;
    supportsNl: boolean;
    supportsCharacters: boolean;
    supportsSeed: boolean;
    supportsAbort: boolean;
  };
  generate(input: NormalizedGenerationInput, profile: VisualProfile): Promise<GenerationResult>;
}

// ============================================================
// 挂载模式
// ============================================================

/**
 * 图片在楼层中的挂载方式。
 * - inline: 插入正文对应位置（插画、漫画分镜）
 * - trailing: 挂载在楼层底部独立区域（QQ人、彩蛋、黑白漫）
 */
export type ArtifactMountMode = 'inline' | 'trailing';

/**
 * 每种创作模式的默认挂载方式。
 */
export function defaultMountMode(mode: CreationMode): ArtifactMountMode {
  switch (mode) {
    case 'illustration':
    case 'comic':
      return 'inline';
    case 'chibi-status':
    case 'chibi-bonus':
    case 'bw-manga':
      return 'trailing';
    default:
      return 'trailing';
  }
}

// ============================================================
// Visual Artifact（第二阶段任务书 §6.1）
// ============================================================

export interface VisualArtifact {
  id: string;
  taskId: string;
  mode: CreationMode;
  chatId: string;
  sourceFloors: number[];
  anchorFloor?: number;
  mountMode: ArtifactMountMode;
  /** inline 挂载时的选段锚点（用于在正文中定位插入位置） */
  textAnchor?: SelectionAnchor;
  pageIndex?: number;
  panelIndex?: number;
  imagePath: string;
  originalImagePath?: string;
  prompt: string;
  nl?: string;
  negative?: string;
  seed?: number;
  profileId?: string;
  dialogue?: ComicDialogue[];
  metadata: Record<string, unknown>;
  createdAt: number;
}

// 注：BaiBaiCapabilities 已在文件上方定义（对齐 PUBLIC_API.md）。
// 以下接口保留为提案类型，等柏宝绘未来开放后使用。

export interface BaiBaiApiGaps {
  generatePrompt: boolean;           // 未公开：LLM Tag 生成
  getArtistPresets: boolean;         // 未公开：读取画师串库
  getGenerationProfiles: boolean;    // 未公开：列出 NAI 方案
  getEndpoints: boolean;             // 未公开：列出 API 接入点
  getWorkflows: boolean;             // 未公开：列出 ComfyUI 工作流
  generateWithProfile: boolean;      // 未公开：指定 Profile 生成
  generateStructuredPrompt: boolean; // 未公开：结构化 JSON 生成
}

// ============================================================
// 扩展设置
// ============================================================

export interface ModeSettings {
  enabled: boolean;
  autoTrigger: boolean;
  profileId: string;
  shots: number;
  // 模式特定选项
  illustrationMultiImage?: boolean;
  comicLayout?: PanelLayout;
  comicPageType?: PanelPageType;
  comicMaxPages?: number;
  comicDialoguePolicy?: DialoguePolicy;
  comicBubbleStyle?: BubbleStyleId;
  comicBubbleFont?: BubbleFontId;
  comicShowComposite?: boolean;
  chibiStyle?: 'card' | 'thumb';
  chibiBonusChance?: number;
  bwMangaSafeMode?: boolean;
  bwMangaArtistId?: string;
}

export interface StoryIllustratorSettings {
  enabled: boolean;
  contextRange: number;
  includeChinese: boolean;
  includeNl: boolean;
  /** 选段清洗：与柏宝绘共享的排除标签同步（默认 true） */
  syncBaiBaiExcludes: boolean;
  /** 选段清洗：正文含 <content> 时只提取其中内容（默认 true，兼容思维链插件） */
  preferContentTag: boolean;
  /** Tag 生成用的 LLM 来源：auto=优先柏宝绘副API，main=主API，secondary=强制副API（全局兜底） */
  llmSource: 'auto' | 'main' | 'secondary';
  /**
   * 每个创作模式各自指定 LLM 渠道：
   * 'main' = 酒馆主 API；'tagGen' = 跟随柏宝绘 tagGen 指派；其他 = 柏宝绘共享渠道 id。
   * 未设置的模式回退到 llmSource。
   */
  modeChannels: Partial<Record<CreationMode, string>>;
  /**
   * 每个创作模式各自指定「出图方案」（柏宝绘 nai.plans 里的方案 id）。
   * 留空/未设置 = 跟随柏宝绘当前方案（不切换）。
   *
   * 注意：柏宝绘公开出图接口不接受 planId 参数，只能切它自己的「当前方案」，
   * 因此出图前会临时切到该模式的方案（串行队列内安全，出图后不自动切回）。
   */
  modeOutPlans: Partial<Record<CreationMode, string>>;
  /** 是否显示右下角悬浮球（🎨）。关掉后仍可从魔杖菜单打开面板。 */
  showFloatingBall: boolean;
  /** 悬浮球位置（left/top，px）。缺省时用右下角默认位置。 */
  floatingBallPos?: { left: number; top: number };
  /** 划词时是否显示快捷「生成配图」按钮 */
  showSelectionToolbar: boolean;
  // 各模式独立设置
  modes: Record<CreationMode, ModeSettings>;
  // Profile 列表（只保存 ID 引用和本插件参数）
  profiles: VisualProfile[];
  // 第一阶段遗留字段（向后兼容）
  chibiMode: boolean;
  chibiStatusBar: boolean;
  chibiStatusShots: number;
  chibiStatusStyle: 'card' | 'thumb';
  chibiBonusEnabled: boolean;
  chibiBonusChance: number;
  chibiBonusShots: number;
  mangaEnabled: boolean;
  mangaShots: number;
  mangaSafe: boolean;
  mangaArtistId: string;
  panelMode: boolean;
  panelLayout: PanelLayout;
  panelPageType: PanelPageType;
  dialogueEnabled: boolean;
  dialoguePolicy: DialoguePolicy;
  bubbleStyle: BubbleStyleId;
  bubbleFont: BubbleFontId;
}

function defaultModeSettings(mode: CreationMode): ModeSettings {
  const base: ModeSettings = {
    enabled: false,
    autoTrigger: false,
    profileId: '',
    shots: 1,
  };
  switch (mode) {
    case 'illustration':
      return { ...base, enabled: true, illustrationMultiImage: false };
    case 'comic':
      return { ...base, comicLayout: 'regular', comicPageType: 'auto', comicMaxPages: 1,
        comicDialoguePolicy: 'auto', comicBubbleStyle: 'classic', comicBubbleFont: 'sans', comicShowComposite: true };
    case 'chibi-status':
      return { ...base, chibiStyle: 'card' };
    case 'chibi-bonus':
      return { ...base, chibiBonusChance: 25 };
    case 'bw-manga':
      return { ...base, bwMangaSafeMode: true, bwMangaArtistId: '' };
    default:
      return base;
  }
}

export const DEFAULT_SETTINGS: StoryIllustratorSettings = {
  enabled: false,
  contextRange: 1,
  includeChinese: true,
  includeNl: false,
  syncBaiBaiExcludes: true,
  preferContentTag: true,
  llmSource: 'auto',
  // 默认不指定，走 llmSource('auto' → 柏宝绘 tagGen 渠道)；用户在弹窗里可为每个模式分别指派
  modeChannels: {},
  // 默认不指定，跟随柏宝绘当前出图方案；用户在弹窗里可为每个模式分别指派
  modeOutPlans: {},
  showFloatingBall: true,
  showSelectionToolbar: true,
  modes: {
    'illustration': defaultModeSettings('illustration'),
    'comic': defaultModeSettings('comic'),
    'chibi-status': defaultModeSettings('chibi-status'),
    'chibi-bonus': defaultModeSettings('chibi-bonus'),
    'bw-manga': defaultModeSettings('bw-manga'),
  },
  profiles: [],
  // 遗留字段
  chibiMode: false,
  chibiStatusBar: false,
  chibiStatusShots: 1,
  chibiStatusStyle: 'card',
  chibiBonusEnabled: false,
  chibiBonusChance: 25,
  chibiBonusShots: 1,
  mangaEnabled: false,
  mangaShots: 1,
  mangaSafe: true,
  mangaArtistId: '',
  panelMode: false,
  panelLayout: 'regular',
  panelPageType: 'auto',
  dialogueEnabled: false,
  dialoguePolicy: 'auto',
  bubbleStyle: 'classic',
  bubbleFont: 'sans',
};
