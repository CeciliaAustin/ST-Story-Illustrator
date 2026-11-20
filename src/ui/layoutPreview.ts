/**
 * 版面线框预览（纯 DOM，无外部依赖）
 *
 * 扩展指导 §5：生成前让用户看见 LLM 的设计——每格形状/位置/大小、主次、
 * 阅读顺序、留白与气泡安全区。这里提供两个渲染器：
 * - `styleWireframe(style)`：风格卡片用的默认示意线框（没有 layoutPlan 时）；
 * - `renderLayoutPreview(plan, options)`：按真实 slots 精确绘制，支持 polygon 斜切。
 *
 * 全部用 SVG 绘制，坐标 0..1 映射到 viewBox 0..100，便于在设置卡片与灯箱复用。
 */

import type {
  ComicLayoutPlan,
  ComicLayoutStyle,
  ComicPanelSlot,
} from '../types';

const NS = 'http://www.w3.org/2000/svg';
const VB = 100;

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const ROLE_FILL: Record<string, string> = {
  hero: 'rgba(91, 141, 255, 0.20)',
  support: 'rgba(91, 141, 255, 0.10)',
  detail: 'rgba(255, 176, 91, 0.18)',
  reaction: 'rgba(160, 120, 255, 0.16)',
  object: 'rgba(120, 200, 160, 0.16)',
};

/** 一套风格的默认示意 slots（只用于卡片缩略图，不是出图几何）。 */
function defaultSlots(style: ComicLayoutStyle): ComicPanelSlot[] {
  const base = (panelIndex: number, x: number, y: number, width: number, height: number,
    role: ComicPanelSlot['role'] = 'support'): ComicPanelSlot => ({
    panelIndex, x, y, width, height, shape: 'rect', zIndex: panelIndex,
    role, border: 'thin', overlapAllowed: false,
  });
  switch (style) {
    case 'classic_grid':
      return [base(0, 0.06, 0.04, 0.88, 0.2, 'hero'), base(1, 0.06, 0.28, 0.88, 0.2),
        base(2, 0.06, 0.52, 0.88, 0.2), base(3, 0.06, 0.76, 0.88, 0.2)];
    case 'diagonal_panels':
      return [base(0, 0.05, 0.05, 0.9, 0.42, 'hero'), { ...base(1, 0.05, 0.53, 0.9, 0.42),
        shape: 'parallelogram', polygon: [
          { x: 0.2, y: 0.53 }, { x: 0.95, y: 0.53 }, { x: 0.8, y: 0.95 }, { x: 0.05, y: 0.95 },
        ] }];
    case 'hero_insets':
      return [base(0, 0.12, 0.34, 0.7, 0.52, 'hero'),
        base(1, 0.2, 0.06, 0.5, 0.18, 'detail'), base(2, 0.66, 0.72, 0.24, 0.18, 'detail')];
    case 'freeform':
      return [base(0, 0.08, 0.1, 0.55, 0.62, 'hero'),
        { ...base(1, 0.62, 0.08, 0.3, 0.3, 'detail'), shape: 'floating_rect' },
        base(2, 0.5, 0.66, 0.42, 0.26, 'object')];
    case 'open_montage':
    default:
      return [base(0, 0.1, 0.08, 0.8, 0.34, 'hero'), base(1, 0.08, 0.5, 0.46, 0.36),
        base(2, 0.6, 0.56, 0.32, 0.26, 'detail')];
  }
}

export interface PreviewOptions {
  /** 是否标阅读顺序数字（默认 true）。 */
  showOrder?: boolean;
  /** 是否画气泡安全区（默认 true）。 */
  showSafeAreas?: boolean;
  /** 每格对应的中文短标题（与 readingOrder 同序）。 */
  labels?: string[];
  /** 缩略图尺寸（px）。默认 96。 */
  size?: number;
}

/** 画一个 slot（矩形或多边形）。 */
function drawSlot(svg: SVGElement, slot: ComicPanelSlot, index: number, opts: PreviewOptions): void {
  const isPoly = !!slot.polygon && slot.polygon.length >= 3
    && slot.shape !== 'rect';
  let shapeEl: SVGElement;
  if (isPoly) {
    const pts = slot.polygon!.map(p => `${(p.x * VB).toFixed(1)},${(p.y * VB).toFixed(1)}`).join(' ');
    shapeEl = svgEl('polygon', { points: pts });
  } else {
    shapeEl = svgEl('rect', {
      x: (slot.x * VB).toFixed(1), y: (slot.y * VB).toFixed(1),
      width: (slot.width * VB).toFixed(1), height: (slot.height * VB).toFixed(1),
      rx: slot.shape === 'floating_rect' ? 2 : 0.6,
    });
  }
  shapeEl.setAttribute('fill', ROLE_FILL[slot.role] ?? ROLE_FILL.support);
  shapeEl.setAttribute('stroke', 'var(--sti-wire-stroke, #5b8dff)');
  shapeEl.setAttribute('stroke-width', slot.role === 'hero' ? '1.6' : '1');
  if (slot.border === 'none') shapeEl.setAttribute('stroke-dasharray', '2 2');
  svg.appendChild(shapeEl);

  if (opts.showSafeAreas) {
    for (const sa of slot.safeAreas ?? []) {
      const r = svgEl('rect', {
        x: (sa.x * VB).toFixed(1), y: (sa.y * VB).toFixed(1),
        width: (sa.width * VB).toFixed(1), height: (sa.height * VB).toFixed(1),
        fill: 'rgba(255,176,91,0.10)', stroke: 'var(--sti-wire-safe, #ffb05b)',
        'stroke-width': '0.7', 'stroke-dasharray': '2 1.5',
      });
      svg.appendChild(r);
    }
  }

  if (opts.showOrder !== false) {
    const cx = (slot.x + slot.width / 2) * VB;
    const cy = (slot.y + slot.height / 2) * VB;
    const badge = svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 6,
      fill: 'var(--sti-wire-badge, #5b8dff)' });
    svg.appendChild(badge);
    const label = svgEl('text', {
      x: cx.toFixed(1), y: (cy + 2.6).toFixed(1),
      'text-anchor': 'middle', 'font-size': '7.5', fill: '#fff', 'font-weight': 'bold',
    });
    label.textContent = String(index + 1);
    svg.appendChild(label);
  }
}

/** 按真实 layoutPlan 精确绘制线框预览。 */
export function renderLayoutPreview(plan: ComicLayoutPlan, opts: PreviewOptions = {}): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: `0 0 ${VB} ${VB}`,
    width: opts.size ?? 96,
    height: opts.size ?? 96,
    class: 'sti-layout-preview',
    role: 'img',
    'aria-label': '漫画版面线框预览',
  });
  const bg = svgEl('rect', { x: 0, y: 0, width: VB, height: VB,
    fill: plan.background === 'black' ? '#1c1c1c' : '#fafafa' });
  svg.appendChild(bg);
  // 按 readingOrder 画格子编号，和模型的阅读路径一致
  const order = plan.readingOrder.length ? plan.readingOrder : plan.slots.map((_, i) => i + 1);
  order.forEach((slotIdx, orderIdx) => {
    const slot = plan.slots.find(s => s.panelIndex === slotIdx - 1) ?? plan.slots[orderIdx];
    if (slot) drawSlot(svg, slot, orderIdx, { ...opts, showOrder: true });
  });
  return svg as SVGSVGElement;
}

/** 风格卡片用的默认线框（没有真实 layoutPlan 时）。 */
export function styleWireframe(style: ComicLayoutStyle, opts: PreviewOptions = {}): SVGSVGElement {
  const slots = defaultSlots(style);
  const pseudo: ComicLayoutPlan = {
    style,
    panelCount: slots.length,
    background: 'white',
    whitespace: { intent: 'balanced', outerMargin: 0.05, gutter: 0.02, reservedRegions: [] },
    readingOrder: slots.map((_, i) => i + 1),
    slots,
    designRationale: '',
  };
  return renderLayoutPreview(pseudo, { ...opts, showSafeAreas: false });
}
