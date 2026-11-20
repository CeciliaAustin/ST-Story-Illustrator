# PHASE_LAYOUT_SYSTEM — 漫画版面系统扩展报告

> 对应《ST-Story-Illustrator-漫画版面系统扩展指导.md》任务书。
> 基线：`main` @ `f4dc099`（已含连续性/锚点/自动触发修复）。本轮不推翻这些成果。
> 纪律：先 Step 1 只读核查并汇报，再逐步实施，不一口气重写插件。

## 0. 目标与边界

把漫画版面从「四档 + 格数」升级为**用户可选版面系统**：
- 三个独立维度：用户选**风格** → 用户选**格数** → LLM 设计**具体几何**，代码验证执行。
- 五种风格：traditional four-panel / open montage / diagonal panels / hero+insets / freeform。
- 留白由版面与剧情决定，不再全局强制固定比例。

## 1. Step 1 核查结论（基线 47 文件 / 699 用例 / tsc 0）

| 维度 | 核查结果 |
|---|---|
| 版面类型 | 仅四档 `regular/irregular/inset/unframed` + auto；`comicLayout`(新) 与 `panelLayout`(旧) 并存 |
| 格数 | `comicPanelsPerPage:0/2/3/4` 已实现，但一页一次生图，非硬保证 |
| 留白 | 上轮已删全局 gutter，但无独立偏好设置 |
| slots 几何 | 仅矩形 `{x,y,w,h}`，`irregular` 直接返回空；无 polygon/role/zIndex/safeAreas |
| 三阶段计划 | 无；一次调用直出 `ComicPagePlan[]` |
| 气泡 | 已读 `panelSlots`，但只按矩形 bbox 碰撞 |
| compositor | 只在已生成的一张图上合成气泡，无逐格生成 + 裁切 |
| UI | 只有一个下拉；无线框预览、阅读顺序、留白/安全区 |

**认知差异**：旧 UI 把 `irregular` 标成「斜切分镜」，但它真实语义是「不规则拼版」，代码里没有任何斜切几何。新系统里 `irregular→open_montage`，真斜切是新的 `diagonal_panels`。

### 旧字段迁移表

| 旧值 | 新值 | 处理 |
|---|---|---|
| regular | classic_grid | 规整等分 |
| irregular | open_montage | 开放拼版（不误当斜切） |
| inset | hero_insets | 主格 + 嵌入 |
| unframed | hero_insets（border:'none' 无框变体） | 保留无框语义 |
| auto | freeform 缺省 / 由 LLM 选风格 | |
| panelLayout(旧)/comicLayout(新) | comicStyle | 读迁移、存新枚举、不覆盖旧偏好 |

## 2. 逐步实施

### Step 2 — 新版面类型与兼容 adapter
- `src/types.ts`：新增 `ComicLayoutStyle`(5) / `ComicPanelCount`(2|3|4|'auto') / `ComicWhitespacePreference` / `ComicWhitespaceIntent`；几何类型 `ComicPanelSlot` / `ComicPanelShape` / `ComicPanelRole` / `ComicPanelBorder` / `ComicSafeArea` / `ComicPoint`；三阶段产物 `ComicVisualDirection` / `ComicLayoutPlan` / `ComicLayoutValidation`；`ModeSettings` 加 `comicStyle/comicPanelCount/comicWhitespace`；`ComicPagePlan` 加 `direction/layoutPlan`。旧 `PanelLayout`/`comicLayout`/`comicPanelsPerPage` 保留为 deprecated adapter。
- `src/manga/layoutStyle.ts`（新）：归一化 + 迁移（`migrateLayoutChoice` / `layoutStyleToLegacy` / `resolveLayoutStyle` / `resolvePanelCount` / `resolveWhitespaceIntent` + 各风格默认）。关键：`irregular→open_montage`，不误转斜切。
- 测试：`tests/layoutStyle.test.ts`（12 例）。

### Step 3 — LLM 三阶段布局计划与校验
- `src/manga/layoutValidator.ts`（新）：`validateLayoutPlan` 全量校验（格数/风格锁定/readingOrder 完整排列/坐标/polygon 顶点与自交/重叠/留白区/安全区/对白归属与顺序）；`repairLayoutPlan` 安全确定性修复（clamp、补排序、尺寸兜底），**保留已声明的合法阅读顺序、只补缺失，不擅自重排**。
- `src/manga/layoutPlan.ts`（新）：解析 LLM 的 `direction` / `layout`（兼容顶层与嵌套写法）；先修复再校验，**修复后的 plan 正确回传**（初版踩过"只记录修复却没回传"的坑，已修正）。
- `src/manga/layoutDirective.ts`（新）：把用户选的风格/格数/留白转成注入 system 的导演指令（§2.1），写明 direction/layout schema 与硬边界（锁定风格不得换、固定格数必须 N 个 slot、auto 才交给 LLM）。
- 接入链：`panelPlan.buildPanelRule` 加 `layoutDirective` 通道 → `planPrompts.buildComicSystemPrompt` 生成指令 → `planGenerator` 把用户锁定风格/格数作为 `layoutConstraints` 传给 `parseComicPagePlan` → `workflow` 用 adapter 解析设置并填入。
- 不合格 layout 变成可见 warning；绝不静默换成用户没选的版式。
- 测试：`tests/layoutValidator.test.ts`（15）、`tests/layoutPlan.test.ts`（10）、`tests/layoutDirective.test.ts`（7）。

### Step 4 — 版面预览 UI
- `src/ui/layoutPreview.ts`（新）：SVG 线框渲染器——`styleWireframe(style)`（风格卡片示意）与 `renderLayoutPreview(plan)`（按真实 slots 精确绘制，支持 polygon 斜切、阅读顺序编号、主次配色、安全区）。坐标 0..1 映射 viewBox 0..100。
- `src/ui/configPanel.ts`：设置面板「版面」下拉改为**五种风格的线框卡片**（点选即设 `comicStyle`，同步旧字段）；格数下拉接 `comicPanelCount`（自动/2/3/4）；新增留白偏好下拉 `comicWhitespace`。
- `src/styles/style.css`：风格卡片 + 线框预览样式（含 `@media(max-width:700px)` 两列适配）。
- 气泡同源：`workflow` 把 `direction/layoutPlan` 随图存进 artifact.metadata；`bubbleOverlay.artifactSlotsOf` **优先读随图存档的真实 slots**，老 artifact 回落旧推算。测试：`tests/bubbleOverlay.test.ts` +3。

### Step 5 — 几何 compositor（能力储备，默认未启用）
- `src/manga/pageCompositor.ts`（新）：`composePageCanvas` 按 zIndex 逐格合成，clip 用 polygon `Path2D`、边框沿同一路径描边（无 Path2D 环境降级矩形，不丢边框）；`slotPath` / `polygonCutsSafeArea`（斜切是否切到安全区的射线法判定）。纯函数、依赖注入 ctx 与图像源。
- 测试：`tests/pageCompositor.test.ts`（10，含 Path2D polyfill 验证 polygon 路径）。

## 3. 验证

- tsc 0 错；Vitest **54 文件 / 756 用例全过**（本轮 +57）。
- build `dist/index.js` 445.73 kB / `dist/style.css` 54.05 kB。
- 迁移兼容：老设置（comicLayout/panelLayout/comicPanelsPerPage）经 adapter 自动迁移，不覆盖用户偏好；老 artifact 无 layoutPlan 时气泡回落旧格位，行为不变。
- `buildComicSystemPrompt` 不传新维度时**完全兼容旧行为**（不产出导演指令），旧调用方与旧测试不受影响。

## 4. 未完成项 / 能力边界（诚实标注）

1. **确定性逐格合成未接入出图流程**：本轮交付了 compositor 几何核心 + 结构 + 预览，但默认出图仍是「整页一次生成」（柏宝绘原版架构）。逐格生成会显著增加请求数/成本、需改任务队列与角色一致性策略，属架构级决策——未经用户确认不擅自切换。风格/格数/斜切/留白目前是**强提示 + 代码校验 + 可见 warning**，不是几何硬保证。
2. **灯箱内的「版面设计线框」切换未做**：预览做在设置面板（选风格时可见），真实 layoutPlan 已存档可消费；灯箱视图切换属增强项，留待下一步。
3. **真实 ST + 柏宝绘环境验收未做**：本轮为纯函数单测 + 结构验证，未在真机实跑五种版式。需用户刷新后各出一组确认格数、斜切、留白是否符合预期。
4. **Canvas polygon 碰撞用于气泡**：compositor 已具备 polygon clip，但气泡碰撞仍按 slot bbox；真斜切下气泡与斜边的精确避让留待确定性合成启用时一并处理。

## 5. 改动文件清单

新增：`src/manga/layoutStyle.ts`、`layoutValidator.ts`、`layoutPlan.ts`、`layoutDirective.ts`、`pageCompositor.ts`，`src/ui/layoutPreview.ts`；测试 `tests/layoutStyle.test.ts`、`layoutValidator.test.ts`、`layoutPlan.test.ts`、`layoutDirective.test.ts`、`pageCompositor.test.ts`（+ `bubbleOverlay.test.ts` 扩展）。
修改：`src/types.ts`、`src/manga/panelPlan.ts`、`src/manga/planPrompts.ts`、`src/manga/planGenerator.ts`、`src/manga/bubbleOverlay.ts`、`src/tasks/workflow.ts`、`src/ui/configPanel.ts`、`src/styles/style.css`。
报告：`PHASE_LAYOUT_SYSTEM_REPORT.md`（本文件）。
