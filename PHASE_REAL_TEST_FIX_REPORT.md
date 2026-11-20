# 漫画分镜实测故障修复报告（三页全错 + 气泡位置不刷新）

> 触发：用户实测三页漫画全错（A 开放拼版竖排无留白 / B、C 主图+特写只出一格），台词被改写，
> 改气泡位置后退出聊天仍是旧的。GPT 任务书作参考。
> 提交：`5ea0a7c`，部署 md5 `28fcbd02…`。

---

## 一、审计结论（任务书 §1 的 12 问）

| # | 问题 | 结论 |
|---|------|------|
| 1 | UI 的 layout/panelCount/whitespace 是否传到 LLM 规划层 | 传了：`workflow.ts` 把 `comicStyle/comicPanelCount/comicWhitespace` 写进 `planOptions`，`buildComicSystemPrompt` 生成 layoutDirective。 |
| 2 | 是否在中间被默认值覆盖 | **是，关键断点**：规划层读了新三维，但**出图层** `enforceForGeneration` 仍用旧字段 `comicLayout` → 经 `layoutStyleToLegacy` 拍回旧四档 → 取旧词表。用户新选择等于白选。 |
| 3 | 3koma 是否无条件注入 | **是**。旧 `panelTagsForCount` 对固定格数无条件追加 `Nkoma`。 |
| 4 | multiple views / split screen 是否无条件注入 | **是**。`PANEL_TAGS_BY_LAYOUT` 的 irregular = `multiple views + split screen`，开放拼版也被注入 → 实测 A 竖切屏。 |
| 5 | inset 是否用 one or two | **是**。`LAYOUT_NL_HEAD.inset` = "one or two small close-up panels" → 实测 B/C 只出一格。 |
| 6 | 页级 NL 是否被兜底句覆盖/追加冲突 | 是。`buildPageNl` 无条件追加 `LAYOUT_GAP_NOTE`，与旧首句并存又互相打架。 |
| 7 | 整页一次还是逐格 Canvas | **整页一次**（`baiBaiAdapter.generate` 每页一次）。`composePageCanvas` 是能力储备，默认未启用。 |
| 8 | 格数是否有校验 | 只在 LLM JSON 层（`expectedPanelCount` 告警），**没有**最终图像可见格数的校验，失败静默当成功。 |
| 9 | 台词是否由 LLM 重写 | **是**。prompt 明写「写不超过 20 字口语」，`normalizeDialogueItems` 还 trim/slice。无 source span，100% 改写。 |
| 10 | 角色库清洗/绑定 | 有（resolveCastNames / characterPromptsFromLibrary），本次未动。 |
| 11 | 是否有提示词日志 | 有 `recordImageLog`，本次改为记录真正发出的 `finalPrompt/finalNl`。 |
| 12 | dist 是否与源码一致 | 是。部署 md5 与构建产物一致。 |

**根因一句话**：新版面系统只做对了「规划 + 校验 + 预览」，但**出图词仍走旧四档词表**，且台词是生成式而非引用式；气泡刷新输给了增量挂载。

---

## 二、本次修复（对应实测三个症状）

### 修复 1 — 新风格真正驱动出图词（治 A / B / C 的词层根因）
- 新增 `src/manga/stylePrompt.ts`（纯函数）：`styleCompositionTags / styleLayoutNl / buildStyleGeneration / stripLegacyLayoutTags`。
- `workflow.ts` 出图前：先 `stripLegacyLayoutTags(composed.prompt)` 剥掉模型写进 page.tags 的旧冲突词
  （`3koma / split screen / multiple views / white background`），再由新三维注入正确的词。
- NL 改为「新风格骨架句 + 各格画面内容」（`panelNlContentOnly`），旧档首句/留白句不再拼进来。
- 效果对照：
  - A 开放拼版三格：`asymmetric layout + 3koma`，NL 声明 "unequal in size, do NOT line up in a simple vertical column" + airy 留白 → 不再竖排、不再无留白。
  - B/C 主图+特写三格：`3koma`，NL 明确 "Exactly three separate panels … one large main panel plus two smaller bordered inset panels (exactly three panels in total)" + dramatic 留白 → 不再 "one or two"、不再只画一格。
- 旧链路（panelEnforce / PANEL_TAGS_BY_LAYOUT）**保留**：自动档、历史图重画仍走它，不破坏既有功能。

### 修复 2 — 台词 100% 原文（治「台词被改写」）
- 新增 `src/manga/sourceDialogue.ts`：
  - `resolveSourceDialogue`：从用户选段逐字抽候选台词（引号优先，退到逐行），带稳定序号。
  - `reconcileDialogueWithSource`：按 `sourceIndex` / 逐字命中回填原文那一串；**匹配不到的整条丢弃**。
  - `sourceDialogueBlock`：注入 LLM 的「可选原文清单」，明令禁止改写。
- LLM 侧：`presets.ts` 的 COMIC schema 把 dialogue 改为引用式（`sourceIndex` + 可省略 text）；
  `buildComicUserPrompt` 注入原文块；`panelPlan.normalizeDialogueItems` 保留引用字段（不再截断 quote）。
- 结果：气泡里的字一定是 `selectedText` 里出现过的逐字片段；UI 拖位置/换行只做视觉处理，底层原文不变。

### 修复 3 — 气泡位置改了不刷新
- 根因：`onSave` 调 `mountFloor`，但它是增量挂载——卡片还在 DOM、`data-sti-src`（无字原图路径）没变 →
  判为「没过期」跳过 → 气泡不重合成。灯箱里看着改好了，关掉还是旧的，退出聊天重进才对。
- 修复：新增 `refreshComicCard(floor, artifactId)`，只精准重绘这一张卡的气泡（撤销旧 blob → 退回无字原图 → 按最新 dialogue 重合成），其它卡与 DOM 不动，不闪屏。

### 修复 4 — 固定格数 QC
- `artifact.metadata` 存 `expectedPanelCount / renderedPanelCount / panelCountMatched`；不符时出日志 + 用户提示，不再静默当成功。

---

## 三、验证
- 新增 `tests/styleGeneration.test.ts`（12 例，三场景固化）、`tests/sourceDialogue.test.ts`（11 例）。
- 全量：56 文件 / 779 用例通过；`tsc --noEmit` 0 错；`vite build` 448.56 kB。
- 部署：G 盘扩展根目录 index.js/style.css 与构建产物 md5 一致（`28fcbd02…`）。

---

## 四、诚实限制（未做 / 不能宣称做到的）
1. **固定格数不是程序级保证**：当前仍是「整页一次生图」，格数靠模型遵循 `Exactly N panels` 的自然语言。
   真正的确定性方案是「逐格生成 N 张素材 + Canvas 按 slots 合成」（任务书 §3.2 / §5），
   `composePageCanvas` 已具备几何能力，但接入会改变出图成本（×N）、图库存图方式与气泡落位，
   属架构级重构，本轮**未接入**。本轮做的是「词层确定性 + 格数 QC 告警 + 提示用户」。
   如需 100% 格数，下一步应专门做逐格合成模式（可作为明确标注的实验选项）。
2. **未做真机生图验收**：当前环境无法调用 NovelAI / 柏宝绘真实出图，三场景只做了词层回归与数据流测试。
   视觉效果（是否真的三格、留白是否真留）需要用户在 SillyTavern + 柏宝绘里刷新插件后实测。
3. **角色串脸 / 人物错**（实测 A 提到人物不符）：本次未改角色绑定链路，需单独取证是选段取词还是库条目问题。
