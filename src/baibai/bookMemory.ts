/**
 * 柏宝书（ST-BaiBai-Book）角色状态读取
 *
 * 为什么要接它：柏宝绘出图时不是只看角色库——它还把柏宝书的「角色参考」块发进
 * user 消息最前面（主角/重要角色/NPC 的**外貌、当前着装、状态**）。
 * 角色库给的是「固定外貌」，柏宝书给的是「此刻穿什么、什么状态」（湿身、破损、换装），
 * 两者合起来才有服装一致性。我们之前只有前者，所以正文里换了衣服也画不出来。
 *
 * 读法与柏宝绘一致：
 * - 优先 `getContextAtFloor({floor})`（前后快照由柏宝书自己对齐 revision）；
 * - 旧版 API 用 getFloor + getSnapshot 逐次对齐，对不上就放弃（不猜）。
 * - 只发「主角 + important/随行/在正文里出现过的人」，其余角色不占篇幅。
 * - 柏宝书不可用 / 没有角色信息 → 返回 null，调用方当作「没有参考」继续。
 */

interface BookFloor {
  revision: number;
  memory: { valid: boolean };
}

interface BookSnapshot {
  revision: number;
  [key: string]: unknown;
}

interface BookFloorContext {
  revision: number;
  floorData?: { memory?: { valid?: boolean } };
  snapshotBefore?: BookSnapshot;
  snapshotAfter?: BookSnapshot;
}

interface BookApi {
  apiVersion: number;
  getFloor(floor: number): BookFloor;
  getSnapshot(options: { floor: number; at: 'before' | 'after' }): BookSnapshot;
  getContextAtFloor?(options: { floor: number }): BookFloorContext;
}

function getBookApi(): BookApi | null {
  const api = (globalThis as { STBaiBaiBook?: BookApi }).STBaiBaiBook;
  return api?.apiVersion === 1 ? api : null;
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** 主角一行：性别/年龄/身份/外貌/着装/状态。 */
function fmtProtagonist(protagonist: unknown): string {
  const p = (protagonist ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const fields: Array<[string, string]> = [
    ['性别', 'gender'],
    ['年龄', 'age'],
    ['身份', 'identity'],
    ['外貌', 'appearance'],
    ['着装', 'outfit'],
    ['状态', 'condition'],
  ];
  for (const [label, key] of fields) {
    const v = oneLine(p[key]);
    if (v) parts.push(`${label}:${v}`);
  }
  return parts.join('；');
}

/** NPC 一行：名字(性别·年龄·头衔) —— 与主角关系 〔外貌;着装;状态;随行/在哪〕。 */
function fmtNpc(n: Record<string, unknown>): string {
  const name = oneLine(n.name);
  const bracket = [oneLine(n.gender), oneLine(n.age), oneLine(n.title)].filter(Boolean).join('·');
  let line = bracket ? `${name}(${bracket})` : name;
  const rel = oneLine(n.relation);
  if (rel) line += ` —— 与主角:${rel}`;
  const tail: string[] = [];
  const desc = oneLine(n.desc);
  if (desc) tail.push(`外貌:${desc}`);
  const outfit = oneLine(n.outfit);
  if (outfit) tail.push(`着装:${outfit}`);
  const condition = oneLine(n.condition);
  if (condition) tail.push(`状态:${condition}`);
  if (n.follow === true) tail.push('随行');
  else {
    const loc = oneLine(n.location);
    if (loc) tail.push(`在:${loc}`);
  }
  return tail.length ? `${line} 〔${tail.join(';')}〕` : line;
}

/**
 * 快照 → 角色参考文本。空角色信息返回空串。
 *
 * @param protagonistName 用户人设名（ST 的 `name1`）。柏宝绘就是这么传的：
 *   主角档在柏宝书里没有名字字段，不把 `name1` 标上去，模型会以为「主角」
 *   跟角色库里的某个人（比如「小雪」）是两个人，于是把同一人画成两个角色。
 */
export function formatBookRoles(
  snapshot: BookSnapshot,
  bodyText: string,
  protagonistName = '',
): string {
  const lines: string[] = [];
  const lead = oneLine(protagonistName);
  const protagonist = fmtProtagonist(snapshot.protagonist);
  if (protagonist) lines.push(lead ? `主角(${lead}):${protagonist}` : `主角:${protagonist}`);

  const npcs = Array.isArray(snapshot.npcs) ? snapshot.npcs : [];
  const npcLines: string[] = [];
  for (const raw of npcs) {
    const n = (raw ?? {}) as Record<string, unknown>;
    const name = oneLine(n.name);
    if (!name) continue;
    // 重要角色常驻；随行角色永远在场；其余用名字去目标正文里查（逐字，区分大小写）
    if (n.important === true || n.follow === true || String(bodyText ?? '').includes(name)) {
      npcLines.push(`- ${fmtNpc(n)}`);
    }
  }
  if (npcLines.length) lines.push(`重要角色:\n${npcLines.join('\n')}`);
  return lines.join('\n');
}

/**
 * 从柏宝书快照抽出「每个人此刻穿什么」，与柏宝绘的角色参考同一批人：
 * 主角 + important/follow + 正文点名的人。原文保留（多为中文），
 * 交给写 tag 的模型翻成英文 tag——代码不做翻译，避免把中文塞进 NAI。
 */
export function bookOutfits(
  snapshot: BookSnapshot,
  bodyText: string,
  protagonistName = '',
): Array<{ name: string; outfit: string }> {
  const out: Array<{ name: string; outfit: string }> = [];
  const seen = new Set<string>();
  const push = (rawName: string, rawOutfit: unknown): void => {
    const name = String(rawName ?? '').trim();
    const outfit = oneLine(rawOutfit);
    if (!name || !outfit || seen.has(name)) return;
    seen.add(name);
    out.push({ name, outfit });
  };

  const protagonist = (snapshot.protagonist ?? {}) as Record<string, unknown>;
  // 主角档在柏宝书里没有名字字段，用 name1 补——与 formatBookRoles 同一口径。
  if (oneLine(protagonist.outfit)) push(protagonistName || '主角', protagonist.outfit);

  const npcs = Array.isArray(snapshot.npcs) ? snapshot.npcs : [];
  for (const raw of npcs) {
    const n = (raw ?? {}) as Record<string, unknown>;
    const name = oneLine(n.name);
    if (!name) continue;
    if (n.important === true || n.follow === true || String(bodyText ?? '').includes(name)) {
      // NPC 有时把衣着写在 desc 里而不是 outfit（柏宝书两种版本都存在）。
      push(name, oneLine(n.outfit) || oneLine(n.desc));
    }
  }
  return out.slice(0, 8);
}

export interface BookContext {
  text: string;
  timing: 'before_latest' | 'after_latest';
  /**
   * 柏宝书里每个人的**当前着装**（原文，可能是中文）。
   *
   * 为什么要把结构化着装单独带出来：以前只把它塞进 `text` 给写 tag 的模型看，
   * 而插画/漫画的模板又明令「服装由角色库提供」——模型照办，结果角色块里
   * 一件衣服都没有。真正的做法和柏宝绘一样：把「此刻穿什么」当**冻结的定妆**
   * 交给模型翻成英文 tag，代码再逐字拼进每个角色块。这里只负责把原文取出，
   * 不翻译（翻译是写 tag 那一步的事，且必须英文）。
   */
  outfits?: Array<{ name: string; outfit: string }>;
}

/**
 * 读某一楼的柏宝书角色参考。
 *
 * @param floor 目标楼层
 * @param bodyText 该楼正文（判断不在场角色是否真的参与本楼）
 * @param protagonistName 用户人设名（`name1`），用于把主角档对上角色库里的那个人
 */
export function readBookRoles(
  floor: number,
  bodyText: string,
  protagonistName = '',
): BookContext | null {
  const api = getBookApi();
  if (!api) return null;
  try {
    let snapshot: BookSnapshot | undefined;
    let timing: BookContext['timing'] = 'before_latest';

    if (typeof api.getContextAtFloor === 'function') {
      const data = api.getContextAtFloor({ floor });
      const valid = !!data.floorData?.memory?.valid;
      timing = valid ? 'after_latest' : 'before_latest';
      snapshot = valid ? data.snapshotAfter : data.snapshotBefore;
    } else {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const floorData = api.getFloor(floor);
        timing = floorData.memory.valid ? 'after_latest' : 'before_latest';
        const s = api.getSnapshot({ floor, at: timing === 'after_latest' ? 'after' : 'before' });
        if (floorData.revision === s.revision) {
          snapshot = s;
          break;
        }
      }
      if (!snapshot) return null;
    }
    if (!snapshot) return null;

    const roles = formatBookRoles(snapshot, bodyText, protagonistName);
    if (!roles) return null;
    const outfits = bookOutfits(snapshot, bodyText, protagonistName);
    return {
      timing,
      text: `【角色参考（柏宝书同步的最新状态，只读）】\n${roles}`,
      ...(outfits.length ? { outfits } : {}),
    };
  } catch (error) {
    console.warn('[ST-Story-Illustrator] 读取柏宝书角色状态失败，本次只用角色库与正文。', error);
    return null;
  }
}
