/**
 * ST-Story-Illustrator — 小剧场三桶存储（status / bonus / manga）
 *
 * 数据挂在 message.extra.sti_theater，独立于柏宝绘命名空间。
 * 空台词/空位置不落盘，保证 round-trip 稳定（坑 12）。
 */

import type { BbiStatusInfo, StatusLine } from '../types';
import { getMessage } from '../host/sillytavern';

const THEATER_KEY = 'sti_theater';
type Bucket = 'status' | 'bonus' | 'manga';

interface TheaterStore {
  version: number;
  buckets: Record<Bucket, BbiStatusInfo[]>;
}

function emptyStore(): TheaterStore {
  return { version: 1, buckets: { status: [], bonus: [], manga: [] } };
}

function readStore(raw: unknown): TheaterStore {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  const o = raw as Record<string, unknown>;
  const buckets = (o.buckets ?? {}) as Record<string, unknown>;
  for (const b of ['status', 'bonus', 'manga'] as Bucket[]) {
    if (Array.isArray(buckets[b])) {
      store.buckets[b] = (buckets[b] as unknown[]).filter(
        (x): x is BbiStatusInfo => !!x && typeof x === 'object',
      );
    }
  }
  return store;
}

function writeStore(floor: number, store: TheaterStore): boolean {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  (msg.extra as Record<string, unknown>)[THEATER_KEY] = store;
  return true;
}

/** 读某楼层某桶的故事列表。 */
export function getStories(floor: number, bucket: Bucket): BbiStatusInfo[] {
  const msg = getMessage(floor);
  if (!msg) return [];
  const extra = msg.extra as Record<string, unknown> | undefined;
  return readStore(extra?.[THEATER_KEY]).buckets[bucket];
}

/** 该楼层该桶是否已有故事（用于自动触发去重）。 */
export function hasStory(floor: number, bucket: Bucket): boolean {
  return getStories(floor, bucket).length > 0;
}

/** 追加一条故事。lines 为空时不写该字段。 */
export function saveStory(floor: number, bucket: Bucket, story: BbiStatusInfo): boolean {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[THEATER_KEY]);
  const clean: BbiStatusInfo = {
    ...story,
    ...(story.lines && story.lines.length ? { lines: story.lines } : { lines: undefined }),
  };
  store.buckets[bucket].push(clean);
  return writeStore(floor, store);
}

/** 删除某条故事（按 storyId）。 */
export function removeStory(floor: number, bucket: Bucket, storyId: string): boolean {
  const msg = getMessage(floor);
  if (!msg?.extra) return false;
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[THEATER_KEY]);
  const before = store.buckets[bucket].length;
  store.buckets[bucket] = store.buckets[bucket].filter(s => s.storyId !== storyId);
  if (store.buckets[bucket].length === before) return false;
  return writeStore(floor, store);
}

/** 生成故事 ID。 */
export function newStoryId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 从 lines 里提取说话人名字（用于角色快照匹配）。 */
export function speakersOf(lines?: StatusLine[]): string[] {
  if (!lines) return [];
  const set = new Set<string>();
  for (const line of lines) {
    if (line.speaker && line.speaker !== '旁白') set.add(line.speaker);
  }
  return [...set];
}
