/**
 * ST-Story-Illustrator — 台词 100% 原文引用（纯函数）
 *
 * 任务书 §8 / 用户实测 A：台词被改写。根因是旧链路让 LLM「写一条不超过 20 字的
 * 中文口语」，于是模型凭记忆重写原文——改写、纠错、缩写、改标点全都会发生。
 *
 * 这一版把台词从「生成式文本」改成「引用式数据」：
 * 1. resolveSourceDialogue：从用户划线的选段里逐字抽出候选台词（带序号），发 LLM 时
 *    只允许它引用序号（sourceIndex），不许自带 text；
 * 2. reconcileDialogueWithSource：出图前按 sourceIndex / 逐字命中，把台词换回原文里的
 *    那一串字符；匹配不上的整条丢弃——宁可少一句，也不画一句改写的。
 *
 * 保证：气泡里 final text 一定是 selectedText 里出现过的逐字片段。
 * 不做任何 trim / 标点修正 / 合并 / 拆分（UI 显示层的视觉处理不在这里）。
 */

import type { ComicDialogue } from '../types';

/** 从选段抽出的一句原文台词。index 是它在候选表里的稳定序号。 */
export interface SourceDialogueLine {
  index: number;
  /** 逐字原文切片，保留原文里的标点与空白，绝不加工。 */
  text: string;
  /** 猜测的说话人（引号前的「XX说：」），仅用于帮 LLM 对号，不画进气泡。 */
  speaker?: string;
}

/** 中文/英文引号的配对，用于抽出「……」里的台词。 */
const QUOTE_PAIRS: Array<[string, string]> = [
  ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ['「', '」'],
];

/** 一句台词的最短/最长长度（太短多是语气词，太长塞不进气泡）。 */
const MIN_LEN = 2;
const MAX_LEN = 120;

/**
 * 去掉一段话里的结构空白，但**不动字符本身**——只用于判断候选是否有效，
 * 不会写回 text。
 */
function meaningful(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_LEN && trimmed.length <= MAX_LEN
    && /[^\s，。,.!！?？、；;：:]/.test(trimmed);
}

/** 从「XX（副词）说道：」的引号前文里猜说话人（最多 12 字，避免吞进正文）。 */
function speakerBefore(source: string, quoteStart: number): string | undefined {
  const before = source.slice(Math.max(0, quoteStart - 24), quoteStart);
  // 允许「低声 / 轻声 / 笑着」这类副词夹在人名与「说/道」之间
  const m = before.match(
    /([^\s「」『』“”‘’，。！？!?\n]{1,12}?)\s*(?:低声|轻声|笑着|笑道|冷声|柔声|缓缓|突然|连忙|立即|又|才|也|便)?\s*(?:说道|说|道|问|答|喊|开口|嘟囔|呢喃)[:：，,]?\s*$/,
  );
  return m ? m[1] : undefined;
}

/**
 * 逐字抽取选段里的台词候选。
 * 优先取引号内的内容；同一段没有任何引号时，才退到按行/句末标点切分。
 * 返回顺序 = 原文出现顺序（稳定序号就是数组下标）。
 */
export function resolveSourceDialogue(rawText: unknown): SourceDialogueLine[] {
  const source = String(rawText ?? '');
  if (!source.trim()) return [];

  const found: Array<{ start: number; text: string; speaker?: string }> = [];
  const claimed: Array<[number, number]> = [];

  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    while (from < source.length) {
      const openAt = source.indexOf(open, from);
      if (openAt < 0) break;
      const closeAt = source.indexOf(close, openAt + open.length);
      if (closeAt < 0) break;
      const text = source.slice(openAt + open.length, closeAt);
      const span: [number, number] = [openAt, closeAt + close.length];
      // 不同引号对可能重叠（例如英文引号套中文引号），只认第一次命中
      if (meaningful(text) && !claimed.some(([a, b]) => a < span[1] && span[0] < b)) {
        found.push({ start: openAt, text, ...(speakerBefore(source, openAt) ? { speaker: speakerBefore(source, openAt) } : {}) });
        claimed.push(span);
      }
      from = closeAt + close.length;
    }
  }

  // 没有引号台词：退到逐行（台词小说常一行一句对话）
  if (found.length === 0) {
    for (const line of source.split(/\r?\n/)) {
      const text = line.trim();
      if (meaningful(text)) found.push({ start: source.indexOf(text), text });
    }
  }

  return found
    .sort((a, b) => a.start - b.start)
    .slice(0, 16)
    .map((item, i) => ({ index: i, ...item }));
}

/** 只保留字与数字，用来做「标点/空格差异」的等价比较。 */
function skeleton(text: string): string {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 判断 LLM 写回的 text 是否就是原文某一句。
 *
 * 两级判定：
 * 1. 逐字包含（含整句截断）；
 * 2. 去掉标点/空白后包含 —— 模型回述时最常见的是弄丢「」或把逗号改成句号，
 *    这种差异不该让整句台词消失（用户实测：台词全没了）。
 * 仍然要求「一方完整包含另一方」，不把两个词凑成一句也算命中。
 */
function exactMatch(text: string, lines: readonly SourceDialogueLine[]): SourceDialogueLine | undefined {
  const a = text.trim();
  if (!a) return undefined;
  const direct = lines.find(line => {
    const b = line.text.trim();
    return a === b || a.includes(b) || b.includes(a);
  });
  if (direct) return direct;
  const sa = skeleton(a);
  if (sa.length < 2) return undefined;
  return lines.find(line => {
    const sb = skeleton(line.text);
    return sb.length >= 2 && (sa === sb || sa.includes(sb) || sb.includes(sa));
  });
}

/**
 * 把 LLM 的台词引用回填成原文逐字字符串。
 *
 * success 条件（任一）：
 * - `sourceIndex` 合法 → 用 lines[index].text；
 * - `quote` / `text` 与某句原文逐字命中 → 用那一句原文。
 * 否则丢弃此条（返回 false），保证输出里不会出现改写过的字。
 * speaker / area / panel / x / y / dir / mood 等排版字段原样保留。
 */
export interface ReconcileResult {
  dialogue: ComicDialogue[];
  /** 回填成原文的条数 */
  restored: number;
  /** 在原文里找不到出处、被丢弃的条数 */
  dropped: number;
  /** 没有任何原文候选（选段里抽不到台词），此时保留模型稿 */
  noSource: boolean;
}

/**
 * 回填 + 统计。`reconcileDialogueWithSource` 的详细版，供上层记日志与提示。
 *
 * 两种兜底，都是为了「台词不能整页消失」：
 * - 选段里抽不到任何引号台词（noSource）→ 没有可比对的原文，保留模型稿；
 * - 有原文但这一条匹配不上 → 丢弃（宁可少一句，也不画改写的字）。
 */
export function reconcileDialogueDetailed(
  dialogue: readonly ComicDialogue[] | undefined,
  lines: readonly SourceDialogueLine[],
): ReconcileResult {
  if (!Array.isArray(dialogue) || !dialogue.length) {
    return { dialogue: [], restored: 0, dropped: 0, noSource: lines.length === 0 };
  }
  const noSource = lines.length === 0;
  const out: ComicDialogue[] = [];
  let restored = 0;
  let dropped = 0;
  for (const item of dialogue) {
    if (!item || typeof item.text !== 'string') continue;
    const raw = item as ComicDialogue & { sourceIndex?: number; quote?: string; exactText?: string };
    const { sourceIndex: _si, quote: _q, exactText: _e, ...rest } = raw;
    const text = String(rest.text ?? '').trim();
    if (noSource) {
      // 没有原文可比对：text 是唯一内容，空的就丢
      if (!text) continue;
      out.push({ ...rest, text });
      continue;
    }
    let line: SourceDialogueLine | undefined;
    if (typeof raw.sourceIndex === 'number' && Number.isInteger(raw.sourceIndex)) {
      line = lines[raw.sourceIndex];
    }
    // text 只是定位用：允许模型省略 text 只给 sourceIndex
    if (!line && !text) continue;
    if (!line) line = exactMatch(raw.quote ?? raw.exactText ?? text, lines);
    if (!line) {
      dropped += 1;
      continue;
    }
    restored += 1;
    out.push({ ...rest, text: line.text });
  }
  return { dialogue: out, restored, dropped, noSource };
}

/**
 * 把 LLM 的台词引用回填成原文逐字字符串。
 *
 * success 条件（任一）：
 * - `sourceIndex` 合法 → 用 lines[index].text；
 * - `quote` / `text` 与某句原文逐字（或去标点后）命中 → 用那一句原文。
 * 否则丢弃此条（返回 false），保证输出里不会出现改写过的字。
 * speaker / area / panel / x / y / dir / mood 等排版字段原样保留。
 */
export function reconcileDialogueWithSource(
  dialogue: readonly ComicDialogue[] | undefined,
  lines: readonly SourceDialogueLine[],
): ComicDialogue[] {
  return reconcileDialogueDetailed(dialogue, lines).dialogue;
}

/**
 * 生成注入 LLM 的「可选台词原文」块。
 * 明确告诉模型：text 只是标识，最终画的是这里的原文；引用序号最稳。
 */
export function sourceDialogueBlock(lines: readonly SourceDialogueLine[]): string {
  if (!lines.length) return '';
  const list = lines
    .map(l => `${l.index}: ${l.speaker ? `[${l.speaker}] ` : ''}${l.text}`)
    .join('\n');
  return [
    '【本页可选台词原文（逐字引用，禁止改写/纠错/缩写/合并/翻译）】',
    list,
    'dialogue 里每条用 sourceIndex 引用上面的序号；text 字段可省略（写了也只作定位，最终以这里的原文为准）。',
    '只能引用本段确实出现的话；没有合适的就少写或留空，绝对不要自己编台词。',
  ].join('\n');
}
