/**
 * 魔杖菜单（#extensionsMenu）入口
 *
 * 注入两个入口，都指向同一个面板的两个标签页：
 *   🎨 生成配图 —— 不需要先划线，打开后可自己选楼层/范围/勾选
 *   🎨 配图设置 —— 出图方案、接入点、小剧场开关
 */

import { openStudio } from './studio';

const ITEMS: Array<{ id: string; label: string; title: string; icon: string; tab: 'generate' | 'settings' }> = [
  {
    id: 'sti-menu-generate',
    label: '生成配图',
    title: 'ST 故事插画 · 生成配图（也可先划线）',
    icon: 'fa-wand-magic-sparkles',
    tab: 'generate',
  },
  {
    id: 'sti-menu-config',
    label: '配图设置',
    title: 'ST 故事插画 · 出图方案 / 小剧场设置',
    icon: 'fa-images',
    tab: 'settings',
  },
];

function buildItem(spec: (typeof ITEMS)[number]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'extension_container interactable';
  wrap.tabIndex = 0;

  const link = document.createElement('a');
  link.id = spec.id;
  link.className = 'list-group-item';
  link.href = '#';
  link.title = spec.title;

  const icon = document.createElement('i');
  icon.className = `fa-solid ${spec.icon}`;
  link.appendChild(icon);
  const text = document.createElement('span');
  text.textContent = ' ' + spec.label;
  link.appendChild(text);

  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStudio(spec.tab);
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
      menu.style.display = 'none';
      menu.classList.remove('visible');
    }
  });

  wrap.appendChild(link);
  return wrap;
}

/** 注入魔杖菜单入口（懒加载轮询；菜单被 ST 重建后会自动补回）。 */
export function injectWandMenu(): () => void {
  let timer = 0;

  const tryInject = () => {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    for (const spec of ITEMS) {
      if (document.getElementById(spec.id)) continue;
      menu.appendChild(buildItem(spec));
    }
    // 两个入口都在了就不用再轮询
    if (ITEMS.every(spec => !!document.getElementById(spec.id))) {
      window.clearInterval(timer);
    }
  };

  tryInject();
  timer = window.setInterval(tryInject, 800);
  return () => window.clearInterval(timer);
}

export function destroyWandMenu(): void {
  for (const spec of ITEMS) {
    document.getElementById(spec.id)?.closest('.extension_container')?.remove();
    document.getElementById(spec.id)?.remove();
  }
}
