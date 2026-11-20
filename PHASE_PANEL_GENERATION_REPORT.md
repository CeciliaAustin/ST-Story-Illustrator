# 逐格出图 + 代码排版：漫画分页重构报告

> 对应问题：用户实测「主图+特写 / 固定三格 / 大面积留白」出成 **一格**、
> **整张纯白底**、**台词全丢**。

## 一、为什么之前的修法注定失败

前两版都在"整页一次出图"的框架里调词。这条路有三条硬上限：

| 现象 | 真实原因（架构级） |
|---|---|
| 三格变一格 | 格数是模型"愿不愿意画"的问题。整页出图时 `3koma` 只是暗示，模型忽略就没有任何补救手段。 |
| 框内也没背景、整张纯白 | 想把"框外留白"告诉模型，唯一能用的词是 `white background`；但它在 NAI 里的含义是**整张图不要背景**。模型无法区分"页面留白"和"格内背景"——这两个概念在单张图里没有区别。 |
| 台词全丢 | 台词回填要求逐字命中，模型回述时丢了「」或改了标点就整条丢弃；选段里抽不到引号台词时，候选表为空 → 每条都丢弃。 |
| 留白/主次不听 | 页面留白本质是**几何排版**，不是画出来的内容。靠自然语言描述几何，成功率天然很低。 |

结论：**只要还是一张图画多格，白底、格数、留白都不可能可靠**。

## 二、新架构：一页 N 格 = N 张图 + 代码排版

```
规划（LLM，只写每格画什么）
   ↓
逐格出图（每格一张完整插画，各自带场景背景）
   ↓
代码排版（白纸 + 各格 + 细黑框；留白由页边空白提供）
   ↓
上传落盘 → artifact（存 panelImages / pageSlots / panelPrompts）
   ↓
显示层：无字页图 + 气泡合成（改台词/挪气泡不重出图）
```

### 新增模块

- `src/manga/pageSlots.ts` — 确定性格位。四档各有一套几何：
  - `regular`：等分横排（传统四格）；
  - `irregular`：大格 + 递减小格，铺满整页；
  - `inset`：**主图居中无框 + 顶部窄条 + 右下特写格**，主图四边不贴页边（= 框外留白）；
  - `unframed`：主图铺满无框，特写格浮在上面。
- `src/manga/panelShot.ts` — 每格的出图词。剥掉**所有**页级构图词
  （koma / multiple views / split screen / white background / comic page / panel layout…），
  保留场景，人数词按本格角色库条目的性别重算。
- `src/manga/pageAssemble.ts` — Canvas 合成：白纸 + cover 裁切（顶部锚点 0.28，不切脸）+ 细黑框。
- `src/host/sillytavern.ts` — `uploadImageBase64`：走 ST 的 `/api/images/upload` 落盘，刷新不丢。

### 改动点

- `workflow.ts`：出图循环从"一页一次"改成"一页 N 次 + 合成 + 上传"；
  逐格失败时整页兜底（旧路径），保证这一页不空；metadata 记
  `panelImages / panelPrompts / panelNls / pageSlots / pageAssembled`。
- `panelPlan.ts`：新增 `perPanelRule()`。逐格模式下规则里**没有任何构图词**，
  改为要求"每格自带场景、每格写清镜头与地点、不许写版面词"。
- `presets.ts`：COMIC 提示词同步改写——不许写 koma / white background，
  page.tags 必须写地点与光线（会被带进每一格）。
- `sourceDialogue.ts`：两级匹配（逐字 → 去标点）+ 选段无台词候选时保留模型稿。
  台词不会再整页消失。
- `bubbleOverlay.ts`：气泡格位优先读 `pageSlots`（合成这张图用的那一份）。
- `rerollPage.ts`：逐格页的"改词重画"按格重画再拼回一页，不会退回单格。

## 三、端到端实际产出（用户这次那一页）

```
版面: inset / 3 格
格位: #0 x=.055 y=.195 w=.890 h=.545 border=none   ← 主图，四边留白
      #1 x=.140 y=.035 w=.720 h=.120 border=thin   ← 顶部窄条（脸）
      #2 x=.600 y=.795 w=.350 h=.170 border=thin   ← 右下特写（手）

[格 1] 1girl, 1boy, upper body, height gap, hand on cheek, cupping face,
       luxury boutique, fitting room, warm lighting, soft shadow
       叶均 → 1boy, dark charcoal patterned shirt, rolled-up sleeves, hand on her cheek
       陆子慕 → 1girl, cream white wool coat, low-cut knit sweater, looking up

[格 2] 1girl, close-up, …, luxury boutique, fitting room, warm lighting
       陆子慕 → 1girl, cream white wool coat, blushing

[格 3] 1boy, extreme close-up, …, luxury boutique, fitting room, warm lighting
       叶均 → 1boy, dark charcoal patterned shirt, thumb on her lip
```

- `white background` 一个都没有 → 框内保留背景
- 白只出现在格子之间与页边（#0 四边留 5~7%）→ 框外留白
- 3 张图 = 3 格，格数是代码保证的

## 四、验证

- 新增 `tests/perPanelGeneration.test.ts` 21 例：格位几何、逐格词无版面词、每格保留场景、
  单人特写格不串人、裁切不切头、规划规则无构图词、台词不整页消失、气泡用 pageSlots。
- 全量 **58 文件 / 835 用例通过**，`tsc` 0 错，`build` 486.74 kB。
- 部署到酒馆扩展目录，产物 md5 一致。

## 五、仍然存在的限制（如实说明）

1. **成本变成 N 倍**：一页三格 = 三次出图。这是"格数 100% 确定"的唯一代价。
2. **同一页各格是同一次调用的不同种子**：人物一致性靠角色块 + 着装定妆，比整页出图稍弱，
   但不会再出现"三个人三张脸"级别的漂移。
3. **页面级动作词会带进每一格**：`page.tags` 里若写了 `hand on cheek` 这类共享互动，
   每一格的图都会有它（这对特写格通常是好事，但可能让某格多出一只手）。
4. **上传失败会退化**：`/api/images/upload` 不可用时只显示第一格并给出提示。真机需要确认一次。
