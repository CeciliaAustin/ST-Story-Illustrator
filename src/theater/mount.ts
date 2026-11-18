/**
 * ST-Story-Illustrator — 小剧场楼层挂载
 *
 * 从 message.extra.sti_theater 三桶读取故事，挂到楼层底部独立区域（trailing）。
 * 不写进正文；台词用 textContent 渲染（不注入 HTML）。
 */

import type { BbiStatusInfo } from '../types';
import { getStories, removeStory } from './store';
import { openLightbox } from '../ui/lightbox';

type Bucket = 'status' | 'bonus' | 'manga';

const AREA_ID = 'sti-theater-area-';
const AREA_CLASS = 'sti-cs-bar';
const MOUNTED_ATTR = 'data-sti-theater-mounted';

const BUCKET_LABELS: Record<Bucket, string> = {
  status: 'QQ人小剧场',
  bonus: '彩蛋',
  manga: '黑白漫',
};

/** 重挂某楼层的小剧场卡片。 */
export function mountTheater(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  unmountTheater(floor);

  const all: Array<{ bucket: Bucket; story: BbiStatusInfo }> = [];
  for (const bucket of ['status', 'bonus', 'manga'] as Bucket[]) {
    for (const story of getStories(floor, bucket)) all.push({ bucket, story });
  }
  if (all.length === 0) return;

  const mesBlock = mes.querySelector<HTMLElement>('.mes_block') ?? mes;
  const area = document.createElement('div');
  area.id = `${AREA_ID}${floor}`;
  area.className = AREA_CLASS;
  area.setAttribute(MOUNTED_ATTR, String(floor));

  for (const { bucket, story } of all) {
    area.appendChild(buildTheaterCard(floor, bucket, story));
  }
  mesBlock.appendChild(area);
}

export function unmountTheater(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const areas = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"]`);
  for (const area of Array.from(areas)) area.remove();
}

function buildTheaterCard(floor: number, bucket: Bucket, story: BbiStatusInfo): HTMLElement {
  const card = document.createElement('details');
  card.className = 'sti-cs-card';

  const summary = document.createElement('summary');
  summary.className = 'sti-cs-headline';
  const kicker = document.createElement('span');
  kicker.className = 'sti-cs-kicker';
  kicker.textContent = BUCKET_LABELS[bucket];
  summary.appendChild(kicker);
  summary.appendChild(document.createTextNode(' ' + (story.title || `第 ${story.index + 1} 格`)));
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'sti-cs-body';

  if (story.imagePath) {
    const figure = document.createElement('div');
    figure.className = 'sti-cs-figure';
    const img = document.createElement('img');
    img.className = 'sti-cs-photo';
    img.src = story.imagePath;
    img.alt = story.title ?? '小剧场';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(story.imagePath!, story.title));
    figure.appendChild(img);
    body.appendChild(figure);
  }

  if (story.lines && story.lines.length) {
    const lines = document.createElement('div');
    lines.className = 'sti-cs-lines';
    for (const line of story.lines) {
      const row = document.createElement('div');
      row.className = 'sti-cs-line';
      if (line.speaker) {
        const b = document.createElement('b');
        b.textContent = line.speaker;
        row.appendChild(b);
      }
      row.appendChild(document.createTextNode(line.text));
      lines.appendChild(row);
    }
    body.appendChild(lines);
  }

  const actions = document.createElement('div');
  actions.className = 'sti-cs-actions';
  const del = document.createElement('button');
  del.className = 'sti-cs-regen';
  del.textContent = '删除';
  del.addEventListener('click', (e) => {
    e.preventDefault();
    removeStory(floor, bucket, story.storyId);
    mountTheater(floor);
  });
  actions.appendChild(del);
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}
