/**
 * 三阶段版面计划的解析与归一（Stage A/B 输出 → 类型化 + Stage C 校验）
 *
 * 扩展指导 §2：LLM 先出 Visual Direction，再出 Layout Plan；代码解析后必须
 * 经 layoutValidator 修复与校验。这里只做「把脏 JSON 归一成可信结构」，
 * 绝不相信 LLM 的自我声明——合格与否一律由 validateLayoutPlan 说了算。
 */

import type {
  ComicDialogue,
  ComicLayoutPlan,
  ComicLayoutValidation,
  ComicPanelSlot,
  ComicPoint,
  ComicSafeArea,
  ComicPanelShape,
  ComicPanelRole,
  ComicPanelBorder,
  ComicVisualDirection,
  ComicWhitespaceIntent,
} from '../types';
import { normalizeLayoutStyle } from './layoutStyle';
import { repairLayoutPlan, validateLayoutPlan } from './layoutValidator';

const SHAPES: readonly ComicPanelShape[] = [
  'rect', 'parallelogram', 'triangle', 'trapezoid', 'custom_polygon', 'floating_rect',
];
const ROLES: readonly ComicPanelRole[] = ['hero', 'support', 'detail', 'reaction', 'object'];
const BORDERS: readonly ComicPanelBorder[] = ['none', 'thin', 'rough'];
const INTENTS: readonly ComicWhitespaceIntent[] = ['compact', 'balanced', 'airy', 'dramatic'];
const READING = ['top_to_bottom', 'left_to_right', 'right_to_left'] as const;

interface Rect { x: number; y: number; width: number; height: number }

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function parseRect(v: unknown): Rect {
  const o = rec(v);
  if (!o) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: num(o.x, 0), y: num(o.y, 0), width: num(o.width, 0), height: num(o.height, 0) };
}

function parsePoint(v: unknown): ComicPoint | null {
  const o = rec(v);
  if (!o) return null;
  return { x: num(o.x, 0), y: num(o.y, 0) };
}

function parseSafeAreas(raw: unknown): ComicSafeArea[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ComicSafeArea[] = [];
  for (const item of raw.slice(0, 8)) {
    const o = rec(item);
    if (!o) continue;
    const type = o.type === 'bubble' || o.type === 'caption' || o.type === 'keep_clear' ? o.type : 'keep_clear';
    out.push({ type, ...parseRect(o) });
  }
  return out.length ? out : undefined;
}

function parseSlot(raw: unknown, index: number): ComicPanelSlot | null {
  const o = rec(raw);
  if (!o) return null;
  const shape = typeof o.shape === 'string' && (SHAPES as readonly string[]).includes(o.shape)
    ? o.shape as ComicPanelShape
    : 'rect';
  const polygon = Array.isArray(o.polygon)
    ? o.polygon.map(parsePoint).filter((p): p is ComicPoint => p !== null).slice(0, 12)
    : undefined;
  const role = typeof o.role === 'string' && (ROLES as readonly string[]).includes(o.role)
    ? o.role as ComicPanelRole
    : (index === 0 ? 'hero' : 'support');
  const border = typeof o.border === 'string' && (BORDERS as readonly string[]).includes(o.border)
    ? o.border as ComicPanelBorder
    : 'thin';
  return {
    panelIndex: Math.max(0, Math.floor(num(o.panelIndex, index))),
    x: num(o.x, 0), y: num(o.y, 0),
    width: num(o.width, 0.3), height: num(o.height, 0.3),
    shape,
    ...(polygon && polygon.length >= 3 ? { polygon } : {}),
    zIndex: Math.floor(num(o.zIndex, index)),
    role,
    border,
    overlapAllowed: o.overlapAllowed === true,
    ...(() => { const sa = parseSafeAreas(o.safeAreas); return sa ? { safeAreas: sa } : {}; })(),
  };
}

/** Stage A 输出解析。脏字段丢弃，不足字段回落到安全默认，不影响出图。 */
export function parseVisualDirection(raw: unknown): ComicVisualDirection | undefined {
  const o = rec(raw);
  if (!o) return undefined;
  const readingOrder = (READING as readonly string[]).includes(String(o.readingOrder))
    ? o.readingOrder as ComicVisualDirection['readingOrder']
    : 'top_to_bottom';
  const whitespaceIntent = (INTENTS as readonly string[]).includes(String(o.whitespaceIntent))
    ? o.whitespaceIntent as ComicWhitespaceIntent
    : 'balanced';
  const direction: ComicVisualDirection = {
    beatId: str(o.beatId, 80) ?? '',
    visualFocus: str(o.visualFocus, 200) ?? '',
    emotionalTone: str(o.emotionalTone, 120) ?? '',
    pageRhythm: str(o.pageRhythm, 200) ?? '',
    recommendedLayout: normalizeLayoutStyle(o.recommendedLayout),
    recommendedPanelCount: Math.max(1, Math.min(8, Math.round(num(o.recommendedPanelCount, 3)))),
    reason: str(o.reason, 300) ?? '',
    whitespaceIntent,
    readingOrder,
  };
  const motif = str(o.visualMotif, 120);
  if (motif) direction.visualMotif = motif;
  return direction;
}

export interface ParsedLayout {
  /** 已经过安全修复的 plan（可直接用于预览 / 出图）。 */
  plan: ComicLayoutPlan;
  validation: ComicLayoutValidation;
}

export interface ParseLayoutContext {
  expectedPanelCount?: number;
  styleLocked?: boolean;
  expectedStyle?: ComicLayoutPlan['style'];
  dialogue?: readonly ComicDialogue[];
}

/**
 * Stage B 输出解析 + Stage C 校验修复。
 *
 * 关键：修复后的 plan 必须回传（repairLayoutPlan 返回新对象），
 * 否则 clamp/排序做了等于没做——这正是初版实现踩过的坑。
 */
export function parseLayoutPlan(raw: unknown, context: ParseLayoutContext = {}): ParsedLayout | undefined {
  const o = rec(raw);
  if (!o) return undefined;

  // 同时兼容 layoutPlan.{slots,...} 与直接把 slots 放顶层两种写法
  const body = rec(o.layoutPlan) ?? o;
  if (!Array.isArray(body.slots)) return undefined;
  const slots = body.slots.slice(0, 8).map(parseSlot).filter((s): s is ComicPanelSlot => s !== null);
  if (!slots.length) return undefined;

  const ws = rec(body.whitespace) ?? {};
  const intent = (INTENTS as readonly string[]).includes(String(ws.intent))
    ? ws.intent as ComicWhitespaceIntent : 'balanced';
  const reserved = Array.isArray(ws.reservedRegions)
    ? ws.reservedRegions.slice(0, 8).map(parseRect)
    : [];

  const rawPlan: ComicLayoutPlan = {
    style: normalizeLayoutStyle(body.style),
    panelCount: Math.max(1, Math.min(8, Math.round(num(body.panelCount, slots.length)))),
    background: body.background === 'black' || body.background === 'transparent' || body.background === 'scene'
      ? body.background : 'white',
    whitespace: {
      intent,
      outerMargin: num(ws.outerMargin, 0.04),
      gutter: num(ws.gutter, 0.02),
      reservedRegions: reserved,
    },
    readingOrder: Array.isArray(body.readingOrder)
      ? body.readingOrder.map(v => Math.round(num(v, 0))).slice(0, 8)
      : slots.map((_, i) => i + 1),
    slots,
    designRationale: str(body.designRationale, 400) ?? '',
  };

  // 先做安全确定性修复，拿回修复后的 plan，再校验这个修复后的版本。
  const repaired = repairLayoutPlan(rawPlan);
  const validation = validateLayoutPlan({
    plan: repaired.plan,
    ...(context.expectedPanelCount !== undefined ? { expectedPanelCount: context.expectedPanelCount } : {}),
    ...(context.styleLocked !== undefined ? { styleLocked: context.styleLocked } : {}),
    ...(context.expectedStyle !== undefined ? { expectedStyle: context.expectedStyle } : {}),
    ...(context.dialogue ? { dialogue: context.dialogue } : {}),
  });
  validation.fixes = [...repaired.fixes, ...validation.fixes];

  return { plan: repaired.plan, validation };
}
