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
  /**
   * 本批定妆：每个出场角色一条英文着装 tag，由模型据柏宝书/角色库定一次。
   * 代码逐字拼进每个角色块（及 Base 兜底），保证与柏宝绘穿同一套。
   */
  outfits?: StatusOutfit[];
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

/**
 * 旧版四档版面（deprecated adapter，保留给老设置/老 artifact 与出图规则复用）。
 * 新代码请用 `ComicLayoutStyle`；两者通过 `migrateLayoutChoice` / `layoutStyleToLegacy` 互通。
 */
export type PanelLayout = 'regular' | 'irregular' | 'inset' | 'unframed';
/**
 * 版面档位或「自动」。
 *
 * auto 不是第五种版面，而是「让模型每页自己挑一档」：写 tag 的模型读过整段剧情，
 * 比用户更清楚这一页该是「一问一答」还是「白底特写」。用户不懂分镜时也不该被迫选。
 * 落到具体某一页时永远是 PanelLayout 里的四档之一。
 */
export type PanelLayoutChoice = PanelLayout | 'auto';

// ============================================================
// 新版面系统（版面系统扩展指导 §1 / §4）
//
// 三个独立维度：用户选风格 → 用户选格数 → LLM 设计具体几何。
// 风格是「视觉语言」，生成模式（整页一次 / 确定性合成）是另一回事，不可混为一谈。
// ============================================================

/** 用户可选择的版面风格。 */
export type ComicLayoutStyle =
  | 'classic_grid'
  | 'open_montage'
  | 'diagonal_panels'
  | 'hero_insets'
  | 'freeform';

/** 格数独立于风格；'auto' 交给 LLM 按 beat 决定。 */
export type ComicPanelCount = 2 | 3 | 4 | 'auto';

/** 留白偏好。'auto' = 由版面风格决定（默认），用户偏好优先于风格默认。 */
export type ComicWhitespacePreference = 'auto' | 'compact' | 'airy' | 'dramatic';

/** 具体留白强度（校验/合成用，来自偏好或风格默认）。 */
export type ComicWhitespaceIntent = 'compact' | 'balanced' | 'airy' | 'dramatic';

/** 归一化坐标点（0..1）。 */
export interface ComicPoint {
  x: number;
  y: number;
}

/** 一格的几何形状。rect 之外的都需 polygon 顶点表达，供 Canvas clip 使用。 */
export type ComicPanelShape =
  | 'rect'
  | 'parallelogram'
  | 'triangle'
  | 'trapezoid'
  | 'custom_polygon'
  | 'floating_rect';

/** 一格在页面中的角色（视觉主次）。 */
export type ComicPanelRole = 'hero' | 'support' | 'detail' | 'reaction' | 'object';

/** 格子边框样式。 */
export type ComicPanelBorder = 'none' | 'thin' | 'rough';

/** 格内的安全区 / 保留区（气泡、旁白、必须留空）。归一化坐标。 */
export interface ComicSafeArea {
  type: 'bubble' | 'caption' | 'keep_clear';
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一格的可执行几何（Layout Director 的输出，Stage B）。
 * 坐标为 0..1 页面归一化；custom_polygon 顶点也必须落在 bounding box 内。
 */
export interface ComicPanelSlot {
  panelIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: ComicPanelShape;
  polygon?: ComicPoint[];
  zIndex: number;
  role: ComicPanelRole;
  border: ComicPanelBorder;
  overlapAllowed: boolean;
  safeAreas?: ComicSafeArea[];
}

/** Visual Director 输出：先理解剧情再定视觉方案（Stage A）。 */
export interface ComicVisualDirection {
  beatId: string;
  visualFocus: string;
  emotionalTone: string;
  pageRhythm: string;
  recommendedLayout: ComicLayoutStyle;
  recommendedPanelCount: number;
  reason: string;
  whitespaceIntent: ComicWhitespaceIntent;
  readingOrder: 'top_to_bottom' | 'left_to_right' | 'right_to_left';
  visualMotif?: string;
}

/** Layout Director 输出：可执行几何 + 留白参数（Stage B）。 */
export interface ComicLayoutPlan {
  style: ComicLayoutStyle;
  panelCount: number;
  background: 'black' | 'white' | 'transparent' | 'scene';
  whitespace: {
    intent: ComicWhitespaceIntent;
    outerMargin: number;
    gutter: number;
    reservedRegions: Array<{ x: number; y: number; width: number; height: number }>;
  };
  readingOrder: number[];
  slots: ComicPanelSlot[];
  designRationale: string;
}

/** 版面校验结果（Stage C，由代码判定，不让 LLM 自我宣布合格）。 */
export interface ComicLayoutValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 安全的确定性修复（clamp、排序修复）记录。 */
  fixes: string[];
}
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
  /**
   * 本批共用的「当前着装」，每个角色一条（模型在顶层 cast[].outfit 里定一次）。
   * 出图时由代码逐字拼进每一格的角色块，保证同一批四格穿的是同一套衣服。
   */
  outfits?: StatusOutfit[];
  /**
   * 角色库里**没有**的人的英文外貌（模型补）。
   *
   * 「2 people」却只给一个人建角色块，图上另一个人就全靠模型瞎画；用户那句
   * 「明明是两个人却只生成了 Elias」就是这么来的。有这条兜底，第二个人才有
   * 自己的 character prompt。
   */
  looks?: StatusLook[];
}

/** 一个角色的本批着装（英文 danbooru 短语）。 */
export interface StatusOutfit {
  name: string;
  outfit: string;
}

/** 角色库里没有的人：模型按正文/柏宝书补的一次性外貌（英文 danbooru tag）。 */
export interface StatusLook {
  name: string;
  look: string;
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
  /** 叠了台词气泡的带字版覆盖 imagePath 时，这里留无字原图（下载/重画用） */
  originalPath?: string;

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
  /**
   * 重画这张用：当时从柏宝绘角色库取到的外貌（原生 character prompt 通道）。
   * 外貌不再拼进 prompt，不存这份的话单格重画会丢掉人物、变成路人脸。
   */
  characters?: Array<{ name: string; tag: string; nl?: string }>;
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
    /** 收尾时要说的一句话（例如「角色库里缺 Julian」）；成功但需要提醒时用 */
    message?: string;
  };
}

// ============================================================
// 漫画分镜计划（第二阶段任务书 §2.3）
// ============================================================

export interface ComicDialogue {
  text: string;
  speaker?: string;
  area?: PanelBubbleArea;
  /**
   * 这一句出现在第几格（1 起，按阅读顺序）。
   * 气泡合成的第一条硬规则是「不许离开自己那一格」，所以这个字段比 area 重要：
   * area 只是页内九宫格，模型看不到真实的格线；panel 是它自己写的分镜顺序。
   */
  panel?: number;
  dir?: 'h' | 'v';
  mood?: 'calm' | 'shout' | 'whisper';
  /**
   * 手动钉的位置（页面相对 0~1，气泡中心）。用户在灯箱里拖出来写回的，
   * 模型不写——有 x/y 的气泡原地钉死，不参与自动排版、不被避让挪动。
   */
  x?: number;
  y?: number;
}

/**
 * 这一格的镜头类型，由 LLM 按当前 beat 的叙事需要自由选择（任务书 §3.1）。
 * 一格可以是单人、单人局部、双人、双人局部、物件、环境细节或同步分屏；
 * **不是**「整页人物清单的复制」——页级角色集合仅在角色块里提供外貌约束。
 */
export type ComicComposition =
  | 'single'
  | 'single_detail'
  | 'duo'
  | 'duo_detail'
  | 'object'
  | 'environment_detail'
  | 'split_scene';

export interface ComicPanelPlan {
  index: number;
  title: string;
  /**
   * 这一格的镜头类型。缺省由 nl / characters 推断，老计划没有也不影响显示。
   */
  composition?: ComicComposition;
  /**
   * 这一格出场的人。`look` 只给**角色库里没有**的人用（模型按正文/柏宝书补的
   * 英文外貌），有库条目的留空——库是权威，不许改写。
   */
  characters: Array<{ name: string; act: string; look?: string }>;
  mood: string;
  /**
   * 这一格的镜头距离（`wide shot` / `medium shot` / `close-up` / `extreme close-up`）。
   * 相邻格必须不同——两格同一个镜头、同一个动作，出来就是「两幅差不多的画」。
   */
  shot?: string;
  /** 这一格的**信息点**：一句话说清这格要让读者看到什么（不是动作的重复）。 */
  subject?: string;
  tags: string;
  nl?: string;
  dialogue?: ComicDialogue[];
}

/**
 * 一页选定的「连续瞬间」（single continuous beat）。
 * 整页所有格都属于同一时间、同一事件；格与格只切观察角度 / 景别 / 局部。
 * 前后文只用于理解人物与代词，不得作为本页新增事件（任务书 §1 / §6）。
 */
export interface ComicBeat {
  /** 这一瞬间的定格时间范围（同一时刻/紧邻动作，不得跳时） */
  timeScope?: string;
  /** 地点 */
  location?: string;
  /** 正在发生的一件事 */
  event?: string;
  /** 为什么这几格属于同一瞬间（给校验与预览看） */
  continuityNote?: string;
  /** 本页台词在原文里的先后顺序（按文本顺序） */
  dialogueOrder?: string[];
}

export interface ComicPagePlan {
  pageIndex: number;
  title: string;
  layout: PanelLayout;
  /** 本页选定的连续瞬间；老计划没有也能正常出图。 */
  beat?: ComicBeat;
  /**
   * 整页共用的一套英文 tag（一张图 = 一页，不是一格一张）。
   * 新版模型输出才有；旧计划没有时由 pageCompose 从各格 tag 合并兜底。
   */
  tags?: string;
  /** 整页英文分区描述：先总述版面，再逐格写（唯一能分区描述各格的通道）。 */
  nl?: string;
  /** 整页台词（气泡锚点按整页算）。 */
  dialogue?: ComicDialogue[];
  /**
   * 本批定妆：每个出场角色的英文着装 tag。一页一张图，但多页是同一次出图，
   * 所有页必须穿同一套——代码逐字拼进每个角色块，这是服装一致性的硬约束。
   */
  outfits?: StatusOutfit[];
  /**
   * 新版面系统 Stage A 的视觉方向。老计划没有也可正常出图。
   * 有它时 LLM 已先想清楚「这一页的视觉核心 + 页面节奏」再排格子。
   */
  direction?: ComicVisualDirection;
  /**
   * 新版面系统 Stage B 的可执行几何。老计划没有时由旧四档 layout 兜底。
   * 气泡层与未来的确定性合成都以这份 slots 为唯一几何真源。
   */
  layoutPlan?: ComicLayoutPlan;
  /** 各格只作为「这一格画了什么」的内容索引，不再一格一张图。 */
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
  /** 落盘分组名（柏宝绘图库里按角色分文件夹）。省略 = 柏宝绘按当前聊天角色名归。 */
  character?: string;
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
  /**
   * 这条作品属于哪一条 swipe。
   *
   * `message.extra` 是**楼层级**的，ST 换 swipe 时不会清空它——所以不记 swipeId 的话，
   * 用户 swipe 出一条新正文，上一版画好的漫画还会挂在新正文上（旧图残留）。
   * 显示层按它把作品和当前 swipe 对齐；老数据没有这个字段，走 swipeScope 的降级判定。
   */
  swipeId?: number;
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
  /** @deprecated 旧四档版面，读取时迁移到 comicStyle；仍保留以免覆盖老用户偏好。 */
  comicLayout?: PanelLayoutChoice;
  /**
   * 新版面风格（版面系统扩展指导 §1.1）。缺省时由 comicLayout 迁移而来。
   * 'freeform' 之外的值会约束 LLM 不得擅自换风格；'freeform' 才允许它推荐任意风格。
   */
  comicStyle?: ComicLayoutStyle;
  /**
   * 格数，独立于风格（§1.2）。缺省时由 comicPanelsPerPage 迁移而来。
   * 'auto' 交给 LLM；固定 2/3/4 时计划必须有对应数量的 panel 与 slot。
   */
  comicPanelCount?: ComicPanelCount;
  /**
   * 留白偏好（§1.3）。'auto'（默认）= 由版面风格决定；
   * 用户明确偏好 > 版面风格默认 > LLM 对剧情的判断 > 系统默认。
   */
  comicWhitespace?: ComicWhitespacePreference;
  comicPageType?: PanelPageType;
  comicMaxPages?: number;
  /**
   * 每页固定几格（0 = 跟随版面：规整档 2 格，其余档不约束）。
   * @deprecated 由 comicPanelCount 取代；保留给老设置与旧代码路径。
   */
  comicPanelsPerPage?: number;
  comicDialoguePolicy?: DialoguePolicy;
  comicBubbleStyle?: BubbleStyleId;
  comicBubbleFont?: BubbleFontId;
  comicShowComposite?: boolean;
  chibiStyle?: 'card' | 'thumb';
  chibiBonusChance?: number;
  bwMangaSafeMode?: boolean;
  /**
   * 黑白锁定：正向上锁 monochrome/greyscale + 洗彩色语义词，负面补 color。
   * 与 bwMangaSafeMode 正交（那个只管 NSFW）。默认 true。
   */
  bwMangaMono?: boolean;
  bwMangaArtistId?: string;
  /** 黑白漫是否带对白气泡（文档原设计没有台词，这里做成可关的加分项） */
  bwMangaDialogue?: boolean;
  bwMangaBubbleStyle?: BubbleStyleId;
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
  /**
   * 出完图是否把柏宝绘的「当前方案」切回任务开始前那套。
   *
   * 柏宝绘的方案是**全局**的：切到 QQ 人那套之后如果不切回来，接下来
   * 正文插图（走柏宝绘卡片）就会莫名其妙用 QQ 人的模型与画师串出图。
   * 默认 true —— 正文永远用用户自己选的那套。
   */
  restorePlanAfterTask: boolean;
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
  /**
   * 「提示词」标签页里改过的内置提示词。
   * 键 = PromptDocId（单格版）或 `${id}@many`（多格版）；空串/缺省 = 用内置默认。
   */
  promptOverrides: Record<string, string>;
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
      // 默认「自动」：分镜怎么排交给读过剧情的模型，用户不必懂版面也能出好看的页
      return { ...base, comicLayout: 'auto', comicPageType: 'auto', comicMaxPages: 1,
        comicPanelsPerPage: 0,
        comicDialoguePolicy: 'auto', comicBubbleStyle: 'classic', comicBubbleFont: 'sans', comicShowComposite: true };
    case 'chibi-status':
      return { ...base, chibiStyle: 'card' };
    case 'chibi-bonus':
      return { ...base, chibiBonusChance: 25 };
    case 'bw-manga':
      return { ...base, bwMangaSafeMode: true, bwMangaMono: true, bwMangaArtistId: '',
        bwMangaDialogue: true, bwMangaBubbleStyle: 'classic' };
    default:
      return base;
  }
}

/** 模式的中文名：报错、日志、日志列表里都要能一眼看出是哪一个。 */
export const MODE_LABEL: Record<CreationMode, string> = {
  illustration: '正文插画',
  comic: '正文漫画分镜',
  'chibi-status': 'QQ 人状态栏',
  'chibi-bonus': 'QQ 人彩蛋',
  'bw-manga': '黑白漫小剧场',
};

/**
 * 取某个模式的完整设置。
 *
 * 存档里的 modes 是**整体替换**的：以前存的设置只有当时那几种模式，后来新增的
 * （例如 chibi-bonus）在旧存档里就是 undefined。直接 `settings.modes[mode].shots`
 * 会抛 TypeError，任务在「读配置」这一步就死了——用户只看到「少生成了一份」。
 * 所以一律走这里，缺什么补什么。
 */
export function resolveModeSettings(
  settings: Pick<StoryIllustratorSettings, 'modes'> | undefined | null,
  mode: CreationMode,
): ModeSettings {
  const defaults = defaultModeSettings(mode);
  const stored = settings?.modes?.[mode];
  return stored ? { ...defaults, ...stored } : defaults;
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
  restorePlanAfterTask: true,
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
  promptOverrides: {},
};
