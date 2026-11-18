# 按创作模式分别指定 API 渠道（复用柏宝绘方案）

## 需求

不同创作模式使用不同 LLM 渠道：例如「正文插画」用 NAI5，「QQ 人状态栏 / 黑白漫」用便宜的 NAI4.5。
渠道本身不重复配置，直接复用柏宝绘已经配好的渠道列表。

## 关键发现

1. 柏宝绘的渠道列表本来就设计为**跨插件共享**，真身在
   `extensionSettings['baibai_api_channels'] = { schemaVersion, revision, channels[] }`，
   并广播事件 `st-baibai-api-channels:changed`。源码注释明确写着"在各「柏宝」插件间同步"。
   → 本扩展只读这份配置，不另建配置界面，柏宝绘里加/删渠道会立刻反映到本扩展。
2. 柏宝绘调用副 API **不是直连渠道 URL**，而是 POST 酒馆后端
   `/api/backends/chat-completions/generate`，用 `reverse_proxy` + `proxy_password`
   （有 reasoningEffort 时改走 `custom` 源 + `custom_url`），请求头用 `ctx.getRequestHeaders()`。
   → 旧版直连写法对部分 NAI 中转渠道会失败，本次已改成与柏宝绘完全同款。
3. 柏宝绘自己的 `assignments.tagGen` 指派我们**不碰**，只作为「跟随柏宝绘 tagGen」这个选项读取。

## 实现

| 文件 | 改动 |
|---|---|
| `src/baibai/secondaryLlm.ts` | 重写。导出 `normalizeChannel` / `parseSharedChannels` / `resolveChannelId` / `buildChannelRequestBody` / `extractCompletionText` 纯函数；`generateViaChannelId(channelId, ...)` 支持指定渠道；调用改走酒馆 chat-completions 端点，兼容 reasoningEffort / excludeParams / 多模态 content parts；保留 `generateViaSecondary` 等旧导出兼容 |
| `src/types.ts` | 新增 `modeChannels: Partial<Record<CreationMode, string>>`，默认 `{}`（回退全局 `llmSource`） |
| `src/manga/planGenerator.ts` | 新增 `makeModeLlmCaller(settings, mode)`：按模式取渠道，失败回退主 API |
| `src/tasks/workflow.ts` | 插画 / 漫画 / 小剧场三处 LLM 调用全部改为 `makeModeLlmCaller(deps.fullSettings, mode)` |
| `src/ui/selectionPanel.ts` | 弹窗新增「LLM API 渠道」区：5 个模式各一个下拉；选项 = 跟随柏宝绘 tagGen / 酒馆主 API / 共享渠道列表；切换即保存并派发 `sti-settings-changed` |
| `src/index.ts` | 监听 `sti-settings-changed`，重建队列，改完立即生效（无需重启） |
| `src/styles/style.css` | 新增渠道选择区样式 |

## 怎么用

1. **在柏宝绘里配渠道**：柏宝绘设置 → 副 API 渠道，添加 NAI5 / NAI4.5 等（这一步在柏宝绘做，两插件共用）。
2. 回到本扩展，划线 →「生成配图」→ 弹窗底部「LLM API 渠道」区。
3. 给每个模式选一条渠道，例如：
   - 正文插画 → `NAI5 · ...`
   - 正文漫画分镜 → `NAI4.5 · ...`
   - QQ 人状态栏 / 彩蛋 / 黑白漫 → `NAI4.5 · ...`
4. 选择后立即保存，不用重启；下次打开弹窗会记住选择。

**回退行为**：
- 选「跟随柏宝绘 tagGen」但柏宝绘没指派渠道 → 自动用主 API。
- 选了某条渠道但该渠道请求失败/模型没填 → 自动回退主 API，任务不会中断。
- 渠道在柏宝绘里被删掉 → 下拉里显示「已失效渠道」，重新选一条即可。

## 验证

- 252 个测试全通过（新增 16 个渠道解析/请求体/分派测试）
- TypeScript `tsc --noEmit` 0 错误
- `npm run build` 成功，`index.js` 148KB / `style.css` 20KB，落到扩展根目录
- 已同步到 `G:\SillyTavern\public\scripts\extensions\third-party\ST-Story-Illustrator`
- 产物校验：渠道选择 UI、共享渠道键、chat-completions 端点、reverse_proxy、模式分派均已打入

## 注意

- 渠道选择只影响**剧情理解 / Tag 生成这一步的 LLM 调用**。真正出图仍由各模式的 Profile / 柏宝绘后端决定（那是另一个配置层）。
- 重启酒馆后弹窗才会加载新代码（manifest 未变，但 JS/CSS 换了新的）。
