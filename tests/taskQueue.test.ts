/**
 * 串行任务队列测试
 */

import { describe, it, expect } from 'vitest';
import { TaskQueue, type TaskRunner } from '../src/tasks/taskQueue';
import type { VisualTask } from '../src/types';

function makeTask(id: string): VisualTask {
  return {
    id,
    chatId: 'chat-1',
    source: { chatId: 'chat-1', sourceKind: 'single', floorIds: [0], text: 'x', messages: [], createdAt: 0 },
    mode: 'illustration',
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('TaskQueue', () => {
  it('runs tasks serially in order', async () => {
    const order: string[] = [];
    const runner: TaskRunner = async (task) => {
      order.push(`${task.id}:start`);
      await delay(10);
      order.push(`${task.id}:end`);
    };
    const q = new TaskQueue(runner);
    q.enqueue(makeTask('a'));
    q.enqueue(makeTask('b'));
    q.enqueue(makeTask('c'));
    await q.idle();
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('deduplicates by task id', async () => {
    let count = 0;
    const runner: TaskRunner = async () => { count += 1; };
    const q = new TaskQueue(runner);
    q.enqueue(makeTask('a'));
    q.enqueue(makeTask('a'));
    await q.idle();
    expect(count).toBe(1);
  });

  it('sets status through lifecycle', async () => {
    const statuses: string[] = [];
    const runner: TaskRunner = async () => {};
    const q = new TaskQueue(runner, {
      onStatusChange: (_t, s) => statuses.push(s),
    });
    const task = makeTask('a');
    q.enqueue(task);
    await q.idle();
    expect(statuses).toContain('queued');
    expect(statuses).toContain('reading');
    expect(statuses).toContain('completed');
  });

  it('marks task failed and calls onError on throw', async () => {
    let errored: Error | null = null;
    const runner: TaskRunner = async () => { throw new Error('boom'); };
    const q = new TaskQueue(runner, { onError: (_t, e) => { errored = e; } });
    const task = makeTask('a');
    q.enqueue(task);
    await q.idle();
    expect(task.status).toBe('failed');
    expect(task.error).toBe('boom');
    expect(errored).not.toBeNull();
  });

  it('cancels a queued task before it starts', async () => {
    const ran: string[] = [];
    const runner: TaskRunner = async (task) => { ran.push(task.id); };
    const q = new TaskQueue(runner);
    q.enqueue(makeTask('a'));
    q.enqueue(makeTask('b'));
    q.cancel('b');
    await q.idle();
    expect(ran).toEqual(['a']);
  });

  it('aborts a running task via signal', async () => {
    const runner: TaskRunner = async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
    const q = new TaskQueue(runner);
    const task = makeTask('a');
    q.enqueue(task);
    await delay(5);
    q.cancel('a');
    await q.idle();
    expect(task.status).toBe('cancelled');
  });

  it('watchdog aborts a hanging task', async () => {
    const runner: TaskRunner = async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
      });
    };
    const q = new TaskQueue(runner, { taskTimeoutMs: 20 });
    const task = makeTask('a');
    q.enqueue(task);
    await q.idle();
    expect(task.status).toBe('cancelled');
  });

  it('forwards progress reports', async () => {
    const runner: TaskRunner = async (_task, ctx) => {
      ctx.report({ stage: 'generating', page: 1, totalPages: 2 });
    };
    const q = new TaskQueue(runner);
    const task = makeTask('a');
    q.enqueue(task);
    await q.idle();
    expect(task.progress?.stage).toBe('generating');
    expect(task.progress?.page).toBe(1);
  });
});
