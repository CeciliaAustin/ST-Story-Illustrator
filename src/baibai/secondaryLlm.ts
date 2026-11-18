/**
 * 柏宝绘「副 API」LLM 调用桥接
 *
 * 柏宝绘把副 API 渠道配置放在跨插件共享存储 extensionSettings['baibai_api_channels']，
 * 出图 tag 生成默认指派其中某条渠道（assignments.tagGen，存于 baibai_image 设置）。
 * 本模块只读这份共享配置，用标准 OpenAI /chat/completions 协议发一次静默 LLM 请求——
 * 不调用柏宝绘的私有函数，不绕过其任何队列（LLM 请求本就不走绘图队列）。
 *
 * 读不到配置/请求失败时返回 null，由调用方回退到 ST 主 API（generateQuietPrompt）。
 */

import { getContext } from '../host/sillytavern';

const CHANNELS_KEY = 'baibai_api_channels';
const IMAGE_SETTINGS_KEY = 'baibai_image';

interface ApiChannel {
  id: string;
  name?: string;
  url: string;
  key?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSec?: number;
  stream?: boolean;
  excludeParams?: string[];
}

export interface SecondaryChannelInfo {
  id: string;
  name: string;
  model: string;
  url: string;
}

/** 读取共享渠道存储里的渠道数组（兼容 {channels:[]} 与裸数组）。 */
function readChannels(): ApiChannel[] {
  const ctx = getContext();
  const ext = ctx.extensionSettings ?? {};
  const raw = ext[CHANNELS_KEY];
  if (!raw || typeof raw !== 'object') return [];
  const store = raw as Record<string, unknown>;
  const arr = Array.isArray(store.channels) ? store.channels : (Array.isArray(raw) ? raw : []);
  return arr.filter((c): c is ApiChannel =>
    !!c && typeof c === 'object' && typeof (c as ApiChannel).url === 'string' && typeof (c as ApiChannel).model === 'string',
  );
}

/** 读取 tagGen 指派的渠道 id（空串 = 跟随主 API）。 */
function readTagGenChannelId(): string {
  const ctx = getContext();
  const ext = ctx.extensionSettings ?? {};
  const raw = ext[IMAGE_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object') return '';
  const settings = raw as Record<string, unknown>;
  const assignments = settings.assignments as Record<string, unknown> | undefined;
  const id = assignments?.tagGen;
  return typeof id === 'string' ? id.trim() : '';
}

/** 返回当前用于 tag 生成的副 API 渠道信息（未配置返回 null）。 */
export function getActiveSecondaryChannel(): SecondaryChannelInfo | null {
  const id = readTagGenChannelId();
  if (!id) return null;
  const channel = readChannels().find(c => c.id === id);
  if (!channel) return null;
  return {
    id: channel.id,
    name: channel.name || channel.id,
    model: channel.model,
    url: channel.url,
  };
}

/** 是否有可用的副 API 渠道。 */
export function hasSecondaryChannel(): boolean {
  return getActiveSecondaryChannel() !== null;
}

/**
 * 用副 API 渠道发一次 LLM 请求（OpenAI 兼容）。
 * 成功返回文本；未配置或失败返回 null（调用方回退主 API）。
 */
export async function generateViaSecondary(
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const info = getActiveSecondaryChannel();
  if (!info) return null;
  const channel = readChannels().find(c => c.id === info.id);
  if (!channel) return null;

  const url = channel.url.replace(/\/+$/, '');
  const endpoint = /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`;

  const body: Record<string, unknown> = {
    model: channel.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (typeof channel.temperature === 'number') body.temperature = channel.temperature;
  if (typeof channel.maxTokens === 'number' && channel.maxTokens > 0) body.max_tokens = channel.maxTokens;
  for (const key of channel.excludeParams ?? []) delete body[key];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (channel.key) headers.Authorization = `Bearer ${channel.key}`;

  const timeoutMs = Math.max(5, channel.timeoutSec ?? 180) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`[ST-Story-Illustrator] 副 API 请求失败 (${resp.status})，回退主 API。`);
      return null;
    }
    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (data.error) {
      console.warn('[ST-Story-Illustrator] 副 API 返回错误，回退主 API：', data.error.message);
      return null;
    }
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content : null;
  } catch (err) {
    const aborted = signal?.aborted === true;
    if (!aborted) {
      console.warn('[ST-Story-Illustrator] 副 API 不可用，回退主 API：', err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
