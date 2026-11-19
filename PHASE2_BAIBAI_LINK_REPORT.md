# 与柏宝绘真正联动：人物外貌走 character prompts

> 本轮用户反馈三件事：
> 1. 「正文插画」自动出图的勾取消后仍显示勾着，要勾一次再取消才消失；
> 2. 小剧场出图跟剧情、跟人物都没关系（四格里的人不是 Elias / Cecilia）；
> 3. 「柏宝绘是有提示词的、有人物的，你怎么能不跟柏宝绘联动？走柏宝绘途径出图！」
>    并贴出了读剧情的请求日志：`messages:[{role:'system',content:''}, ...]`。

## 一、最要命的一条：外貌被拼进了正向词

柏宝绘自己的源码里写得很清楚（`src/backends/nai.ts`、`src/generate.ts`）：

- 它画多角色走的是 NAI 的 **character prompts**（`v4_prompt.char_captions`），
  公开接口对应的字段就是 `characters: [{ name, tag, nl }]`；
- `GenerateOutput.charactersApplied` 的注释原话：
  「**不在这里降级拼进 prompt**：那正是 0.2.3 修掉的重叠躯干问题（一张图里多份完整外貌）」。

我们之前干的正是这件事：

```
prompt = Q版串 + Elias 的全身外貌 + Cecilia 的全身外貌 + 动作 tag + 景别兜底
```

NAI 拿到两份完整的 `1boy, ...` / `1girl, ...` 挤在同一条 Base 里，只能把两个人揉成
一张路人脸——用户看到的就是「这跟我的人有什么关系」。

**改法**：`TheaterImageInput` 增加 `characters`，运行时把 `getCharacters(floor)`
（柏宝绘角色库，`tag` 由它自己的 `buildEntryTag` 现算）原样递进公开接口，落进
`char_captions`。正向词里**不再出现任何外貌**。

只有后端不支持时（NAI3 / ComfyUI，`supportsCharacters=false`）才回落成拼进正向词——
这是公开接口能力决定的，不是我们的选择。

单格重画同样要带这批人：`BbiStatusInfo.characters` 把当时那几个人存进楼层数据，
否则「重画」会换一张脸。

## 二、名字对不上时，以前会乱套别人的外貌

`makeLookReader` 旧逻辑：

```ts
const hit = byNorm.get(key) ?? base ?? primary ?? onlyOne;   // 任何名字都能落到主角
```

模型写了 `Julian`（角色库里没有），画出来却是 Elias 的样子——**比没有外貌更糟**，
因为用户会以为「这个插件连人都认错」。

现在：精确名 → 括号前主名 → 停。只有**代词**（他/她/the man…）且**角色库里只有一个条目**
时才兜底。其余一律留空，并冒泡到 `missingLooks`：

- 出图日志记一条「提示」：`柏宝绘角色库里没有：Julian …`；
- 左下角状态条 + toast 同步提醒一次：`角色库里没有 Julian：这几个人这次没带上外貌`。

## 三、这一格没写角色时，不再把全场塞进去

截图第 4 格「他移到向阳侧遮她」画成了拱廊里的两个小人。原因：模型这一格没给
`characters`，旧代码回落成「本楼出现过的所有人」，于是把两个人硬塞进了本该是空景的镜头。

现在只认 `nl` / `title` 里真的提到的人；全场只有一个人时才兜底。

## 四、system 是空的，规则全挤在 user 里

日志里的 `{ role:'system', content:'' }` 是真的：`runTheaterOne` 把
`system + '---' + user` 拼成一条，交给 `makeModeLlmCaller(...)('', prompt)`。

现在 `TheaterLlmCaller` 改成 `(system, user)`，与柏宝绘 `buildChannelRequestBody`
的两条 message 一致。日志里读剧情那条也从「一坨」变成 `【system】/【user】` 两段。

## 五、读剧情提示词按柏宝绘的规范改了口径

柏宝绘的《NAI 4.5/V5 Prompt Specification》明确要求：

- Base tag 写**全局**：人数、场景、构图、镜头、光线、氛围；
- 单个角色的**外貌 / 服装 / 动作**放进 Character Prompt，**不要写进 Base**；
- 画面语言（景别、光源、色调）**必须由模型补全**——正文是散文，不会写机位。

我们原来的规则恰好相反（「禁止写镜头景别、光照颜色、服装细节、角色外貌」），
结果每格都是同一张平光半身像。现在 `COMMON_RULES` 改成：

- tags 必须交代 ① 人数与互动 ② 地点/环境 ③ 光线或时间；
- `characters[].act` 只写这个人的动作/表情/接触，外貌服装由角色库负责；
- 禁止写画风、画质、画师名、负面词（这些由方案负责）。

另外，读剧情时把**柏宝绘角色库的名字名单**一起给模型，要求照抄——
名字对不上，`characters` 就取不到人的外貌，这是「人物不像」的另一半来源。

## 六、勾选框「取消后还显示勾着」

两件事叠在一起：

1. `patchSettings()` 每次开关都 `showConfigPanel()` **整块重建面板**。重建会把鼠标正
   按着的那个 `<input>` 换掉，看起来就是「点了没反应 / 还勾着」，得再点一次。
   → 开关期间用 `insideToggle` 标记跳过重建；面板不重建也就不会跳回顶部。
2. 有些主题把 checkbox 的 `:focus` 画成粉/红描边，点完焦点还在，像「勾着」。
   → `change` 后 `blur()`；CSS 改成只在 `:focus-visible`（键盘）时画环。

顺带把同一设置的两个开关按 `data-sti-toggle` 同步，避免两处状态打架。

## 七、公开接口就这四个旋钮，这是硬边界

`STBaiBaiImage.generate(request)` 能传的只有：

| 字段 | 柏宝绘怎么用 |
|---|---|
| `prompt` | Base Prompt（拼在画师串之后、质量词之前） |
| `nl` | NAI4.5/V5 时接在 Base 后面（`fullPositivePrompt`） |
| `characters` | → `v4_prompt.char_captions`，**每个角色一条独立描述** |
| `negative` | 仅 ComfyUI 生效；NAI 的负面取渠道配置 |

画师串、质量词、模型、采样参数全部由**方案**决定，公开接口只能整套照用；
「请求历史」是它模块内的内存数组，没有写入接口（只有 `floor/Card.vue` 那条链路会写）。
所以能做到的「联动」就是：**别自己拼提示词，把 Base / nl / characters 三样按它的协议递进去**。
本轮做的正是这件事。

## 自查清单

1. 出图日志里每条出图应有 `角色（柏宝绘角色库）` 一栏，写着 `Elias：1boy, ...`；
   空的话就是名字没对上或角色库没这个条目（同时会有「提示」条目）。
2. 四格里不该再出现「同一张脸」或「两个无关小人」；每格的人应当与 `characters` 对应。
3. 读剧情日志里应有 `【system】` 与 `【user】` 两段，user 开头是「可用角色（柏宝绘角色库…）」。
4. 取消「正文插画」自动出图后立刻生效，粉框不再残留。

## 校验

- `tsc --noEmit` 0 错
- `vitest` 23 文件 / 359 用例全过（新增 `tests/theaterCharacters.test.ts`）
- 产物已同步到 `G:\SillyTavern\public\scripts\extensions\third-party\ST-Story-Illustrator`
