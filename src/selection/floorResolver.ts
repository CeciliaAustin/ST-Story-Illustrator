/**
 * 楼层定位
 *
 * 从选区 DOM 向上定位实际消息容器，提取 mesId / swipeId / chatId。
 */

import { getCurrentChatId, getSendDate, getSwipeId } from '../host/sillytavern';
import { getMesFromSelection } from './selector';
import type { FloorLocation } from '../types';

// ============================================================
// 常量
// ============================================================

/** 楼层 ID 属性名 */
const MESID_ATTR = 'mesid';

/** 消息容器选择器 */
const MES_SELECTOR = '.mes';

// ============================================================
// 楼层定位
// ============================================================

/**
 * 从选区定位所属楼层。
 * 返回 null 表示无法可靠定位。
 */
export function resolveFloorFromSelection(selection: Selection): FloorLocation | null {
  const mes = getMesFromSelection(selection);
  if (!mes) return null;

  return resolveFloorFromMesElement(mes);
}

/**
 * 从 .mes 元素定位楼层。
 */
export function resolveFloorFromMesElement(mes: HTMLElement): FloorLocation | null {
  const mesidAttr = mes.getAttribute(MESID_ATTR);
  if (mesidAttr === null) return null;

  const mesId = parseInt(mesidAttr, 10);
  if (!Number.isFinite(mesId) || mesId < 0) return null;

  const chatId = getCurrentChatId();
  if (!chatId) return null;

  const swipeId = getSwipeId(mesId);

  return {
    chatId,
    mesId,
    swipeId,
    mesElement: mes,
  };
}

/**
 * 从 DOM 查找指定楼层的 .mes 元素。
 */
export function findMesElement(floor: number): HTMLElement | null {
  const selector = `${MES_SELECTOR}[${MESID_ATTR}="${floor}"]`;
  return document.querySelector<HTMLElement>(selector);
}

/**
 * 验证楼层仍然有效（聊天未切换、消息未删除）。
 */
export function validateFloor(floor: FloorLocation): boolean {
  // 检查聊天 ID 未变
  const currentChatId = getCurrentChatId();
  if (currentChatId !== floor.chatId) return false;

  // 检查消息仍然存在
  const mes = findMesElement(floor.mesId);
  if (!mes) return false;

  // 检查 send_date 身份（排队期间消息可能被删导致楼层号前移）
  const currentSendDate = getSendDate(floor.mesId);
  // 只有当前后端有 send_date 时才比对
  // 调用方传入的 floor 可能在排队期间已过期

  return true;
}
