# 漫画分页按柏宝绘原版重搭 — 审计与实现报告

> 触发：用户实测「主图 + 特写 / 固定三格 / 大面积留白」，出图是**三条等宽横带**，
> 并给出《漫画分镜与对白气泡 — 代码与提示词说明》要求照它重搭。

---

## 一、为什么会出成三条横带（逐条对因）

用户拿到的实际出图词是：

```
comic page layout, 3koma, 2girls, cowboy shot, portrait, whispering, leaning in, ...
角色: 叶均  1boy, ...
角色: 陆子慕 1girl, ...
```

| 现象 | 根因 |
|---|---|
| 三条**等宽**横带 | `3koma` 在 danbooru / NAI 的语义就是「等分 N 格漫画条」。用户要的是"一张主图 + 两个特写格"，而主图+特写在原版里是 **inset / unframed 档，明确禁止写 2koma/3koma/4koma**——写了就会被画成等分条带。 |
| 词写了但没效果 | `comic page layout` / `panel layout` 是上一版自己造的词，danbooru 上是 0 帖空 tag。文档点名：`panel layout` / `comic panel` / `manga` 写了等于没写，`comic` 会拉成黑白网点。 |
| 没有留白 | inset 档的 nl 被写成 `"narrow white margins"`（贴边白边），与"大面积留白"**正好相反**。原版是 `generous white space around it`。 |
| 人数 `2girls` | 人数词由 LLM 写，它把 `1boy`（叶均）+ `1girl`（陆子慕）数成了两个女生。人数词直接决定画面里有几个人、什么性别。 |
| 主图+特写只出一格 | 旧 nl 写 `one or two small close-up panels`——"一到两个"模型就取 1。 |

**结论**：不是模型不听话，是发给它的词与它想要的版面语义相反。分镜效果 90% 在提示词。

---

## 二、重搭后的结构

### 2.1 三个维度 → 柏宝绘四档（唯一映射点）

| UI 风格 | 格数 | 留白 | 落到档位 | 构图词（带权重，原样） |
|---|---|---|---|---|
| 传统四格 | 2 | — | regular | `1.4::multiple views::` `1.4::2koma::` `1.5::split screen::` |
| 传统四格 | 3 | — | regular | 同上，`2koma` → `3koma` |
| 传统四格 | 4 | — | regular | 同上，→ `4koma` |
| 开放拼版 | 2~4 | 任意 | irregular | `1.4::multiple views::` `1.5::split screen::` |
| 斜切分格 | 2~4 | 任意 | irregular + nl 描述斜边 | 同上 |
| 主图 + 特写 | 2~3 | 舒展 / 大面积 / 默认 | **inset** | `1.5::multiple views::` `1.4::white background::` |
| 主图 + 特写 | 2~3 | 紧凑 | unframed（A/B 页型） | 9 个中文带权重词（非对称布局 / 无边框中央插画 / 人物自然融入白色空间…） |
| 自由构图 | 2~4 | 任意 | irregular | 同开放拼版 |

三条硬规则：

1. **`koma` 只对 regular 成立**——它是"等分 N 格"的语义本身，不是通用格数提醒。
2. **白底两档（inset / unframed）禁写任何 koma / split screen / 场景词**，否则必被画成实景或多栏。
3. **"留白"只对主图+特写有效**：inset 是"四周大量留白"，unframed 是"主画铺到页底、白边窄"。开放拼版在原版里是**铺满**的，留白偏好对它无效——这一点现在会在运行提示里如实说明，不再假装支持。

### 2.2 发送侧确定性纠偏（不靠模型听话）

出图前一律过一遍：

1. 删与档位冲突的分格词（inset/unframed 删全部 koma + split screen + multiple views）；
2. 无条件删空 tag（`comic page layout` / `panel layout` / `comic panel` / `manga` / `comic`）；
3. 补这一档缺的构图词，**放在最前面**（越靠前权重越高）；
4. 白底档清场景词：inset 全删家具/光照/时段；unframed 放行 `indoors/outdoors` + 最多 2 个地点词（全删会让室内戏画到街上）；
5. 比较一律用裸词（`1.4::3koma::` 与 `3koma` 同一个），跨逗号权重块一律不动（宁可漏删，不撕坏提示词）。

### 2.3 nl 由代码写死第一句

- 版面首句按「档 + 页型 + 格数」取原版措辞：inset 明确"居中主图 + 四周大量留白 + 顶部横条 + 右下格"；unframed A 型明确"顶条 20% + 主画 80% + 右下浮格"；regular 三格明确"一宽上格 + 两小下格"。
- 各格内容按区域引导词落位（主图 → 顶部条 → 右下格），顺序与版面一致。
- 收尾一句连续性：所有格是同一个连续瞬间。
- 规划层与出图层**共用同一个版面答案**（同一次 `buildBoardGeneration`），不再出现"计划四格、出图三格"。

### 2.4 人数词纠偏

以角色块为准重算 Base 人数词（`1boy` + `1girl` → `1girl, 1boy`）。
**只在角色块覆盖得住 Base 声称人数时才纠**：库里查不到第二个人（例如用户扮演的「你」还没建块）时不动，否则会真的少画一个人。

---

## 三、验证

- 新增/重写 35 例：四档词表、档间禁词、空 tag 清理、白底档场景词、`koma` 覆盖、跨逗号权重块保留、四档 nl 措辞、区域引导词、人数纠偏、三场景端到端。
- 端到端跑用户这次的选择（主图+特写 / 三格 / 大面积留白）：

```
正向词：1.5::multiple views::, 1.4::white background::, 1girl, 1boy, cowboy shot,
        portrait, whispering, leaning in, holding arm
删除：comic page layout | 3koma | soft lighting
nl：A manga page on a white background: a single unframed character illustration
    occupies the center, drawn large, with generous empty white space around it;
    a narrow wide panel with a thin black border across the top shows a close-up of
    one face, and a small framed panel in the bottom right corner shows one
    close-up detail of the same moment. ...
```

- 全量 **57 文件 / 814 用例** 通过，tsc 0 错，build 461.29 kB，部署产物 md5 一致。

---

## 四、限制（必须知情）

1. **格数仍非"像素级保证"**：整页仍是一次出图。regular 档的 `3koma`/`4koma` 是**语义级**保证（这个 word 本身就是等分 N 格，模型很难违背）；inset/unframed 的三格靠"顶条 + 主画 + 右下格"的位置描述，比裸 `3koma` 稳，但仍有概率漏掉一个特写格。真要做到 100%，只能逐格出图再 Canvas 合成（`composePageCanvas` 已有几何能力，未接入，成本 ×格数）。
2. **未做真机生图验收**：此环境无法调用 NAI/柏宝绘真实出图。请刷新插件后重跑那一页，把新提示词和成图发我；若仍有偏差，我按"实际收到的图"继续调词，而不是猜。
3. **UI 仍是五风格入口**：没有改成柏宝绘的四档按钮——五位是老用户已保存的偏好，改动会重置他们的设置。五风格现在只是"选档入口"，映射表见 §2.1，并在提示里说明哪种组合会落到哪一档。
