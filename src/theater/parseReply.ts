/**
 * ST-Story-Illustrator — 小剧场读剧情响应解析（纯函数）
 *
 * 移植自文档 §3.2/3.3：tag 清洗 + 容忍式 JSON 解析。
 * 坏 JSON 丢弃、不连累整条；旧格式兼容；超额/去重/清洗。
 */

import type { StatusFrame, StatusReading, StatusLine, StatusRole } from '../types';

export const STATUS_MAX_CHARACTERS = 2;
export const STATUS_MAX_PANELS = 4;
export const STATUS_MAX_LINES = 4;

const STYLE_BLOCKLIST = [
  'masterpiece', 'best quality', 'high quality', 'highly detailed', 'ultra detailed',
  'absurdres', '8k', '4k', 'photorealistic', 'realistic', 'photo', 'cinematic',
  'depth of field', 'chibi', 'anime style', 'illustration', 'lineart', 'flat color',
  'cel shading', 'full body', 'cowboy shot', 'wide shot', 'from below', 'foreshortening',
];
const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const MAX_TAGS = 14;

/** tag 清洗：去掉权重写法、挡掉画风词、去中文、去重、限额。 */
export function sanitizeStatusTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of String(raw ?? '').split(/[,，、\n]/)) {
    let tag = piece.trim().toLowerCase();
    if (!tag) continue;
    tag = tag.replace(/^\(?\s*[\d.]+::/, '').replace(/::$/, '').replace(/^\(|\)$/g, '');
    tag = tag.replace(/:\s*[\d.]+$/, '').trim();
    if (!tag || HAS_CJK.test(tag)) continue;
    if (STYLE_BLOCKLIST.some(word => tag === word || tag.includes(word))) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function emptyFrame(): StatusFrame {
  return { title: '', characters: [], roles: [], mood: '', tags: '', nl: '' };
}

/** 容忍式解析模型 JSON → StatusReading。 */
export function parseStatusReply(raw: string): StatusReading {
  const empty: StatusReading = { ...emptyFrame(), panels: [] };
  const text = String(raw ?? '');
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
    const tags = sanitizeStatusTags(tagsRaw);

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
  return { ...head, title: (pick(record.title) || head.title).slice(0, 40), panels };
}

/** 张数 clamp 到 1~4。 */
export function clampMangaShots(raw: unknown): number {
  const value = Math.round(Number(raw) || 1);
  return Math.min(Math.max(value, 1), STATUS_MAX_PANELS);
}
