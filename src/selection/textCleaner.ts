/**
 * 文本清理器
 *
 * 从 ST chat 消息的 mes 字段提取纯剧情文本。
 * 清理 HTML、已有生图标签（<bbi_image>）与插件元数据，不得误删正文。
 */

// ============================================================
// 常量
// ============================================================

/** 已知生图标签正则 */
const BBI_IMAGE_TAG_RE = /<bbi_image[\s\S]*?<\/bbi_image>/gi;

/** 已知插件子标签正则 */
const DIALOGUE_SUBTAG_RE = /<dialogue>[\s\S]*?<\/dialogue>/gi;

/** HTML 标签正则 */
const HTML_TAG_RE = /<[^>]+>/g;

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
// 文本清理
// ============================================================

/**
 * 从 ST chat 消息的 mes 字段提取纯文本。
 *
 * 步骤：
 * 1. 移除 <bbi_image>...</bbi_image> 标签（含 <dialogue> 子标签）
 * 2. 移除独立 <dialogue>...</dialogue> 子标签
 * 3. 去除 HTML 标签（保留内部文本）
 * 4. 解码 HTML 实体
 * 5. 压缩空白
 *
 * 不得误删正文内容。
 */
export function cleanMessageText(mes: string | undefined): string {
  if (!mes || typeof mes !== 'string') return '';

  let text = mes;

  // 1. 移除生图标签（整体移除，不保留内容）
  text = text.replace(BBI_IMAGE_TAG_RE, ' ');

  // 2. 移除独立对白子标签
  text = text.replace(DIALOGUE_SUBTAG_RE, ' ');

  // 3. 去 HTML 标签（保留标签内文本）
  // <br> / <p> 转换为换行
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p\s*>/gi, '\n');
  text = text.replace(HTML_TAG_RE, ' ');

  // 4. 解码 HTML 实体
  text = decodeHtmlEntities(text);

  // 5. 压缩空白（保留换行作为消息边界）
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

/**
 * 解码常见 HTML 实体。
 */
function decodeHtmlEntities(text: string): string {
  // 先处理数字实体
  text = text.replace(/&#(\d+);/g, (_, code: string) => {
    const num = parseInt(code, 10);
    if (num > 0 && num <= 0x10FFFF) {
      try {
        return String.fromCodePoint(num);
      } catch {
        return '';
      }
    }
    return '';
  });
  // 再处理十六进制实体
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
    const num = parseInt(hex, 16);
    if (num > 0 && num <= 0x10FFFF) {
      try {
        return String.fromCodePoint(num);
      } catch {
        return '';
      }
    }
    return '';
  });
  // 命名实体
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(char);
  }
  return text;
}

/**
 * 判断消息是否是 system / narrator 等非剧情消息。
 *
 * ST 中 system 消息的 is_system 为 true，或者 name 为 "system" / "narrator"。
 */
export function isSystemMessage(msg: {
  is_system?: boolean;
  name?: string;
  extra?: Record<string, unknown>;
}): boolean {
  if (msg.is_system === true) return true;
  const name = (msg.name ?? '').toLowerCase().trim();
  if (name === 'system' || name === 'narrator') return true;
  // 检查 extra.type
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
