/**
 * 文本清理器
 *
 * 从 ST chat 消息的 mes 字段提取纯剧情文本。
 * 清洗口径与柏宝绘/柏宝书 cleanBody 同步：
 * - 排除思维链 <think>/<thinking>、HTML 注释、<horae> 块
 * - 排除柏宝绘共享设置里配置的自定义标签（customStripTags）
 * - 排除 bbs_items / bbs_vars 托管旁注、bbs_start/bbs_end 时间标签
 * - 排除已有生图标签 <bbi_image>（含 <dialogue>/<nl>/<negative> 子标签）
 * - 保留正文，不误删
 *
 * 「提取模式」：若正文里存在 <content>...</content>（思维链插件常把正文放进此标签），
 * 可只提取 content 内部文本——用于「排除+提取」双管齐下。
 */

import { getSyncedStripTags } from './baiBaiExcludes';

// ============================================================
// 常量
// ============================================================

/** 思维链块 */
const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;

/** HTML 注释 */
const RE_HTML_COMMENT = /<!--[\s\S]+?-->/g;

/** horae 块 */
const RE_HORAE = /<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi;

/** 已有生图标签（整体移除） */
const BBI_IMAGE_TAG_RE = /<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>/gi;

/** content 块（提取模式用） */
const RE_CONTENT_BLOCK = /<content\b[^>]*>([\s\S]*?)<\/content>/gi;

/** HTML 实体解码映射 */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&#x27;': "'",
};

// ============================================================
// 标签块删除（与柏宝绘 clean.ts 同口径）
// ============================================================

/**
 * 按标签名生成「整块删除」正则（含标签本身与内部内容）。
 * 边界用前瞻 (?=[\s/>]) 而非 \b —— 中文标签（如 <雪>）在 `雪` 与 `>` 之间无词边界，
 * 前瞻对中英文都成立，并防止 <snow> 误吃 <snowball>。
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'),
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'),
  ];
}

function stripTagsByNames(s: string, tags: string[]): string {
  let out = s;
  for (const tag of tags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, '');
  }
  return out;
}

/** 托管旁注块（开/闭标签独占行配对） */
function stripManagedBlock(s: string, tag: string): string {
  const openRe = new RegExp(`^[ \\t]*<${tag}\\b[^>]*>[ \\t]*$`, 'm');
  const closeRe = new RegExp(`^[ \\t]*</${tag}>[ \\t]*$`, 'm');
  let out = s;
  let open: RegExpMatchArray | null;
  let guard = 0;
  while ((open = out.match(openRe)) && guard++ < 100) {
    const start = open.index ?? 0;
    const rest = out.slice(start + open[0].length);
    const close = rest.match(closeRe);
    if (!close) {
      out = out.slice(0, start) + out.slice(start + open[0].length);
      continue;
    }
    const end = start + open[0].length + (close.index ?? 0) + close[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

// ============================================================
// 主清洗入口
// ============================================================

export interface CleanOptions {
  /** 同步柏宝绘的自定义标签排除（默认 true） */
  syncBaiBai?: boolean;
  /** 提取模式：正文含 <content> 时只取其中内容（默认 false） */
  preferContent?: boolean;
  /** 额外要排除的标签名 */
  extraStripTags?: string[];
}

/**
 * 从 ST chat 消息的 mes 字段提取纯剧情文本。
 *
 * 步骤：
 * 1. 若开启提取模式且存在 <content>，先取 content 内部文本
 * 2. 移除 bbi_image / thinking / 注释 / horae / 自定义标签 / 托管旁注 / 时间标签
 * 3. 去 HTML 标签（br/p 转换行）
 * 4. 解码 HTML 实体
 * 5. 压缩空白
 */
export function cleanMessageText(mes: string | undefined, options: CleanOptions = {}): string {
  if (!mes || typeof mes !== 'string') return '';

  const { syncBaiBai = true, preferContent = false, extraStripTags = [] } = options;
  let text = mes;

  // 1. 提取模式：content 优先
  if (preferContent) {
    const blocks: string[] = [];
    text = text.replace(RE_CONTENT_BLOCK, (_m, inner: string) => {
      blocks.push(inner);
      return '\n';
    });
    if (blocks.length > 0) {
      text = blocks.join('\n\n');
    }
  }

  // 2. 生图标签整体移除（正文不该出现插画 tag）
  text = text.replace(BBI_IMAGE_TAG_RE, '');

  // 3. 思维链 / 注释 / horae
  text = text.replace(RE_THINK_BLOCK, '');
  text = text.replace(RE_HTML_COMMENT, '');
  text = text.replace(RE_HORAE, '');

  // 4. 自定义标签（柏宝绘同步 + 额外）
  const tags = [
    ...(syncBaiBai ? getSyncedStripTags() : []),
    'bbs_items',
    'bbs_vars',
    'bbs_start',
    'bbs_end',
    ...extraStripTags,
  ];
  text = stripTagsByNames(text, tags);

  // 5. 托管旁注（独占行配对）
  text = stripManagedBlock(text, 'bbs_items');
  text = stripManagedBlock(text, 'bbs_vars');

  // 6. 去 HTML 标签（br/p 转换行）
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');

  // 7. 解码实体
  text = decodeHtmlEntities(text);

  // 8. 压缩空白
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

/** 解码常见 HTML 实体。 */
function decodeHtmlEntities(text: string): string {
  text = text.replace(/&#(\d+);/g, (_, code: string) => {
    const num = parseInt(code, 10);
    if (num > 0 && num <= 0x10FFFF) {
      try { return String.fromCodePoint(num); } catch { return ''; }
    }
    return '';
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
    const num = parseInt(hex, 16);
    if (num > 0 && num <= 0x10FFFF) {
      try { return String.fromCodePoint(num); } catch { return ''; }
    }
    return '';
  });
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(char);
  }
  return text;
}

/**
 * 判断消息是否是 system / narrator 等非剧情消息。
 */
export function isSystemMessage(msg: {
  is_system?: boolean;
  name?: string;
  extra?: Record<string, unknown>;
}): boolean {
  if (msg.is_system === true) return true;
  const name = (msg.name ?? '').toLowerCase().trim();
  if (name === 'system' || name === 'narrator') return true;
  const extraType = msg.extra?.type;
  if (typeof extraType === 'string' && (extraType === 'system' || extraType === 'narrator')) {
    return true;
  }
  return false;
}

/**
 * 判断消息是否是有效剧情消息（有文本且非系统）。
 */
export function isStoryMessage(msg: {
  mes?: string;
  is_system?: boolean;
  name?: string;
  extra?: Record<string, unknown>;
}): boolean {
  if (isSystemMessage(msg)) return false;
  const text = cleanMessageText(msg.mes);
  return text.length > 0;
}
