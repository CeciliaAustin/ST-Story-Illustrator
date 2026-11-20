# PHASE_NEXT — 漫画连续性 / 自由构图 / 正文锚点修复报告

> 对应《ST-Story-Illustrator-下一步漫画分镜修复指导.md》任务书。
> 执行纪律：先 Step 1 核查并汇报，再逐步实施，不重写整个插件。
> 基线：`main` @ `ee6398e`，tsc 0 错 / 47 文件 672 用例 / build 414.37 kB。

## 0. 本轮解决的用户诉求

1. **自动出图一进新聊天就启动** → 修（生成窗口门闩）。
2. **一页把几个不连续瞬间拼一起、台词不连贯** → 修（连续性最高约束 + validator + 台词条款）。
3. **一格强制同一批人 / 想自由单人局部双人局部物件** → 修（composition 字段 + panel-level 人数体检）。
4. **选 3 格只画 2 格** → 修根因之一（所有档位钉格数时都下发对应 koma 词并纠正错词）。
5. **留白消失、所有格同尺寸铺满** → 修（删满版/窄 gutter 规则，主次 + 负空间 + 参考图式版面倾向）。
6. **图不在对应台词位置、多页堆一处** → 修（每页用自己的台词原文做锚点，各插各的位置）。
7. **iqoo 手机面板被遮挡/裁切** → 修（移动端 dvh + @media 适配）。
8. **参考图构图叫什么** → 非对称漫画页 + 插入式特写分格（Hero Panel with Floating Insets，`hero_insets`）。

## 1. Step 1 核查结论

任务书点名 7 处冲突全部在 `ee6398e` 实证存在，已逐条对应到文件/函数：

| 冲突 | 定位 | 证据 |
|---|---|---|
| different moment 兜底 | `pageCompose.ts:133` | 真实存档 `sti-mwnugbbm-1` 的 nl 就是这句 |
| filled edge to edge / 3% gutter / 九成覆盖 | `pageCompose.ts:38,40`、`panelPlan.ts:361,386,482` | 同上 prompt 拼三个不同地点 |
| 只强调差异、无时间连续性 | `panelPlan.ts` PANEL_ART_CLAUSE / PANEL_SELF_CHECK | 规则全文 |
| 人数词强制对齐 + 重问 | `pageCompose.ts:170` findCastShortfall、`workflow.ts:415` | 测试 `castResolve` 旧用例 |
| 多页共用 inlineAnchor | `workflow.ts:469,577` | 每页 `anchorText: segment.text.slice(0,120)` |
| 单页单请求无法保证格数 | `workflow.ts:488` | 一页一次 `baiBaiAdapter.generate` |
| 自动触发挂 MESSAGE_RECEIVED | `index.ts:279-292` | 打开聊天历史重渲会走该事件 |

## 2. 逐步实施记录

### 自动逻辑（独立于任务书，用户首诉）
- `src/tasks/autoTrigger.ts`：新增纯函数 `isFreshGeneratedFloor({generationActive, isAiStoryMessage})`。
- `src/index.ts`：`GENERATION_STARTED/ENDED` 维护 `generationActive`；`MESSAGE_RECEIVED` 只在生成窗口内且是 AI 剧情层才打 `autoPending` 标记；`CHAT_CHANGED` 清窗口。
- `src/host/sillytavern.ts`：补 `GENERATION_STARTED` 事件常量兜底。
- 效果：打开/切换/刷新聊天重渲历史 → 不在生成窗口 → 不再自动出图；只有真正 roll 一层才自动。

### Step 2 — 连续 beat 与台词来源
- `src/types.ts`：`ComicPanelPlan.composition`（7 种镜头）、`ComicPagePlan.beat`（timeScope/location/event/continuityNote/dialogueOrder）。
- `src/manga/panelPlan.ts`：新增 `CONTINUITY_CLAUSE`（**最高优先级**，放在规则最前）；重写 `PANEL_ART_CLAUSE`（镜头差异≠事件差异）、`PANEL_SELF_CHECK`（删除"相邻差异"自检）；四档 body 删除"每格同一批人/九成覆盖/两格两差异"；新增 `validateComicContinuity()`（跳时词/空格/台词倒序 warning）接入 parse。
- `src/manga/planPrompts.ts` / `src/prompt/presets.ts`：COMIC schema 加 `beat` / `composition`；硬要求 1/1a/1b/1c 写清"一页一个连续瞬间、台词连续、每格镜头自由、版面有主次"；删掉 5c 禁止重播 / 5d 人数强制，输出约束改为"宁可少写台词不编造"。
- `src/manga/pageCompose.ts`：重写 `findCastShortfall()` 为 panel-level——单人格/局部格/物件格一律放过，只有"某格明确 ≥2 人同框且缺外貌"才报；重问文案同步。
- `src/manga/panelPlan.ts`：`normalizePanel/normalizePage` 解析 composition/beat。

### Step 3 — 页面布局计划与留白
- `src/manga/pageCompose.ts`：`LAYOUT_GAP_NOTE` 全部改为"主次 + 负空间"，删除 edge-to-edge / 3% 窄 gutter；`buildPageNl` 兜底句改为"same continuous instant + different camera angles"。
- `src/manga/panelPlan.ts`：auto 档 `3b` 改为"主格大其余小、留明显负空间、不做同尺寸填满"；`2/3/4 格按切面数量，不硬凑`；`panelTagsForCount()` 现在**所有档位**钉格数时都注入 `Nkoma`（旧版只认 regular，是"选 3 画 2"的机械根因）。
- `src/manga/panelEnforce.ts`：`forbidden` 集按目标格数精确化——放行目标 koma、删掉其它 koma（旧版对 irregular 等档禁全部 koma，连写对的都删）。

### Step 4 — 格数确定性（**部分完成，见限制**）
- 本轮以"强 koma 注入 + 冲突纠正 + 幂等"缓解，**未实现逐格生成 + Canvas 合成**。

### Step 5 — 每页独立正文锚点
- `src/tasks/workflow.ts`：新增 `pickPageAnchorText(page, segmentText)`——优先本页第一句台词原文（24 字），退回 beat.event（须在原文里），最后退回选段开头；`insertManwaTag` 改传每页各自 anchorText。
- `src/baibai/manwaTag.ts`：新增 `insertionPointAfterLineTags()`——多页只有锚到同一行才按页序堆叠，锚到不同台词则各插各的位置。

### Step 6 — 气泡 / 手机遮挡
- 气泡层经核查**已完整读取 slot 几何**（`panelSlots → assignDialogueToSlots → noGo`），四档 layout 未变，兼容新规则；本轮无需改动。
- `src/styles/style.css`：新增移动端适配——`@supports` 用 `dvh` 兜底 vh、`@media (max-width:700px)` 面板 96vw / 上移 8dvh / 76dvh 可滚 / 按钮触控区 ≥38px / 长文本换行 / 灯箱近全屏。

## 3. 验证

- tsc 0 错；Vitest **49 文件 / 699 用例全过**（本轮 +27：自动逻辑 4、连续性 16、锚点 6、人数体检语义调整）。
- build `dist/index.js` 420.75 kB / `dist/style.css` 52.47 kB。
- 真实存档证据：`sti-mwnugbbm-1` 复现了被修复的兜底句与不连续 prompt。

## 4. 未完成项 / 能力边界（诚实标注）

1. **固定格数仍未 100% 保证**：当前仍是"一页一次出图"（柏宝绘原版架构），`Nkoma` 强注入只提高成功率，不能像任务书 §5-B 的 `deterministic_composition`（逐格生成 + 本地 Canvas 合成）那样确定性保证 3 格。完整实现会显著增加出图次数/成本、需改任务队列与气泡坐标系，属架构级改动，按"不一口气重写"原则留给下一步专项。
2. **真实环境验收（任务书 Step 7）未做**：本轮是纯函数单测 + 真实存档取证，未在 ST + 柏宝绘里实际重跑 2/3/4 格与跨消息剧情。需用户刷新后实出一组确认。
3. **新 `hero_insets` archetype 枚举未落**：本轮复用既有四档（unframed/inset 已能表达参考图式主画面+浮动特写）通过提示词实现视觉方向，未新增 `ComicPageLayoutPlan.slots` 的显式几何枚举（会牵动 compositor 与气泡）。

## 5. 改动文件清单

`src/index.ts`、`src/host/sillytavern.ts`、`src/tasks/autoTrigger.ts`、`src/tasks/workflow.ts`、
`src/types.ts`、`src/manga/panelPlan.ts`、`src/manga/pageCompose.ts`、`src/manga/panelEnforce.ts`、
`src/prompt/presets.ts`、`src/baibai/manwaTag.ts`、
`src/styles/style.css`、测试：`tests/autoTrigger.test.ts`、`tests/comicContinuity.test.ts`（新）、
`tests/pageAnchor.test.ts`（新）、`tests/castResolve.test.ts`、`tests/pageCompose.test.ts`、
`tests/panelCount.test.ts`、`tests/manwaTag.test.ts`。
