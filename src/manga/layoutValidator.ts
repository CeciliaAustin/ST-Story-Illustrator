/**
 * 版面几何校验器（Stage C，纯函数）
 *
 * 扩展指导 §2 Stage C：布局是否合格由**代码**判定，不让 LLM 自我宣布。
 * 流程：先做安全的确定性修复（clamp、排序），无法安全修复则记 error，
 * 交给上层决定「重写 layout / 回退安全模板」，绝不静默换成用户没选的版式。
 *
 * 所有坐标为 0..1 归一化。这里只做几何与结构校验，不碰 DOM、不发请求。
 */

import type {
  ComicDialogue,
  ComicLayoutPlan,
  ComicLayoutValidation,
  ComicPanelPlan,
  ComicPanelSlot,
  ComicPoint,
  ComicLayoutStyle,
} from '../types';

/** 一格最小可见尺寸（归一化）。小于此值视为不可读。 */
const MIN_SIZE = 0.06;
/** 坐标容差。 */
const EPS = 0.002;

export interface LayoutValidationInput {
  plan: ComicLayoutPlan;
  /** 用户钉死的格数（来自 comicPanelCount）；'auto'/undefined 表示不约束。 */
  expectedPanelCount?: number;
  /** 用户是否钉死风格（freeform 之外为 true）。 */
  styleLocked?: boolean;
  /** 用户实际选的风格；钉死时 plan.style 必须等于它。 */
  expectedStyle?: ComicLayoutStyle;
  /** 关联的 panel 内容（校验每格有对应内容、是否同一 beat）。 */
  panels?: readonly ComicPanelPlan[];
  /** 整页台词（校验 panel 归属存在、order 不倒序）。 */
  dialogue?: readonly ComicDialogue[];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** 形状是否需要 polygon 顶点。 */
function needsPolygon(slot: ComicPanelSlot): boolean {
  return slot.shape === 'parallelogram'
    || slot.shape === 'triangle'
    || slot.shape === 'trapezoid'
    || slot.shape === 'custom_polygon';
}

/** 两个轴对齐矩形是否相交（留一点容差，贴边不算重叠）。 */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  return a.x < bx2 - EPS && ax2 > b.x + EPS && a.y < by2 - EPS && ay2 > b.y + EPS;
}

/** 多边形顶点是否自交（相邻边除外）。 */
function polygonSelfIntersects(pts: readonly ComicPoint[]): boolean {
  if (pts.length < 4) return false;
  const cross = (o: ComicPoint, a: ComicPoint, b: ComicPoint): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const segIntersect = (p1: ComicPoint, p2: ComicPoint, p3: ComicPoint, p4: ComicPoint): boolean => {
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (i === j || (j === i + 1) || (i === 0 && j === n - 1)) continue;
      if (segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * 安全的确定性修复：坐标夹回 0..1、宽高补到最小可见尺寸、polygon 顶点夹进 bbox、
 * readingOrder 修复成 1..N 的完整排列。无法自动修的留给 validate 报 error。
 */
export function repairLayoutPlan(plan: ComicLayoutPlan): { plan: ComicLayoutPlan; fixes: string[] } {
  const fixes: string[] = [];
  const n = plan.slots.length;

  const slots = plan.slots.map((s, i) => {
    const x = clamp01(Number.isFinite(s.x) ? s.x : 0);
    const y = clamp01(Number.isFinite(s.y) ? s.y : 0);
    const rawW = Number.isFinite(s.width) ? s.width : 1;
    const rawH = Number.isFinite(s.height) ? s.height : 1;
    let width = Math.max(MIN_SIZE, Math.min(rawW, 1 - x));
    let height = Math.max(MIN_SIZE, Math.min(rawH, 1 - y));
    if (width !== s.width || height !== s.height || x !== s.x || y !== s.y) {
      fixes.push(`格 ${i + 1} 的坐标/尺寸已夹回页面范围内`);
    }
    let polygon = s.polygon;
    if (polygon && needsPolygon(s) && polygon.length >= 3) {
      polygon = polygon.map(p => ({
        x: Math.max(x, Math.min(x + width, clamp01(Number.isFinite(p.x) ? p.x : x))),
        y: Math.max(y, Math.min(y + height, clamp01(Number.isFinite(p.y) ? p.y : y))),
      }));
      fixes.push(`格 ${i + 1} 的 polygon 顶点已夹进自身 bounding box`);
    }
    return { ...s, x, y, width, height, ...(polygon ? { polygon } : {}) } as ComicPanelSlot;
  });

  // readingOrder 必须是 1..n 的完整排列：去重、补齐缺失、夹掉越界。
  const seen = new Set<number>();
  const order: number[] = [];
  for (const v of plan.readingOrder) {
    const k = Math.round(Number(v));
    if (k >= 1 && k <= n && !seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  for (let k = 1; k <= n; k += 1) {
    if (!seen.has(k)) order.push(k);
  }
  if (order.length !== plan.readingOrder.length || order.some((v, i) => v !== plan.readingOrder[i])) {
    fixes.push('阅读顺序已修复为 1..N 的完整排列');
  }

  // whitespace 数值夹回 0..0.5（留白不可能超过半页）。
  const outerMargin = Math.max(0, Math.min(0.5, clampNum(plan.whitespace.outerMargin, 0.04)));
  const gutter = Math.max(0, Math.min(0.3, clampNum(plan.whitespace.gutter, 0.02)));
  const reservedRegions = (plan.whitespace.reservedRegions ?? []).map(r => ({
    x: clamp01(clampNum(r.x, 0)),
    y: clamp01(clampNum(r.y, 0)),
    width: Math.max(0, Math.min(1, clampNum(r.width, 0))),
    height: Math.max(0, Math.min(1, clampNum(r.height, 0))),
  }));

  return {
    plan: {
      ...plan,
      slots,
      readingOrder: order,
      whitespace: { ...plan.whitespace, outerMargin, gutter, reservedRegions },
    },
    fixes,
  };
}

function clampNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 完整校验。先看结构错误（格数/风格/readingOrder/坐标），再看几何（polygon/重叠/留白/安全区），
 * 最后看内容与对白的关联。errors 非空即不合格；warnings 不阻断（提示人工复核）。
 */
export function validateLayoutPlan(input: LayoutValidationInput): ComicLayoutValidation {
  const { plan } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const fixes: string[] = [];
  const slots = plan.slots ?? [];
  const n = slots.length;

  // ---- 结构与约束 ----
  if (!Number.isInteger(plan.panelCount) || plan.panelCount < 1 || plan.panelCount > 8) {
    errors.push(`panelCount 非法：${plan.panelCount}`);
  }
  if (plan.panelCount !== n) {
    errors.push(`slots 数量（${n}）与 panelCount（${plan.panelCount}）不一致`);
  }
  if (input.expectedPanelCount && n !== input.expectedPanelCount) {
    errors.push(`用户固定 ${input.expectedPanelCount} 格，但布局给出 ${n} 格`);
  }
  if (input.styleLocked && input.expectedStyle && plan.style !== input.expectedStyle) {
    errors.push(`用户锁定风格 ${input.expectedStyle}，但布局写成了 ${plan.style}`);
  }

  const order = plan.readingOrder ?? [];
  if (order.length !== n || new Set(order).size !== n || order.some(v => v < 1 || v > n)) {
    errors.push(`readingOrder 不是 1..${n} 的完整排列`);
  }

  // ---- 几何 ----
  slots.forEach((s, i) => {
    const label = `格 ${i + 1}`;
    if (s.x < 0 || s.y < 0 || s.x + s.width > 1 + EPS || s.y + s.height > 1 + EPS) {
      errors.push(`${label} 超出页面（坐标必须在 0..1）`);
    }
    if (s.width < MIN_SIZE || s.height < MIN_SIZE) {
      errors.push(`${label} 尺寸过小，读者看不清`);
    }
    if (needsPolygon(s)) {
      const pts = s.polygon ?? [];
      if (pts.length < 3) {
        errors.push(`${label} 是 ${s.shape}，但没有给出至少 3 个 polygon 顶点`);
      } else {
        const out = pts.some(p => p.x < s.x - EPS || p.x > s.x + s.width + EPS
          || p.y < s.y - EPS || p.y > s.y + s.height + EPS);
        if (out) errors.push(`${label} 的 polygon 顶点超出了自身 bounding box`);
        if (polygonSelfIntersects(pts)) errors.push(`${label} 的 polygon 自交`);
      }
    }
    // 安全区不越界（相对页面）
    for (const sa of s.safeAreas ?? []) {
      if (sa.x < 0 || sa.y < 0 || sa.x + sa.width > 1 + EPS || sa.y + sa.height > 1 + EPS) {
        errors.push(`${label} 的安全区越出页面`);
      }
    }
  });

  // 未显式允许重叠的格子不得重叠
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (!slots[i].overlapAllowed && !slots[j].overlapAllowed && overlaps(slots[i], slots[j])) {
        errors.push(`格 ${i + 1} 与格 ${j + 1} 重叠，但都未声明允许重叠`);
      }
    }
  }

  // 保留的留白区不能被普通格覆盖
  for (const r of plan.whitespace.reservedRegions ?? []) {
    if (r.width < EPS || r.height < EPS) continue;
    slots.forEach((s, i) => {
      if (overlaps(s, r) && s.role !== 'hero') {
        warnings.push(`格 ${i + 1} 压到了预留留白区（若这是有意的，可忽略）`);
      }
    });
  }

  // ---- 内容与对白关联 ----
  if (input.panels && input.panels.length !== n) {
    warnings.push(`panel 内容（${input.panels.length}）与 slot 数（${n}）不一致`);
  }
  if (input.dialogue) {
    let lastPanel = 0;
    for (const d of input.dialogue) {
      if (typeof d.panel === 'number') {
        if (d.panel < 1 || d.panel > n) {
          errors.push(`台词「${d.text.slice(0, 12)}」指向不存在的格 ${d.panel}`);
        }
        if (d.panel < lastPanel) warnings.push('台词的 panel 号倒退，请按阅读顺序检查');
        lastPanel = d.panel;
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, fixes };
}

/**
 * 便捷入口：先修复再校验，把修复记录并入结果。
 * 上层拿到 ok=false 时按任务书 §2 失败处理：重写 layout（不动 beat/台词/格内容）→ 安全模板回退。
 */
export function repairAndValidate(input: LayoutValidationInput): ComicLayoutValidation {
  const repaired = repairLayoutPlan(input.plan);
  const result = validateLayoutPlan({ ...input, plan: repaired.plan });
  return { ...result, fixes: [...repaired.fixes, ...result.fixes] };
}
