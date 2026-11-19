/**
 * ST-Story-Illustrator — 黑白漫「安全」与「黑白」两条本地后处理（纯函数）
 *
 * 两件事以前被塞进同一个叫「安全洗」的开关里，但其实是正交的：
 * 1. 安全（NSFW）：洗露点/性描写，并对负面词补一串 nsfw 词。
 * 2. 黑白（monochrome）：正向上锁黑白 + 洗掉彩色语义词 + 负面压彩色。
 * 第 2 条一直没有，于是「黑白漫」全靠用户的画师串，画师串偏彩色就整页全彩。
 */

import type { StatusReading, StatusFrame } from '../types';

export const MANGA_SAFE_NEGATIVE =
  'nsfw, nude, naked, completely nude, topless, bottomless, nipples, areolae, ' +
  'underwear, panties, lingerie, braless, see-through, ' +
  'cleavage, underboob, sideboob, pussy, penis, genitals, anus, buttocks, ' +
  'sex, intercourse, fellatio, cunnilingus, paizuri, handjob, masturbation, ' +
  'cum, semen, creampie, ahegao, spread legs';

// 词边界 \b：否则 ass 会命中 glass、bra 会命中 brush，把正常 tag 一起删掉
const UNSAFE_RE = new RegExp(
  `\\b(?:${[
    'nsfw', 'nudes?', 'naked', 'topless', 'bottomless', 'nipples?', 'areolae?', 'underwear',
    'panties?', 'lingerie', 'braless', 'see[ -]through', 'cleavage', 'underboob', 'sideboob',
    'downblouse', 'upskirt', 'pussy', 'penis', 'genitals?', 'anus', 'buttocks?', 'ass', 'groin',
    'breasts?', 'sex', 'sexual', 'intercourse', 'fellatio', 'cunnilingus', 'paizuri', 'handjob',
    'masturbation', 'orgasm', 'ejaculat\\w*', 'cum', 'semen', 'creampie', 'ahegao', 'spread legs',
    'exposed breasts?',
  ].join('|')})\\b`, 'i',
);

export function isMangaUnsafeText(text: string): boolean {
  return UNSAFE_RE.test(String(text ?? ''));
}

// ============================================================
// 黑白锁定（monochrome）
// ============================================================

/**
 * 正向上锁的「黑白」词。danbooru/NAI 上最稳的组合就是这两条：
 * monochrome = 整张只有明度，greyscale = 灰度渐变（不带它会变成网点硬边风格）。
 * 只靠负面写 color 压不住彩色——负面只能减少彩色倾向，不能把画面变成黑白。
 */
export const MANGA_BW_POSITIVE = 'monochrome, greyscale';

/** 负面压彩色。只写「彩色语义」，不写画质词，避免连线条质感一起压掉。 */
export const MANGA_BW_NEGATIVE =
  'color, colorful, full color, vivid colors, saturated, chromatic, rainbow, multicolored';

/**
 * 正向上要洗掉的「彩色语义」词（整项剔除）。
 *
 * 只收**纯调色**词：colorful / full color / vivid / saturated / rainbow 这类。
 * **不收 red hair / blue eyes**——那是角色身份，删掉会让人不像本人；
 * 黑白稿里它们由 monochrome 转成灰度，只当明度信息用。
 * 也不收 white / black / grey：那是黑白稿里正常的明暗词。
 */
const COLOR_STYLE_RE = new RegExp(
  `\\b(?:${[
    'colorful', 'colou?red', 'full[ -]?color', 'multi[ -]?colou?red', 'technicolou?r',
    'vivid', 'vibrant', 'saturated', 'saturation', 'chromatic', 'rainbow',
    'pastel colors?', 'neon colors?', 'colou?r palette', 'colou?r scheme',
  ].join('|')})\\b`,
  'i',
);

/** 洗掉提示词里的彩色语义（页面级：整条 tag 剔除，避免留下半句病句）。 */
export function stripMangaColorTags(tags: string): { tags: string; hits: string[] } {
  const hits: string[] = [];
  const kept = String(tags ?? '').split(/[,，]/).map(p => p.trim()).filter(Boolean)
    .filter(part => {
      if (!COLOR_STYLE_RE.test(part)) return true;
      hits.push(part);
      return false;
    });
  return { tags: kept.join(', '), hits };
}

/**
 * 合并多段负面词并去重。
 *
 * 安全负面与黑白负面都是逗号串，直接 `a + ', ' + b` 会出现重复；
 * 重复不会让 NAI 更听话，只会让负面词挤占正向词的 token 预算。
 */
export function mergeNegative(...parts: Array<string | undefined | null>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const piece of String(part ?? '').split(/[,，]/)) {
      const tag = piece.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(', ');
}

/** 整项剔除而非删词：删 breasts 会剩一个说不通的 large。 */
export function stripMangaUnsafeTags(tags: string): { tags: string; hits: string[] } {
  const hits: string[] = [];
  const kept = String(tags ?? '').split(/[,，]/).map(p => p.trim()).filter(Boolean)
    .filter(part => {
      if (!UNSAFE_RE.test(part)) return true;
      hits.push(part);
      return false;
    });
  return { tags: kept.join(', '), hits };
}

/** 出图前本地确定性洗一遍整条分镜（防护第二层）。 */
export function scrubMangaReading(reading: StatusReading): { reading: StatusReading; hits: string[] } {
  const hits: string[] = [];
  const scrubFrame = (frame: StatusFrame): StatusFrame => {
    const tags = stripMangaUnsafeTags(frame.tags);
    hits.push(...tags.hits);
    const roles = frame.roles.map(role => {
      if (!role.act || !UNSAFE_RE.test(role.act)) return role;
      hits.push(`${role.name} 的动作描写`);
      return { ...role, act: '' }; // 整段清空，不删词留病句
    });
    let nl = frame.nl;
    if (nl && UNSAFE_RE.test(nl)) {
      hits.push(`${frame.title || '一格'} 的自然语言描述`);
      nl = '';
    }
    return { ...frame, tags: tags.tags, roles, nl };
  };
  const panels = reading.panels.map(scrubFrame).filter(f => !!f.tags);
  // 本批服装也要过一遍：一串「underwear / no bra」会把安全模式直接废掉，
  // 而它不在 tags/act/nl 里，光洗那三处漏得干干净净。
  const outfits = (reading.outfits ?? []).filter(item => {
    if (!UNSAFE_RE.test(item.outfit)) return true;
    hits.push(`${item.name} 的服装描写`);
    return false;
  });
  const kept: StatusReading = { ...reading };
  if (outfits.length) kept.outfits = outfits;
  else delete kept.outfits;
  const head = panels[0];
  if (!head) {
    return { reading: { ...kept, panels, tags: '', roles: [], characters: [], nl: '' }, hits };
  }
  return { reading: { ...kept, ...head, title: reading.title, panels }, hits };
}
