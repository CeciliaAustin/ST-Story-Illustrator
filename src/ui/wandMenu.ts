/**
 * 魔杖菜单（#extensionsMenu）入口
 *
 * **只留一个入口**：以前注入了「生成配图」和「配图设置」两条，点开的是同一个面板的
 * 不同标签页——菜单里两条并排，用户看到的是「同一个东西写了两个名字」。
 * 现在只有「配图」一条，面板内部的标签页（生成配图 / 配图设置 / 提示词 / 出图日志）
 * 照样可以互相切换。
 */

import { openStudio } from './studio';

const ITEM = {
  id: 'sti-menu-studio',
  label: '配图',
  title: 'ST 故事插画 · 生成配图 / 配图设置 / 提示词 / 出图日志',
} as const;

function buildItem(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'extension_container interactable';
  wrap.tabIndex = 0;

  const link = document.createElement('a');
  link.id = ITEM.id;
  link.className = 'list-group-item';
  link.href = '#';
  link.title = ITEM.title;

  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-wand-magic-sparkles';
  link.appendChild(icon);
  const text = document.createElement('span');
  text.textContent = ' ' + ITEM.label;
  link.appendChild(text);

  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStudio('generate');
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
    if (!document.getElementById(ITEM.id)) menu.appendChild(buildItem());
    // 已经在菜单里就不用再轮询
    if (document.getElementById(ITEM.id)) window.clearInterval(timer);
  };

  tryInject();
  timer = window.setInterval(tryInject, 800);
  return () => window.clearInterval(timer);
}

export function destroyWandMenu(): void {
  document.getElementById(ITEM.id)?.closest('.extension_container')?.remove();
  document.getElementById(ITEM.id)?.remove();
}
