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

export interface BookContext {
  text: string;
  timing: 'before_latest' | 'after_latest';
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
    return {
      timing,
      text: `【角色参考（柏宝书同步的最新状态，只读）】\n${roles}`,
    };
  } catch (error) {
    console.warn('[ST-Story-Illustrator] 读取柏宝书角色状态失败，本次只用角色库与正文。', error);
    return null;
  }
}
