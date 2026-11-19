/**
 * 统一面板入口
 *
 * 「生成配图」和「配图设置」现在是同一个面板的两个标签页：
 * 悬浮球 🎨 / 魔杖菜单 / 划词按钮都从这里进入，互相切换不丢状态。
 *
 * 用注册表避免模块循环依赖：两个面板各自渲染时只需要 buildStudioTabs()，
 * 真正的跳转实现由 index.ts 在激活时注册。
 */

export type StudioTab = 'generate' | 'settings';

export interface StudioHandlers {
  generate: (options?: { floor?: number; text?: string }) => void;
  settings: () => void;
}

let handlers: StudioHandlers | null = null;

export function registerStudio(next: StudioHandlers): void {
  handlers = next;
}

export function isStudioReady(): boolean {
  return !!handlers;
}

export function openStudio(tab: StudioTab, options?: { floor?: number; text?: string }): void {
  if (!handlers) {
    console.warn('[ST-Story-Illustrator] 面板尚未就绪。');
    return;
  }
  if (tab === 'settings') handlers.settings();
  else handlers.generate(options);
}

const TAB_LABELS: Array<{ tab: StudioTab; label: string; icon: string }> = [
  { tab: 'generate', label: '生成配图', icon: 'fa-wand-magic-sparkles' },
  { tab: 'settings', label: '配图设置', icon: 'fa-sliders' },
];

/** 面板顶部的两个标签页。两个面板共用同一套样式，切换时看起来是同一个面板。 */
export function buildStudioTabs(active: StudioTab): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'sti-studio-tabs';
  for (const { tab, label, icon } of TAB_LABELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sti-studio-tab${tab === active ? ' active' : ''}`;
    btn.dataset.tab = tab;

    const i = document.createElement('i');
    i.className = `fa-solid ${icon}`;
    btn.appendChild(i);
    btn.appendChild(document.createTextNode(' ' + label));

    btn.addEventListener('click', () => {
      if (tab === active) return;
      openStudio(tab);
    });
    bar.appendChild(btn);
  }
  return bar;
}
