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

/** 生成一次生成（N 格）共用的 setId。 */
export function newSetId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ============================================================
// 卡片分组（一次生成的 N 格 → 一张卡片）
// ============================================================

export interface TheaterSet {
  setId: string;
  kind: Bucket;
  title: string;
  cast: string[];
  mood: string;
  /** 按 index 升序 */
  panels: BbiStatusInfo[];
  /** 整条重出用 */
  sourceText: string;
  characterName: string;
  createdAt: number;
}

/** 把某桶里的格按 setId 归组成卡片，保持落盘顺序（新的在前不倒序，与落盘一致）。 */
export function getSets(floor: number, bucket: Bucket): TheaterSet[] {
  const list = getStories(floor, bucket);
  const order: string[] = [];
  const map = new Map<string, BbiStatusInfo[]>();

  for (const story of list) {
    const key = story.setId && story.setId.trim() ? story.setId : `single-${story.storyId}`;
    if (!map.has(key)) { map.set(key, []); order.push(key); }
    map.get(key)!.push(story);
  }

  const sets: TheaterSet[] = [];
  for (const key of order) {
    const panels = (map.get(key) ?? []).slice().sort((a, b) => a.index - b.index);
    const first = panels[0];
    if (!first) continue;
    const cast = dedupe(panels.flatMap(p => p.cast ?? []));
    const mood = panels.map(p => p.mood).find(m => !!m) ?? '';
    sets.push({
      setId: key,
      kind: bucket,
      title: first.setTitle ?? first.title ?? '',
      cast,
      mood,
      panels,
      sourceText: first.sourceText ?? '',
      characterName: first.characterName ?? '',
      createdAt: first.storyAt ?? 0,
    });
  }
  return sets;
}

/** 一次生成的整组格一起落盘（共用 setId 与标题信息）。 */
export function saveSet(floor: number, bucket: Bucket, stories: BbiStatusInfo[]): boolean {
  if (stories.length === 0) return false;
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[THEATER_KEY]);
  for (const story of stories) {
    store.buckets[bucket].push({
      ...story,
      ...(story.lines && story.lines.length ? { lines: story.lines } : { lines: undefined }),
    });
  }
  return writeStore(floor, store);
}

/** 改某一格（重画这张用）。 */
export function updatePanel(
  floor: number,
  bucket: Bucket,
  setId: string,
  index: number,
  patch: Partial<BbiStatusInfo>,
): boolean {
  const msg = getMessage(floor);
  if (!msg?.extra) return false;
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[THEATER_KEY]);
  const list = store.buckets[bucket];
  const at = list.findIndex(s => s.setId === setId && s.index === index);
  if (at < 0) return false;
  list[at] = { ...list[at], ...patch };
  return writeStore(floor, store);
}

/** 整条重出：用同一 setId 替换整组格（顺序与格数可变）。 */
export function replaceSet(floor: number, bucket: Bucket, setId: string, stories: BbiStatusInfo[]): boolean {
  const msg = getMessage(floor);
  if (!msg?.extra) return false;
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[THEATER_KEY]);
  const kept = store.buckets[bucket].filter(s => s.setId !== setId);
  // 替换后插回原位置：找原第一条的索引
  const firstAt = store.buckets[bucket].findIndex(s => s.setId === setId);
  const merged = kept.slice();
  const insertAt = firstAt < 0 ? merged.length : Math.min(firstAt, merged.length);
  merged.splice(insertAt, 0, ...stories.map(s => ({
    ...s,
    ...(s.lines && s.lines.length ? { lines: s.lines } : { lines: undefined }),
  })));
  store.buckets[bucket] = merged;
  return writeStore(floor, store);
}

/** 删除整条卡片。 */
export function removeSet(floor: number, bucket: Bucket, setId: string): boolean {
  const msg = getMessage(floor);
  if (!msg?.extra) return false;
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[THEATER_KEY]);
  const before = store.buckets[bucket].length;
  store.buckets[bucket] = store.buckets[bucket].filter(s => s.setId !== setId);
  if (store.buckets[bucket].length === before) return false;
  return writeStore(floor, store);
}

function dedupe(list: string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const v = String(item ?? '').trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
  }
  return out;
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
