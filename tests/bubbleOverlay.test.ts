/**
 * 显示层合成参数（bubbleOverlay）——「落盘无字原图、显示时才合成」的地基
 *
 * 原版（柏宝绘）架构的三条承诺，靠这里兑现：
 * 1. artifact 只存无字原图，台词与版面元数据一起跟着 artifact 走；
 * 2. 显示层重放时按「生成当时下发的格位」排版，改全局设置不影响历史页；
 * 3. 手动钉的位置（x/y）写回 dialogue，原地钉死、不被自动排版挪动。
 */

import { describe, it, expect } from 'vitest';
import { comicOverlayPlan, normalizeDialogueEdits, artifactLayoutOf, artifactPageTypeOf, artifactSlotsOf } from '../src/manga/bubbleOverlay';
import { DEFAULT_SETTINGS } from '../src/types';
import type { VisualArtifact } from '../src/types';

function artifactOf(metadata: Record<string, unknown>, dialogue?: VisualArtifact['dialogue']): VisualArtifact {
  return {
    id: 'a1',
    taskId: 't1',
    mode: 'comic',
    chatId: 'c1',
    sourceFloors: [3],
    mountMode: 'inline',
    imagePath: 'user/images/raw.png',
    prompt: '1.4::multiple views::, 1.4::2koma::',
    dialogue,
    metadata,
    createdAt: 0,
  } as VisualArtifact;
}

describe('comicOverlayPlan', () => {
  it('没有台词时返回 null：显示层直接用无字原图', () => {
    const a = artifactOf({ layout: 'regular', panelCount: 2 });
    expect(comicOverlayPlan(a, DEFAULT_SETTINGS)).toBeNull();
  });

  it('regular 两格页：格位按生成当时的元数据重放', () => {
    const a = artifactOf({ layout: 'regular', panelCount: 2, pageType: 'auto' }, [
      { text: '早安。', panel: 1 },
      { text: '……嗯。', panel: 2 },
    ]);
    const plan = comicOverlayPlan(a, DEFAULT_SETTINGS);
    expect(plan).not.toBeNull();
    expect(plan!.items).toHaveLength(2);
    expect(plan!.opts.panels).toHaveLength(2); // 上下两格
    // 第一格在上、第二格在下：台词落格的证据
    expect(plan!.opts.panels![0].y).toBeLessThan(plan!.opts.panels![1].y);
  });

  it('unframed A 型：主插画区是一个 slot，右下浮格与顶部条是禁区', () => {
    const a = artifactOf({ layout: 'unframed', panelCount: 3, pageType: 'a' }, [
      { text: '别动。' },
    ]);
    const plan = comicOverlayPlan(a, DEFAULT_SETTINGS)!;
    expect(plan.opts.panels).toHaveLength(1);
    expect(plan.opts.avoid!.length).toBeGreaterThan(0);
    // 禁区在页面下部（右下浮格），主插画区从顶部 20% 以下开始
    expect(plan.opts.panels![0].y).toBeGreaterThan(0.15);
  });

  it('手动钉的位置原样带回（0~1 夹取），自动排版不挪它', () => {
    const a = artifactOf({ layout: 'regular', panelCount: 2 }, [
      { text: '钉在这。', x: 0.2, y: 0.9 },
    ]);
    const plan = comicOverlayPlan(a, DEFAULT_SETTINGS)!;
    expect(plan.items[0].x).toBe(0.2);
    expect(plan.items[0].y).toBe(0.9);
  });

  it('脏位置被夹回 0~1，非数值剔除，不假装钉过', () => {
    const a = artifactOf({}, [
      { text: 'a', x: 3, y: -1 },
      { text: 'b', x: Number.NaN, y: 0.5 },
    ]);
    const plan = comicOverlayPlan(a, DEFAULT_SETTINGS)!;
    expect(plan.items[0].x).toBe(1); // 越界 → 夹到边界
    expect(plan.items[0].y).toBe(0);
    expect(plan.items[1].x).toBeUndefined(); // 非数值 → 当没钉过
    expect(plan.items[1].y).toBeUndefined();
  });
});

describe('normalizeDialogueEdits', () => {
  it('空文本条目被丢；先截前 4 条再滤空（与原版口径一致）', () => {
    const out = normalizeDialogueEdits([
      { text: '  ' },
      { text: '留下的' },
      { text: '2' }, { text: '3' }, { text: '4' }, { text: '被丢弃' },
    ]);
    expect(out).toHaveLength(3);
    expect(out![0].text).toBe('留下的');
  });

  it('非法 dir/mood/area 被剔除，合法的保留', () => {
    const out = normalizeDialogueEdits([
      { text: '……', dir: 'v', mood: 'whisper', area: 'tl' },
      { text: '嘿', dir: 'h', mood: 'angry', area: 'center' },
    ]);
    expect(out![0].dir).toBe('v');
    expect(out![0].mood).toBe('whisper');
    expect(out![0].area).toBe('tl');
    expect(out![1].dir).toBeUndefined();
    expect(out![1].mood).toBeUndefined();
    expect(out![1].area).toBeUndefined();
  });

  it('全空时返回 undefined（调用方写回空台词）', () => {
    expect(normalizeDialogueEdits([{ text: '' }])).toBeUndefined();
    expect(normalizeDialogueEdits('bad')).toBeUndefined();
  });
});

describe('artifact 元数据还原', () => {
  it('脏档位回落 regular / auto', () => {
    expect(artifactLayoutOf(artifactOf({ layout: 'weird' }))).toBe('regular');
    expect(artifactPageTypeOf(artifactOf({ pageType: 'z' }))).toBe('auto');
  });

  it('有 layoutPlan 时用随图存档的真实格位（不是按档位猜）', () => {
    const a = artifactOf({
      layout: 'regular', panelCount: 3,
      layoutPlan: {
        slots: [
          { panelIndex: 0, x: 0.05, y: 0.3, width: 0.6, height: 0.6 },
          { panelIndex: 1, x: 0.7, y: 0.2, width: 0.25, height: 0.3 },
          { panelIndex: 2, x: 0.7, y: 0.55, width: 0.25, height: 0.3 },
        ],
      },
    });
    const slots = artifactSlotsOf(a);
    expect(slots).toHaveLength(3);
    expect(slots[0]).toMatchObject({ x: 0.05, y: 0.3, width: 0.6, height: 0.6 });
  });

  it('没有 layoutPlan 时回落旧按档位推算（老 artifact 兼容）', () => {
    const slots = artifactSlotsOf(artifactOf({ layout: 'regular', panelCount: 2 }));
    expect(slots).toHaveLength(2);
  });

  it('layoutPlan 存在但无有效 slots 时也回落，不返回空', () => {
    const slots = artifactSlotsOf(artifactOf({ layout: 'regular', panelCount: 2, layoutPlan: { slots: [] } }));
    expect(slots).toHaveLength(2);
  });
});
