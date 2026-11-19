/**
 * ST-Story-Illustrator — 画面密度图（气泡避让的「眼睛」）
 *
 * 为什么需要：之前的避让全靠两套**猜**的矩形——整页的「脸在 0.33~0.67」和
 * 每格的「头在上半」。每格猜错一次，气泡就正好压在脸上；不规则拼版连格的几何
 * 都不知道，只能退回整页猜。用户看到的永远是同一句抱怨：「台词还是挡脸」。
 *
 * 这里改成看**这张图本身**：把成图缩成一张很粗的网格，算每一小块的「有多花」。
 * 白底、留白、大片纯色 → 0；线稿、头发、花纹、阴影 → 高。气泡落点往 0 的地方去。
 *
 * 全部是纯函数（像素数组进、网格出），DOM 只在 `readBusyGrid` 这一层出现。
 */

/** 粗网格：20×28 对 832×1216 的图大约每格 42×43 像素，比一颗气泡小得多。 */
export const BUSY_COLS = 20;
export const BUSY_ROWS = 28;

export interface BusyGrid {
  cols: number;
  rows: number;
  /** 每个格子的密度 0~1（行优先），越高越不适合压字 */
  cells: number[];
  /** 整幅平均密度：判断「这页几乎是空白的白底页」用 */
  mean: number;
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * 像素 → 密度网格。
 *
 * 每格算两件事：
 * - **线条密度**：格内亮度的标准差。白底几乎为 0，线稿/网点/花纹很高；
 * - **深色占比**：格内平均亮度偏低（头发、黑衣、暗背景）。深色块上盖白气泡
 *   虽然能读，但会把画面糊掉一块，所以也算「忙」。
 *
 * 阈值 0.04 是白底页的自然噪声（JPEG 压缩、轻微渐变）——低于它的起伏当没有。
 */
export function buildBusyGrid(
  data: Uint8ClampedArray | readonly number[],
  width: number,
  height: number,
  cols: number = BUSY_COLS,
  rows: number = BUSY_ROWS,
): BusyGrid {
  const c = Math.max(1, Math.round(cols));
  const r = Math.max(1, Math.round(rows));
  const sum = new Array<number>(c * r).fill(0);
  const sumSq = new Array<number>(c * r).fill(0);
  const count = new Array<number>(c * r).fill(0);

  if (!width || !height || data.length < 4) {
    return { cols: c, rows: r, cells: new Array<number>(c * r).fill(0), mean: 0 };
  }

  // 逐像素扫太慢（一张 832×1216 就是 100 万次）；按目标格数反推采样步长，
  // 每格取 4×4 个样本就够了——我们只要「花不花」，不需要精确统计。
  const stepX = Math.max(1, Math.floor(width / (c * 4)));
  const stepY = Math.max(1, Math.floor(height / (r * 4)));

  for (let y = 0; y < height; y += stepY) {
    const gy = Math.min(r - 1, Math.floor((y * r) / height));
    for (let x = 0; x < width; x += stepX) {
      const gx = Math.min(c - 1, Math.floor((x * c) / width));
      const i = (y * width + x) * 4;
      const alpha = data[i + 3];
      if (alpha !== undefined && alpha < 8) continue;
      const lum = (0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)) / 255;
      const k = gy * c + gx;
      sum[k] += lum;
      sumSq[k] += lum * lum;
      count[k] += 1;
    }
  }

  const cells: number[] = [];
  let total = 0;
  for (let k = 0; k < c * r; k += 1) {
    const n = count[k];
    if (!n) {
      cells.push(0);
      continue;
    }
    const mean = sum[k] / n;
    const variance = Math.max(0, sumSq[k] / n - mean * mean);
    const std = Math.sqrt(variance);
    // 线条/花纹：标准差超过白底噪声才开始算
    const density = clamp01((std - 0.04) * 2.8);
    // 深色区：整体压暗（头发、黑衣、夜景）
    const darkness = clamp01((0.52 - mean) * 1.6);
    const busy = clamp01(0.75 * density + 0.45 * darkness);
    cells.push(Math.round(busy * 1000) / 1000);
    total += busy;
  }

  return {
    cols: c,
    rows: r,
    cells,
    mean: Math.round((total / Math.max(1, c * r)) * 1000) / 1000,
  };
}

export interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一块归一化矩形（0~1）盖住的平均密度，按覆盖面积加权。
 *
 * 用面积加权而不是「格心落在框里」：气泡只有两三个格宽时，格心法会把
 * 半个气泡的实际情况丢掉，落点就会跳来跳去。
 */
export function busyInRect(grid: BusyGrid | undefined, rect: NormRect): number {
  if (!grid || !grid.cells.length) return 0;
  const x0 = clamp01(Math.min(rect.x, rect.x + rect.width));
  const y0 = clamp01(Math.min(rect.y, rect.y + rect.height));
  const x1 = clamp01(Math.max(rect.x, rect.x + rect.width));
  const y1 = clamp01(Math.max(rect.y, rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return 0;

  const cw = 1 / grid.cols;
  const ch = 1 / grid.rows;
  let weighted = 0;
  let area = 0;
  for (let gy = 0; gy < grid.rows; gy += 1) {
    const cy0 = gy * ch;
    const cy1 = cy0 + ch;
    const oy = Math.min(y1, cy1) - Math.max(y0, cy0);
    if (oy <= 0) continue;
    for (let gx = 0; gx < grid.cols; gx += 1) {
      const cx0 = gx * cw;
      const cx1 = cx0 + cw;
      const ox = Math.min(x1, cx1) - Math.max(x0, cx0);
      if (ox <= 0) continue;
      const w = ox * oy;
      weighted += (grid.cells[gy * grid.cols + gx] ?? 0) * w;
      area += w;
    }
  }
  return area > 0 ? weighted / area : 0;
}

/** 这一页是不是「几乎空白」：白底档 + 干净线稿时，气泡优先级可以放宽。 */
export function isSparsePage(grid: BusyGrid | undefined): boolean {
  return !!grid && grid.mean <= 0.18;
}

/**
 * 从成图读密度网格（唯一碰 DOM 的地方）。
 *
 * 做法是把图画进一张 20×28 的小 canvas 再 getImageData——比在整图上扫像素快两个
 * 数量级，而且图已经能画进主 canvas，说明没有 CORS 污染，这里同样安全。
 * 任何异常都返回 null：拿不到密度就退回旧的几何避让，不能让气泡整体失败。
 */
export function readBusyGrid(
  image: CanvasImageSource & { naturalWidth?: number; width?: number; naturalHeight?: number; height?: number },
  cols: number = BUSY_COLS,
  rows: number = BUSY_ROWS,
): BusyGrid | null {
  try {
    const w = Number(image.naturalWidth ?? image.width ?? 0);
    const h = Number(image.naturalHeight ?? image.height ?? 0);
    if (!w || !h) return null;
    const small = document.createElement('canvas');
    small.width = cols;
    small.height = rows;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, cols, rows);
    const { data } = ctx.getImageData(0, 0, cols, rows);
    return buildBusyGrid(data, cols, rows, cols, rows);
  } catch {
    return null;
  }
}
