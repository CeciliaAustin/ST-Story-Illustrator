/**
 * ST-Story-Illustrator — 可视化任务串行队列
 *
 * 职责（任务 #6 后半）：
 * - 串行执行 VisualTask（读剧情→出图→落盘），一次只跑一个，避免打爆柏宝绘并发闸门
 * - 支持取消、进度回调、看门狗超时（防止单个任务卡死整条队列）
 * - 队列与 ST 环境解耦：runOne 通过构造参数注入，便于测试
 *
 * 设计：任务体是 (task, ctx) => Promise<void> 的函数，由上层（index.ts 工作流）提供。
 * 队列本身只负责调度、串行、取消与超时，不关心具体模式。
 */

import type { VisualTask, VisualTaskStatus } from '../types';

// ============================================================
// 类型
// ============================================================

export interface QueueRunContext {
  /** 请求取消当前任务 */
  signal: AbortSignal;
  /** 上报进度（stage/page/panel 等） */
  report: (progress: NonNullable<VisualTask['progress']>) => void;
  /** 更新任务状态（队列会在关键点自动调用，任务体也可主动调用） */
  setStatus: (status: VisualTaskStatus) => void;
}

export type TaskRunner = (task: VisualTask, ctx: QueueRunContext) => Promise<void>;

export interface TaskQueueOptions {
  /** 单个任务看门狗超时（毫秒），0 = 不启用。默认 5 分钟。 */
  taskTimeoutMs?: number;
  /** 任务完成回调 */
  onComplete?: (task: VisualTask) => void;
  /** 任务失败回调 */
  onError?: (task: VisualTask, error: Error) => void;
  /** 任务状态变化回调（用于刷新 UI） */
  onStatusChange?: (task: VisualTask, status: VisualTaskStatus) => void;
}

interface QueueEntry {
  task: VisualTask;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

// ============================================================
// 队列实现
// ============================================================

export class TaskQueue {
  private pending: VisualTask[] = [];
  private current: QueueEntry | null = null;
  private running = false;
  private runner: TaskRunner;
  private options: TaskQueueOptions;
  private timeoutMs: number;

  constructor(runner: TaskRunner, options: TaskQueueOptions = {}) {
    this.runner = runner;
    this.options = options;
    this.timeoutMs = options.taskTimeoutMs ?? 5 * 60 * 1000;
  }

  /** 入队。重复 task.id 会被去重（忽略后入的）。 */
  enqueue(task: VisualTask): void {
    if (this.pending.some(t => t.id === task.id)) return;
    if (this.current?.task.id === task.id) return;
    this.pending.push(task);
    this.setStatus(task, 'queued');
    void this.drain();
  }

  /** 取消指定任务：排队中的直接移除；运行中的发出 abort。 */
  cancel(taskId: string): void {
    const idx = this.pending.findIndex(t => t.id === taskId);
    if (idx >= 0) {
      const [task] = this.pending.splice(idx, 1);
      this.setStatus(task, 'cancelled');
      return;
    }
    if (this.current?.task.id === taskId) {
      this.current.controller.abort();
    }
  }

  /** 取消全部（排队中 + 运行中）。 */
  cancelAll(): void {
    for (const task of this.pending.splice(0)) this.setStatus(task, 'cancelled');
    if (this.current) this.current.controller.abort();
  }

  /** 等待当前队列排空（测试用）。 */
  async idle(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  get size(): number {
    return this.pending.length + (this.current ? 1 : 0);
  }

  // ----------------------------------------------------------
  // 内部调度
  // ----------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const task = this.pending.shift()!;
        const controller = new AbortController();
        const entry: QueueEntry = { task, controller, timer: null };
        this.current = entry;

        // 看门狗：超时则 abort（任务体应响应 signal）
        if (this.timeoutMs > 0) {
          entry.timer = setTimeout(() => controller.abort(), this.timeoutMs);
        }

        const ctx: QueueRunContext = {
          signal: controller.signal,
          report: progress => {
            task.progress = progress;
            task.updatedAt = Date.now();
          },
          setStatus: status => this.setStatus(task, status),
        };

        try {
          if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
          this.setStatus(task, 'reading');
          await this.runner(task, ctx);
          if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
          this.setStatus(task, 'completed');
          this.options.onComplete?.(task);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const cancelled = error.name === 'AbortError' || controller.signal.aborted;
          this.setStatus(task, cancelled ? 'cancelled' : 'failed');
          if (!cancelled) {
            task.error = error.message;
            this.options.onError?.(task, error);
          }
        } finally {
          if (entry.timer) clearTimeout(entry.timer);
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private setStatus(task: VisualTask, status: VisualTaskStatus): void {
    task.status = status;
    task.updatedAt = Date.now();
    this.options.onStatusChange?.(task, status);
  }
}
