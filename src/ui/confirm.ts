/**
 * ST-Story-Illustrator — 轻量确认框
 *
 * 为什么不用 `window.confirm`：它是同步阻塞的，而删除要先把气泡合成的 blob 撤销、
 * 再从 DOM 摘卡片，同步弹窗会卡住整条渲染；手机上 confirm 的样式也完全脱离插件。
 * 这里用一层 mask + 一个小卡片，跟改词面板同一套视觉。
 */

let mask: HTMLElement | null = null;

function ensureMask(): HTMLElement {
  if (mask && mask.isConnected) return mask;
  const el = document.createElement('div');
  el.className = 'sti-dlg-mask';
  el.style.display = 'none';
  document.body.appendChild(el);
  mask = el;
  return el;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  /** 确认按钮文案，默认「删除」。 */
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除）用红色按钮，默认 true。 */
  danger?: boolean;
}

/** 打开确认框；确认返回 true，取消/点遮罩返回 false。同一时刻只会有一个。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const host = ensureMask();
  host.innerHTML = '';
  host.style.display = 'flex';

  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      host.style.display = 'none';
      host.innerHTML = '';
      resolve(value);
    };

    host.onclick = event => { if (event.target === host) finish(false); };

    const panel = document.createElement('div');
    panel.className = 'sti-confirm';
    panel.addEventListener('click', event => event.stopPropagation());

    const title = document.createElement('div');
    title.className = 'sti-confirm__title';
    title.textContent = options.title ?? '确认删除';
    panel.appendChild(title);

    const message = document.createElement('div');
    message.className = 'sti-confirm__msg';
    message.textContent = options.message;
    panel.appendChild(message);

    const foot = document.createElement('div');
    foot.className = 'sti-confirm__foot';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sti-prompt-dlg__btn';
    cancel.textContent = options.cancelText ?? '取消';
    cancel.addEventListener('click', () => finish(false));

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = `sti-prompt-dlg__btn ${options.danger === false ? 'sti-prompt-dlg__btn--main' : 'sti-confirm__btn--danger'}`;
    ok.textContent = options.confirmText ?? '删除';
    ok.addEventListener('click', () => finish(true));

    foot.append(cancel, ok);
    panel.appendChild(foot);
    host.appendChild(panel);
    ok.focus();
  });
}

export function destroyConfirm(): void {
  if (mask) { mask.remove(); mask = null; }
}
