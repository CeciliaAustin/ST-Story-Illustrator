/**
 * 统一选段入口测试
 *
 * 通过 vi.mock 模拟 ST 环境函数，
 * 测试 StorySegment 构建器、验证、锚定楼层、上下文提取等纯逻辑。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Mock ST 环境函数
// ============================================================

// Mock 数据
let mockChat: Array<{
  mes?: string;
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  send_date?: string;
  swipe_id?: number;
  extra?: Record<string, unknown>;
}> = [];

let mockChatId = 'test-chat-001';

vi.mock('../src/host/sillytavern', () => ({
  getChat: () => mockChat,
  getCurrentChatId: () => mockChatId,
  getSendDate: (floor: number) => {
    const msg = mockChat[floor];
    return typeof msg?.send_date === 'string' ? msg.send_date.trim() : '';
  },
  getSwipeId: (floor: number) => {
    const msg = mockChat[floor];
    return typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
  },
  stillCurrent: (chatId: string, _floor: number, swipe: number, sendDate?: string) => {
    if (mockChatId !== chatId) return false;
    const msg = mockChat[_floor];
    if (!msg) return false;
    if (sendDate) {
      const actual = typeof msg.send_date === 'string' ? msg.send_date.trim() : '';
      if (actual && actual !== sendDate) return false;
    }
    const currentSwipe = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
    if (currentSwipe !== swipe) return false;
    return true;
  },
}));

// 导入被测模块（在 mock 之后）
import {
  buildSingleSegment,
  buildRangeSegment,
  buildPickedSegment,
  buildManualSegment,
  validateSegment,
  getAnchorFloor,
  defaultFloor,
  getAvailableFloors,
  getChatFloorCount,
  extractMessage,
} from '../src/selection/storySegment';

// ============================================================
// 测试数据
// ============================================================

function setupMockChat(): void {
  mockChat = [
    { mes: '你好，欢迎来到这里。', name: 'Alice', is_user: false, send_date: '2024-01-01-10:00:00', swipe_id: 0 },
    { mes: '嗨，很高兴见到你。', name: 'User', is_user: true, send_date: '2024-01-01-10:00:01', swipe_id: 0 },
    { mes: '今天天气不错，我们去散步吧。', name: 'Alice', is_user: false, send_date: '2024-01-01-10:00:02', swipe_id: 0 },
    { mes: '好的，我也想出去走走。', name: 'User', is_user: true, send_date: '2024-01-01-10:00:03', swipe_id: 0 },
    { mes: '<bbi_image>some image tag</bbi_image>那边的花园很漂亮。', name: 'Alice', is_user: false, send_date: '2024-01-01-10:00:04', swipe_id: 0 },
    { mes: '这是一个系统提示。', name: 'System', is_user: false, is_system: true, send_date: '2024-01-01-10:00:05', swipe_id: 0 },
    { mes: '<dialogue speaker="Bob">你好</dialogue>他说了一句你好。', name: 'Bob', is_user: false, send_date: '2024-01-01-10:00:06', swipe_id: 0 },
  ];
  mockChatId = 'test-chat-001';
}

beforeEach(() => {
  setupMockChat();
});

// ============================================================
// 测试
// ============================================================

describe('extractMessage', () => {
  it('should extract a valid message', () => {
    const msg = extractMessage(0, 'test-chat-001');
    expect(msg).not.toBeNull();
    expect(msg!.floor).toBe(0);
    expect(msg!.speaker).toBe('Alice');
    expect(msg!.isUser).toBe(false);
    expect(msg!.text).toBe('你好，欢迎来到这里。');
  });

  it('should return null for out-of-range floor', () => {
    expect(extractMessage(-1, 'test-chat-001')).toBeNull();
    expect(extractMessage(999, 'test-chat-001')).toBeNull();
  });

  it('should return null when chatId mismatches', () => {
    expect(extractMessage(0, 'wrong-chat-id')).toBeNull();
  });

  it('should clean bbi_image tags from text', () => {
    const msg = extractMessage(4, 'test-chat-001');
    expect(msg).not.toBeNull();
    expect(msg!.text).not.toContain('<bbi_image>');
    expect(msg!.text).not.toContain('</bbi_image>');
    expect(msg!.text).toContain('那边的花园很漂亮');
  });

  it('should clean dialogue tags from text', () => {
    const msg = extractMessage(6, 'test-chat-001');
    expect(msg).not.toBeNull();
    expect(msg!.text).not.toContain('<dialogue');
    expect(msg!.text).toContain('他说了一句你好');
  });
});

describe('buildSingleSegment', () => {
  it('should build segment from a valid floor', () => {
    const seg = buildSingleSegment(0);
    expect(seg).not.toBeNull();
    expect(seg!.sourceKind).toBe('single');
    expect(seg!.floorIds).toEqual([0]);
    expect(seg!.messages).toHaveLength(1);
    expect(seg!.messages[0].speaker).toBe('Alice');
    expect(seg!.text).toBe('你好，欢迎来到这里。');
  });

  it('should return null for invalid floor', () => {
    expect(buildSingleSegment(-1)).toBeNull();
    expect(buildSingleSegment(999)).toBeNull();
  });

  it('should return null when no chatId', () => {
    mockChatId = '';
    expect(buildSingleSegment(0)).toBeNull();
  });
});

describe('buildRangeSegment', () => {
  it('should build segment from a range', () => {
    const seg = buildRangeSegment(0, 4);
    expect(seg).not.toBeNull();
    expect(seg!.sourceKind).toBe('range');
    expect(seg!.startFloor).toBe(0);
    expect(seg!.endFloor).toBe(4);
    // Floor 5 is system message, should be filtered
    // Floors 0-4 are non-system
    expect(seg!.messages.length).toBe(5);
    expect(seg!.floorIds).toEqual([0, 1, 2, 3, 4]);
  });

  it('should handle reversed range (end < start)', () => {
    const seg = buildRangeSegment(4, 0);
    expect(seg).not.toBeNull();
    expect(seg!.startFloor).toBe(0);
    expect(seg!.endFloor).toBe(4);
    expect(seg!.messages.length).toBe(5);
  });

  it('should exclude specified floors', () => {
    const seg = buildRangeSegment(0, 4, [1, 3]);
    expect(seg).not.toBeNull();
    expect(seg!.floorIds).toEqual([0, 2, 4]);
    expect(seg!.messages.length).toBe(3);
  });

  it('should filter system messages', () => {
    const seg = buildRangeSegment(0, 6);
    expect(seg).not.toBeNull();
    // Floor 5 is system, should be excluded
    expect(seg!.floorIds).not.toContain(5);
  });

  it('should return null when all floors are excluded', () => {
    const seg = buildRangeSegment(0, 4, [0, 1, 2, 3, 4]);
    expect(seg).toBeNull();
  });

  it('should return null when no chatId', () => {
    mockChatId = '';
    expect(buildRangeSegment(0, 4)).toBeNull();
  });
});

describe('buildPickedSegment', () => {
  it('should build segment from picked floors', () => {
    const seg = buildPickedSegment([0, 2, 4]);
    expect(seg).not.toBeNull();
    expect(seg!.sourceKind).toBe('picked');
    expect(seg!.floorIds).toEqual([0, 2, 4]);
    expect(seg!.messages.length).toBe(3);
  });

  it('should filter system messages from picked list', () => {
    const seg = buildPickedSegment([0, 5, 6]);
    expect(seg).not.toBeNull();
    // Floor 5 is system, filtered out
    expect(seg!.floorIds).toEqual([0, 6]);
  });

  it('should filter invalid floors', () => {
    const seg = buildPickedSegment([0, -1, 999, 2]);
    expect(seg).not.toBeNull();
    expect(seg!.floorIds).toEqual([0, 2]);
  });

  it('should return null for empty list', () => {
    expect(buildPickedSegment([])).toBeNull();
  });
});

describe('buildManualSegment', () => {
  it('should build segment from manual text', () => {
    const seg = buildManualSegment('这是一段手动输入的剧情文本。');
    expect(seg).not.toBeNull();
    expect(seg!.sourceKind).toBe('manual');
    expect(seg!.text).toBe('这是一段手动输入的剧情文本。');
    expect(seg!.messages).toEqual([]);
  });

  it('should return null for empty text', () => {
    expect(buildManualSegment('')).toBeNull();
    expect(buildManualSegment('   ')).toBeNull();
  });

  it('should record floorIds when provided', () => {
    const seg = buildManualSegment('手动文本', [0, 2]);
    expect(seg).not.toBeNull();
    expect(seg!.floorIds).toEqual([0, 2]);
    // Should also extract messages from those floors
    expect(seg!.messages.length).toBe(2);
  });
});

describe('validateSegment', () => {
  it('should validate a single segment', () => {
    const seg = buildSingleSegment(0);
    expect(seg).not.toBeNull();
    expect(validateSegment(seg!)).toBe(true);
  });

  it('should invalidate when chatId changes', () => {
    const seg = buildSingleSegment(0);
    expect(seg).not.toBeNull();
    mockChatId = 'different-chat';
    expect(validateSegment(seg!)).toBe(false);
  });

  it('should invalidate when message is deleted', () => {
    const seg = buildSingleSegment(2);
    expect(seg).not.toBeNull();
    // Simulate message deletion
    mockChat.splice(2, 1);
    expect(validateSegment(seg!)).toBe(false);
  });

  it('should always validate manual segments', () => {
    const seg = buildManualSegment('手动文本');
    expect(seg).not.toBeNull();
    mockChatId = 'changed';
    expect(validateSegment(seg!)).toBe(true);
  });
});

describe('getAnchorFloor', () => {
  it('should return last floor for single segment', () => {
    const seg = buildSingleSegment(3);
    expect(seg).not.toBeNull();
    expect(getAnchorFloor(seg!)).toBe(3);
  });

  it('should return last floor for range segment', () => {
    const seg = buildRangeSegment(0, 4);
    expect(seg).not.toBeNull();
    expect(getAnchorFloor(seg!)).toBe(4);
  });

  it('should return last picked floor for picked segment', () => {
    const seg = buildPickedSegment([2, 0, 4]);
    expect(seg).not.toBeNull();
    expect(getAnchorFloor(seg!)).toBe(4);
  });

  it('should return last floorId for manual segment', () => {
    const seg = buildManualSegment('手动文本', [1, 3, 5]);
    expect(seg).not.toBeNull();
    expect(getAnchorFloor(seg!)).toBe(5);
  });

  it('should return null for manual segment without floorIds', () => {
    const seg = buildManualSegment('手动文本');
    expect(seg).not.toBeNull();
    expect(getAnchorFloor(seg!)).toBeNull();
  });
});

describe('defaultFloor', () => {
  it('should return the last AI message floor', () => {
    // Last AI message is floor 6 (Bob)
    expect(defaultFloor()).toBe(6);
  });

  it('should skip system messages', () => {
    // Make floor 6 a system message
    mockChat[6] = { mes: '系统消息', name: 'System', is_system: true, send_date: '2024-01-01-10:00:06', swipe_id: 0 };
    // Last AI message should now be floor 4
    expect(defaultFloor()).toBe(4);
  });

  it('should return -1 when chat is empty', () => {
    mockChat = [];
    expect(defaultFloor()).toBe(-1);
  });
});

describe('getAvailableFloors', () => {
  it('should list all non-system floors', () => {
    const floors = getAvailableFloors();
    // Floor 5 is system, should be excluded
    expect(floors).toHaveLength(6);
    expect(floors.map(f => f.floor)).toEqual([0, 1, 2, 3, 4, 6]);
  });

  it('should include speaker and preview', () => {
    const floors = getAvailableFloors();
    const first = floors[0];
    expect(first.speaker).toBe('Alice');
    expect(first.isUser).toBe(false);
    expect(first.preview.length).toBeGreaterThan(0);
  });

  it('should return empty array for empty chat', () => {
    mockChat = [];
    expect(getAvailableFloors()).toEqual([]);
  });
});

// ============================================================
// 隐藏楼层（is_system）访问
// ============================================================

describe('hidden floors (is_system)', () => {
  it('excludes hidden floors by default', () => {
    const floors = getAvailableFloors();
    expect(floors.some(f => f.floor === 5)).toBe(false);
    expect(floors.every(f => f.hidden === false)).toBe(true);
  });

  it('lists hidden floors when includeHidden', () => {
    const floors = getAvailableFloors({ includeHidden: true });
    expect(floors.map(f => f.floor)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const hidden = floors.find(f => f.floor === 5);
    expect(hidden?.hidden).toBe(true);
  });

  it('extractMessage returns null for hidden floor by default', () => {
    expect(extractMessage(5, 'test-chat-001')).toBeNull();
  });

  it('extractMessage returns hidden floor when includeHidden', () => {
    const msg = extractMessage(5, 'test-chat-001', { includeHidden: true });
    expect(msg).not.toBeNull();
    expect(msg!.floor).toBe(5);
    expect(msg!.text).toContain('系统提示');
  });

  it('buildSingleSegment can select a hidden floor', () => {
    expect(buildSingleSegment(5)).toBeNull();
    const seg = buildSingleSegment(5, { includeHidden: true });
    expect(seg).not.toBeNull();
    expect(seg!.floorIds).toEqual([5]);
  });

  it('buildRangeSegment skips hidden floors by default', () => {
    const seg = buildRangeSegment(0, 6);
    expect(seg!.floorIds).toEqual([0, 1, 2, 3, 4, 6]);
  });

  it('buildRangeSegment includes hidden floors when asked', () => {
    const seg = buildRangeSegment(0, 6, [], { includeHidden: true });
    expect(seg!.floorIds).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seg!.text).toContain('系统提示');
  });

  it('buildPickedSegment skips hidden floors by default', () => {
    expect(buildPickedSegment([5])).toBeNull();
  });

  it('buildPickedSegment includes hidden floors when asked', () => {
    const seg = buildPickedSegment([1, 5], { includeHidden: true });
    expect(seg!.floorIds).toEqual([1, 5]);
  });

  it('buildRangeSegment clamps range to chat bounds', () => {
    const seg = buildRangeSegment(-5, 999);
    // 上界被夹到最后一楼，下界夹到 0
    expect(seg!.startFloor).toBe(0);
    expect(seg!.endFloor).toBe(mockChat.length - 1);
    expect(seg!.floorIds.every(f => f >= 0 && f < mockChat.length)).toBe(true);
  });

  it('getChatFloorCount reports chat length', () => {
    expect(getChatFloorCount()).toBe(mockChat.length);
  });
});
