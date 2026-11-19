/**
 * 柏宝绘「出图配置」同步读取层
 *
 * 数据源：extension_settings['baibai_image'].nai（柏宝绘本体的设置，跨插件可读）
 *   - nai.endpoints[]  接入点（url/key，密钥不外泄）
 *   - nai.plans[]      出图方案（模型、接入点引用、尺寸等）
 *   - nai.activePlanId 当前出图方案
 *
 * 纪律：
 * - 本模块**只读**，不写柏宝绘设置。切换方案必须走柏宝绘自己的 UI（见 planSwitch.ts），
 *   因为它的设置是启动时的内存快照，外部直接改 extension_settings 不会被它读取。
 * - 全部解析逻辑抽成纯函数，便于测试；从 getContext 取值只发生在最外层。
 */

import { getContext } from '../host/sillytavern';

const IMAGE_SETTINGS_KEY = 'baibai_image';

/** 接入点摘要（密钥不外泄）。 */
export interface EndpointInfo {
  id: string;
  name: string;
  url: string;
  hasKey: boolean;
}

/** 出图方案摘要。 */
export interface PlanInfo {
  id: string;
  name: string;
  model: string;
  endpointId: string;
  endpointName: string;
  portraitSize: string;
  landscapeSize: string;
  /** 模型大版本：'5' | '4.5' | '4' | 'unknown'（用于省钱提示） */
  modelFamily: string;
  /**
   * 方案里的「生成自然语言」开关（柏宝绘 4.5/V5 方案面板上的那一项）。
   *
   * 为什么必须读它：nl 是**底模的属性**，不是插件的偏好。Illustrious/Pony 这类
   * 只吃 danbooru 短 tag 的方案开了 nl 会让画面变味，4.5 关掉 nl 的方案再硬塞
   * 一段英文句子同样是错的。柏宝绘自己每张图都按这个开关决定写不写 nl，
   * 我们之前一律写死「要 nl」，于是「方案明明关了，4.5 还是给我写自然语言」。
   */
  naturalLanguage: boolean;
  /** 引用的画师串 id / 名字 */
  artistId: string;
  artistName: string;
  /**
   * 画师串里命中的「分格/整页」词（multiple views、4koma…）。
   *
   * 为什么值得单独算：方案是「模型 + 画师串」一整套，画师串会拼在正向词最前面。
   * 如果它是照「一页多格」写的，那我们每张卡片要的**单格**图就会被画成一整页，
   * 四张卡片全是重复的大头——看起来像「图跟剧情无关」，其实是版面被方案接管了。
   * 这类问题在成图上极难反推，只能在这里指明。
   */
  layoutWords: string[];
}

/** 柏宝绘画师串（只取判定需要的字段）。 */
export interface ArtistInfo {
  id: string;
  name: string;
  prompt: string;
  /** 正面质量词：也算进「会不会抢版面」的判定（有人把分格词写在这） */
  quality: string;
}

/** 画师串里会抢走版面的词。 */
const PAGE_LAYOUT_WORDS = [
  'multiple views', 'split screen', '2koma', '3koma', '4koma',
  'comic page', 'manga page', 'paneled', 'panels', 'panel layout',
];

/** 在一段画师串里找出会抢版面的词（纯函数）。 */
export function layoutWordsIn(text: string): string[] {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return [];
  return PAGE_LAYOUT_WORDS.filter(word => lower.includes(word));
}

/** 出图配置快照。 */
export interface OutConfigSnapshot {
  backend: string;
  endpoints: EndpointInfo[];
  plans: PlanInfo[];
  activePlanId: string;
  activePlanName: string;
  /** 当前方案引用的接入点是否配了地址 */
  activeEndpointConfigured: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** 判定 NAI 模型大版本（用于区分 NAI5 / NAI4.5）。 */
export function detectModelFamily(model: string): string {
  const m = model.toLowerCase();
  if (/4[._-]?5|v4\.5|nai45|diffusion-4-5|diffusion-4\.5/.test(m)) return '4.5';
  if (/nai.?5|diffusion-5|v5\b|-5-full|-5$/.test(m)) return '5';
  if (/4\b|diffusion-4|v4/.test(m)) return '4';
  return 'unknown';
}

/** 解析接入点数组（纯函数）。 */
export function parseEndpoints(raw: unknown): EndpointInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: EndpointInfo[] = [];
  for (const item of raw) {
    const e = asRecord(item);
    if (!e) continue;
    const id = str(e.id).trim();
    if (!id) continue;
    const url = str(e.url).trim();
    out.push({
      id,
      name: str(e.name).trim() || id,
      url,
      hasKey: str(e.key).trim().length > 0,
    });
  }
  return out;
}

/** 解析画师串库（纯函数）。 */
export function parseArtists(raw: unknown): ArtistInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ArtistInfo[] = [];
  for (const item of raw) {
    const a = asRecord(item);
    if (!a) continue;
    const id = str(a.id).trim();
    if (!id) continue;
    out.push({
      id,
      name: str(a.name).trim() || id,
      prompt: str(a.prompt).trim(),
      quality: str(a.quality).trim(),
    });
  }
  return out;
}

/** 解析方案数组（纯函数），接入点名按 id 关联、画师串按 artistId 关联。 */
export function parsePlans(
  raw: unknown,
  endpoints: EndpointInfo[],
  artists: ArtistInfo[] = [],
): PlanInfo[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(endpoints.map(e => [e.id, e]));
  const artistById = new Map(artists.map(a => [a.id, a]));
  const out: PlanInfo[] = [];
  for (const item of raw) {
    const p = asRecord(item);
    if (!p) continue;
    const id = str(p.id).trim();
    if (!id) continue;
    const endpointId = str(p.endpointId).trim();
    const artistId = str(p.artistId).trim();
    const artist = artistById.get(artistId);
    out.push({
      id,
      name: str(p.name).trim() || '未命名方案',
      model: str(p.model).trim(),
      endpointId,
      endpointName: byId.get(endpointId)?.name ?? (endpointId || '(未指定)'),
      // 柏宝绘里尺寸直接存成形如 "832×1216" 的字符串
      portraitSize: str(p.portraitSize).trim(),
      landscapeSize: str(p.landscapeSize).trim(),
      modelFamily: detectModelFamily(str(p.model)),
      naturalLanguage: p.naturalLanguage === true,
      artistId,
      artistName: artist?.name ?? '',
      layoutWords: artist ? layoutWordsIn(`${artist.prompt}, ${artist.quality}`) : [],
    });
  }
  return out;
}

/** 从柏宝绘原始设置解析出完整快照（纯函数）。 */
export function parseOutConfig(raw: unknown): OutConfigSnapshot {
  const settings = asRecord(raw) ?? {};
  const nai = asRecord(settings.nai) ?? {};
  const endpoints = parseEndpoints(nai.endpoints);
  const artists = parseArtists(nai.artistPresets);
  const plans = parsePlans(nai.plans, endpoints, artists);
  const activePlanId = str(nai.activePlanId).trim();
  const active = plans.find(p => p.id === activePlanId) ?? plans[0];
  const activeEndpoint = endpoints.find(e => e.id === active?.endpointId);
  return {
    backend: str(settings.defaultBackend, 'nai'),
    endpoints,
    plans,
    activePlanId: active?.id ?? '',
    activePlanName: active?.name ?? '',
    activeEndpointConfigured: !!activeEndpoint && activeEndpoint.url.length > 0,
  };
}

/** 读取柏宝绘当前出图配置快照。 */
export function readOutConfig(): OutConfigSnapshot {
  const ctx = getContext();
  return parseOutConfig(ctx.extensionSettings?.[IMAGE_SETTINGS_KEY]);
}

/** 快照里「当前方案」那一条（读模型/画师串等细节用）。 */
export function activePlanOf(snap: OutConfigSnapshot): PlanInfo | undefined {
  return snap.plans.find(p => p.id === snap.activePlanId);
}

/**
 * 这套方案要不要写自然语言（nl）。
 *
 * 抄的是柏宝绘自己的判据：`naiSupportsCharacterPrompts(model) && plan.naturalLanguage`
 * ——自然语言是 4.5 才引入的，原版 NAI4 只吃 tag，给它发英文句子只会稀释权重；
 * 4.5/V5 上则完全由方案里的开关说了算。
 */
export function planNlEnabled(plan: PlanInfo | undefined): boolean {
  if (!plan) return false;
  if (plan.modelFamily !== '5' && plan.modelFamily !== '4.5') return false;
  return plan.naturalLanguage === true;
}

/**
 * 某个创作模式真正会用的那套方案。
 *
 * 正文插图**不切方案**（卡片直接用用户当前选的那套），其余模式若指派了方案，
 * 出图前会切过去——所以读剧情阶段就得按「将要用的那套」判断 nl，
 * 否则判断的是还没被切走的旧方案。
 */
export function planForMode(
  snap: OutConfigSnapshot,
  mode: string,
  assigned?: Partial<Record<string, string>>,
): PlanInfo | undefined {
  if (mode !== 'illustration') {
    const id = assigned?.[mode];
    if (id) {
      const hit = snap.plans.find(p => p.id === id);
      if (hit) return hit;
      // 指派了一个已经不存在的方案：出图前会报错，这里退回当前方案，
      // 至少 nl 判断不会莫名变成 false。
    }
  }
  return activePlanOf(snap);
}

/** 纯函数版：某模式这次要不要写 nl（便于测试）。 */
export function nlOfMode(
  snap: OutConfigSnapshot,
  mode: string,
  assigned?: Partial<Record<string, string>>,
): boolean {
  return planNlEnabled(planForMode(snap, mode, assigned));
}

/**
 * 某模式这次要不要写 nl（读当前柏宝绘配置）。
 *
 * 调用点：拼 system（模板里 `{{#nl}}` 段）、拼柏宝绘规范（`{{#nl}}` 条件段）、
 * 以及要不要真的把 `<nl>` 写进 `<bbi_image>`。三处必须同一个答案，
 * 否则会出现「提示词说别写、代码却在等 nl」这种自相矛盾。
 */
export function nlForMode(
  settings: { modeOutPlans?: Partial<Record<string, string>> } | undefined,
  mode: string,
): boolean {
  return nlOfMode(readOutConfig(), mode, settings?.modeOutPlans);
}

/** 当前方案的模型名，写进日志用：`NAI5` 与 `NAI4.5` 的账单差一倍，必须留证据。 */
export function activePlanModel(): string {
  return activePlanOf(readOutConfig())?.model ?? '';
}

/** 计算当前配置的省钱提示：是否有比当前方案更便宜的模型族可选。 */
export function moneySavingHint(snap: OutConfigSnapshot): string {
  const active = snap.plans.find(p => p.id === snap.activePlanId);
  if (!active) return '';
  if (active.modelFamily === '5' && snap.plans.some(p => p.modelFamily === '4.5' || p.modelFamily === '4')) {
    return '当前用的是 NAI5（较贵）。柏宝绘里已有更便宜的方案，可在柏宝绘里切到 NAI4.5 省钱。';
  }
  return '';
}
