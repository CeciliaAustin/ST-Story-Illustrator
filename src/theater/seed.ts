/**
 * ST-Story-Illustrator — 固定种子（纯函数）
 * 移植自文档 §3.5：FNV-1a 变体，让同一对角色连续几层脸稳定。
 */

/** 由角色名（单个或一组）生成稳定的非零种子。 */
export function statusSeedFor(name: string | string[]): number {
  const text = (Array.isArray(name) ? name : [name])
    .map(s => String(s ?? '').trim()).filter(Boolean).join('|');
  if (!text) return 0;
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 4294967294) + 1; // 0 被当作随机，留 1 余量
}

/** 重出必须换种子：同 prompt + 同 seed 确定性的，点了按钮却吐回同一张图。 */
export function rerollSeed(backend: 'nai' | 'comfyui' | 'webui', previous = 0): number {
  const pick = backend === 'nai'
    ? () => Math.floor(Math.random() * 4294967294) + 1
    : () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
  for (let i = 0; i < 8; i += 1) {
    const seed = pick();
    if (seed > 0 && seed !== previous) return seed;
  }
  return previous > 0 ? previous + 1 : 1;
}

/** 决定默认种子：显式 > NAI 面板固定种子 > 随机。 */
export function decideSeed(backend: 'nai' | 'comfyui' | 'webui', override?: number, fixedSeed = 0): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (backend === 'nai') return fixedSeed > 0 ? fixedSeed : rerollSeed('nai');
  return rerollSeed(backend);
}
