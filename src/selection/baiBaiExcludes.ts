/**
 * 柏宝绘排除设置桥接（只读）
 *
 * 柏宝绘把跨插件共享的「排除设置」真身存在 ST 的
 * extensionSettings['baibai_exclude_settings'] 里，镜像在
 * settings.excludes（四张名单）。本模块只读其中与正文清洗相关的
 * customStripTags，让本插件的选段清洗与柏宝绘/柏宝书同口径。
 *
 * 只读、不写、不订阅；读不到时安全降级为空名单。
 */

/** 共享存储键（与柏宝绘 architecture.md §共享存储 一致） */
const SHARED_EXCLUDES_KEY = 'baibai_exclude_settings';

/** 内置默认条目名规则（共享存储创建时播种，只发一次） */
const DEFAULT_STRIP_TAGS: string[] = ['\\[mvu[\\s\\S]*?\\]'];

/** getContext 返回的运行时上下文（只取需要的字段） */
interface StRuntimeContext {
  extensionSettings?: Record<string, unknown>;
}

/**
 * 读取与柏宝绘同步的自定义清洗标签名列表。
 * 返回的是「标签名」（不含尖括号），例如 ['think', 'status', '雪']。
 *
 * 读取路径：globalThis.getContext().extensionSettings['baibai_exclude_settings']
 *   → 兼容直接存 { customStripTags } 与带 revision 的镜像两种形态。
 */
export function getBaiBaiCustomStripTags(): string[] {
  const ctx = getRuntimeContext();
  if (!ctx) return [];
  const ext = ctx.extensionSettings;
  if (!ext) return [];

  const raw = ext[SHARED_EXCLUDES_KEY];
  if (!raw || typeof raw !== 'object') return [];

  const store = raw as Record<string, unknown>;
  // 真身可能是 { customStripTags: [...] }，也可能是 { excludes: { customStripTags } } 镜像
  const direct = store.customStripTags;
  const mirrored = (store.excludes as Record<string, unknown> | undefined)?.customStripTags;
  const source = Array.isArray(direct) ? direct : (Array.isArray(mirrored) ? mirrored : null);

  if (!source) return [];
  const tags = source.filter((t): t is string => typeof t === 'string' && t.length > 0);
  return tags.length ? tags : [];
}

/**
 * 清洗用的完整标签名名单：内置默认 + 柏宝绘同步。
 * 去重，保持顺序（内置在前）。
 */
export function getSyncedStripTags(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...DEFAULT_STRIP_TAGS, ...getBaiBaiCustomStripTags()]) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function getRuntimeContext(): StRuntimeContext | null {
  const g = globalThis as Record<string, unknown>;
  const fn = g.getContext;
  if (typeof fn !== 'function') return null;
  try {
    const ctx = (fn as () => StRuntimeContext | undefined)();
    return ctx && typeof ctx === 'object' ? ctx : null;
  } catch {
    return null;
  }
}
