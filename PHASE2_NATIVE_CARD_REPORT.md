# PHASE2_NATIVE_CARD_REPORT

## 本轮要解决的三个问题（用户实测反馈）

1. 图片能进图库，正文里一开始有、**刷新就没了**；不要图片下方的说明文字；**显示要与柏宝绘一模一样**（重绘 / 改词）。
2. **出图调用日志不进柏宝绘「请求历史」**，出错无从排查。
3. 漫画分镜**出图与选段毫无关联**，也**没有对白**。

## 根因

| 现象 | 根因 |
| --- | --- |
| 刷新后图片消失 | 插画走的是「自己出图 → 往 `mes` 里写 `![](url)`」，漫画走的是「自己出图 → 只把 artifact 写进 `extra` 后**没有 saveChat**」。两条路都不在柏宝绘的持久化链路里。 |
| 显示不像柏宝绘 | 显示层是本插件自己的 DOM 卡片（下方带 nl 说明文字），天然没有重绘/改词/删除/灯箱。 |
| 日志不进柏宝绘 | 本插件直连 `STBaiBaiImage.generate()`（公开接口）。**该接口刻意不写 `state/history`** —— 只有楼层卡片（`Card.vue`）那条链路才记请求历史。 |
| 分镜与剧情无关 | ① 漫画模式的 `nl` 默认关（`includeNl:false`）、`dialogue` 默认关，模型只拿得到「排几格」的规则，没有分区描述通道；② 系统提示词没写「tags 必须画出正在发生的事」，模型极易只吐构图词（`multiple views, split screen`）——而构图词本来就会把画面变成空页面；③ 角色库外观从未注入分格 prompt。 |
| 没有对白 | `bubbleComposite` 一直没被任何地方调用；台词字段即使生成了也只躺在 artifact 里。 |

## 做法

### 1. 出图与显示统一交给柏宝绘原生卡片（`src/baibai/bbiTag.ts`）

- 不再自己出图、不再写 markdown。改为往 `message.mes` 里插一条柏宝绘的
  `<bbi_image>…<nl>…</nl><size>…</size></bbi_image>`，然后**点卡片上的「生成图片」**。
- 结果：显示、重绘、改词、下载、删除、灯箱、图库归档、并发闸门、429 退避、
  **请求历史**——全部是柏宝绘原生那一套，一字不差；tag 落在 `mes` 里，刷新/换设备都在。
- `promptHash` 按柏宝绘 `floor/storage.ts` 的 cyrb53 派生**逐字节复刻**（单测锁定真实值），
  否则卡片按 hash 找不到自己的结果（图出来了却显示未生成）。
- 插入走 CAS（chatId / send_date / swipe 三重复核），排队期间消息变了就放弃，不覆盖别人的编辑。
- `updateMessageBlock` 只换 `.mes_text` 的 html、**不发事件**，所以插入后主动 `emit(MESSAGE_UPDATED)`，
  柏宝绘的卡片水合挂在这个事件上。
- 同一个 class 下有两种按钮：正常的「生成图片 / 重试」与「按当前方案重新生成本楼」（后者会跑它自己的
  自动 tag、重写整楼正文）。按文案区分，**绝不替用户点后者**。

### 2. 漫画相关度（`src/manga/panelPrompts.ts` + `src/manga/panelRelevance.ts`）

- 漫画模式**强制** `nl: true`、`dialogue: true`（对白是漫画页一半的信息量，之前默认关着）。
- `COMIC_SYSTEM_HEAD` 增加正/反例与硬要求：每格 tags 必须含①角色外观②正在做什么③在哪④关键物件；
  明写「只写构图词的 tags 一律不合格」。
- `mergeCharacterTags`：按格里的角色名把角色库外貌 tag 并进 prompt（已有裸词跳过，比较口径同 enforcePanelPrompt）。
- `hasStoryContent`：整页只有构图词时**重问一次**（把「必须写人和动作」塞进 user prompt），
  仍旧不合格就报错——宁可失败也不出一张与剧情无关的图。

### 3. 对白气泡（`src/manga/bubbleBake.ts`）

柏宝绘卡片只认一条图片路径，没有「显示时加工」的钩子，所以台词只能合成一次：
出图落库后 → `compositeDialogue`（文档 §6.4~6.11 那套 canvas 算法）→ 上传到
`user/images/ST创作_带字/` → 把 `extra.bbiImage` 里那条 entry 的 `path` 改指向带字版 → 重绘。
**原图仍留在图库**（侧写 json 也在），不是覆盖式烧死。

### 4. 其它

- `appendArtifact` 之后补 `saveChatSafe()`：artifact 是调试与对账用的账本，不能只活在内存里。
- 任务超时 5min → 12min（现在每个分格要等真实出图完成才继续）。

## 已知边界

- **重绘后气泡不会自动再叠**：卡片重绘写入的是新的 entry（无字原图），本插件此时不在等待状态。
  再叠一次需要给柏宝绘加钩子，或接受「重绘 = 无字版」。
- 「点按钮」依赖柏宝绘卡片的 DOM（`.bbi-figure__generate`）。文案或结构变了会退化为
  「已写入 tag，请手动点生成」，不会静默失败。
- **本插件的 LLM 调用（写 tag / 排分镜）仍不进柏宝绘请求历史**——那是它内部 store，
  没有公开写入接口。出图那部分已经在了。
- 若当前出图方案是 ComfyUI 漫画方案，插画 tag 会被柏宝绘判为不匹配（卡片给「按当前方案重新生成本楼」），
  本插件识别后直接报错，不会误点。

## 验证

- `tsc --noEmit` 0 错误；`vitest` 18 文件 **292 用例**全过（新增 `bbiTag.test.ts` 10 例、
  `panelRelevance.test.ts` 10 例）；`vite build` 成功，已同步到
  `G:\SillyTavern\public\scripts\extensions\third-party\ST-Story-Illustrator`。
