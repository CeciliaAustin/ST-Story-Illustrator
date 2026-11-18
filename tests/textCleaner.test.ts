import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanMessageText } from '../src/selection/textCleaner';

/** 提供一个假的 globalThis.getContext，返回带 extensionSettings 的上下文。 */
function fakeContext(ext: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>).getContext = () => ({ extensionSettings: ext });
}
function clearContext(): void {
  delete (globalThis as Record<string, unknown>).getContext;
}

describe('textCleaner 与柏宝绘同步清洗', () => {
  beforeEach(() => clearContext());
  afterEach(() => clearContext());

  it('移除思维链块', () => {
    const text = '前文<think>内部推理内容</think>后文';
    const out = cleanMessageText(text, { syncBaiBai: false });
    expect(out).toBe('前文后文');
  });

  it('移除 thinking（带 s）块', () => {
    const out = cleanMessageText('A<thinking>secret</thinking>B', { syncBaiBai: false });
    expect(out).toBe('AB');
  });

  it('移除 HTML 注释与 horae 块', () => {
    const out = cleanMessageText('A<!-- 注释 -->B<horae>噪音</horae>C', { syncBaiBai: false });
    expect(out).toBe('ABC');
  });

  it('移除 bbi_image 标签整体', () => {
    const out = cleanMessageText('正文<bbi_image>tag<nl>desc</nl></bbi_image>继续', { syncBaiBai: false });
    expect(out).toBe('正文继续');
  });

  it('preferContent 只提取 content 内文本', () => {
    const mes = '<think>推理</think><content>真正的剧情正文</content>';
    const out = cleanMessageText(mes, { syncBaiBai: false, preferContent: true });
    expect(out).toBe('真正的剧情正文');
  });

  it('关闭 preferContent 时不提取 content 但会去掉标签壳', () => {
    const out = cleanMessageText('<content>正文</content>', { syncBaiBai: false, preferContent: false });
    expect(out).toBe('正文');
  });

  it('同步柏宝绘 customStripTags', () => {
    fakeContext({
      baibai_exclude_settings: { customStripTags: ['status', '雪'] },
    });
    const out = cleanMessageText('A<status>状态栏内容</status>B<雪>天气</雪>C', { syncBaiBai: true });
    expect(out).toBe('ABC');
  });

  it('支持镜像形态 excludes.customStripTags', () => {
    fakeContext({
      baibai_exclude_settings: { excludes: { customStripTags: ['note'] } },
    });
    const out = cleanMessageText('A<note>旁注</note>B', { syncBaiBai: true });
    expect(out).toBe('AB');
  });

  it('读不到共享设置时安全降级', () => {
    const out = cleanMessageText('A<status>内容</status>B', { syncBaiBai: true });
    // 无共享名单时 status 不是内置标签，只去壳留内容
    expect(out).toBe('A内容B');
  });

  it('中文标签整块删除（前瞻边界）', () => {
    fakeContext({ baibai_exclude_settings: { customStripTags: ['雪'] } });
    const out = cleanMessageText('前<雪>雪景描写</雪>后<雪ball>保留</雪ball>', { syncBaiBai: true });
    expect(out).toContain('前后');
    expect(out).toContain('保留');
  });
});
