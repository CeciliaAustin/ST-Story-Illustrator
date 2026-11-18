/**
 * 柏宝绘「副 API」LLM 调用桥接（按创作模式可选渠道）
 *
 * 设计要点：
 * 1. 渠道列表不自建——只读柏宝绘的跨插件共享存储 extensionSettings['baibai_api_channels']。
 *    用户在柏宝绘设置页里加的渠道（NAI5 / NAI4.5 / 任何 OpenAI 兼容端点）会自动出现在这里。
 * 2. 调用方式与柏宝绘完全一致：走酒馆后端 /api/backends/chat-completions/generate，
 *    用 reverse_proxy + proxy_password（或 custom 源 + reasoning_effort），不直连渠道 URL。
 *    这样能复用酒馆的请求头、代理和端点兼容逻辑，NAI 中转渠道才不会失败。
 * 3. 本插件只维护「哪个创作模式用哪条渠道」的映射，不碰柏宝绘自己的 tagGen 指派。
 *
 * 读不到配置/请求失败时返回 null，由调用方回退主 API。
 */

import { getContext } from '../host/sillytavern';
import type { CreationMode } from '../types';

const CHANNELS_KEY = 'baibai_api_channels';
const IMAGE_SETTINGS_KEY = 'baibai_image';
const CHAT_COMPLETIONS_URL = '/api/backends/chat-completions/generate';

/** 与柏宝绘 ApiChannel 同构（含本插件不暴露到 UI 的 key）。 */
export interface ApiChannel {
  id: string;
  name: string;
  url: string;
  key: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSec: number;
  stream: boolean;
  excludeParams: string[];
  reasoningEffort: string;
}

/** 给 UI 用的渠道信息（不含密钥）。 */
export interface SharedChannelInfo {
  id: string;
  name: string;
  model: string;
  url: string;
}

/** 模式渠道映射：'main'=酒馆主API，'tagGen'=跟随柏宝绘tagGen指派，其他=渠道 id。 */
export type ModeChannelMap = Partial<Record<CreationMode, string>>;

/** 归一化渠道对象，容错缺字段/老数据。 */
export function normalizeChannel(raw: unknown): ApiChannel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === 'string' ? c.id.trim() : '';
  const url = typeof c.url === 'string' ? c.url.trim() : '';
  if (!id || !url) return null;
  return {
    id,
    name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : id,
    url,
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model.trim() : '',
    temperature: typeof c.temperature === 'number' && Number.isFinite(c.temperature) ? c.temperature : 1,
    maxTokens: typeof c.maxTokens === 'number' && c.maxTokens > 0 ? Math.floor(c.maxTokens) : 65535,
    timeoutSec: typeof c.timeoutSec === 'number' && c.timeoutSec > 0 ? Math.floor(c.timeoutSec) : 180,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim())
      : [],
    reasoningEffort: typeof c.reasoningEffort === 'string' ? c.reasoningEffort.trim() : '',
  };
}

/** 从共享存储的原始值里解析渠道数组（兼容 {channels:[]} 与裸数组）。 */
export function parseSharedChannels(raw: unknown): ApiChannel[] {
  if (!raw || typeof raw !== 'object') return [];
  const store = raw as Record<string, unknown>;
  const arr = Array.isArray(store.channels) ? store.channels : (Array.isArray(raw) ? raw : []);
  const out: ApiChannel[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const ch = normalizeChannel(item);
    if (!ch || seen.has(ch.id)) continue;
    seen.add(ch.id);
    out.push(ch);
  }
  return out;
}

/** 读取柏宝绘共享的渠道列表。 */
export function listSharedChannels(): ApiChannel[] {
  const ctx = getContext();
  return parseSharedChannels(ctx.extensionSettings?.[CHANNELS_KEY]);
}

/** 给下拉框用的渠道摘要（不含密钥）。 */
export function listSharedChannelInfos(): SharedChannelInfo[] {
  return listSharedChannels().map(c => ({
    id: c.id,
    name: c.name || c.id,
    model: c.model,
    url: c.url,
  }));
}

/** 读取柏宝绘 tagGen 指派的渠道 id（空串 = 跟随主 API）。 */
export function readTagGenChannelId(): string {
  const ctx = getContext();
  const raw = ctx.extensionSettings?.[IMAGE_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object') return '';
  const settings = raw as Record<string, unknown>;
  const assignments = settings.assignments as Record<string, unknown> | undefined;
  const id = assignments?.tagGen;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * 解析某模式应当使用的渠道 id。
 * 优先级：模式专属映射 > 全局 llmSource 兜底。
 * 返回 'main' 表示主 API；返回渠道 id 表示副 API 指定渠道。
 */
export function resolveChannelId(
  mode: CreationMode,
  modeChannels: ModeChannelMap | undefined,
  llmSource: 'auto' | 'main' | 'secondary' | undefined,
): string {
  const explicit = modeChannels?.[mode];
  if (explicit) return explicit;
  return llmSource === 'main' ? 'main' : 'tagGen';
}

/**
 * 构造请求体。与柏宝绘 api/client.ts buildRequestBody 同口径：
 * - reasoningEffort 非空 → custom 源（不过白名单）
 * - 否则 → openai 源 + reverse_proxy
 * - excludeParams 逐字段删除
 * 抽成纯函数便于测试。
 */
export function buildChannelRequestBody(
  channel: ApiChannel,
  messages: Array<{ role: string; content: string }>,
  stream = false,
): Record<string, unknown> {
  const effort = (channel.reasoningEffort ?? '').trim();
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    tool_choice: 'none',
    presence_penalty: 0,
    frequency_penalty: 0,
  };
  const body: Record<string, unknown> = effort
    ? {
        chat_completion_source: 'custom',
        custom_url: channel.url,
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ''}` }),
        custom_include_body: JSON.stringify({ reasoning_effort: effort }),
        ...common,
      }
    : {
        chat_completion_source: 'openai',
        reverse_proxy: channel.url,
        proxy_password: channel.key || '',
        ...common,
      };
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}

/** 解析酒馆 chat-completions 的响应文本（含常见兼容格式）。 */
export function extractCompletionText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.error === 'object' && d.error !== null) {
    const msg = (d.error as Record<string, unknown>).message;
    console.warn('[ST-Story-Illustrator] 副 API 返回错误：', typeof msg === 'string' ? msg : '未知错误');
    return null;
  }
  const choices = Array.isArray(d.choices) ? d.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const c = choice as Record<string, unknown>;
    const message = c.message as Record<string, unknown> | undefined;
    const parts = [message?.content, c.text, d.content];
    for (const part of parts) {
      const text = textFromContent(part);
      if (text) return text;
    }
  }
  return textFromContent(d.content);
}

function textFromContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value.trim() : null;
  if (Array.isArray(value)) {
    // 多模态 content parts：[{type:'text', text:'...'}]
    const texts: string[] = [];
    for (const part of value) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string') texts.push(p.text);
    }
    return texts.join('').trim() || null;
  }
  return null;
}

/**
 * 用指定渠道 ID 发一次 LLM 请求。
 * selector: 'main' → 主 API；'tagGen' → 柏宝绘指派渠道；其他 → 共享列表中的渠道 id。
 * 未配置/失败返回 null，调用方决定是否回退。
 */
export async function generateViaChannelId(
  channelId: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const id = (channelId || '').trim();
  if (!id || id === 'main') return null;

  const ctx = getContext();
  const all = listSharedChannels();
  const targetId = id === 'tagGen' ? readTagGenChannelId() : id;
  if (!targetId) return null;
  const channel = all.find(c => c.id === targetId);
  if (!channel) return null;
  if (!channel.model) {
    console.warn(`[ST-Story-Illustrator] 渠道「${channel.name}」未填模型，跳过。`);
    return null;
  }

  const headers = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {};
  const controller = new AbortController();
  const timeoutMs = Math.max(5, channel.timeoutSec) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const resp = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildChannelRequestBody(channel, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ])),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.warn(`[ST-Story-Illustrator] 渠道「${channel.name}」请求失败 (${resp.status})：${detail.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json().catch(() => null);
    return extractCompletionText(data);
  } catch (err) {
    if (signal?.aborted !== true) {
      console.warn(`[ST-Story-Illustrator] 渠道「${channel.name}」不可用：`, err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 兼容旧调用：跟随柏宝绘 tagGen 指派渠道。 */
export async function generateViaSecondary(
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return await generateViaChannelId('tagGen', system, user, signal);
}

/** 兼容旧调用：当前指派的渠道摘要。 */
export function getActiveSecondaryChannel(): SharedChannelInfo | null {
  const id = readTagGenChannelId();
  const channel = listSharedChannels().find(c => c.id === id);
  if (!channel) return null;
  return { id: channel.id, name: channel.name, model: channel.model, url: channel.url };
}

export function hasSecondaryChannel(): boolean {
  return getActiveSecondaryChannel() !== null;
}
