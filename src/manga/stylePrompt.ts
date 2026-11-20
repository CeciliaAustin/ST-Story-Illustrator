/**
 * ST-Story-Illustrator — 风格 / 格数 / 留白 → 柏宝绘四档版面（纯函数）
 *
 * UI 的三个维度（风格、格数、留白）是"用户想要什么"，柏宝绘原版只有四档
 * （regular / irregular / inset / unframed）是"NAI 真的画得出来什么"。
 * 这一层就是两者之间唯一的映射点——**不造词、不改权重**，只用原版验证过的构图词。
 *
 * 关键纪律（来自实测与文档坑清单）：
 * - `3koma`/`4koma` 是"等分 N 格"的语义，**只有 classic_grid 能用**。
 *   在"主图+特写"上写它，NAI 会画成 N 条等宽横带（用户实测的截图就是这个）。
 * - "主图+特写"对应两档：
 *   · 要**大量留白** → inset（白底 + 居中主图 + 四周留白 + 带框特写格）；
 *   · 要**铺满** → unframed（白底 + 主画铺到页底 + 特写格，白边窄）。
 *   两档的留白要求正好相反，选错就一边是"空得离谱"、一边是"挤成一团"。
 * - 格数不成立时降级并说明，不硬凑（inset 最多 1 主 + 2 特写 = 3 格）。
 */

import type { ComicLayoutStyle, ComicPanelCount, ComicWhitespacePreference } from '../types';
import { normalizeLayoutStyle, normalizePanelCount, resolveWhitespaceIntent } from './layoutStyle';
import {
  boardNlHead,
  PANEL_TAGS_BY_LAYOUT,
  regularKomaTag,
  type BoardLayout,
  type BoardPageType,
} from './boardPrompt';

export interface BoardResolution {
  layout: BoardLayout;
  pageType: BoardPageType;
  /** regular 档的等分格数（其他档由 nl 表达，不用 koma 词） */
  koma?: 2 | 3 | 4;
  /** 这一页实际几格 */
  panelCount: number;
  /** 斜切风格：没有专属档，靠 nl 补一句 */
  diagonal?: boolean;
  /** 与用户所选格数不一致时的可读说明（写进运行提示，不静默） */
  note?: string;
}

function fixedCount(style: ComicLayoutStyle, count: ComicPanelCount): number {
  const n = normalizePanelCount(count);
  if (n !== 'auto') return n;
  switch (style) {
    case 'classic_grid':
      return 2;
    default:
      return 3;
  }
}

/**
 * 解析成「这一页用哪一档、哪种页型、几格」。
 *
 * 留白维度只在 hero_insets 上改变档位（inset ↔ unframed）：
 * 这两档都叫"主图+特写"，唯一区别就是主图四周留多少白。
 */
export function resolveBoard(input: {
  style: ComicLayoutStyle;
  panelCount: ComicPanelCount;
  whitespace: ComicWhitespacePreference;
}): BoardResolution {
  const style = normalizeLayoutStyle(input.style);
  const whitespace = resolveWhitespaceIntent(input.whitespace, style);
  const wanted = fixedCount(style, input.panelCount);

  if (style === 'classic_grid') {
    const n = (wanted === 4 ? 4 : wanted === 3 ? 3 : 2) as 2 | 3 | 4;
    return { layout: 'regular', pageType: 'auto', koma: n, panelCount: n };
  }

  if (style === 'open_montage') {
    const n = Math.min(4, Math.max(2, wanted));
    // 诚实说明：不等格拼版在原版规则里是「排版要满、白边要窄」，
    // 留白维度对它不起作用。要大片留白只能走白底档（主图+特写）。
    const wantAir = whitespace === 'airy' || whitespace === 'dramatic';
    return {
      layout: 'irregular',
      pageType: 'auto',
      panelCount: n,
      ...(wantAir
        ? { note: '「开放拼版」本身是铺满页面的不等格拼版，四周不会留大片白边；想要大面积留白请改选「主图+特写」并把留白设成平衡以下。' }
        : {}),
    };
  }

  if (style === 'diagonal_panels') {
    const n = Math.min(4, Math.max(2, wanted));
    return { layout: 'irregular', pageType: 'auto', panelCount: n, diagonal: true };
  }

  if (style === 'hero_insets') {
    // 留白多 → inset（白底居中 + 四周留白）；留白少 → unframed（主画铺底）
    const wantAir = whitespace === 'airy' || whitespace === 'dramatic';
    if (wantAir) {
      const note = wanted >= 4
        ? `「主图+特写」最多只能三格（一张主图 + 两个特写格），已按三格出图；要四格请改用「经典网格」。`
        : undefined;
      return {
        layout: 'inset',
        pageType: 'auto',
        panelCount: Math.min(3, Math.max(2, wanted)),
        ...(note ? { note } : {}),
      };
    }
    const note = wanted >= 4
      ? '铺满版式最多三格（主画 + 一到两个特写格），已按三格出图；要四格请改用「经典网格」。'
      : undefined;
    const n = Math.min(3, Math.max(2, wanted));
    return {
      layout: 'unframed',
      pageType: n >= 3 ? 'a' : 'b',
      panelCount: n,
      ...(note ? { note } : {}),
    };
  }

  // freeform：没有钉死风格，用最通用的不等格拼版承载
  const n = Math.min(4, Math.max(2, wanted));
  return { layout: 'irregular', pageType: 'auto', panelCount: n };
}

/** 这一档这一格数该注入的构图词（带权重，原样）。 */
export function boardTagsFor(board: BoardResolution): string[] {
  if (board.layout === 'regular') {
    const n = board.koma ?? 2;
    return ['1.4::multiple views::', regularKomaTag(n), '1.5::split screen::'];
  }
  return [...PANEL_TAGS_BY_LAYOUT[board.layout]];
}

export interface BoardGeneration extends BoardResolution {
  tags: string[];
  /** nl 的版面首句（原版措辞，按档 + 页型 + 格数） */
  nlHead: string;
}

/**
 * 一次性产出这一页该注入的构图词与版面首句。
 * 出图时再走 `enforcePanelPrompt` 做删禁词/补缺词，两道合起来才是确定性的。
 */
export function buildBoardGeneration(input: {
  style: ComicLayoutStyle;
  panelCount: ComicPanelCount;
  whitespace: ComicWhitespacePreference;
}): BoardGeneration {
  const board = resolveBoard(input);
  const whitespace = resolveWhitespaceIntent(input.whitespace, normalizeLayoutStyle(input.style));
  const nlHead = boardNlHead({
    layout: board.layout,
    pageType: board.pageType,
    panelCount: board.panelCount,
    whitespace,
    ...(board.diagonal ? { diagonal: true } : {}),
  });
  return { ...board, tags: boardTagsFor(board), nlHead };
}
