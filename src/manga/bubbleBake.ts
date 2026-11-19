/**
 * ST-Story-Illustrator — 气泡烧录（comic 专用）
 *
 * 文档推荐「落盘无字原图、显示时合成」，但那要求插件自己掌控显示层。
 * 本插件的漫画页显示交给柏宝绘卡片（为了重绘/改词/请求日志那一整套），
 * 卡片只认一个图片路径，没有「显示时加工」的钩子——于是只能在拿到结果后
 * 合成一次，把卡片指向带字版，原图留在图库里不丢。
 *
 * 失败一律返回 null：气泡没画上不能升级成「生成失败」（文档坑 11）。
 */

import { compositeDialogue } from './bubbleComposite';
import type { PanelDialogueItem, AvoidZone } from './bubbleTypes';
import type { PanelSlot } from './panelSlots';
import type { BubbleStyleId, BubbleFontId } from '../types';
import { getContext } from '../host/sillytavern';

/** 合成图落地目录（user/images 下的子目录）。 */
const COMPOSITE_FOLDER = 'ST创作_带字';

export interface BakeBubblesInput {
  imagePath: string;
  dialogue: PanelDialogueItem[];
  style?: BubbleStyleId;
  font?: BubbleFontId;
  /**
   * 这一页的格位（归一化、阅读顺序）。给了就按格排版：
   * 气泡不许出格、不许骑 gutter——真漫画的第一条排版语法。
   */
  slots?: readonly PanelSlot[];
  /** 页面级禁区（特写格、顶部脸条），格内排版时用 */
  noGo?: readonly AvoidZone[];
  /** 每一格出场的人（阅读顺序），用于按说话人反查台词属于哪一格 */
  panelCast?: readonly (readonly string[])[];
}

/** blob URL → base64（不含 data: 前缀）。 */
async function blobUrlToBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise<string | null>(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

type Ctx = ReturnType<typeof getContext> & {
  getRequestHeaders?: () => Record<string, string>;
};

/** 上传合成图，返回可访问路径（/user/images/...）；失败 null。 */
async function uploadComposite(base64: string, filename: string): Promise<string | null> {
  const ctx = getContext() as Ctx;
  const headers = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {};
  try {
    const response = await fetch('/api/images/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: base64,
        format: 'png',
        ch_name: COMPOSITE_FOLDER,
        filename,
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { path?: unknown };
    return typeof data.path === 'string' && data.path ? data.path : null;
  } catch {
    return null;
  }
}

/**
 * 把台词烧进图片，返回新的图片路径；没有台词或任何一步失败返回 null。
 */
export async function bakeDialogueIntoImage(input: BakeBubblesInput): Promise<string | null> {
  const items = input.dialogue.filter(item => item.text?.trim());
  if (!items.length || !input.imagePath) return null;

  const composite = await compositeDialogue(input.imagePath, items, {
    ...(input.style ? { style: input.style } : {}),
    ...(input.font ? { font: input.font } : {}),
    ...(input.slots && input.slots.length ? { panels: input.slots } : {}),
    ...(input.noGo && input.noGo.length ? { avoid: input.noGo } : {}),
    ...(input.panelCast && input.panelCast.length ? { panelCast: input.panelCast } : {}),
  });
  if (!composite) return null;

  try {
    const base64 = await blobUrlToBase64(composite.url);
    if (!base64) return null;
    const stamp = Date.now().toString(36);
    const filename = `sti_bubble_${stamp}_${Math.random().toString(36).slice(2, 6)}.png`;
    return await uploadComposite(base64, filename);
  } finally {
    composite.revoke();
  }
}
