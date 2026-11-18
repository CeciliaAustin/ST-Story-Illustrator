/**
 * 把 dist/ 的构建产物复制到扩展根目录。
 * ST 的 manifest.json 从扩展根目录加载 index.js / style.css。
 * 跨平台 Node 脚本（避免依赖 cp 命令）。
 */
import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['index.js', 'style.css']) {
  const src = resolve(root, 'dist', name);
  const dest = resolve(root, name);
  if (!existsSync(src)) {
    console.error(`[copy-build] 缺少构建产物: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`[copy-build] ${name} → 扩展根目录`);
}
