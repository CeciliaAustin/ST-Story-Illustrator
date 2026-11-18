/**
 * 柏宝绘公开 API 桥接层
 *
 * 负责：
 * - 检测 globalThis.STBaiBaiImage 是否存在
 * - 版本兼容性检查
 * - 有界等待 API 就绪
 * - 提供统一的接口访问层
 *
 * 不调用柏宝绘未公开的私有函数。
 * 不猜测不存在的接口。
 */

import type { BaiBaiApi, BaiBaiBackendStatus, BaiBaiCharacter, BaiBaiCharacterList, BaiBaiGenerateRequest, BaiBaiGenerateOptions, BaiBaiGenerateResult, BaiBaiChangeNotice } from '../types';

// ============================================================
// 常量
// ============================================================

/** 扩展支持的最低 API 版本 */
const MIN_API_VERSION = '1';

/** 等待 API 就绪的最大尝试次数 */
const MAX_WAIT_ATTEMPTS = 20;

/** 每次尝试的间隔（毫秒） */
const WAIT_INTERVAL_MS = 500;

// ============================================================
// 类型
// ============================================================

export type ApiAvailability =
  | { status: 'available'; api: BaiBaiApi }
  | { status: 'not_installed' }
  | { status: 'version_mismatch'; apiVersion: string }
  | { status: 'error'; message: string };

// ============================================================
// 内部状态
// ============================================================

let cachedApi: BaiBaiApi | null = null;
let cachedAvailability: ApiAvailability | null = null;

// ============================================================
// 版本比较
// ============================================================

/**
 * 简单语义版本比较。
 * 只比较 major.minor.patch，不处理预发布标签。
 * 返回值：正数表示 a > b，负数表示 a < b，0 表示相等。
 */
export function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string): number[] => {
    return v.split('.').map(part => {
      const num = parseInt(part, 10);
      return isNaN(num) ? 0 : num;
    });
  };

  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

// ============================================================
// API 检测
// ============================================================

/**
 * 检测 globalThis.STBaiBaiImage 是否存在且版本兼容。
 * 不发起网络请求，只做本地检测。
 */
export function checkAvailability(): ApiAvailability {
  // 缓存命中且 API 仍然存在时直接返回
  if (cachedApi && typeof globalThis !== 'undefined') {
    const current = (globalThis as Record<string, unknown>).STBaiBaiImage;
    if (current === cachedApi) {
      return cachedAvailability!;
    }
  }

  if (typeof globalThis === 'undefined') {
    cachedAvailability = { status: 'error', message: 'globalThis not available' };
    return cachedAvailability;
  }

  const raw = (globalThis as Record<string, unknown>).STBaiBaiImage;
  if (!raw || typeof raw !== 'object') {
    cachedApi = null;
    cachedAvailability = { status: 'not_installed' };
    return cachedAvailability;
  }

  const api = raw as BaiBaiApi;

  // 版本检查 — PUBLIC_API.md 说 apiVersion 固定为 1（数字）
  if (typeof api.apiVersion !== 'number' && typeof api.apiVersion !== 'string') {
    cachedApi = null;
    cachedAvailability = { status: 'version_mismatch', apiVersion: 'unknown' };
    return cachedAvailability;
  }

  const versionStr = String(api.apiVersion);
  if (compareVersions(versionStr, MIN_API_VERSION) < 0) {
    cachedApi = null;
    cachedAvailability = { status: 'version_mismatch', apiVersion: versionStr };
    return cachedAvailability;
  }

  cachedApi = api;
  cachedAvailability = { status: 'available', api };
  return cachedAvailability;
}

// ============================================================
// 有界等待
// ============================================================

/**
 * 有界等待柏宝绘 API 就绪。
 * 不无限轮询。超时后返回 not_installed。
 */
export async function waitForApi(maxAttempts: number = MAX_WAIT_ATTEMPTS): Promise<ApiAvailability> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = checkAvailability();
    if (result.status === 'available') {
      return result;
    }
    if (result.status === 'version_mismatch' || result.status === 'error') {
      return result;
    }
    // not_installed → 等待后重试
    await sleep(WAIT_INTERVAL_MS);
  }
  return { status: 'not_installed' };
}

// ============================================================
// 安全调用封装
// ============================================================

/**
 * 获取柏宝绘 API。如果不可用则抛出可理解的错误。
 */
export function getApi(): BaiBaiApi {
  const result = checkAvailability();
  if (result.status === 'available') {
    return result.api;
  }
  throw new BaiBaiApiError(result);
}

/**
 * 检查柏宝绘是否可用（不抛异常）。
 */
export function isAvailable(): boolean {
  return checkAvailability().status === 'available';
}

/**
 * 读取后端状态。
 * 如果 API 不可用，返回未配置状态。
 */
/** 未配置时的兜底状态（字段对齐 BaiBaiBackendStatus）。 */
function unconfiguredBackendStatus(): BaiBaiBackendStatus {
  return {
    apiVersion: 1,
    pluginVersion: '',
    backend: 'nai',
    configured: false,
    model: '',
    supportsCharacters: false,
    reason: '柏宝绘 API 不可用',
  };
}

export async function getBackendStatus(): Promise<BaiBaiBackendStatus> {
  if (!isAvailable()) {
    return unconfiguredBackendStatus();
  }
  try {
    const api = getApi();
    return await api.getBackendStatus();
  } catch {
    return unconfiguredBackendStatus();
  }
}

/**
 * 读取角色库。
 * floor 可选：不传 = 当前快照，传 floor = 该楼之前的历史快照。
 * 如果 API 不可用或读取失败，返回空列表。
 */
export async function getCharacters(floor?: number): Promise<BaiBaiCharacterList> {
  if (!isAvailable()) {
    return { apiVersion: 1, pluginVersion: '', revision: 0, floor: null, characters: [] };
  }
  try {
    const api = getApi();
    return await api.getCharacters(floor !== undefined ? { floor } : {});
  } catch {
    return { apiVersion: 1, pluginVersion: '', revision: 0, floor: null, characters: [] };
  }
}

/**
 * 调用柏宝绘出图。
 * 不绕过其队列和限流。
 */
export async function generateImage(
  request: BaiBaiGenerateRequest,
  options?: BaiBaiGenerateOptions,
): Promise<BaiBaiGenerateResult> {
  const api = getApi();
  return await api.generate(request, options);
}

/**
 * 订阅角色库变更。
 * 返回取消订阅函数。
 */
export function subscribeToCharacterChanges(listener: (notice: BaiBaiChangeNotice) => void): () => void {
  if (!isAvailable()) {
    return () => {};
  }
  try {
    const api = getApi();
    return api.subscribe(listener);
  } catch {
    return () => {};
  }
}

// ============================================================
// 错误类型
// ============================================================

export class BaiBaiApiError extends Error {
  readonly availability: ApiAvailability;

  constructor(availability: ApiAvailability) {
    let message: string;
    switch (availability.status) {
      case 'not_installed':
        message = '柏宝绘未安装或未加载。请先安装并启用柏宝绘扩展。';
        break;
      case 'version_mismatch':
        message = `柏宝绘 API 版本不兼容（当前 ${availability.apiVersion}，需要 >= ${MIN_API_VERSION}）。`;
        break;
      case 'error':
        message = availability.message;
        break;
      default:
        message = '柏宝绘 API 不可用。';
    }
    super(message);
    this.name = 'BaiBaiApiError';
    this.availability = availability;
  }
}

// ============================================================
// 辅助
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
