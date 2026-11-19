# 小剧场/插图：接上柏宝绘「自定义提示词」，服装一致性落到代码层

> 起因：人物终于对了，但同一批四格的衣服每格都不一样。
> 用户在柏宝绘 → 设置 →「自定义提示词 → NAI 规范」里明明写了规则
> （`# NOVELAI V5 — IMAGE PROMPT GENERATION RULES`，16k 字），包含
> §4.4 Appearance and Clothing / §6 CONSISTENCY —— 这些规则对小剧场完全没生效。

## 一、根因：我们从来没把那份规范发出去

柏宝绘读剧情时，system 的顺序是：

```
破限词 → 角色卡 → 人设 → 世界书 → 【后端书写规范 naiV5Spec】 → 任务协议 → 思维链
```

我们自己的（`src/theater/prompts.ts` 等）虽然是从这份规范**抄**的紧凑版，但用户改了
规范本身之后，两者就分叉了：他写的「连续场景沿用同一套衣服、不许因为这一格没提
衣服就换一套」对我们一个字都不生效。柏宝绘不会出这个问题，因为它每一张都过一遍。

## 二、改法 A：凡是写 tag/nl 的调用，都先过一遍这份规范

新增 `src/baibai/specPrompt.ts`：

| 函数 | 作用 |
| --- | --- |
| `parsePromptSet(raw)` | 从 `baibai_image.autoTag.prompts` 取 `jailbreak` / `naiV5Spec`（空则回退 `naiSpec`）/ `naiV5Thinking`，与柏宝绘同口径 |
| `expandNlSections(text, nl)` | 展开 `{{#nl}}…{{/nl}}` / `{{^nl}}…{{/nl}}`（与它 `autoTag/prompt.ts` 同一实现） |
| `buildSpecPreamble(set, {nl})` | 拼成「破限 → 规范 → 思维链 → **输出契约优先**」 |
| `readPromptSet()` / `specPreambleFor(nl)` | 每次现读，改完立刻生效 |

接入点只有一处：`makeModeLlmCaller()`（`src/manga/planGenerator.ts`）。
正文插图 / 漫画分镜 / 小剧场三套都走它，所以三种模式一次性都过上了规范。

**为什么末尾必须加「输出契约优先」**：规范的示例 JSON 是柏宝绘自己的字段
（`position / tag / characters[].tag / size`）。不声明，模型会照着示例输出，
我们每个模式各自的解析器就什么都拿不到。声明里写清了分工——
**格式听任务协议，画面内容听规范。**

**为什么还要剥 `<thinking>`**：`naiV5Thinking` 要求模型先在 `<thinking>` 里过检查点。
那段文字里随手一个花括号，就会把「取第一个 `{` 到最后一个 `}`」式的解析带偏。
新增 `src/prompt/think.ts` 的 `stripThinkingBlocks()`，统一在
`extractJson` / `parseStatusReply` / `parseComicPagePlan` 三个入口先剥。

## 三、改法 B：服装一致性不能只靠提示词

即便规范进了 system，「同一批四格」仍是一次 LLM 输出里模型**每格各自重写**一遍的
（white shirt / grey shirt / school uniform），而 NAI 每格是独立请求，没人替它记住上一格。
所以把服装冻成一份**本批定妆**，由代码逐字拼进每一格：

1. 提示词新增顶层字段 `cast:[{name, outfit}]`，要求「本批只定一次，
   版型+主色+关键配件，逐字复用；角色库有『固定着装』就照抄」；
2. `parseStatusReply` 把 `cast[].outfit` 解析成 `reading.outfits`（中文串丢弃——NAI 只认英文）；
3. `runTheaterOne` 用 `outfitOf(name)` 给每一格的角色块拼
   **固定外貌 → 当前着装 → 动作**（顺序照规范的 §3.3 / §4.4）；
4. 模型没给时回落到角色库的「固定着装」（`makeLookReader` 现在把 `fields.outfit` 带出来）；
5. 单格重画沿用存下来的 `characters[]`（其中已含那串服装），所以重画不会换衣服；
6. 安全模式连 `outfit` 一起洗（`scrubMangaReading`），否则一串 `underwear` 就能绕过安全过滤。

> 用户当前的角色库 11 条全是空字段（`fields: {}`），所以「固定着装」没得抄——
> 这种情况下 `cast` 就是唯一的一致性来源；要在**跨楼层**也保持一致，还是得去柏宝绘
> 把角色的固定着装填上（`missingLooks` 提示里已经这么说过）。

## 四、顺带：配图设置页能看见「接没接上」

新增「读剧情用的提示词」只读块，直接报字数：

```
NAI 规范 → 已接入 · 16025 字
思维链   → 已接入 · 4129 字
破限词   → 未填写
```

留空会写「未填写 · 用插件内置精简规则」——省得用户改完规范还在猜生效没有。

## 五、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/baibai/specPrompt.ts` | 新增：读取/展开/拼装柏宝绘自定义提示词 |
| `src/prompt/think.ts` | 新增：剥 `<thinking>` 块 |
| `src/manga/planGenerator.ts` | `makeModeLlmCaller` 前置规范（三种模式共用的唯一入口） |
| `src/manga/planPrompts.ts`、`src/manga/panelPlan.ts` | 解析前剥思考块 |
| `src/theater/prompts.ts` | 新增 `cast` 字段与服装一致性规则 |
| `src/theater/parseReply.ts` | 解析 `cast[].outfit`；剥思考块 |
| `src/theater/runtime.ts` | 服装逐字拼进每一格（原生角色通道 / 正向词两条路都拼） |
| `src/theater/safeFilter.ts` | 安全模式连服装一起洗 |
| `src/tasks/theaterRun.ts` | 外貌读取器带出「固定着装」 |
| `src/types.ts` | `StatusReading.outfits` / `StatusOutfit` |
| `src/ui/configPanel.ts` | 「读剧情用的提示词」块 |

## 六、验证

- `tsc --noEmit` 0 错误
- `vitest` **27 文件 / 407 用例**全过（新增 `tests/specPrompt.test.ts` 11 例、
  `tests/theaterOutfit.test.ts` 11 例）
- `npm run build` 成功，`index.js` / `style.css` 已同步酒馆扩展目录

## 七、若仍未一致，按这个顺序看

1. 配图设置页「读剧情用的提示词」是不是「已接入」——不是就说明柏宝绘那边填在了
   别的字段（我们只认 NAI 规范 / NAI 思维链 / 破限词）；
2. 出图日志里该格「角色外貌」那一栏，看 `characters[].tag` 里有没有同一串衣服
   —— 四格应当**一模一样**；
3. 有衣服但画出来还是不同 → 那是 NAI 把服装画歪，不是取值问题：把画师串换成不带
   分格词/裸露倾向的，或把服装写得再具体一点（材质+颜色+版型）；
4. 跨楼层不一致 → 去柏宝绘把角色「固定着装」填上，插件会逐字照抄。
