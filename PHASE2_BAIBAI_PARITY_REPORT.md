# 柏宝绘对齐报告（第 4 轮）

> 这轮的问题不是「提示词口味」，是三个可指认的缺陷 + 一个架构边界。
> 先把「文档功能在柏宝绘内部是怎么实现的」讲清楚，再讲伴生插件能接到哪一层。

---

## 一、两份文档的功能，如果在柏宝绘内部实现，是这么接的

### 1.1 漫画分镜 + 对白气泡（漫画分镜文档）

它长在 **autoTag（自动打标）** 这条链路上，一共三个注入点：

| 注入点 | 位置 | 做什么 |
|---|---|---|
| ① 规则注入 | `autoTag/prompt.ts` 组装 system 处 | 按 `spec → castRule → chibiRule → panelRule → shotRule → compositionRule → gazeRule` 顺序 merge，`buildPanelRule()` 关闭时返回空串 |
| ② 发送侧纠正 | `generate.ts` 调 `generateImage()` 之前 | `decidePanelInjection` 判档（小剧场不注入、Q 版压回 regular）→ `enforcePanelPrompt` 删冲突词补缺词（构图词**带权重**，`1.4::multiple views::`）→ `applyPanelToNl` 补版面句 |
| ③ 台词存储与显示 | bbi_image tag 的 `<dialogue>` 子标签 + `floor/Card.vue` / `Lightbox.vue` | 落盘只存**无字原图**（`baseOnly`），台词当数据存；显示/下载时 `compositeDialogue()` 现画气泡 |

关键点：它和正文插图共用同一个 `promptHash` / 对账 / 历史，所以「改一个词就判旧图、重 roll」这套天生就有。

### 1.2 三套小剧场（QQ 人 / 彩蛋 / 黑白漫）

它**不走 autoTag**，是一条平行的运行时：

```
MESSAGE_RECEIVED → 串行队列（一次一层）
  → readStatus()：一次 LLM 请求（KIND 表决定 system + 格数）
  → parseStatusReply → 安全清洗（黑白漫三层防护）
  → 按角色取外貌 → 拼 prompt + characters
  → generateImage({ prompt, nl, characters, seed, size, lane })
  → saveStatusImage 落 message.extra 的三个桶（status/bonus/manga）
  → mountStatusBar 挂 .mes_block 末尾
```

两个决定性细节：

1. **外貌不是靠名字查表**。`autoTag/charAnchors.ts` 的文件头写得很明白：生成 tag 前把**整份角色库文本**拼进请求，让模型照抄字段。所以「正文叫她 Cecilia、库里叫 Sissy」这种差异，是**模型自己接上的**。
2. **小剧场图不写正文**（§1B.7）。它存 extra，不参与 promptHash，否则自动化会污染剧情文本、还会把正文插图的槽位序号顶掉。

---

## 二、伴生插件只能走协议口，`STBaiBaiImage` 就四个方法

```
getCharacters({floor}) → 角色库快照（name / tag / fields / nl / scope）
getBackendStatus()     → 后端、模型、supportsCharacters
generate({prompt, nl, characters, negative, seed, size, save})
subscribe(listener)    → 角色库变更通知
```

没有：autoTag、tag 写入、请求历史。因为跨 bundle 拿不到内部函数，而它的请求历史是模块内 `records` 数组（只有 `floor/Card.vue` 会写）。

所以「完全一样」只能在协议层做到等价：

| 文档里的做法 | 插件里的等价物 | 状态 |
|---|---|---|
| 角色库文本进 prompt，模型照抄 | `getCharacters()` → 渲染成同一套字段文本 → 塞进读剧情 system | **本轮补上** |
| `characters[]` 走 NAI char_captions | `generate({characters})` | 已有 |
| 方案（模型/画师串/质量词/vibe） | 同一个 `generateImage()` 闸门，整套方案照用 | 已有 |
| 台词 `<dialogue>` 子标签 | 黑白漫 `lines` + canvas 叠气泡（存无字原图） | 已有 |
| 提示词可改（柏宝绘的提示词编辑弹窗） | 卡片上「改词」按钮：看得见、改得动这一格真正发出去的 tag + nl | **本轮补上** |
| 请求历史 | 自建「出图日志」页 | 已说明不可行 |

---

## 三、这轮修的四个缺陷

### 3.1 勾选框「取消不掉」（选段弹窗）

```ts
// 旧代码
if (selectedModes.size === 0) {
  selectedModes.add('illustration');   // ← 偷偷塞回去
  cb.checked = false;                  // ← 只把勾去了，行还是 selected
}
```

于是 `selectedModes` 里仍有 `illustration`，`.sti-mode-item.active` 继续用主题色（这套主题是粉红）画边框 —— 用户看到的就是「没勾但红框还在」。只有先勾别的（size > 0）、再取消，才会真的删掉。

现在：允许一个都不选；确认按钮置灰并显示「请至少选一个创作模式」；change 后 `blur()`，焦点环只在 `:focus-visible` 画。

### 3.2 「这人是谁」——角色库根本没进 prompt

旧 prompt 只发**名字名单**，模型看不到发色瞳色；又因为它被要求「照抄正文里的叫法」，正文写 `Cecilia` 而库里叫 `Sissy` 时：名字查不到 → 没有外貌 → 模型自己编一个（白毛/棕发路人）。

现在（与柏宝绘同一套做法）：

- 把角色库按字段渲染成文本发进 system：`- Elias: 性别=1boy, 头发=short blond hair, 眼睛=green eyes, 体型=tall`
- 加「谁是谁」：`用户扮演：Sissy（正文里的「你」指的就是这一位）` + 角色卡 + 人设摘要
- 规则改成：`characters[].name 必须照抄角色库里的名字`
- 读音分流：`你/我` → 用户扮演那位；`他/她` → 角色卡那位（以前统一落到主角，用户说「你」反而拿到对方外貌）
- 唯一解一对一补位：一格里只有一个名字对不上、库里正好只剩一条没用过 → 那就是他
- 库为空时明确写日志，不再装没事

### 3.3 act 绑错人

`act` 以前被合进 Base 正向词，两个角色时模型经常把 A 的动作安到 B 身上。现在 `act` 进各自的 `characters[].tag`（柏宝绘规范：Base 只写人数/场景/光线，角色动作写在该角色自己的 tag 里）；没有外貌的人把动作留在 Base，避免人凭空消失。

### 3.4 提示词没法改

小剧场的图不挂正文 tag（见 §1.2），所以柏宝绘的提示词编辑弹窗够不着它。新增卡片上的「改词」按钮：两栏（正向 tag / nl）就是当时真正发出去的内容，改完就地重画，并写回这一格（下次 ↻ 沿用改后的词）。

外貌那一栏只读——它来自角色库，改这里等于绕过角色库，重画出来就不是那个人；要改请去柏宝绘「角色」页。

---

## 四、验证

1. 硬刷新酒馆。
2. 打开「创作模式」，把唯一勾着的「正文插画」取消 → 粉框立刻消失，确认按钮变灰。
3. 跑一次小剧场，开「出图日志」：
   - 读剧情那条的 `【system】` 里应出现 `【角色固定外貌库 · 来自柏宝绘，只读】` 与 `【本聊天的人物对应】`；
   - 出图那条的「角色（柏宝绘角色库）」应显示 `Sissy: 1girl, long brown curly hair, wine red eyes, ...`；
   - 若出现「柏宝绘角色库是空的」→ 说明 `getCharacters()` 真的返回空，去柏宝绘「角色」页确认条目（全局库也算）。
4. 点任意一格的「改词」，把 `1girl` 改成 `1boy` 再保存 → 应该出一张男的，说明改的确实是发出去的那串。

---

## 五、仍然做不到的（不是没做，是接口没有）

- **小剧场图变成正文的 `<bbi_image>` tag**：会顶掉正文插图的槽位序号（`hasImageTagAfter` 那套会判「旧提示词」），也会让柏宝绘再画一遍同一张。要这么做等于放弃「附加物」这条设计（文档 §1B.7）。
- **写进柏宝绘的请求历史**：那是模块内数组，没有写入接口。
- **调它的 autoTag 替我们写 tag**：`requestFloorTags` 没有导出到公开接口。
