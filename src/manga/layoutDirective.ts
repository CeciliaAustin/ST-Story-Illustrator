/**
 * 版面导演指令（三段式 Stage A/B 的 prompt 侧，纯函数）
 *
 * 扩展指导 §2.1：自由构图不能只说「自由发挥」，要让 LLM 先当视觉导演想清楚
 * 「这一瞬间值不值得看、看什么、什么节奏」，再输出可执行几何。
 * 这里生成一段注入到分镜规则里的中文指令；用户选的风格/格数/留白是硬边界。
 */

import type {
  ComicLayoutStyle,
  ComicPanelCount,
  ComicWhitespaceIntent,
  ComicWhitespacePreference,
} from '../types';
import { defaultWhitespaceForStyle, isStyleLocked } from './layoutStyle';

export interface LayoutDirectiveInput {
  style: ComicLayoutStyle;
  panelCount: ComicPanelCount;
  whitespace: ComicWhitespacePreference;
}

const STYLE_LABEL: Record<ComicLayoutStyle, string> = {
  classic_grid: '传统四格（纵向等宽 yonkoma / 或 2×2 规整网格）',
  open_montage: '开放式拼版（大小不等、可错位、有主次，宽 gutter 与外边距）',
  diagonal_panels: '斜切分格（斜边/梯形/平行四边形制造动势，1~2 条斜边即可）',
  hero_insets: '主画面 + 浮动特写（一张大主格 + 1~2 个漂浮的细节格，大量负空间）',
  freeform: '自由构图（由你按这一瞬间的视觉核心决定，但必须给出可验证的结构）',
};

const WHITE_LABEL: Record<ComicWhitespaceIntent, string> = {
  compact: '紧凑：格间窄、外边距小',
  balanced: '平衡：适度留白，主次清楚',
  airy: '舒展：宽 gutter、明显外边距与负空间',
  dramatic: '戏剧性：主画面周围大面积留白，停顿感强',
};

const DIRECTOR_RULE =
  '【版面导演（先想清楚再排格子，这决定这一页好不好看）】\n' +
  '先判断这一个连续 beat 的视觉核心：人物关系 / 动作接触点 / 表情 / 身体局部 / 关键物件 / 空间关系，' +
  '只选真正增强叙事的镜头，不为凑格重复同一个半身，也不为让每格不同而编造新事件。\n' +
  '建立视觉主次：一个主要焦点，其余格只做必要补充（极近特写/局部/物件/空镜都行）；' +
  '不要求每格都有人、人数相同、等大、对齐或矩形。\n' +
  '版面必须有明确阅读路径。斜切用于方向/冲突/速度/不稳定；浮动 inset 用于放大同一瞬间的细节；' +
  '大面积留白用于停顿/孤独/余韵/强调——每种形式都要有叙事理由，不随机叠加装饰。\n' +
  '先写 direction（视觉方案），再写 layout（几何 slots）；坐标一律 0~1 归一化，polygon 顶点落在自己格内。';

/**
 * 生成注入到分镜规则里的版面导演文本。
 * 用户锁定的风格/格数是硬边界：明确写「不得换成 X」；自由模式才允许 LLM 自选。
 */
export function buildLayoutDirective(input: LayoutDirectiveInput): string {
  const { style, panelCount, whitespace } = input;
  const locked = isStyleLocked(style);
  const intent = whitespace === 'auto'
    ? defaultWhitespaceForStyle(style)
    : (whitespace as ComicWhitespaceIntent);

  const lines: string[] = [DIRECTOR_RULE];
  lines.push(
    `本批版面风格：${STYLE_LABEL[style]}。` +
    (locked
      ? '这是用户指定的风格，整批每一页都必须用它，不得擅自换成别的风格。'
      : '这是自由模式：你可以按每页 beat 在五种风格里挑最合适的一种，写在 direction.recommendedLayout。'),
  );
  lines.push(
    panelCount === 'auto'
      ? '格数由你按 beat 决定（2~4 格）：素材只够一两个镜头就少排，不为凑数编剧情；写在 direction.recommendedPanelCount。'
      : `格数固定为 ${panelCount} 格：每页的 panels、layout.slots、layout.readingOrder 都必须正好是 ${panelCount} 个，不得多也不得少。`,
  );
  lines.push(`留白倾向：${WHITE_LABEL[intent]}。黑底页保留黑色负空间，白底页保留白色负空间，不按规定百分比硬填。`);

  // schema 说明：让 LLM 知道要把 direction / layout 写在页的哪个字段
  lines.push(
    '每页额外输出两个字段：' +
    '"direction":{"visualFocus":"视觉核心","emotionalTone":"情绪基调","pageRhythm":"页面节奏",' +
    '"recommendedLayout":"classic_grid|open_montage|diagonal_panels|hero_insets|freeform",' +
    '"recommendedPanelCount":数字,"reason":"为什么这么排","whitespaceIntent":"compact|balanced|airy|dramatic",' +
    '"readingOrder":"top_to_bottom|left_to_right|right_to_left"};' +
    '"layout":{"style":同上,"panelCount":数字,"background":"white|black|transparent|scene",' +
    '"whitespace":{"intent":同上,"outerMargin":0~0.3,"gutter":0~0.15,"reservedRegions":[]},' +
    '"readingOrder":[1,2,3],"slots":[{"panelIndex":0,"x":0,"y":0,"width":0.5,"height":0.5,' +
    '"shape":"rect|parallelogram|triangle|trapezoid|custom_polygon|floating_rect",' +
    '"polygon":[{"x":0,"y":0}],"zIndex":0,"role":"hero|support|detail|reaction|object",' +
    '"border":"none|thin|rough","overlapAllowed":false}],' +
    '"designRationale":"版面设计理由"}。' +
    'direction/layout 只描述这**一页**，必须与本页 panels 一一对应；代码会校验格数、坐标和阅读顺序，不合格会退回重排。',
  );
  return lines.join('\n');
}
