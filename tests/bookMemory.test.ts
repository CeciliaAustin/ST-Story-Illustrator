/**
 * 柏宝书角色参考读取测试
 *
 * 这层的东西一旦错了不会报错，只会「服装每格都不一样」——
 * 所以断言的落点是：主角带名字、在场判定、读不到就老实返回 null（不许编）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatBookRoles, readBookRoles } from '../src/baibai/bookMemory';

interface BookGlobal {
  STBaiBaiBook?: unknown;
}

function setBook(api: unknown): void {
  (globalThis as BookGlobal).STBaiBaiBook = api;
}

afterEach(() => {
  delete (globalThis as BookGlobal).STBaiBaiBook;
  vi.restoreAllMocks();
});

describe('formatBookRoles', () => {
  it('主角带上人设名，否则模型会以为「主角」跟库里那个人是两个人', () => {
    const text = formatBookRoles(
      { revision: 1, protagonist: { gender: '女', appearance: '黑色长发', outfit: '白色衬衫' } },
      '',
      '小雪',
    );
    expect(text).toContain('主角(小雪)');
    expect(text).toContain('外貌:黑色长发');
    expect(text).toContain('着装:白色衬衫');
  });

  it('没有人设名时退回只写「主角」，不硬塞一个名字', () => {
    const text = formatBookRoles(
      { revision: 1, protagonist: { gender: '女', appearance: '黑色长发' } },
      '',
    );
    expect(text).toContain('主角:');
    expect(text).not.toContain('主角(');
  });

  it('重要角色常驻；普通过客要正文里出现才发（否则整段全是人名）', () => {
    const text = formatBookRoles(
      {
        revision: 1,
        protagonist: {},
        npcs: [
          { name: '老板娘', important: true, desc: '短发' },
          { name: '路人甲', desc: '没写进正文' },
          { name: '柏宝', follow: true, outfit: '校服' },
        ],
      },
      '柏宝把书合上了',
    );
    expect(text).toContain('老板娘');
    expect(text).toContain('柏宝');
    expect(text).not.toContain('路人甲');
    // 随行的人即使正文没提到也要在（他就在画面里）
    expect(text).toContain('着装:校服');
  });

  it('主角与 NPC 都没有字段时返回空串，调用方据此当成「没有参考」', () => {
    expect(formatBookRoles({ revision: 1, protagonist: {}, npcs: [] }, '')).toBe('');
    expect(formatBookRoles({ revision: 1 }, '')).toBe('');
  });
});

describe('readBookRoles', () => {
  it('柏宝书不在场 → null（不是空壳文本）', () => {
    expect(readBookRoles(3, '正文')).toBeNull();
  });

  it('apiVersion 不是 1 视为不兼容，不硬读', () => {
    setBook({ apiVersion: 2, getFloor: () => ({ revision: 1, memory: { valid: true } }) });
    expect(readBookRoles(3, '正文')).toBeNull();
  });

  it('优先用 getContextAtFloor：memory 有效就读 after 快照', () => {
    const getSnapshot = vi.fn();
    setBook({
      apiVersion: 1,
      getFloor: vi.fn(),
      getSnapshot,
      getContextAtFloor: () => ({
        revision: 1,
        floorData: { memory: { valid: true } },
        snapshotBefore: { revision: 1, protagonist: { appearance: '旧衣服' } },
        snapshotAfter: { revision: 1, protagonist: { appearance: '新衣服' } },
      }),
    });
    const got = readBookRoles(3, '正文', '小雪');
    expect(got?.timing).toBe('after_latest');
    expect(got?.text).toContain('新衣服');
    expect(got?.text).toContain('【角色参考（柏宝书同步的最新状态，只读）】');
    // 有 getContextAtFloor 就不该再自己拼前后快照
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('memory 未更新时读 before 快照（这一楼还没结算）', () => {
    setBook({
      apiVersion: 1,
      getFloor: vi.fn(),
      getSnapshot: vi.fn(),
      getContextAtFloor: () => ({
        revision: 1,
        floorData: { memory: { valid: false } },
        snapshotBefore: { revision: 1, protagonist: { outfit: '雨衣' } },
        snapshotAfter: { revision: 2, protagonist: { outfit: '睡衣' } },
      }),
    });
    const got = readBookRoles(3, '正文');
    expect(got?.timing).toBe('before_latest');
    expect(got?.text).toContain('雨衣');
  });

  it('旧版 API：revision 三次都对不上就放弃，不拿错位的状态去画', () => {
    setBook({
      apiVersion: 1,
      getFloor: () => ({ revision: 5, memory: { valid: true } }),
      getSnapshot: () => ({ revision: 6, protagonist: { outfit: '别人的衣服' } }),
    });
    expect(readBookRoles(3, '正文')).toBeNull();
  });

  it('旧版 API：revision 对上就正常返回', () => {
    setBook({
      apiVersion: 1,
      getFloor: () => ({ revision: 7, memory: { valid: true } }),
      getSnapshot: () => ({ revision: 7, protagonist: { outfit: '校服' } }),
    });
    const got = readBookRoles(3, '正文');
    expect(got?.text).toContain('校服');
  });

  it('柏宝书自己抛错时吞掉并返回 null（不能让整个出图任务挂掉）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBook({
      apiVersion: 1,
      getFloor: () => {
        throw new Error('boom');
      },
      getSnapshot: () => ({ revision: 1 }),
    });
    expect(readBookRoles(3, '正文')).toBeNull();
  });
});
