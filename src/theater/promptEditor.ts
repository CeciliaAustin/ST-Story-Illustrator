/**
 * 小剧场单格「改词」面板。
 *
 * 为什么需要它：小剧场走的是公开出图接口（不是正文里的 <bbi_image> tag），
 * 所以柏宝绘的提示词编辑弹窗管不到这几张图。用户要「像 bbi_image 一样能改词」，
 * 这里补上等价物：正向 tag 与 nl 都是当时真正发出去的那两段，改完就地重画。
 *
 * 不提供「改外貌」：外貌走的是柏宝绘角色库（characters 通道），
 * 改这里等于绕过角色库，重画出来就不是那个人了；要改请去柏宝绘角色页改。
 */

import type { BbiStatusInfo, StoryKind } from '../types';
import { rerollPanel } from './reroll';

const OVERLAY_ID = 'sti-pe-overlay';

function closeEditor(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

export interface PromptEditorOptions {
  floor: number;
  kind: StoryKind;
  setId: string;
  panel: BbiStatusInfo;
  onSaved?: () => void;
}

/** 打开改词面板。 */
export function openPromptEditor(options: PromptEditorOptions): void {
  closeEditor();
  const { panel } = options;

  const overlay = document.createElement('div');
  overlay.className = 'sti-pe-overlay';
  overlay.id = OVERLAY_ID;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeEditor();
  });

  const box = document.createElement('div');
  box.className = 'sti-pe-box';

  const head = document.createElement('div');
  head.className = 'sti-pe-head';
  const title = document.createElement('h3');
  title.textContent = `改词 · 第 ${panel.index + 1} 格`;
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sti-pe-x';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeEditor);
  head.appendChild(close);
  box.appendChild(head);

  const tip = document.createElement('p');
  tip.className = 'sti-pe-tip';
  tip.textContent = '下面两段就是出图时真正发给柏宝绘的内容。正向是 danbooru 短 tag，nl 是自然语言描述；'
    + '画风、画师串、模型由柏宝绘的方案决定，不在这里。';
  box.appendChild(tip);

  const promptLabel = document.createElement('label');
  promptLabel.className = 'sti-pe-label';
  promptLabel.textContent = '正向 tag';
  const promptInput = document.createElement('textarea');
  promptInput.className = 'sti-pe-input';
  promptInput.rows = 4;
  promptInput.value = panel.prompt ?? '';
  promptLabel.appendChild(promptInput);
  box.appendChild(promptLabel);

  const nlLabel = document.createElement('label');
  nlLabel.className = 'sti-pe-label';
  nlLabel.textContent = 'nl（自然语言描述）';
  const nlInput = document.createElement('textarea');
  nlInput.className = 'sti-pe-input';
  nlInput.rows = 3;
  nlInput.value = panel.story ?? '';
  nlLabel.appendChild(nlInput);
  box.appendChild(nlLabel);

  if (panel.characters?.length) {
    const cast = document.createElement('div');
    cast.className = 'sti-pe-cast';
    cast.textContent = `外貌来自柏宝绘角色库：${panel.characters.map(c => c.name).join('、')}`
      + '（要改外貌请去柏宝绘 →「角色」改档，这里改了也会被覆盖）';
    box.appendChild(cast);
  }

  const foot = document.createElement('div');
  foot.className = 'sti-pe-foot';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sti-pe-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeEditor);
  foot.appendChild(cancel);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sti-pe-btn is-main';
  save.textContent = '保存并重画';
  save.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      promptInput.focus();
      return;
    }
    save.disabled = true;
    save.textContent = '重画中…';
    const result = await rerollPanel(options.floor, options.kind, options.setId, panel.index, {
      prompt,
      nl: nlInput.value.trim(),
    });
    save.disabled = false;
    save.textContent = '保存并重画';
    if (!result.ok) {
      const err = document.createElement('div');
      err.className = 'sti-pe-error';
      err.textContent = result.message ?? '重画失败。';
      box.appendChild(err);
      return;
    }
    closeEditor();
    options.onSaved?.();
  });
  foot.appendChild(save);
  box.appendChild(foot);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
}
