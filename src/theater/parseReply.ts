/**
 * ST-Story-Illustrator — 小剧场读剧情响应解析（纯函数）
 *
 * 移植自文档 §3.2/3.3：tag 清洗 + 容忍式 JSON 解析。
 * 坏 JSON 丢弃、不连累整条；旧格式兼容；超额/去重/清洗。
 */

import type { StatusFrame, StatusLook, StatusOutfit, StatusReading, StatusLine, StatusRole, StoryKind } from '../types';
import { stripThinkingBlocks } from '../prompt/think';

export const STATUS_MAX_CHARACTERS = 2;
export const STATUS_MAX_PANELS = 4;
export const STATUS_MAX_LINES = 4;

const STYLE_BLOCKLIST = [
  'masterpiece', 'best quality', 'high quality', 'highly detailed', 'ultra detailed',
  'absurdres', '8k', '4k', 'photorealistic', 'realistic', 'photo', 'cinematic',
  'depth of field', 'chibi', 'anime style', 'illustration', 'lineart', 'flat color',
  'cel shading', 'full body', 'cowboy shot', 'wide shot', 'from below', 'foreshortening',
];

/**
 * 景别词：黑白漫的读剧情提示词**要求模型自己挑一个景别**（交代环境要 wide shot、
 * 情绪要 close-up）。但状态栏那套清洗表把它们全当画风词删了——于是黑白漫每一格
 * 都退化成同一句「cowboy shot」，四格看着像同一张图复制了几遍。
 * 所以漫画链路要放行景别，并且只留**第一个**（文档：景别整页只写一个，
 * 写两个会互相拉扯，画面被折中成半身像）。
 */
const FRAMING_TAGS = [
  'extreme close-up', 'close-up', 'closeup', 'upper body', 'cowboy shot', 'full body',
  'wide shot', 'medium shot', 'from above', 'from below', 'from side', 'dutch angle',
];

/**
 * 漫画链路额外要拦的词：黑白/网点/分格线都归画师串与方案管，
 * 提示词里再写一遍只会和画师串打架（文档 §2.5：「写了只会和它打架」）。
 */
const MANGA_STYLE_BLOCKLIST = [
  'screentone', 'greyscale', 'grayscale', 'monochrome', 'black and white',
  'speech bubble', 'caption', 'comic panel', 'panel layout', 'thought bubble',
];

const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const MAX_TAGS = 14;
/** 漫画链路放宽：动作+道具+景别+人数，14 条经常把动作挤掉。 */
const MAX_TAGS_MANGA = 20;

export interface SanitizeOptions {
  /** 放行景别词（黑白漫/漫画链路用），并且只保留一个。 */
  allowFraming?: boolean;
  maxTags?: number;
}

function framingOf(tag: string): string {
  const hit = FRAMING_TAGS.find(word => tag === word || tag.includes(word));
  return hit ?? '';
}

/** tag 清洗：去掉权重写法、挡掉画风词、去中文、去重、限额。 */
export function sanitizeStatusTags(raw: string, options: SanitizeOptions = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const maxTags = options.maxTags ?? MAX_TAGS;
  let keptFraming = '';
  for (const piece of String(raw ?? '').split(/[,，、\n]/)) {
    let tag = piece.trim().toLowerCase();
    if (!tag) continue;
    tag = tag.replace(/^\(?\s*[\d.]+::/, '').replace(/::$/, '').replace(/^\(|\)$/g, '');
    tag = tag.replace(/:\s*[\d.]+$/, '').trim();
    if (!tag || HAS_CJK.test(tag)) continue;
    const framing = framingOf(tag);
    if (options.allowFraming && framing) {
      // 只留第一个景别；后面的丢掉（两个景别会把画面折中成半身像）
      if (keptFraming) continue;
      keptFraming = framing;
    } else if (
      STYLE_BLOCKLIST.some(word => tag === word || tag.includes(word))
      || (options.allowFraming && MANGA_STYLE_BLOCKLIST.some(word => tag === word || tag.includes(word)))
    ) {
      continue;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= maxTags) break;
  }
  return out;
}

function emptyFrame(): StatusFrame {
  return { title: '', characters: [], roles: [], mood: '', tags: '', nl: '' };
}

const MAX_OUTFIT_CHARS = 160;

/**
 * 「本批服装」：模型在顶层 `cast[].outfit` 里给每个角色定**一次**着装，
 * 出图时由代码逐字拼进每一格的角色块。
 *
 * 为什么要代码兜这一层：同一批四格是一次 LLM 输出，但模型对每一格会重新"想"一遍
 * 衣服（白衬衫 / 灰衬衫 / 校服），而 NAI 每格是独立请求，没人替它记住上一格。
 * 服装一致性靠提示词只是软约束；这里把它冻成同一串词，才是硬的。
 */
export function parseOutfits(record: Record<string, unknown>): StatusOutfit[] {
  const out: StatusOutfit[] = [];
  const push = (name: unknown, outfit: unknown) => {
    const n = typeof name === 'string' ? name.trim() : '';
    const o = typeof outfit === 'string' ? outfit.replace(/\s+/g, ' ').trim() : '';
    if (!n || !o) return;
    if (out.length >= 4) return;
    if (out.some(item => item.name === n)) return;
    // NAI 只认英文 tag：带中文的整条丢掉，让调用方回落到角色库/原始 act
    if (HAS_CJK.test(o)) return;
    out.push({ name: n, outfit: o.slice(0, MAX_OUTFIT_CHARS) });
  };
  const cast = record.cast ?? record.outfits;
  if (Array.isArray(cast)) {
    for (const item of cast) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      push(rec.name, rec.outfit ?? rec.current ?? rec.clothing);
    }
  } else if (cast && typeof cast === 'object') {
    for (const [name, outfit] of Object.entries(cast as Record<string, unknown>)) push(name, outfit);
  }
  return out;
}

const MAX_LOOK_CHARS = 160;

/**
 * 「角色库里没有的人」的外貌：模型在 `cast[].look` 里补一次。
 *
 * 为什么需要：以前库里查不到就整条丢掉，于是 Base 写着 `2 people`、
 * 角色块只有一个人——另一张脸全靠模型随手画，用户看到的就是
 * 「明明是两个人，只生成了 Elias 一个」。
 *
 * 只收英文（NAI 只认 danbooru tag），带中文的整条丢，不做机翻。
 */
export function parseLooks(record: Record<string, unknown>): StatusLook[] {
  const out: StatusLook[] = [];
  const cast = record.cast ?? record.looks;
  if (!Array.isArray(cast)) return out;
  for (const item of cast) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const raw = rec.look ?? rec.appearance;
    const look = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!name || !look) continue;
    if (out.length >= 4) continue;
    if (out.some(x => x.name === name)) continue;
    if (HAS_CJK.test(look) || !/[A-Za-z]/.test(look)) continue;
    out.push({ name, look: look.slice(0, MAX_LOOK_CHARS) });
  }
  return out;
}

/** 容忍式解析模型 JSON → StatusReading。 */
export function parseStatusReply(raw: string, kind: StoryKind = 'status'): StatusReading {
  const empty: StatusReading = { ...emptyFrame(), panels: [] };
  const manga = kind === 'manga';
  const sanitize: SanitizeOptions = manga
    ? { allowFraming: true, maxTags: MAX_TAGS_MANGA }
    : {};
  // 我们让模型先写 <thinking> 再给 JSON（柏宝绘的思维链要求），这里先剥掉
  const text = stripThinkingBlocks(String(raw ?? ''));
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  const body = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    try { parsed = JSON.parse(body.replace(/'/g, '"')); } catch { return empty; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const record = parsed as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const parseFrame = (value: unknown): StatusFrame => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyFrame();
    const frame = value as Record<string, unknown>;
    const roles: StatusRole[] = [];
    const push = (item: unknown) => {
      if (roles.length >= STATUS_MAX_CHARACTERS) return;
      if (typeof item === 'string') {
        const name = item.trim();
        if (name && !roles.some(r => r.name === name)) roles.push({ name, act: '' });
        return;
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        const act = typeof rec.act === 'string' ? rec.act.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        if (name && !roles.some(r => r.name === name)) roles.push({ name, act });
      }
    };
    if (Array.isArray(frame.characters)) frame.characters.forEach(push);
    else push(frame.characters);
    push(frame.character); // 兼容 0.8.0 单角色字段

    const tagsRaw = Array.isArray(frame.tags) ? frame.tags.join(', ') : pick(frame.tags);
    const tags = sanitizeStatusTags(tagsRaw, sanitize);

    const lines: StatusLine[] = [];
    if (Array.isArray(frame.lines)) {
      for (const lineRaw of frame.lines) {
        if (lines.length >= STATUS_MAX_LINES) break;
        if (typeof lineRaw === 'string') {
          const t = lineRaw.trim().slice(0, 60);
          if (t) lines.push({ speaker: '', text: t });
          continue;
        }
        if (lineRaw && typeof lineRaw === 'object' && !Array.isArray(lineRaw)) {
          const rec = lineRaw as Record<string, unknown>;
          const speaker = typeof rec.speaker === 'string' ? rec.speaker.trim().slice(0, 16) : '';
          const text = typeof rec.text === 'string' ? rec.text.trim().slice(0, 60) : '';
          if (text) lines.push({ speaker, text });
        }
      }
    }

    const nlRaw = pick(frame.nl).replace(/\s+/g, ' ').slice(0, 300);
    const nl = nlRaw && !HAS_CJK.test(nlRaw) ? nlRaw : '';
    return {
      title: pick(frame.title).slice(0, 40),
      characters: roles.map(r => r.name),
      roles,
      mood: pick(frame.mood).slice(0, 24),
      tags: tags.join(', '),
      nl,
      ...(lines.length ? { lines } : {}),
    };
  };

  const panels: StatusFrame[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record.panels)) {
    for (const panelRaw of record.panels) {
      if (panels.length >= STATUS_MAX_PANELS) break;
      const frame = parseFrame(panelRaw);
      if (!frame.tags) continue;
      const key = frame.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      panels.push(frame);
    }
  }
  const top = parseFrame(record);
  if (!panels.length && top.tags) panels.push(top);
  if (!panels.length) return empty;
  const head = panels[0];
  const outfits = parseOutfits(record);
  const looks = parseLooks(record);
  return {
    ...head,
    title: (pick(record.title) || head.title).slice(0, 40),
    panels,
    ...(outfits.length ? { outfits } : {}),
    ...(looks.length ? { looks } : {}),
  };
}

/** 张数 clamp 到 1~4。 */
export function clampMangaShots(raw: unknown): number {
  const value = Math.round(Number(raw) || 1);
  return Math.min(Math.max(value, 1), STATUS_MAX_PANELS);
}
