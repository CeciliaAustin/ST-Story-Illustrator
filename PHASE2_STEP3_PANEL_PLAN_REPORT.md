# Phase 2 — Step 3（前半）分镜计划纯函数 完成报告

> 日期：2026-11-18
> 范围：接上次中断处继续。上次 AI 说要加 `mountMode` 字段并开始「任务 #16 —— 漫画分镜计划纯函数」。
> 本次完成：`mountMode` 状态核查 + 任务 #16（漫画分镜计划纯函数 + 发送侧确定性纠正）。

---

## 0. 中断点状态核查

上次 AI 计划做的两件事，`mountMode` **其实已经落地**，无需重复：

| 项目 | 核查结果 | 位置 |
| --- | --- | --- |
| `mountMode` 字段区分 inline / trailing | ✅ 已存在 | `src/types.ts:491` `ArtifactMountMode`、`496` `defaultMountMode()`、`521` `VisualArtifact.mountMode` |
| 设计文档说明两种挂载 | ✅ 已存在 | `DESIGN_NOTES.md:176–194`「显示位置：两种挂载模式」 |
| `anchorFloor` 字段 | ✅ 已存在 | `src/types.ts:520` `VisualArtifact.anchorFloor` |

> 结论：设计层已经完备。真正缺的是 **Step 3 漫画分镜选择链**里的纯函数实现，即上次说的「任务 #16」。本次补齐。

---

## 1. 新增文件

| 文件 | 说明 |
| --- | --- |
| `src/manga/panelPlan.ts` | 漫画分镜计划纯函数（本任务核心）：四档规则构建、构图词/nl 版面句常量、台词归一化、LLM JSON → ComicPagePlan 容错解析 |
| `src/manga/panelEnforce.ts` | 发送侧确定性纠正纯函数：`enforcePanelPrompt` / `decidePanelInjection` / `applyPanelToNl` / `enforceForGeneration` |
| `tests/panelPlan.test.ts` | 33 个测试覆盖归一化、规则构建、台词清洗、JSON 解析 |
| `tests/panelEnforce.test.ts` | 24 个测试覆盖纠正、注入决策、nl 兜底、串联组合 |

---

## 2. 实现内容

### 2.1 `panelPlan.ts` — 计划纯函数

**常量唯一来源**（遵守文档坑 2「规则/示例/nl 兜底三处同档」纪律）：

- `PANEL_TAGS_BY_LAYOUT` — 四档带权重构图词（原样照抄，坑 3）
- `PANEL_NL_SENTENCE` — 四档 × 画幅的 nl 版面句
- `UNFRAMED_PAGE_SPECS` — 无框 a/b/c/d 四页型结构（含 `nlHeadline`、区域、边框归属、重叠上限）
- `PANEL_BUBBLE_AREAS` / `PANEL_DIALOGUE_MAX = 4` / `PANEL_DIALOGUE_TEXT_MAX = 60`

**归一化纯函数**：

- `normalizePanelLayout` / `normalizePanelPageType` / `normalizeDialoguePolicy` — 脏值回落白名单
- `normalizeDialogueItems(value)` — 台词清洗：坏条目丢弃、超长截断、area 乱码回落自动分配、坐标 clamp 到 0~1 并四位小数
- `normalizePanelLayout` 在 `enforcePanelPrompt` 等入口内部也先归一化（文档初版漏了这一层）

**规则构建**：

- `buildPanelRule(enabled, options)` — 关闭立即返回空串；按档分派 regular/irregular/inset/unframed 规则文本； nl 关闭时走无 nl 变体；仅 NAI + 角色块追加「不写 pos」；台词开启时追加 `panelDialogueClause`
- `panelDialogueClause(mode, policy)` — json / tag 两种写入格式 × auto/always/eager 三种频率
- `unframedNlSentence(pageType)` — auto 用经典 A 型长句，钉死页型用对应 headline

**LLM JSON → ComicPagePlan 容错解析**：

- `parseComicPagePlan(input)` — 接受 `{pages:[...]}` / 单页对象 / 页数组 / markdown 代码围栏 JSON 字符串；坏 JSON 返回空 pages + warning，**不抛异常**；逐页逐格归一化，脏布局回落 regular，索引钳制为非负整数；空可选字段省略以保证历史数据 round-trip 稳定

### 2.2 `panelEnforce.ts` — 发送侧确定性纠正

严格按文档 §6.3 移植，关键坑全部覆盖：

- `enforcePanelPrompt(prompt, layout)` — 删与档位冲突的词、补缺词并前置、判重用裸词（`1.4::2koma::` ≡ `2koma`）、跨逗号权重块保留不撕坏、记录所有裸词避免 `white background` 重复注入
- 场景词策略：`inset` 全删场景词；`unframed` 放行 indoors/outdoors 锚点 + 最多 2 个地点词（坑 6：场景词全删会让室内戏画到室外）
- `decidePanelInjection(input)` — 判据只在这一处：小剧场图不注入；Q 版生效恒压回 regular；档位先归一化
- `applyPanelToNl(nl, layout, orientation, pageType)` — nl 为空/中文主体/已写版面标记三种情况不碰；「中文主体」用**中文字符数 > 英文字母数**判断（坑 5：含中文角色名的英文 nl 不能误判）；幂等
- `enforceForGeneration(input)` — 上述三者的串联组合，供后续出图步骤直接调用

### 2.3 对文档参考实现的一处修正

文档 §6.1 的 `normalizeDialogueItems` 写的是 `value.slice(0, MAX)` 后再过滤坏条目——坏条目会挤占有效名额（模型给 4 条、其中 2 条坏，就只剩 2 条）。改为「先过滤、凑够 4 条有效台词就停」，与文档自称的"一图最多 4 条有效台词"意图一致。代码注释已标注此偏差。

---

## 3. 类型检查

`types.ts` 已定义的类型（`PanelLayout`、`PanelPageType`、`DialoguePolicy`、`PanelBubbleArea`、`ComicDialogue`、`ComicPanelPlan`、`ComicPagePlan` 等）足以覆盖本次实现，**无需改动 types.ts**。`NormalizedDialogue` 在 `panelPlan.ts` 内以 `extends ComicDialogue` 定义，额外携带可选手动坐标 x/y。

`tsc --noEmit` 中新增 manga 文件 **0 错误**。

---

## 4. 测试结果

```
Test Files  6 passed (6)
     Tests  123 passed (123)

 ✓ tests/bridge.test.ts        (5)
 ✓ tests/anchor.test.ts        (8)
 ✓ tests/compose.test.ts       (17)
 ✓ tests/panelEnforce.test.ts  (24)  ← 新增
 ✓ tests/panelPlan.test.ts     (33)  ← 新增
 ✓ tests/storySegment.test.ts  (36)
```

`panelEnforce` 关键回归用例：加权词判重不重复注入、跨逗号权重块不撕坏、inset 场景词全删、unframed 场景词限流、中文主体不补版面句、含中文角色名的英文 nl 照补、幂等性。
`panelPlan` 关键回归用例：坏 JSON 不抛异常、代码围栏解析、坏分格丢弃保留有效格、空可选字段不落盘。

> 注：`tsc --noEmit` 仍有 5 个**此前就存在**的错误（`bridge.ts` 后端状态字段、`sillytavern.ts` 动态导入 extensions.js、`index.ts` window 类型断言），与本次改动无关。PHASE2_STEP2_REPORT 已记录「TypeScript 编译未验证」，这些是历史遗留。

---

## 5. 剩余工作（Step 3 后半 + 后续）

Step 3「漫画分镜选择链」本次只完成纯函数地基，以下仍待实现：

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 单楼/跨楼选段 → LLM 结构化 JSON | 纯函数已就绪 | `parseComicPagePlan` 可解析，但 LLM 请求接线（`generateQuietPrompt` + system prompt 组装）未做 |
| 预览/编辑 ComicPagePlan UI | 未实现 | 需接 `selectionPanel` 之后 |
| Profile 选择 UI | 未实现 | `VisualProfile` 类型已有 |
| 逐格 generate() 出图 | 未实现 | 需接 `ImageBackendAdapter` |
| 工作组挂载（inline 卡片） | 未实现 | `mountMode`/`anchorFloor` 数据层已就绪，DOM 挂载未做 |
| 对白元数据 + Canvas 合成 | 未实现 | §6.4–6.10 气泡合成纯函数待移植 |
| QQ人状态栏/彩蛋/黑白漫三套 | 未实现 | Step 4 |
| 小剧场串行队列 / 看门狗 / 固定种子 | 未实现 | Step 4 |

**下一步建议**：先把 `buildPanelRule` 的输出接到 `generateQuietPrompt` 组装 system prompt，让「选段 → LLM 结构化分镜 JSON → `parseComicPagePlan`」链路跑通，再做预览编辑 UI 和逐格出图。
