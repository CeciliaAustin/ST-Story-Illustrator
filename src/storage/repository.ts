/**
 * ST-Story-Illustrator — 作品持久化仓库
 *
 * 把 VisualArtifact 存进 message.extra 的独立命名空间（不污染柏宝绘的 bbi_*），
 * 元数据索引存进 chat_metadata。含 schema 版本迁移。
 *
 * 存储分离（DESIGN_NOTES.md）：
 * - 图片文件：柏宝绘图库（save=true）或 dataUrl
 * - 元数据：message.extra.sti_artifacts[]
 * - 任务索引：chat_metadata.STStoryIllustrator.tasks
 */

import type { VisualArtifact } from '../types';
import { getMessage, getChatMetadata, saveChatMetadata } from '../host/sillytavern';

// ============================================================
// 常量与命名空间
// ============================================================

const ARTIFACTS_KEY = 'sti_artifacts';
const CHAT_META_KEY = 'STStoryIllustrator';
const SCHEMA_VERSION = 1;

interface ArtifactStore {
  version: number;
  artifacts: VisualArtifact[];
}

interface ChatTaskIndex {
  version: number;
  updatedAt: number;
  count: number;
}

// ============================================================
// 消息级 artifact 读写
// ============================================================

function readStore(raw: unknown): ArtifactStore {
  if (!raw || typeof raw !== 'object') return { version: SCHEMA_VERSION, artifacts: [] };
  const store = raw as Partial<ArtifactStore>;
  const version = typeof store.version === 'number' ? store.version : 0;
  const artifacts = Array.isArray(store.artifacts)
    ? store.artifacts.filter((a): a is VisualArtifact => !!a && typeof a === 'object')
    : [];
  return migrate({ version, artifacts });
}

/** schema 迁移：逐个把旧 artifact 补齐必需字段，不丢数据。 */
function migrate(store: ArtifactStore): ArtifactStore {
  if (store.version >= SCHEMA_VERSION) return store;
  const artifacts = store.artifacts.map(a => ({
    ...a,
    mountMode: a.mountMode ?? 'trailing' as VisualArtifact['mountMode'],
    metadata: a.metadata ?? {},
    sourceFloors: a.sourceFloors ?? [],
    createdAt: a.createdAt ?? 0,
  }));
  return { version: SCHEMA_VERSION, artifacts };
}

/** 读取某楼层的所有作品。同步读（message.extra 在内存里），无 API 请求。 */
export function getArtifacts(floor: number): VisualArtifact[] {
  const msg = getMessage(floor);
  if (!msg) return [];
  const extra = (msg.extra ?? {}) as Record<string, unknown>;
  return readStore(extra[ARTIFACTS_KEY]).artifacts;
}

/**
 * 追加作品到楼层。直接写入 message.extra（ST 内存对象），调用方随后触发保存。
 * 返回是否写入成功。
 */
export function appendArtifact(floor: number, artifact: VisualArtifact): boolean {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[ARTIFACTS_KEY]);
  store.artifacts.push(artifact);
  store.version = SCHEMA_VERSION;
  extra[ARTIFACTS_KEY] = store;
  touchChatIndex();
  return true;
}

/** 删除某条作品（按 id）。 */
export function removeArtifact(floor: number, artifactId: string): boolean {
  const msg = getMessage(floor);
  if (!msg?.extra) return false;
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[ARTIFACTS_KEY]);
  const next = store.artifacts.filter(a => a.id !== artifactId);
  if (next.length === store.artifacts.length) return false;
  store.artifacts = next;
  extra[ARTIFACTS_KEY] = store;
  touchChatIndex();
  return true;
}

/** 更新某条作品（按 id）。 */
export function updateArtifact(floor: number, artifactId: string, patch: Partial<VisualArtifact>): boolean {
  const msg = getMessage(floor);
  if (!msg?.extra) return false;
  const extra = msg.extra as Record<string, unknown>;
  const store = readStore(extra[ARTIFACTS_KEY]);
  let found = false;
  store.artifacts = store.artifacts.map(a => {
    if (a.id !== artifactId) return a;
    found = true;
    return { ...a, ...patch };
  });
  if (!found) return false;
  extra[ARTIFACTS_KEY] = store;
  touchChatIndex();
  return true;
}

/** 统计当前聊天里的作品总数（写索引，供 UI 显示/对账）。 */
export function getArtifactCount(): number {
  const index = getChatMetadata<ChatTaskIndex>(CHAT_META_KEY, { version: SCHEMA_VERSION, updatedAt: 0, count: 0 });
  return index.count ?? 0;
}

function touchChatIndex(): void {
  const index = getChatMetadata<ChatTaskIndex>(CHAT_META_KEY, { version: SCHEMA_VERSION, updatedAt: 0, count: 0 });
  saveChatMetadata(CHAT_META_KEY, {
    version: SCHEMA_VERSION,
    updatedAt: Date.now(),
    count: (index.count ?? 0) + 1,
  });
}

// ============================================================
// 辅助：创建 artifact
// ============================================================

let seq = 0;
export function createArtifactId(): string {
  seq += 1;
  return `sti-${Date.now().toString(36)}-${seq.toString(36)}`;
}
