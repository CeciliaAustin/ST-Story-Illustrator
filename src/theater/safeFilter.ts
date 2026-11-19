/**
 * ST-Story-Illustrator — 黑白漫三层安全防护（纯函数）
 * 移植自文档 §3.6：负面词 + 本地确定性洗分镜。
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
