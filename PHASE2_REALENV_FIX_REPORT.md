# 真机联调问题修复报告

日期：2026-11-18
触发：用户在 SillyTavern 1.18 真机装好后反馈「什么都没有」，随后联调发现一系列问题。

## 一、先修的：扩展完全不加载

- **根因**：`manifest.json` 缺 `hooks.activate` 字段。ST 的 `activateExtensions()` 加载脚本后只调用 `callExtensionHook(name, 'activate')`，而该函数仅当 `manifest.hooks.activate` 存在时才调用导出的 `onActivate()`。
- **修复**：manifest 增加 `"hooks": {"activate":"onActivate","disable":"onDisable"}` 与 `minimum_client_version: 1.12.0`。

## 二、用户反馈的 8 个问题 → 逐条处理

### 1. 字数统计把思维链/标签算进去了（4000 字到不了正文）
- **根因**：`textCleaner.cleanMessageText` 只去 `<bbi_image>`/HTML，不去 `<think>`、自定义标签、bbs 旁注；字数统计用的是清洗后的 `mes`，但清洗不完整。
- **修复**：
  - 重写 `textCleaner.ts`，与柏宝绘 `clean.ts` 同口径：移除 `<think>/<thinking>`、HTML 注释、`<horae>`、`<bbs_items>/<bbs_vars>/<bbs_start>/<bbs_end>`。
  - 新增 `baiBaiExcludes.ts`：只读柏宝绘共享存储 `extensionSettings['baibai_exclude_settings']` 的 `customStripTags`（含内置 `mvu` 规则），实现**排除标签与柏宝绘同步**（对齐用户诉求「排除标签和柏宝绘同步」）。
  - 保留**截取上限**：`MAX_MESSAGE_TEXT=4000`，但先清洗再截取，正文不再被思维链挤掉。

### 2. 最终剧情文本（可编辑）—— 保留
- 未改动，符合用户「留下」的要求。

### 3. 提取 content 标签（排除+提取都要）
- **修复**：`cleanMessageText(mes, {preferContent:true})` 在正文含 `<content>...</content>`（思维链插件常把正文放里面）时只取 content 内部文本。默认开启（`preferContentTag:true`）。排除与提取两种机制并存。

### 4. 五个创作模式多选
- **根因**：模式选择器用 `radio` + 单个 `currentMode`。
- **修复**：改为 `checkbox` 多选（`selectedModes: Set<CreationMode>`），确认按钮显示「生成 N 份」，`handleSegmentConfirmed` 对每个选中模式各排一个任务。

### 5. 手动 → 局部，放第一个标签页，划线预填充
- **根因**：手动编辑器初始为空，且不接收划线文本；标签页顺序把手动放最后。
- **修复**：
  - 标签页顺序改为 **局部 / 单楼 / 范围 / 勾选**，`manual` 更名 `local`（显示「局部」）。
  - `showSelectionPanel` 新增 `ShowPanelOptions`（`selectedText`/`startAtLocal`），index.ts 把划线文本与所在楼传入，局部框用划线文本预填充。
  - `buildManualSegment(text, [selectedFloorSeed])` 记录划线楼作为锚点，结果挂在该楼。

### 6. 楼层显示错位（选第 2 楼，下拉显示第 4 楼）
- **根因**：`<option>` 用 `opt.selected` 标记，但 `select.value` 未同步，浏览器可能显示首个 option。
- **修复**：`renderSingleSelector` / `createFloorSelect` 在构建后显式 `select.value = String(selectedFloor)`，下拉与预览用同一楼层号。

### 7. 主 API 生成（用户想用柏宝绘副 API）
- **根因**：LLM Tag 计划用 `generateQuietPrompt`（ST 主 API）；柏宝绘副 API 渠道是跨插件共享配置 `extensionSettings['baibai_api_channels']` + `baibai_image.assignments.tagGen`。
- **修复**：
  - 新增 `secondaryLlm.ts`：只读共享渠道配置，用 OpenAI `/chat/completions` 协议调用用户指派的 tagGen 渠道；未配置/失败返回 null。
  - `planGenerator.defaultLlmCaller` 改为**优先副 API，失败回退主 API**；新增 `makeLlmCaller('auto'|'main'|'secondary')`，设置项 `llmSource` 默认 auto。
  - 插画、漫画、小剧场的 LLM 步骤都接入该调用器。
  - **注意**：不调用柏宝绘私有函数，只读共享配置 + 标准 HTTP；符合"不绕过公开接口"原则。

### 8. 图片插入正文体验不对 / 编辑后图片消失 / 进了图库但正文看不到
- **根因**：图片只注入 DOM（`.mes_text` 里的卡片），从未写入 `message.mes`；ST 重绘或编辑正文后 DOM 卡片被清掉。柏宝绘 public `generate(save:true)` 只把图存进图库，不写正文、不写 `extra.bbiImage`，所以正文标签水合也匹配不到。
- **修复**：
  - 新增 `bodyInserter.ts`：用 markdown 图片语法 `![alt](path)` 把图片写进 `message.mes`（锚定选段之后，找不到则追加末尾），并同步 `swipes[swipe_id]`；CAS 复核 chatId/send_date/swipe，排队期间消息变了就放弃；写后触发 `updateMessageBlock`/`MESSAGE_EDITED` 重绘。幂等（正文已含该图则跳过）。
  - `workflow.runIllustration` 出图后先写正文，成功则把该 artifact 标 `metadata.embeddedInBody=true`。
  - `floorCards.mountFloor` 过滤掉 `embeddedInBody` 的作品，避免 DOM 卡片与正文图片重复；卡片 caption 去掉「模式 tag」，只留简短 nl。

## 三、验证
- 新增测试：`textCleaner.test.ts`（10）、`bodyInserter.test.ts`（3）。
- **236 tests / 14 files 全通过**；`tsc --noEmit` 0 错误；`npm run build` 成功。
- 已同步到酒馆扩展目录 `G:\SillyTavern\public\scripts\extensions\third-party\ST-Story-Illustrator\`（index.js/style.css/manifest.json 大小一致）。
- 已提交 GitHub：`2583c65`（在 `7090ac6` 之后）。

## 四、需用户确认/重启验证
1. **重启 SillyTavern**（manifest 和代码都变了）。
2. 副 API 是否生效取决于柏宝绘设置里 `assignments.tagGen` 是否指派了渠道；未指派则自动回退主 API（不会报错中断）。
3. 图片写正文功能依赖 ST 允许 markdown 图片（默认允许）；若主题禁用了正文 HTML/图片，会降级为 DOM 卡片。
4. 楼层显示：新面板显式同步 select.value，重启后划线再看下拉与预览是否一致。

## 五、仍待做（非阻塞）
- 设置面板 UI（新增的 `syncBaiBaiExcludes`/`preferContentTag`/`llmSource` 三项暂无界面，走默认值）。
- 漫画分镜正文写入（当前仅插画走正文写入，漫画/N剧场仍用 DOM 卡片，符合用户「状态栏/彩蛋挂最后」的设定）。
