import { describe, it, expect } from 'vitest';
import { buildImageSnippet } from '../src/ui/bodyInserter';

describe('buildImageSnippet', () => {
  it('生成 markdown 图片语法', () => {
    const s = buildImageSnippet('/images/test.png', '配图');
    expect(s).toContain('![配图](/images/test.png)');
  });

  it('转义 alt 中的方括号与换行', () => {
    const s = buildImageSnippet('/img.png', 'a]b\nc');
    expect(s).toContain('![a b c](/img.png)');
  });

  it('空 alt 回退为配图', () => {
    const s = buildImageSnippet('/img.png', '');
    expect(s).toContain('![配图](/img.png)');
  });
});
