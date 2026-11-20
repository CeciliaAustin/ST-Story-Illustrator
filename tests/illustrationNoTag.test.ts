/**
 * 正文插画：不写正文 tag（这条是本次改动的全部理由）
 *
 * 背景：以前插画会往 message.mes 里写一条 `<bbi_image>`，再点柏宝绘卡片出图。
 * 于是两个插件抢同一块正文——
 *   · 柏宝绘自动分析扫到已有 tag → 整楼跳过；
 *   · 用户点「重新生成本楼」→ 它 stripImageTags 把整楼 tag 一起清掉，
 *     我们那张跟着消失，seq 也被重排。
 *
 * 现在改成：调它的公开 API 出图，正文一个字都不碰；显示与操作由本插件自己挂。
 * 这里固化三件事：
 * 1. 行内插画没有正文 tag 也必须显示（否则整批图会「看不见」）；
 * 2. 重画/改词走同一条 API，换种子、写回 artifact；
 * 3. workflow 里不再出现任何写 tag 的调用。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isArtifactVisible, needsBodyTag } from '../src/ui/floorCards';
import { rerollIllustration } from '../src/tasks/rerollIllustration';
import { initSTEnvironment } from '../src/host/sillytavern';

/**
 * node 环境没有 window，而 saveChatSafe 用 window.setTimeout 做「合并突发保存」的延迟。
 * 给它一个零延迟版本：测试不需要那 1.5 秒，也不该等。
 */
if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).window = {
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
  };
}

interface RawArtifact {
  id: string;
  mode: string;
  mountMode: string;
  imagePath: string;
  prompt: string;
  nl?: string;
  metadata: Record<string, unknown>;
}

function makeArtifact(patch: Partial<RawArtifact> = {}): Record<string, unknown> {
  return {
    id: 'art_1',
    taskId: 'task_1',
    mode: 'illustration',
    chatId: 'chat_1',
    sourceFloors: [1],
    anchorFloor: 1,
    swipeId: 0,
    mountMode: 'inline',
    imagePath: '/user/images/old.png',
    prompt: '1girl, silver hair, sitting',
    nl: 'a girl sitting by the window',
    metadata: { anchorKind: 'text', galleryCharacter: '阿黛尔' },
    createdAt: 1,
    ...patch,
  };
}

async function stubHost(artifacts: Array<Record<string, unknown>>) {
  const message = {
    mes: '正文一行。\n\n他低下头。',
    swipe_id: 0,
    swipes: ['正文一行。\n\n他低下头。'],
    extra: { sti_artifacts: { version: 1, artifacts } },
  };
  const ctx = {
    chat: [message],
    extensionSettings: {},
    saveChat: async () => {},
    updateMessageBlock: async () => {},
    eventSource: { emit: () => {} },
  };
  (globalThis as unknown as Record<string, unknown>).getContext = () => ctx;
  // 宿主的 getContextFn 是初始化那一刻抓的引用：换了桩必须重新抓一次
  await initSTEnvironment();
  return message;
}

function stubApi(generate: (req: Record<string, unknown>) => Promise<unknown>) {
  (globalThis as unknown as Record<string, unknown>).STBaiBaiImage = {
    apiVersion: 1,
    pluginVersion: 'test',
    generate,
  };
}

describe('行内插画的可见性 —— 没有正文 tag 也要显示', () => {
  it('插画（anchorKind=text）不带 tag 也算可见', () => {
    expect(isArtifactVisible({ id: 'a', mountMode: 'inline', metadata: { anchorKind: 'text' } }, new Set())).toBe(true);
  });

  it('漫画仍然只认正文 tag（删 tag = 不显示，行为不变）', () => {
    const comic = { id: 'c', mountMode: 'inline', metadata: {} } as const;
    expect(isArtifactVisible(comic, new Set())).toBe(false);
    expect(isArtifactVisible(comic, new Set(['c']))).toBe(true);
  });

  it('needsBodyTag 只对漫画成立', () => {
    expect(needsBodyTag({ mountMode: 'inline', metadata: {} })).toBe(true);
    expect(needsBodyTag({ mountMode: 'inline', metadata: { anchorKind: 'text' } })).toBe(false);
    expect(needsBodyTag({ mountMode: 'trailing', metadata: {} })).toBe(false);
  });
});

describe('正文插画不再往正文写 tag', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/tasks/workflow.ts'), 'utf8');

  it('workflow 里没有任何写/读 bbi_image tag 的调用', () => {
    for (const banned of ['insertImageTag', 'buildBbiTag', 'triggerCardGenerate', 'waitForEntry', 'bbiSlotSeq']) {
      expect(source.includes(banned), `workflow.ts 仍在用 ${banned}`).toBe(false);
    }
  });

  it('插画出图走的是柏宝绘公开 API', () => {
    expect(source.includes('baiBaiAdapter.generate')).toBe(true);
  });
});

describe('rerollIllustration —— 换种子重画并写回', () => {
  it('拿到新路径与种子，artifact 就地更新', async () => {
    const message = await stubHost([makeArtifact()]);
    let seen: Record<string, unknown> = {};
    stubApi(async req => {
      seen = req;
      return {
        apiVersion: 1, pluginVersion: 'test', dataUrl: 'data:image/png;base64,AA',
        format: 'png', path: '/user/images/new.png', seed: 4242, backend: 'nai', charactersApplied: true,
      };
    });

    const result = await rerollIllustration(0, 'art_1');
    expect(result.ok).toBe(true);

    const stored = (message.extra.sti_artifacts as { artifacts: Array<Record<string, unknown>> }).artifacts[0];
    expect(stored.imagePath).toBe('/user/images/new.png');
    expect(stored.seed).toBe(4242);
    expect((stored.metadata as Record<string, unknown>).seed).toBe(4242);
    // 提示词与图库分组沿用原值——重画不是重新理解剧情
    expect(seen.prompt).toBe('1girl, silver hair, sitting');
    expect(seen.nl).toBe('a girl sitting by the window');
    expect(seen.character).toBe('阿黛尔');
  });

  it('nl 传空串 = 这次不要 nl（不能被旧值悄悄带回来）', async () => {
    await stubHost([makeArtifact()]);
    let seen: Record<string, unknown> = {};
    stubApi(async req => {
      seen = req;
      return { apiVersion: 1, pluginVersion: 'test', dataUrl: 'data:,', format: 'png', path: '/p.png', seed: 1, backend: 'nai', charactersApplied: false };
    });
    const result = await rerollIllustration(0, 'art_1', { nl: '' });
    expect(result.ok).toBe(true);
    expect(seen).not.toHaveProperty('nl');
  });

  it('改词重画：用新的正向词，不重读剧情', async () => {
    await stubHost([makeArtifact()]);
    let seen: Record<string, unknown> = {};
    stubApi(async req => {
      seen = req;
      return { apiVersion: 1, pluginVersion: 'test', dataUrl: 'data:,', format: 'png', path: '/p.png', seed: 2, backend: 'nai', charactersApplied: false };
    });
    const result = await rerollIllustration(0, 'art_1', { prompt: '1boy, standing, rain' });
    expect(result.ok).toBe(true);
    expect(seen.prompt).toBe('1boy, standing, rain');
  });

  it('柏宝绘报错时返回可读失败，不抛', async () => {
    await stubHost([makeArtifact()]);
    stubApi(async () => {
      throw new Error('backend not configured');
    });
    const result = await rerollIllustration(0, 'art_1');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('backend not configured');
  });

  it('只认插画：漫画 id 传进来直接拒绝', async () => {
    await stubHost([makeArtifact({ id: 'art_c', mode: 'comic' })]);
    stubApi(async () => ({ path: '/p.png', seed: 1 }));
    const result = await rerollIllustration(0, 'art_c');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('不是正文插画');
  });

  it('数据不在了就明确说没数据', async () => {
    await stubHost([]);
    stubApi(async () => ({ path: '/p.png', seed: 1 }));
    const result = await rerollIllustration(0, 'art_missing');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('数据已经不在了');
  });
});
