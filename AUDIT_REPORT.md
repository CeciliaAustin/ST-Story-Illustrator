# ST-Story-Illustrator · 现状核查表

> Step 1 产出（只读核查，不改代码）
> 日期：2026-11-18

---

## 核查结论

以代码为准，以下逐项标记状态。

---

## 1. 选段

| 能力 | 状态 | 说明 |
|---|---|---|
| 正文选区检测（.mes_text 内） | 已实现未验证 | `selector.ts` — `isSelectionInMesText()` 从选区共同祖先向上查找 `.mes_text` → `.mes`，排除输入框/设置面板。未在实际 ST 环境验证。 |
| 楼层定位（mesid 提取） | 已实现未验证 | `floorResolver.ts` — `resolveFloorFromSelection()` 从 `.mes[mesid]` 属性提取楼层号。DOM 结构从 ST 源码确认，未实际验证。 |
| 选段锚点保存 | 已实现有测试 | `anchor.ts` — `buildAnchor()` 保存选段文本 + 前后 60 字符锚点 + 段落索引 + 偏移量。8 个测试用例。 |
| 锚点匹配（编辑/swipe 后） | 已实现有测试 | `anchor.ts` — `matchAnchor()` 三级匹配策略（精确 → 前后联合 → 单锚点）。 |
| **单楼选段** | **已实现** | 第一阶段工具条点击后捕获当前选区楼层。 |
| **跨楼层范围选段** | **未实现** | 第二阶段任务书 §1.1 要求。 |
| **范围内排除楼层** | **未实现** | 第二阶段任务书 §1.1 要求。 |
| **手动粘贴/编辑文本** | **未实现** | 第二阶段任务书 §1.1 要求。 |
| **StorySegment 统一数据结构** | **未实现** | 第二阶段任务书 §1.2 要求。现有 `SelectionResult` 只有单楼。 |
| **预览显示楼层与说话人** | **未实现** | 第二阶段任务书 §1.2 要求。 |
| **身份复核（chatId+floor+sendDate+swipeId）** | **部分实现** | `sillytavern.ts` 有 `stillCurrent()` 函数，但未在生成流程中调用。 |

---

## 2. 楼层定位

| 能力 | 状态 | 说明 |
|---|---|---|
| 从 DOM `.mes[mesid]` 定位 | 已实现未验证 | `floorResolver.ts` |
| 从 ST chat 数组读取消息 | 已实现 | `sillytavern.ts` — `getMessage(floor)` |
| 楼层身份复核 | 已实现未使用 | `sillytavern.ts` — `stillCurrent()` |
| **以 ST chat 数据为准，不从 DOM 猜楼层** | **部分实现** | 当前从 DOM 获取 mesid，再用 `getSwipeId()` 从 chat 数组读 swipe。需要改为直接从 chat 数据构建 StorySegment。 |

---

## 3. Tag 编辑

| 能力 | 状态 | 说明 |
|---|---|---|
| Tag 分段数据模型 | 已实现 | `types.ts` — `TagSegment` / `IllustrationPrompt` |
| 英文 prompt 组装纯函数 | 有测试内联实现 | `compose.test.ts` 中有内联 `composeEnglishPrompt()`，但 `src/prompt/compose.ts` **文件不存在**。 |
| **Tag 编辑器 UI** | **未实现** | 第三阶段计划，第二阶段任务书 §5 要求保留。 |
| **着色显示（黑色角色 / 绿色画面）** | **未实现** | CSS 已预留 `.sti-segment.character` / `.sti-segment.scene`。 |
| **双语显示切换** | **未实现** | |
| **重 Roll 画面段** | **未实现** | |
| **复制完整英文 Tag** | **未实现** | |

---

## 4. 生成调用

| 能力 | 状态 | 说明 |
|---|---|---|
| 柏宝绘 API 检测 | 已实现有测试 | `bridge.ts` — `checkAvailability()` / `waitForApi()` |
| 版本比较 | 已实现有测试 | `bridge.ts` — `compareVersions()` 5 个测试用例 |
| 后端状态检查 | 已实现 | `bridge.ts` — `getBackendStatus()` |
| 角色快照读取 | 已实现 | `bridge.ts` — `getCharacters(floor)` |
| 出图调用封装 | 已实现 | `bridge.ts` — `generateImage(payload, options)` |
| **实际出图流程** | **未实现** | 第四阶段计划。 |
| **多后端 adapter** | **未实现** | 第二阶段任务书 §4.4 要求 `ImageBackendAdapter`。 |
| **Profile 选择** | **未实现** | 第二阶段任务书 §4.1 要求 `VisualProfile`。 |

---

## 5. 存储

| 能力 | 状态 | 说明 |
|---|---|---|
| 扩展设置读写 | 已实现 | `sillytavern.ts` — `getSettings()` / `saveSettings()` 使用 `extension_settings.STStoryIllustrator` |
| 聊天元数据读写 | 已实现 | `sillytavern.ts` — `getChatMetadata()` / `saveChatMetadata()` |
| **任务持久化** | **未实现** | `StoryIllustration` 类型已定义，但 `storage/repository.ts` **文件不存在**。 |
| **VisualArtifact 存储模型** | **未实现** | 第二阶段任务书 §6.1 要求。 |
| **作品组与历史版本** | **未实现** | 第二阶段任务书 §6.2 要求。 |
| **schema 版本迁移** | **未实现** | |

---

## 6. 展示

| 能力 | 状态 | 说明 |
|---|---|---|
| 选区工具条 | 已实现 | `selectionToolbar.ts` — 浮动"生成配图"按钮 |
| **楼层图片卡片** | **未实现** | CSS 已预留 `.sti-floor-card`。 |
| **Lightbox 放大** | **未实现** | CSS 未预留。 |
| **漫画页展示** | **未实现** | |
| **小剧场卡片** | **未实现** | CSS 已预留 `.sti-cs-card` 等。 |
| **多格横条** | **未实现** | CSS 已预留 `.sti-cs-strip` / `.sti-cs-panel`。 |

---

## 7. 配置同步

| 能力 | 状态 | 说明 |
|---|---|---|
| 设置加载（EXTENSION_SETTINGS_LOADED） | 已实现 | `index.ts` — `registerEvents()` |
| 设置类型定义 | 已实现 | `types.ts` — `StoryIllustratorSettings` |
| **多模式设置 UI** | **未实现** | 第二阶段任务书 §7 要求五种模式独立设置。 |
| **Profile 配置** | **未实现** | |
| **柏宝绘资产浏览器** | **未实现** | 第二阶段任务书 §4.2 要求。 |
| **capability detection** | **部分实现** | `bridge.ts` 检测 API 是否存在和版本，但未检测具体能力（画师串库、NAI 方案等）。 |

---

## 8. 两份说明与现有代码差距

### 漫画分镜与对白气泡
| 源文档概念 | 现有代码 | 差距 |
|---|---|---|
| `buildPanelRule()` | 未实现 | 需新建 `src/manga/panelRule.ts` |
| `enforcePanelPrompt()` | 未实现 | 需新建 `src/manga/panelEnforce.ts` |
| `applyPanelToNl()` | 未实现 | 同上 |
| `compositeDialogue()` | 未实现 | 需新建 `src/manga/bubbleComposite.ts` |
| `planBubbles()` / `placeRect()` | 未实现 | 需新建 `src/manga/bubblePlan.ts` |
| `drawBubbles()` | 未实现 | 需新建 `src/manga/bubbleDraw.ts` |
| 台词存储（正文子标签 / 手动表） | 未实现 | 需新建 `src/manga/dialogueStore.ts` |
| `ComicPagePlan` / `ComicPanelPlan` | 类型已定义 | `types.ts` 中无，需补充 |
| 锚点防重叠 / 字号公式 / CORS 安全 | 未实现 | 纯函数，可直接从文档移植 |

### QQ人小剧场/彩蛋/黑白漫
| 源文档概念 | 现有代码 | 差距 |
|---|---|---|
| KIND 差异参数表 | 未实现 | 需新建 `src/theater/kinds.ts` |
| 三套 system prompt | 未实现 | 需新建 `src/theater/prompts.ts` |
| 模型 JSON 解析与清洗 | 未实现 | 需新建 `src/theater/parseReply.ts` |
| 固定种子（FNV-1a） | 未实现 | 需新建 `src/theater/seed.ts` |
| 黑白漫安全防护 | 未实现 | 需新建 `src/theater/safeFilter.ts` |
| 串行队列 + 看门狗 | 未实现 | 需新建 `src/theater/queue.ts`（也用于统一任务队列） |
| 三桶存储 | 未实现 | 需新建 `src/theater/store.ts` |
| DOM 挂载 | 未实现 | 需新建 `src/theater/mount.ts` |
| 楼层按钮注入 | 未实现 | 需新建 `src/theater/buttons.ts` |
| `BbiStatusInfo` / `StatusReading` | 类型已定义 | `types.ts` 中已有 |
| `StoryKind` | 类型已定义 | `types.ts` 中已有 |

---

## 9. 具体改动文件清单（Step 2 计划）

### 新增文件
| 文件 | 说明 |
|---|---|
| `src/selection/storySegment.ts` | 统一选段数据结构与构建器 |
| `src/selection/textCleaner.ts` | HTML/生图标签清理，保留正文 |
| `src/ui/selectionPanel.ts` | 选段面板 UI（模式选择 + 预览 + 编辑） |
| `src/prompt/compose.ts` | 英文 prompt 组装纯函数（从测试内联提取） |

### 修改文件
| 文件 | 改动 |
|---|---|
| `src/types.ts` | 新增 `StorySegment` / `StorySourceKind` / `VisualTask` / `VisualProfile` / `ComicPagePlan` / `ComicPanelPlan` / `ComicDialogue` / `VisualArtifact` / `ImageBackendAdapter` 类型 |
| `src/index.ts` | 接入选段面板，工具条点击后打开面板而非直接输出 |
| `src/ui/selectionToolbar.ts` | 按钮文案改为"创作" |
| `src/host/sillytavern.ts` | 导出 `STChatMessage` 类型供 storySegment 使用 |

### 新增测试
| 文件 | 说明 |
|---|---|
| `tests/storySegment.test.ts` | 选段构建、文本清理、身份复核测试 |
| `tests/compose.test.ts` | 改为从 `src/prompt/compose.ts` 导入 |

---

## 10. 柏宝绘公开 API 能力

| 接口 | 状态 | 说明 |
|---|---|---|
| `apiVersion` | 已知存在 | 版本号字符串 |
| `getCharacters({floor})` | 已知存在 | 按楼层读取角色快照 |
| `getBackendStatus()` | 已知存在 | 查询后端配置状态 |
| `generate(payload, options?)` | 已知存在 | 调用柏宝绘出图 |
| `subscribe(callback)` | 可能存在 | 任务书 §4.3 列为已知，SPEC 标注不确定 |
| `generatePrompt()` | **未公开** | 提案中，尚未实现 |
| 读取画师串库 | **未公开** | 任务书 §4.3 标注 |
| 列出 NAI 方案 | **未公开** | |
| 列出 API 接入点 | **未公开** | |
| 列出 ComfyUI 工作流 | **未公开** | |
| 指定 Profile 生成 | **未公开** | |
| 复用 LLM 配置生成 Tag/JSON | **未公开** | |

**策略**：先做 capability detection（检测 `api` 对象上是否存在这些方法），不支持时显示受限状态。LLM 请求使用 ST `generateQuietPrompt()` 替代。
