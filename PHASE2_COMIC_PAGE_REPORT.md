# 漫画页级出图 + 副 API 严格失败 + 出图日志（第二阶段补丁 2）

修的是四个实测问题，其中两个是架构级错误。

## 一、漫画分镜：之前根本不是漫画

**根因**：文档里「漫画分镜」= 一张画布上排出多格版面——构图词（`1.4::multiple views::`、`1.5::split screen::`
或四档无框写法）+ nl 里逐格描述，**一次出图得到一整页漫画**。
本插件之前是「每个 panel 各出一张图」，所以每张都是一幅单幅插画，格与格之间毫无版面关系。

**改法**：

1. `ComicPagePlan` 增加页级 `tags` / `nl` / `dialogue`（格只保留「这一格画了什么」的内容索引）。
2. `planPrompts` 的 comic system 提示词改成页级输出契约：一页一张图、tag 只写一次、景别只一个、
   nl 必须分区（`In the upper panel, ...` / `The lower panel shows ...`）、禁止画面里出现文字/气泡。
3. 新增 `src/manga/pageCompose.ts`（纯函数）：
   - `mergePanelTags`：把各格 tag 按裸词合并（兼容旧计划）
   - `buildPageNl`：模型没写页级 nl 时，按档位总述句 + 各格 nl 拼出分区描述
   - `collectPageDialogue`：页级台词优先，否则合并各格（上限 4）
   - `composePagePrompt`：整页 → 一次出图请求（含角色库外貌兜底）
4. `workflow.runComic` 改为**每页一次出图**：`composePagePrompt` → `enforceForGeneration`（档位纠正）
   → 写 tag → 点卡片 → 等落库 → 叠气泡。
5. `hasStoryContent` 优先检查页级 tag，只有构图词时仍然重问一次。

## 二、副 API 报错不再偷偷换主 API

- `secondaryLlm.generateViaChannelStrict`：失败抛错，带渠道名 + HTTP 状态 + 上游原文前 300 字。
- `makeModeLlmCaller` / `defaultLlmCaller` / `makeLlmCaller('secondary')` 全部改为严格版。
- 删掉 `workflow` 与 `theaterRun` 里两处 `catch → generateQuietPrompt` 兜底。
- 只有「没指派渠道」时才会走主 API（那是配置，不是失败兜底）。

## 三、插图 + 漫画多选不能共存

**根因**：第二张图插到了第一张 tag **前面**，柏宝绘的卡片按「槽位序号」找结果，序号一挪，
先出的那张就被判成「提示词变了 / 需要重新生成」。

**改法**（`bbiTag.insertImageTag`）：锚点后面已经有生图 tag 时，一律**追加到正文末尾**，
已有槽位序号永不移动。新增纯函数 `hasImageTagAfter` + 3 条单测锁定。

## 四、出图日志

**为什么进不了柏宝绘的「请求历史」**：那一页是它 Vue 模块内的内存 store，
文件头明写「刻意不持久化，不进 settings、不落 localStorage」，也没有任何对外写入接口；
只有它自己的卡片 / 自动 tag 链路会写。小剧场三套走公开出图接口，天生不在那条链上。
另外它是内存态，**刷新页面就清空**——这也是"刚生成完去翻却没有"的常见原因。

**改法**：新增 `src/log/imageLog.ts` + 「配图设置 → 出图日志」：

- 每条记录：时间 / 类型（出图 or 读剧情）/ 模式 / 楼层 / 成功失败 / 耗时 / 种子
- 展开可看完整正向词、nl、负面词、来源（卡片 or 公开接口）
- **失败时把错误原文打在红框里**（副 API 的报错就在这里）
- 内存级、上限 80 条、有清空按钮

## 五、验证

```
npx tsc --noEmit     # 0 error
npx vitest run       # 19 files / 305 tests 全过（新增 pageCompose 10 条 + tag 顺序 3 条）
npm run build        # dist + 根目录
```

已同步到 `G:\SillyTavern\public\scripts\extensions\third-party\ST-Story-Illustrator`。

## 六、还差什么

- 其它三个档（irregular / inset / unframed）的页级提示词已就绪，但「同一个模型连续两页要换页型」
  还没做加权，多页时会连着用同一种版面。
- 气泡仍遵循「出图后合成一次」：改字/重画不会自动重合成（柏宝绘没有显示期钩子）。
