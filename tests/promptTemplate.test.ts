/**
 * 提示词模板：变量 / 条件段 / 空行折叠。
 * 用户会手改这些模板，语法要是错一点就整段提示词变形，所以单测盯死。
 */

import { describe, it, expect } from 'vitest';
import { renderTemplate, renderCompact, collapseBlankLines } from '../src/prompt/template';

describe('renderTemplate', () => {
  it('替换变量', () => {
    expect(renderTemplate('切 {{count}} 格', { count: 3 })).toBe('切 3 格');
  });

  it('未知变量替换成空串（不会把 {{xxx}} 发给模型）', () => {
    expect(renderTemplate('A{{nope}}B')).toBe('AB');
  });

  it('{{#x}} 成立才保留', () => {
    const t = '前{{#on}}中{{/on}}后';
    expect(renderTemplate(t, { on: true })).toBe('前中后');
    expect(renderTemplate(t, { on: false })).toBe('前后');
  });

  it('{{^x}} 不成立才保留', () => {
    const t = '前{{^on}}中{{/on}}后';
    expect(renderTemplate(t, { on: false })).toBe('前中后');
    expect(renderTemplate(t, { on: true })).toBe('前后');
  });

  it('空字符串 / 0 视为不成立', () => {
    const t = '{{#on}}有{{/on}}{{^on}}无{{/on}}';
    expect(renderTemplate(t, { on: '' })).toBe('无');
    expect(renderTemplate(t, { on: 0 })).toBe('无');
  });

  it('多组条件可以共存，互不干扰', () => {
    const t = '{{#a}}A{{/a}}{{#b}}B{{/b}}';
    expect(renderTemplate(t, { a: true, b: false })).toBe('A');
    expect(renderTemplate(t, { a: false, b: true })).toBe('B');
  });

  it('条件段里的逗号/花括号不影响替换', () => {
    const t = '{"lines":[1]{{#d}},{"x":2}{{/d}}}';
    expect(renderTemplate(t, { d: true })).toBe('{"lines":[1],{"x":2}}');
    expect(renderTemplate(t, { d: false })).toBe('{"lines":[1]}');
  });

  it('空模板返回空串', () => {
    expect(renderTemplate('')).toBe('');
  });
});

describe('collapseBlankLines', () => {
  it('三个以上换行压成两个（保留段落间距）', () => {
    expect(collapseBlankLines('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('条件段留下的多余空行被压回一个段间距', () => {
    const rendered = renderCompact('第一行\n{{#off}}\n第二行情况\n{{/off}}\n第三行', { off: false });
    expect(rendered).toBe('第一行\n\n第三行');
  });

  it('去掉首尾空白', () => {
    expect(collapseBlankLines('\n\n  a  \n\n')).toBe('a');
  });
});
