# Phase 2 — Step 2 完成报告

## 概述

Step 2 实现了统一选段入口（Unified Selection Entry），完成 StorySegment 数据结构与构建器、选段面板 UI、以及 index.ts 的流程接线。

## 改动文件

### 新增文件

| 文件                              | 说明                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/selection/textCleaner.ts`  | 文本清洗：剥离 `<bbi_image>`、`<dialogue>` 子标签、HTML 标签，解码实体，压缩空白；系统消息检测                                                                                                                                            |
| `src/selection/storySegment.ts` | 统一选段构建器：`buildSingleSegment`、`buildRangeSegment`、`buildPickedSegment`、`buildManualSegment`、`validateSegment`、`getAnchorFloor`、`getSurroundingContext`、`defaultFloor`、`getAvailableFloors`、`extractMessage` |
| `src/prompt/compose.ts`         | 英文 Prompt 组装纯函数：`composeEnglishPrompt`（保守去重、保留权重语法）、`bareTagOf`、`composeNegativePrompt`                                                                                                                    |
| `src/ui/selectionPanel.ts`      | 选段面板 UI：4 种选段方式标签（单楼/范围/勾选/手动）、5 种创作模式选择器、消息预览、可编辑最终文本、确认/取消按钮                                                                                                                                             |
| `tests/storySegment.test.ts`    | 36 个测试用例覆盖 extractMessage、buildSingleSegment、buildRangeSegment、buildPickedSegment、buildManualSegment、validateSegment、getAnchorFloor、defaultFloor、getAvailableFloors                                        |

### 修改文件

| 文件                        | 改动内容                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`            | 新增 Phase 2 全部类型：`StorySourceKind`、`StorySegmentMessage`、`StorySegment`、`CreationMode`、`VisualTask`、`VisualTaskStatus`、`ComicDialogue`、`ComicPanelPlan`、`ComicPagePlan`、`VisualProfile`、`NormalizedGenerationInput`、`GenerationResult`、`ImageBackendAdapter`、`VisualArtifact`、`BaiBaiCapabilities`、`ModeSettings`、`defaultModeSettings()` 工厂函数、`DEFAULT_SETTINGS` 更新 |
| `src/host/sillytavern.ts` | `STChatMessage` 从 `interface` 改为 `export interface`（供 storySegment.ts 导入）                                                                                                                                                                                                                                                                                           |
| `src/index.ts`            | 重写 `handleGenerateFromSelection`：从 Phase 1 的 console.log 改为调用 `showSelectionPanel()`；新增 `handleSegmentConfirmed` 回调（接收 StorySegment + CreationMode）；`onDisable` 增加 `destroySelectionPanel()`；CHAT_CHANGED 和 MESSAGE_DELETED 事件增加 `hideSelectionPanel()`                                                                                                             |
| `src/styles/style.css`    | 新增选段面板完整样式：overlay、面板容器、标题、选段方式标签、楼层选择器、范围选择器、排除列表、勾选列表、手动编辑器、模式选择器、预览区、操作按钮                                                                                                                                                                                                                                                                                        |
| `tests/compose.test.ts`   | 从本地复制改为从 `src/prompt/compose.ts` 导入；新增 `bareTagOf` 4 个测试、`composeNegativePrompt` 4 个测试、`composeEnglishPrompt` 新增去重和权重保留测试，共 17 个测试                                                                                                                                                                                                                                  |
| `tests/anchor.test.ts`    | 修正 2 个 Phase 1 遗留的 off-by-one 测试期望值（中文标点计数）                                                                                                                                                                                                                                                                                                                         |

## 实现内容

### 1. 文本清洗 (`textCleaner.ts`)

- `cleanMessageText(text)` — 剥离 `<bbi_image>` 标签及内容、`<dialogue>` 子标签（保留内部文本）、其他 HTML 标签，解码 HTML 实体，压缩连续空白
- `isSystemMessage(msg)` — 检查 `is_system` 标志、name 为 "system"/"narrator"、`extra.type` 存在
- `isStoryMessage(msg)` — 结合系统消息检测和文本非空检测

### 2. StorySegment 构建 (`storySegment.ts`)

- **单楼选段** (`buildSingleSegment`) — 从指定楼层提取一条消息，带身份复核
- **范围选段** (`buildRangeSegment`) — 从 startFloor 到 endFloor（含），支持排除列表，自动过滤系统消息，最大 50 条消息
- **勾选选段** (`buildPickedSegment`) — 按用户勾选顺序提取，过滤无效和系统消息
- **手动文本** (`buildManualSegment`) — 用户粘贴/编辑文本，标记为 manual，不伪造楼层归属
- **验证** (`validateSegment`) — chatId 一致性 + 所有消息身份复核（手动文本恒有效）
- **锚定楼层** (`getAnchorFloor`) — 返回选段最后一条消息的楼层（用于结果挂载）
- **上下文** (`getSurroundingContext`) — 获取选段前后 range 层非系统消息文本（用于 LLM 上下文）
- **默认楼层** (`defaultFloor`) — 最近一条非系统 AI 消息
- **可用楼层** (`getAvailableFloors`) — 所有非系统消息的楼层列表（含说话人、预览）

### 3. 选段面板 UI (`selectionPanel.ts`)

- 4 种选段方式标签：单楼、范围、勾选、手动
- 范围选择器支持排除楼层（checkbox 列表）
- 勾选选择器按勾选顺序记录
- 手动编辑器（textarea，不可伪造楼层归属）
- 5 种创作模式选择器（radio 列表，带描述）
- 预览区：楼层信息、消息列表（说话人+文本）、可编辑最终剧情文本
- 操作按钮：取消、确认（确认前验证选段有效性）
- 点击 overlay 或聊天切换时自动关闭

### 4. index.ts 流程接线

```
用户选区 → 工具条"生成配图" → handleGenerateFromSelection
  → 捕获选区文本 + 定位楼层 + 构建锚点
  → showSelectionPanel(floor.mesId, handleSegmentConfirmed)
  → 用户选择选段方式 + 创作模式 → 确认
  → handleSegmentConfirmed(segment, mode)
  → (Step 3 将实现任务队列和生成流程)
```

### 5. Prompt 组装 (`compose.ts`)

- `composeEnglishPrompt(segments)` — 过滤 enabled → 按 order 排序 → 保守去重（裸词相同且非权重块则跳过）→ 保留权重语法 → 逗号连接
- `bareTagOf(tag)` — 去除 `数字::` 前缀、前导 `::`、后缀 `::`，转小写
- `composeNegativePrompt(segments)` — 只取 source='global' 的 enabled 片段

## 测试结果

```
Test Files  4 passed (4)
     Tests  66 passed (66)

 ✓ tests/bridge.test.ts       (5 tests)
 ✓ tests/storySegment.test.ts  (36 tests)
 ✓ tests/compose.test.ts       (17 tests)
 ✓ tests/anchor.test.ts        (8 tests)
```

### 测试覆盖

| 测试文件                   | 测试数 | 覆盖范围                                                                                                                                                     |
| ---------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge.test.ts`       | 5   | compareVersions 版本比较                                                                                                                                     |
| `anchor.test.ts`       | 8   | buildAnchor、matchAnchor（三级匹配）、isAnchorValid                                                                                                              |
| `compose.test.ts`      | 17  | composeEnglishPrompt（含去重、权重保留）、bareTagOf、composeNegativePrompt                                                                                           |
| `storySegment.test.ts` | 36  | extractMessage、buildSingleSegment、buildRangeSegment、buildPickedSegment、buildManualSegment、validateSegment、getAnchorFloor、defaultFloor、getAvailableFloors |

## 未完成项

| 项目                       | 状态  | 说明                                                        |
| ------------------------ | --- | --------------------------------------------------------- |
| `handleSegmentConfirmed` | 占位  | 当前仅记录日志和提示，Step 3 将实现 VisualTask 创建和任务队列                  |
| Profile 选择 UI            | 未实现 | Step 5 将实现 VisualProfile 选择器和柏宝绘资产浏览                      |
| 柏宝绘 capability 检测        | 未实现 | Step 5 将实现 `BaiBaiCapabilities` 检测                        |
| 漫画分镜选择链                  | 未实现 | Step 3 将实现 ComicPagePlan、enforcePanelPrompt、Canvas 对白气泡合成 |
| 小剧场集成                    | 未实现 | Step 4 将实现 StoryKind status/bonus/manga 与 StorySegment 连接 |
| TypeScript 编译            | 未验证 | Vite 构建未运行（ST 环境依赖无法在 Node 中解析），类型正确性靠 IDE 检查             |

## 下一步

进入 **Step 3：漫画分镜选择链**，包括：

1. 单楼/跨楼选段 → LLM 结构化 JSON（ComicPagePlan）
2. 四种面板布局（regular/irregular/inset/unframed）
3. `enforcePanelPrompt()` 发送端校正
4. `applyPanelToNl()` 布局描述
5. 预览/编辑 ComicPagePlan
6. Profile 选择
7. 逐格生成
8. 工作组挂载
9. 对白元数据 + Canvas 合成
