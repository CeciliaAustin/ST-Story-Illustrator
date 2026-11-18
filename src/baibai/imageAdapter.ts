/**
 * ST-Story-Illustrator — 柏宝绘出图后端适配器
 *
 * 把 ImageBackendAdapter 接口接到 bridge.generateImage（柏宝绘公开 API）。
 * 遵守核心原则：只调公开接口，不绕过其队列/限流，不复制内部代码。
 */

import type {
  ImageBackendAdapter,
  NormalizedGenerationInput,
  GenerationResult,
  VisualProfile,
  BaiBaiBackendStatus,
} from '../types';
import { generateImage, getBackendStatus, getCharacters } from './bridge';

/** 从规范化输入组装柏宝绘 generate() 请求。size 归一到 portrait/landscape。 */
export function toBaiBaiRequest(input: NormalizedGenerationInput, character?: string) {
  const size: 'portrait' | 'landscape' = input.size === 'landscape' ? 'landscape' : 'portrait';
  return {
    prompt: input.prompt,
    ...(input.nl ? { nl: input.nl } : {}),
    ...(input.negative ? { negative: input.negative } : {}),
    ...(input.characters && input.characters.length ? { characters: input.characters } : {}),
    size,
    ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
    save: input.save !== false,
    ...(character ? { character } : {}),
  };
}

/** 柏宝绘后端适配器（实现 ImageBackendAdapter）。 */
export const baiBaiAdapter: ImageBackendAdapter = {
  id: 'baibai-public-v1',
  capabilities: {
    supportsWeightedTags: true,
    supportsNl: true,
    supportsCharacters: true,
    supportsSeed: true,
    supportsAbort: true,
  },
  async generate(input: NormalizedGenerationInput, profile: VisualProfile): Promise<GenerationResult> {
    const result = await generateImage(toBaiBaiRequest(input, profile.generationProfileId));
    return {
      ...(result.path ? { path: result.path } : {}),
      ...(result.dataUrl ? { dataUrl: result.dataUrl } : {}),
      seed: result.seed,
      meta: {
        backend: result.backend,
        format: result.format,
        charactersApplied: result.charactersApplied,
      },
    };
  },
};

/** 读取后端能力，供 UI 显示受限状态。 */
export async function readBackendState(): Promise<BaiBaiBackendStatus> {
  return await getBackendStatus();
}

/** 读取当前楼层角色快照，转成 adapter 需要的 characters 数组。 */
export async function readCharacters(floor?: number) {
  const list = await getCharacters(floor);
  return list.characters.map(c => ({
    name: c.name,
    tag: c.tag,
    ...(c.nl ? { nl: c.nl } : {}),
  }));
}
