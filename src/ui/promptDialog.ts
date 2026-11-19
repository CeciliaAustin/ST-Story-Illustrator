/**
 * ST-Story-Illustrator — 改提示词并重画（漫画页）
 *
 * 柏宝绘的楼层卡上有「编辑提示词」，我们的漫画页不写 `<bbi_image>`，就摸不到那个弹窗；
 * 这一层补上等价物：把这一页**当时真正发出去的正向词 + nl** 摊开给人改，改完就地重画。
 *
 * 纪律：
 * - 只改词，不碰角色块（`<characters>` 由 artifact.metadata.characters 保存），
 *   也不重新分镜——分镜是「重新选段生成」的事；
 * - 带字气泡不烧进图：重画落的仍是无字原图，气泡由显示层按新台词重合成；
 * - 重画期间锁住面板，失败把原因写在面板里（不弹窗、不丢用户输入）。
 */

export interface PromptDialogOptions {
  /** 当前正向提示词（必填时为空也能打开，让用户自己填）。 */
  prompt: string;
  /** 当前 nl；没有就是空串。 */
  nl: string;
  /** 标题下的一句说明（例如「第 2 页 · 3 格」）。 */
  subtitle?: string;
  /** 点「保存并重画」时调用；返回 ok=false 时面板保持打开并显示 message。 */
  onApply: (prompt: string, nl: string) => Promise<{ ok: boolean; message?: string }>;
}

let mask: HTMLElement | null = null;

function ensureMask(): HTMLElement {
  if (mask) return mask;
  const el = document.createElement('div');
  el.className = 'sti-dlg-mask';
  el.style.display = 'none';
  document.body.appendChild(el);
  mask = el;
  return el;
}

/** 打开改词面板。同一时刻只允许一个。 */
export function openPromptDialog(options: PromptDialogOptions): void {
  const host = ensureMask();
  host.innerHTML = '';
  host.style.display = 'flex';
  host.onclick = event => { if (event.target === host) close(); };

  const panel = document.createElement('div');
  panel.className = 'sti-prompt-dlg';
  panel.addEventListener('click', event => event.stopPropagation());
  host.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'sti-prompt-dlg__head';
  const title = document.createElement('div');
  title.className = 'sti-prompt-dlg__title';
  title.textContent = '改提示词并重画';
  head.appendChild(title);
  if (options.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'sti-prompt-dlg__sub';
    sub.textContent = options.subtitle;
    head.appendChild(sub);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'sti-prompt-dlg__x';
  x.textContent = '×';
  x.setAttribute('aria-label', '关闭');
  x.addEventListener('click', close);
  head.appendChild(x);
  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'sti-prompt-dlg__body';
  panel.appendChild(body);

  const promptLabel = document.createElement('label');
  promptLabel.className = 'sti-prompt-dlg__label';
  promptLabel.textContent = '正向提示词（Base：人数 / 场景 / 构图 / 光线）';
  const promptArea = document.createElement('textarea');
  promptArea.className = 'sti-prompt-dlg__area';
  promptArea.value = options.prompt;
  promptArea.spellcheck = false;
  promptArea.rows = 8;
  body.append(promptLabel, promptArea);

  const nlLabel = document.createElement('label');
  nlLabel.className = 'sti-prompt-dlg__label';
  nlLabel.textContent = '自然语言画面描述（nl，可留空）';
  const nlArea = document.createElement('textarea');
  nlArea.className = 'sti-prompt-dlg__area is-nl';
  nlArea.value = options.nl;
  nlArea.spellcheck = false;
  nlArea.rows = 4;
  body.append(nlLabel, nlArea);

  const hint = document.createElement('p');
  hint.className = 'sti-prompt-dlg__hint';
  hint.textContent = '角色块（<characters>）不受影响；保存后立刻用新词重画这一页，台词气泡会按当前台词重新合成。';
  body.appendChild(hint);

  const foot = document.createElement('div');
  foot.className = 'sti-prompt-dlg__foot';
  const status = document.createElement('span');
  status.className = 'sti-prompt-dlg__status';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sti-prompt-dlg__btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', close);
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'sti-prompt-dlg__btn sti-prompt-dlg__btn--main';
  apply.textContent = '保存并重画';
  foot.append(status, cancel, apply);
  panel.appendChild(foot);

  let busy = false;
  apply.addEventListener('click', () => {
    if (busy) return;
    const prompt = promptArea.value.trim();
    if (!prompt) {
      status.textContent = '正向提示词不能为空。';
      promptArea.focus();
      return;
    }
    busy = true;
    status.textContent = '';
    apply.disabled = true;
    cancel.disabled = true;
    apply.textContent = '重画中…';
    void (async () => {
      try {
        const result = await options.onApply(prompt, nlArea.value.trim());
        if (result.ok) {
          close();
          return;
        }
        status.textContent = result.message ?? '重画失败。';
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
        apply.disabled = false;
        cancel.disabled = false;
        apply.textContent = '保存并重画';
      }
    })();
  });

  promptArea.focus();
}

function close(): void {
  if (!mask) return;
  mask.style.display = 'none';
  mask.innerHTML = '';
}

export function destroyPromptDialog(): void {
  if (mask) { mask.remove(); mask = null; }
}
