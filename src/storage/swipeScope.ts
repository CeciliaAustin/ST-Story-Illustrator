/**
 * ST-Story-Illustrator — 作品与 swipe 的对齐
 *
 * SillyTavern 的 swipe 只替换 `message.mes` 与 `message.swipes[swipe_id]`，
 * **不会清空 `message.extra`**。本插件把作品存在 `message.extra.sti_artifacts`，
 * 于是「上一版正文里画好的漫画」天然会跟着新正文一起显示——这就是用户看到的
 * 「swipe 之后旧漫画页还在」。
 *
 * 正确做法不是删数据（用户 swipe 回去还要看到），而是**按 swipe 对齐**：
 * 生成时记下生成那一版的 swipe 序号，显示时只挂属于当前 swipe 的作品。
 *
 * 老数据（升级前生成）没有 swipeId，无从判定归属，按下面的降级规则处理——
 * 宁可少判，也不要把用户单 swipe 聊天里已有的图全藏掉。
 */

import type { VisualArtifact } from '../types';

export interface SwipeScope {
  /** 楼层当前的 swipe 序号（`message.swipe_id`） */
  currentSwipe: number;
  /** 当前 swipe 正文里 `<bbi_manwa>` 指向的作品 id */
  taggedIds: ReadonlySet<string>;
  /** 楼层一共有几条 swipe（1 = 没分叉过） */
  swipeCount: number;
}

/** 作品的归属 swipe：优先顶层字段，兼容早期写在 metadata 里的。 */
export function artifactSwipeId(artifact: VisualArtifact): number | undefined {
  const direct = artifact.swipeId;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;
  const nested = artifact.metadata?.swipeId;
  if (typeof nested === 'number' && Number.isFinite(nested) && nested >= 0) return nested;
  return undefined;
}

/**
 * 这条作品该不该出现在当前 swipe 上。
 *
 * 判定顺序（从确定到保守）：
 * 1. 有 swipeId → 严格相等，这是唯一确定的信息；
 * 2. 当前正文里有它的 `<bbi_manwa>` → 必然属于当前 swipe（tag 是写进 `swipes[i]` 的）；
 * 3. 当前 swipe 已经有自己的漫画 tag，但没指向它 → 这条是老 swipe 的，藏；
 * 4. 这楼只有一条 swipe → 不存在残留问题，显示；
 * 5. 还有别的判断不了的：只在第一条 swipe 显示（切回去能看见，不至于丢图）。
 */
export function belongsToSwipe(artifact: VisualArtifact, scope: SwipeScope): boolean {
  const owned = artifactSwipeId(artifact);
  if (owned !== undefined) return owned === scope.currentSwipe;
  if (scope.taggedIds.has(artifact.id)) return true;
  if (scope.taggedIds.size > 0) return false;
  if (scope.swipeCount <= 1) return true;
  return scope.currentSwipe === 0;
}
