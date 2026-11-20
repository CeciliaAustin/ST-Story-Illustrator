/**
 * ST-Story-Illustrator — 漫画气泡「显示时合成」（对齐柏宝绘原版架构）
 *
 * 原版（柏宝绘）的做法是：落盘无字原图，台词作为数据存在正文标签里，
 * 显示与灯箱时才用本地 canvas 把气泡合成上去。收益（原版文档 §1B.4）：
 * - 改台词 / 挪位置 / 换形态**不用重出图**，零额度消耗；
 * - 图库永远只有无字原图，不会被烧录副本污染；
 * - 合成失败随时退回无字原图，历史图 round-trip 不变。
 *
 * 本插件之前把合成提前到了生成时（烧一张带字图上传图库、卡片指向它），
 * 气泡因此变成死的：不能编辑、不能挪、换样式对历史图无效。这一版把它
 * 拉回原版形态：artifact 只存无字原图，合成发生在显示层（卡片 + 灯箱）。
 *
 * 这里的函数都是「从 artifact 还原排版参数」的纯逻辑，方便真测；
 * 真正的 canvas 合成复用 bubbleComposite（CORS 安全 + 失败降级）。
 */

import type {
  VisualArtifact,
  StoryIllustratorSettings,
  BubbleStyleId,
  BubbleFontId,
  PanelLayout,
  PanelPageType,
} from '../types';
import { resolveModeSettings } from '../types';
import { panelSlots, layoutNoGoZones, type PanelSlot } from './panelSlots';
import type { PanelDialogueItem, PlanOptions } from './bubbleTypes';

/** 从 artifact 元数据还原版面档位；脏数据一律回落 regular。 */
export function artifactLayoutOf(artifact: VisualArtifact): PanelLayout {
  const v = artifact.metadata?.layout;
  return v === 'irregular' || v === 'inset' || v === 'unframed' ? v : 'regular';
}

/** 无框档页型；脏数据回落 auto。 */
export function artifactPageTypeOf(artifact: VisualArtifact): PanelPageType {
  const v = artifact.metadata?.pageType;
  return v === 'a' || v === 'b' || v === 'c' || v === 'd' ? v : 'auto';
}

/** 当时下发了几格；0 = 未知（页面元数据缺失）。 */
export function artifactPanelCountOf(artifact: VisualArtifact): number {
  const v = artifact.metadata?.panelCount;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/**
 * 气泡排版的格位：优先用随图存档的 layoutPlan.slots（LLM 设计 + 代码校验过的真实几何），
 * 老 artifact 没有时回落按 layout/count 推算的旧格位。
 * 斜切格先用其 bounding box——气泡层的 polygon 精确碰撞在几何 compositor（Step 5）补。
 */
export function artifactSlotsOf(artifact: VisualArtifact): PanelSlot[] {
  const plan = artifact.metadata?.layoutPlan;
  const planObj = plan && typeof plan === 'object' && !Array.isArray(plan)
    ? plan as { slots?: unknown } : null;
  if (planObj && Array.isArray(planObj.slots) && planObj.slots.length) {
    const slots = planObj.slots
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
      .map(s => {
        const n = (v: unknown, d: number): number =>
          typeof v === 'number' && Number.isFinite(v) ? v : d;
        return { x: n(s.x, 0), y: n(s.y, 0), width: n(s.width, 0.3), height: n(s.height, 0.3) };
      });
    if (slots.length) return slots;
  }
  return panelSlots(artifactLayoutOf(artifact), artifactPanelCountOf(artifact), artifactPageTypeOf(artifact));
}

/** 台词坐标归一：模型/存储里可能混进越界或非有限值，统一夹回 0~1。 */
function clamp01(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000
    : undefined;
}

/**
 * 这一页该拿去合成的底图（无字原图）。
 *
 * 迁移兜底：旧版本把带字烧录图写进 artifact.imagePath、原图留在 metadata.rawImagePath。
 * 直接对烧录图再合成会双重气泡——凡是无字原图还留着，就以它为准。
 */
export function comicBaseImageOf(artifact: VisualArtifact): string {
  const raw = artifact.metadata?.rawImagePath;
  if (typeof raw === 'string' && raw.trim() && raw !== artifact.imagePath) return raw;
  return artifact.imagePath;
}

/**
 * 显示时合成的完整参数。没有台词返回 null（调用方直接显示无字原图）。
 *
 * 排版参数全部来自 artifact 自己的元数据：生成时的版面（layout/panelCount/
 * pageType/panelCast）当年是什么，今天重放就是什么——改全局设置不会让
 * 历史页的气泡跑到错误的格里。
 */
export function comicOverlayPlan(
  artifact: VisualArtifact,
  settings: StoryIllustratorSettings,
): { items: PanelDialogueItem[]; opts: PlanOptions; style: BubbleStyleId; font: BubbleFontId } | null {
  const items: PanelDialogueItem[] = (artifact.dialogue ?? [])
    .filter(item => item && typeof item.text === 'string' && item.text.trim())
    .map(item => {
      // 先剥掉原始的 x/y 再按夹取结果回填：脏值（NaN/越界）不能透传到排版层
      const { x: rawX, y: rawY, ...rest } = item as PanelDialogueItem;
      const x = clamp01(rawX);
      const y = clamp01(rawY);
      return {
        ...rest,
        text: item.text.trim(),
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
      } as PanelDialogueItem;
    });
  if (!items.length) return null;

  const comic = resolveModeSettings(settings, 'comic');
  const style = (comic.comicBubbleStyle ?? settings.bubbleStyle) as BubbleStyleId;
  const font = (comic.comicBubbleFont ?? settings.bubbleFont) as BubbleFontId;

  const layout = artifactLayoutOf(artifact);
  const pageType = artifactPageTypeOf(artifact);
  const panelCount = artifactPanelCountOf(artifact);
  const slots = artifactSlotsOf(artifact);
  const noGo = layoutNoGoZones(layout, pageType);
  const meta = artifact.metadata ?? {};
  const panelCast = Array.isArray(meta.panelCast)
    ? (meta.panelCast as unknown[][]).map(cast =>
        (Array.isArray(cast) ? cast : []).map(name => String(name ?? '')).filter(Boolean),
      )
    : undefined;

  const opts: PlanOptions = {
    style,
    font,
    ...(slots.length ? { panels: slots } : {}),
    ...(noGo.length ? { avoid: noGo } : {}),
    ...(panelCast && panelCast.length ? { panelCast } : {}),
  };
  return { items, opts, style, font };
}

/**
 * 台词编辑后的清洗（灯箱保存走这里）：坏条目丢弃、超长截断、
 * 位置夹回 0~1。手动钉的位置与台词一起存回 artifact.dialogue。
 */
export function normalizeDialogueEdits(value: unknown): VisualArtifact['dialogue'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<VisualArtifact['dialogue']> = [];
  for (const raw of value.slice(0, 4)) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim().slice(0, 60) : '';
    if (!text) continue;
    const item: NonNullable<VisualArtifact['dialogue']>[number] = { text };
    if (typeof rec.speaker === 'string' && rec.speaker.trim()) item.speaker = rec.speaker.trim().slice(0, 16);
    if (typeof rec.area === 'string' && ['tl','tc','tr','ml','mr','bl','bc','br'].includes(rec.area)) {
      item.area = rec.area as NonNullable<VisualArtifact['dialogue']>[number]['area'];
    }
    if (rec.dir === 'v') item.dir = 'v';
    if (rec.mood === 'shout' || rec.mood === 'whisper') item.mood = rec.mood;
    if (typeof rec.panel === 'number' && Number.isFinite(rec.panel) && rec.panel >= 1) {
      item.panel = Math.round(rec.panel);
    }
    const x = clamp01(rec.x);
    const y = clamp01(rec.y);
    if (x !== undefined && y !== undefined) { item.x = x; item.y = y; }
    out.push(item);
  }
  return out.length ? out : undefined;
}
