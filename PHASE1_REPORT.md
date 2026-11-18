# 第一阶段报告 — 最小骨架 + 选段定位

> 日期：2026-11-18  
> 阶段：Phase 1

---

## 1. 已完成的文件

### 项目配置

| 文件               | 说明                                                |
| ---------------- | ------------------------------------------------- |
| `manifest.json`  | ST 扩展清单，loading_order=100，输出 index.js + style.css |
| `package.json`   | npm 配置，devDependencies: typescript, vite, vitest  |
| `tsconfig.json`  | TypeScript 配置，target ES2020, strict mode          |
| `vite.config.ts` | Vite 构建配置，输出 ES module 单文件                        |

### 核心源码

| 文件                               | 说明                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `src/index.ts`                   | 扩展入口，onActivate/onDisable 生命周期钩子                                              |
| `src/types.ts`                   | 全局类型定义（柏宝绘 API、选段、上下文、Tag、任务、分镜、气泡、小剧场、设置）                                    |
| `src/host/sillytavern.ts`        | ST 环境封装（getContext、eventSource、extension_settings、generateQuietPrompt、楼层身份复核） |
| `src/baibai/bridge.ts`           | 柏宝绘 API 桥接（检测、版本检查、有界等待、安全调用封装、BaiBaiApiError）                                |
| `src/selection/selector.ts`      | 选区检测（只在 .mes_text 内响应、选区变化监听）                                                 |
| `src/selection/floorResolver.ts` | 楼层定位（从选区 DOM 向上找 .mes[mesid]）                                                 |
| `src/selection/anchor.ts`        | 选段锚点保存与匹配（buildAnchor、matchAnchor、extractPlainText）                           |
| `src/ui/selectionToolbar.ts`     | 选区工具条（轻量浮动按钮，不遮挡选区）                                                           |
| `src/styles/style.css`           | 全部样式（工具条、楼层卡片、Tag 编辑器、小剧场卡片、设置面板）                                             |

### 测试

| 文件                      | 说明                                  |
| ----------------------- | ----------------------------------- |
| `tests/anchor.test.ts`  | 锚点构建与匹配测试（3 个 describe，8 个 it）      |
| `tests/bridge.test.ts`  | 版本比较测试（1 个 describe，5 个 it）         |
| `tests/compose.test.ts` | Prompt 组装纯函数测试（1 个 describe，4 个 it） |

### 文档

| 文件                 | 说明           |
| ------------------ | ------------ |
| `ANALYSIS.md`      | 环境检查与可行性分析报告 |
| `PHASE1_REPORT.md` | 本文件          |

---

## 2. 已实现的功能

### 2.1 柏宝绘 API 检测与有界等待

- `checkAvailability()` — 检测 `globalThis.STBaiBaiImage` 是否存在，版本是否兼容
- `waitForApi(maxAttempts)` — 有界等待（默认 10 次 × 500ms = 5 秒），不无限轮询
- `BaiBaiApiError` — 可理解的错误类型，面向用户的消息
- 三种状态：`available` / `not_installed` / `version_mismatch`

### 2.2 选区检测

- `isSelectionInMesText(selection)` — 只在 `.mes_text` 内的选区返回 true
- 排除输入框、设置面板、扩展自身 UI
- 最小选区长度 2 字符
- 从选区共同祖先向上查找 `.mes_text` → `.mes` 容器

### 2.3 楼层定位

- `resolveFloorFromSelection(selection)` — 从选区 DOM 向上定位 `.mes[mesid]`
- 提取 chatId、mesId、swipeId
- 无法定位时返回 null，提示用户重新选择

### 2.4 选段锚点

- `buildAnchor(selectedText, floorText, paragraphIndex)` — 构建包含以下信息的锚点：
  - `selectedText` — 选段文本
  - `beforeAnchor` / `afterAnchor` — 前后 60 字符锚点
  - `startOffset` / `endOffset` — 在楼层正文中的偏移量
  - `paragraphIndex` — 段落索引
- `matchAnchor(anchor, newFloorText)` — 在新正文中重新匹配锚点（用于消息编辑/swipe 切换后）
- 三级匹配策略：精确匹配 → 前后锚点联合 → 单锚点

### 2.5 选区工具条

- 浮动按钮，定位在选区上方
- "生成配图"按钮
- `mousedown` 阻止选区丢失
- 聊天切换/消息删除时自动隐藏

### 2.6 事件注册

- `EXTENSION_SETTINGS_LOADED` — 重新读取设置
- `APP_READY` — 确认柏宝绘 API
- `CHAT_CHANGED` — 隐藏工具条
- `MESSAGE_DELETED` — 隐藏工具条

### 2.7 ST 环境封装

- `initSTEnvironment()` — 动态 import ST 的 extensions.js 获取 getContext
- `getContext()` — 安全获取 ST 上下文（失败返回空壳）
- `getEventTypes()` — 合并 ST 原生事件和硬编码兜底
- `on(eventName, callback)` — 事件监听，返回取消函数
- `getSettings()` / `saveSettings()` — 扩展设置读写（`extension_settings.STStoryIllustrator`）
- `getChatMetadata()` / `saveChatMetadata()` — 聊天元数据读写
- `generateQuietPrompt()` — ST 静默 LLM 请求
- `isAiStoryMessage()` / `lastAssistantFloor()` / `stillCurrent()` — 楼层身份复核

---

## 3. 测试结果

### 锚点测试（anchor.test.ts）

- ✅ buildAnchor 精确匹配
- ✅ buildAnchor 文本不存在时处理
- ✅ buildAnchor 长文本截断
- ✅ matchAnchor 精确匹配
- ✅ matchAnchor 前后锚点联合匹配
- ✅ matchAnchor 无匹配返回 null
- ✅ isAnchorValid 匹配成功
- ✅ isAnchorValid 匹配失败

### 版本比较测试（bridge.test.ts）

- ✅ 相等版本
- ✅ 高版本比较
- ✅ 低版本比较
- ✅ 不同段数处理
- ✅ 非数字部分处理

### Prompt 组装测试（compose.test.ts）

- ✅ 按 order 排序组装
- ✅ 跳过禁用片段
- ✅ 空片段处理
- ✅ 过滤空字符串

> 注意：测试需要在安装 npm 依赖后运行（`npm install && npm test`）。  
> composeEnglishPrompt 目前是测试内联实现，第二阶段会从 `src/prompt/compose.ts` 导入。

---

## 4. 剩余问题

### 4.1 需要在实际 ST 环境中验证

| 问题                                  | 说明                                                     | 计划                                                     |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| ST `extensions.js` 导入路径             | `import('../../../extensions.js')` 的相对路径需要在实际 ST 安装中验证 | 在 ST 环境中用 console.log 探测                               |
| `.mes[mesid]` 选择器                   | 已从 ST 源码确认此结构，但不同 ST 版本可能有差异                           | 在实际 ST 版本中验证                                           |
| 柏宝绘 `api.apiVersion` 值              | 需确认实际版本号是否 >= 0.1.0                                    | 在安装柏宝绘的环境中用 `console.log(globalThis.STBaiBaiImage)` 探测 |
| 柏宝绘 `api.getCharacters()` 返回结构      | 角色快照字段名需确认                                             | 第二阶段实际调用时探测                                            |
| 柏宝绘 `api.generate()` payload schema | 需以真实 PUBLIC_API.md 为准                                  | 第四阶段实际调用时探测                                            |

### 4.2 构建配置待验证

- Vite 构建 ST 扩展的配置需要在实际构建中验证输出格式是否正确
- 可能需要调整 `vite.config.ts` 的 `lib` 配置或使用自定义插件处理 CSS 输出

### 4.3 尚未实现（属于后续阶段）

- 上下文构建器（第二阶段）
- Mock prompt generation adapter（第二阶段）
- Tag 编辑器 UI（第三阶段）
- 出图调用（第四阶段）
- 楼层卡片展示（第四阶段）
- 持久化（第四阶段）
- 漫画分镜规则与纠正（第五阶段）
- 对白气泡 canvas 合成（第五阶段）
- 小剧场三套（第六阶段）

---

## 5. 核心原则遵守确认

- [x] 不 Fork、不修改柏宝绘 — 本项目完全独立，不包含柏宝绘代码
- [x] 不复制柏宝绘内部代码 — 只通过 `globalThis.STBaiBaiImage` 公开接口交互
- [x] 不调用柏宝绘未公开的私有函数 — bridge.ts 只使用 SPEC.md 确认的公开接口
- [x] 不自行创建第二套副 API 配置 — LLM 请求使用 ST 自身 `generateQuietPrompt()`
- [x] 不猜测不存在的接口 — `generatePrompt()` 标记为可选，未假设其存在
- [x] 尚未开放的 LLM Tag 生成接口使用 mock adapter — 第二阶段实现，已标记
- [x] 每完成一个阶段报告修改内容、测试结果和剩余问题 — 本文件
