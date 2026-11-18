# ST-Story-Illustrator — 环境检查与可行性分析

> 版本：0.1.0  
> 日期：2026-11-18  
> 状态：规划完成，第一阶段实施中

---

## 1. SillyTavern 扩展开发环境

### 1.1 确认的 ST 扩展机制

通过阅读 SillyTavern `extensions.js`、`events.js`、`st-context.js` 源码，确认以下内容：

**manifest.json 结构：**

```json
{
  "display_name": "ST Story Illustrator",
  "loading_order": 100,
  "requires": [],
  "optional": [],
  "js": "index.js",
  "css": "style.css",
  "author": "ST-Story-Illustrator",
  "version": "0.1.0",
  "homePage": "",
  "auto_update": true
}
```

- 第三方扩展安装在 `public/scripts/extensions/third-party/ST-Story-Illustrator/`
- JS 以 `<script type="module">` 加载，支持 ES module import
- CSS 以 `<link>` 注入
- `loading_order` 控制加载顺序（越大越晚加载）

**getContext() 返回的关键属性（已确认可用）：**

| 属性                      | 类型             | 用途                                                                                   |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `chat`                  | `Array`        | 当前聊天消息数组，每条含 `mes`, `name`, `is_user`, `is_system`, `send_date`, `swipe_id`, `extra` |
| `chatId`                | `string`       | 当前聊天 ID                                                                              |
| `characters`            | `Array`        | 角色数组                                                                                 |
| `characterId`           | `number`       | 当前角色索引                                                                               |
| `name1` / `name2`       | `string`       | 用户名 / 角色名                                                                            |
| `eventSource`           | `EventEmitter` | 事件发射器                                                                                |
| `eventTypes`            | `Object`       | 事件类型常量（完整列表已确认）                                                                      |
| `extensionSettings`     | `Object`       | 即 `extension_settings`，扩展持久化设置                                                       |
| `saveSettingsDebounced` | `Function`     | 保存设置（防抖）                                                                             |
| `getCurrentChatId`      | `Function`     | 获取当前聊天 ID                                                                            |
| `generateQuietPrompt`   | `Function`     | 静默 LLM 请求（不显示在 UI）                                                                   |
| `chatMetadata`          | `Object`       | 聊天元数据                                                                                |
| `saveMetadataDebounced` | `Function`     | 保存元数据                                                                                |
| `messageFormatting`     | `Function`     | 消息格式化                                                                                |
| `updateMessageBlock`    | `Function`     | 更新消息 DOM                                                                             |
| `appendMediaToMessage`  | `Function`     | 向消息追加媒体                                                                              |

**关键事件类型（已从 events.js 确认）：**

| 事件                           | 用途                |
| ---------------------------- | ----------------- |
| `MESSAGE_RECEIVED`           | AI 消息落地（小剧场自动触发用） |
| `MESSAGE_SENT`               | 用户消息发送            |
| `GENERATION_ENDED`           | 生成结束（兜底触发）        |
| `CHARACTER_MESSAGE_RENDERED` | 角色消息渲染完成（挂载卡片用）   |
| `USER_MESSAGE_RENDERED`      | 用户消息渲染完成          |
| `MESSAGE_SWIPED`             | swipe 切换（重挂卡片）    |
| `MESSAGE_UPDATED`            | 消息编辑（重挂卡片）        |
| `MESSAGE_DELETED`            | 消息删除（清理卡片）        |
| `MESSAGE_EDITED`             | 消息编辑              |
| `CHAT_CHANGED`               | 聊天切换（清理队列+重挂）     |
| `CHAT_DELETED`               | 聊天删除              |
| `APP_READY`                  | 应用就绪              |
| `EXTENSION_SETTINGS_LOADED`  | 扩展设置加载完成          |

### 1.2 DOM 结构确认

- 消息容器：`.mes[mesid="N"]` 包含 `.mes_block`
- 消息正文：`.mes .mes_text`（会被 ST 用 `.html()` 重写，**不能**在此挂子元素）
- 楼层按钮区：`.mes .extraMesButtons`（可注入操作按钮）
- 消息属性：`mesid` 属性对应 `chat` 数组下标

### 1.3 持久化方式确认

- `extension_settings.STStoryIllustrator` — 扩展全局设置
- `chat_metadata.STStoryIllustrator` — 当前聊天的任务记录
- `message.extra` — 单条消息的附加数据（小剧场图桶）
- `saveSettingsDebounced()` / `saveMetadataDebounced()` — 保存触发

---

## 2. 柏宝绘公开 API 状态

### 2.1 已确认的公开接口

通过 SPEC.md 和 BAIBAI_API_PROPOSAL.md，以及公开搜索：

| 接口                                | 状态   | 说明                             |
| --------------------------------- | ---- | ------------------------------ |
| `globalThis.STBaiBaiImage`        | 已知存在 | 柏宝绘注入到全局的公开 API 对象             |
| `api.apiVersion`                  | 已知存在 | API 版本号                        |
| `api.getCharacters({ floor })`    | 已知存在 | 按楼层读取角色快照                      |
| `api.getBackendStatus()`          | 已知存在 | 查询后端配置状态                       |
| `api.generate(payload, options?)` | 已知存在 | 调用柏宝绘出图                        |
| `api.subscribe(callback)`         | 可能存在 | API 就绪回调（文档标注"如当前公开 API 版本支持"） |

### 2.2 尚未公开的接口

| 接口                              | 状态      | 影响                      |
| ------------------------------- | ------- | ----------------------- |
| `api.generatePrompt(request)`   | **未公开** | LLM Tag 生成接口，仅存在于提案文档   |
| `api.translatePromptSegments()` | **未公开** | 单独翻译接口，提案中的可选增量能力       |
| `api.regeneratePromptSegment()` | **未公开** | 单独重 Roll 画面段，提案中的可选增量能力 |

### 2.3 处理策略

- **LLM Tag 生成**：使用 mock adapter 实现 UI 开发，明确标记为 mock。当柏宝绘正式开放 `generatePrompt()` 后切换为真实调用。
- **小剧场/漫画分镜的 LLM 读剧情**：这部分在原柏宝绘中通过自身 LLM 配置完成。伴生扩展无法直接调用柏宝绘内部 LLM 请求，有两个替代路径：
  - **路径 A（首选）**：使用 ST 的 `generateQuietPrompt()` 发送独立的 LLM 请求来读剧情/生成 tag。这不依赖柏宝绘的 LLM 配置，而是用 ST 当前配置的 API。
  - **路径 B（备选）**：等待柏宝绘开放 `generatePrompt()` 接口后切换。
- **出图**：直接使用 `api.generate()` 公开接口，不绕过其队列和限流。

---

## 3. 功能分类

### 3.1 可以直接实现的功能（依赖已确认的公开 API 或 ST 自身能力）

| 功能                   | 依赖                                     | 说明         |
| -------------------- | -------------------------------------- | ---------- |
| 正文选段检测               | ST DOM + `Selection` API               | 纯前端，无外部依赖  |
| 楼层定位                 | ST DOM `.mes[mesid]`                   | 纯前端        |
| 选段锚点保存               | 纯数据结构                                  | 无外部依赖      |
| 上下文构建                | `getContext().chat`                    | 已确认可用      |
| 角色快照读取               | `api.getCharacters({ floor })`         | 柏宝绘已公开     |
| 后端状态检查               | `api.getBackendStatus()`               | 柏宝绘已公开     |
| 图片生成                 | `api.generate(payload)`                | 柏宝绘已公开     |
| Tag 着色分段显示           | 纯前端                                    | 无外部依赖      |
| 双语显示切换               | 纯前端                                    | 无外部依赖      |
| 完整英文 Tag 组装          | 纯函数                                    | 无外部依赖      |
| 楼层图片卡片展示             | ST DOM + `message.extra`               | 已确认可用      |
| 任务持久化                | `chat_metadata` / `extension_settings` | 已确认可用      |
| 选区工具条                | 纯前端                                    | 无外部依赖      |
| 错误处理（柏宝绘缺失/不兼容）      | `globalThis.STBaiBaiImage` 检测          | 纯检测        |
| **漫画分镜规则构建**         | 纯字符串常量                                 | 提示词文档已完整给出 |
| **分镜发送侧纠正**          | 纯函数                                    | 文档已给出完整代码  |
| **对白气泡 canvas 合成**   | 纯前端 canvas API                         | 文档已给出完整代码  |
| **台词存储**             | `message.extra` / 独立映射表                | 纯数据        |
| **小剧场读剧情 LLM**       | ST `generateQuietPrompt()`             | ST 自身能力    |
| **小剧场 tag 清洗/解析**    | 纯函数                                    | 文档已给出完整代码  |
| **小剧场固定种子**          | 纯函数 (FNV-1a hash)                      | 文档已给出完整代码  |
| **小剧场 DOM 挂载 + CSS** | 纯前端                                    | 文档已给出完整代码  |
| **小剧场串行队列**          | 纯前端                                    | 文档已给出完整代码  |
| **黑白漫安全防护**          | 纯函数                                    | 文档已给出完整代码  |
| **小剧场楼层按钮注入**        | ST DOM `.extraMesButtons`              | 已确认可用      |

### 3.2 需要新增公开接口才能完整实现的功能

| 功能                       | 缺失接口                            | 当前处理                                            |
| ------------------------ | ------------------------------- | ----------------------------------------------- |
| LLM 自动生成结构化英文 Tag + 中文翻译 | `api.generatePrompt()`          | 使用 mock adapter + ST `generateQuietPrompt()` 替代 |
| 单独重 Roll 画面段             | `api.regeneratePromptSegment()` | MVP 用全量重新生成替代                                   |
| 单独翻译刷新                   | `api.translatePromptSegments()` | MVP 不提供，或用 ST `generateQuietPrompt()` 翻译        |

### 3.3 目前无法确认的部分

| 问题                                       | 说明                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `api.generate()` 的精确 payload schema      | SPEC 要求"按真实 PUBLIC_API.md 组装"，但公开文档未在搜索中找到。需在实际环境中用 `console.log(api)` 探测。 |
| `api.getCharacters()` 返回的角色快照字段结构        | 需确认 `tag`, `nl` 等字段名。MVP 先做防御性读取。                                          |
| `api.subscribe()` 是否存在                   | 文档标注不确定。MVP 用轮询检测 `globalThis.STBaiBaiImage` + 超时。                         |
| `api.generate()` 是否支持 `save: false` 预览模式 | SPEC 要求先确认。MVP 暂不提供预览模式。                                                   |
| 柏宝绘角色块（character prompts）支持情况            | 影响角色外貌注入方式。需探测 `getBackendStatus()` 返回值。                                   |
| 图片路径的浏览器可访问性                             | `api.generate()` 返回的 path 是否可直接作为 `<img src>`。需实际验证。                       |

---

## 4. 两个额外功能的可行性评估

### 4.1 漫画分镜 + 对白气泡

**结论：可以完全在伴生扩展中实现。**

依赖分析：

- 构图规则文本 → 纯字符串常量，文档已完整给出
- 规则注入 → 伴生扩展自己组装 system prompt（使用 ST `generateQuietPrompt`），不需要修改柏宝绘的提示词
- 发送侧纠正（`enforcePanelPrompt` / `applyPanelToNl`）→ 纯函数，在调用 `api.generate()` 前对 prompt 做确定性修正
- canvas 合成气泡 → 纯前端，不依赖任何外部 API
- 台词存储 → 存在伴生扩展自己的数据结构中（`message.extra` 或独立映射表）
- 显示层叠字 → 在伴生扩展自己的楼层卡片中合成显示

**关键架构决策**：伴生扩展不修改柏宝绘的正文 tag 或提示词拼装，而是：

1. 自己用 ST `generateQuietPrompt()` 发独立 LLM 请求获取分镜规则 + 台词
2. 自己组装完整的出图 prompt（含构图词、角色外貌、画面 tag）
3. 调用 `api.generate()` 出无字原图
4. 用 canvas 在显示层叠加对白气泡

### 4.2 QQ人小剧场 / 彩蛋 / 黑白漫状态栏

**结论：可以完全在伴生扩展中实现。**

依赖分析：

- 读剧情 LLM 请求 → ST `generateQuietPrompt()`（不依赖柏宝绘 LLM 配置）
- 角色外貌 → `api.getCharacters({ floor })`（已公开）
- 出图 → `api.generate()`（已公开）
- 图片存储 → `message.extra` 的自定义桶（`status` / `bonus` / `manga`）
- DOM 挂载 → `.mes_block` 末尾插入（不进 `.mes_text`）
- CSS → 纯样式注入
- 串行队列 / 看门狗 / 固定种子 / 安全防护 → 纯函数，文档已完整给出

**关键差异**：原文档中 `generateImage()` 是柏宝绘内部的出图函数。伴生扩展替换为 `api.generate()` 调用。原文档中 `getContext()` / `settings` / `extensionSettings` 全部映射到 ST 的等价物。

### 4.3 两套功能之间的关系

| 维度     | SPEC 主流程（手动配图）          | 小剧场三套（自动配图）                | 漫画分镜+气泡                    |
| ------ | ----------------------- | -------------------------- | -------------------------- |
| 触发方式   | 用户手动选段                  | `MESSAGE_RECEIVED` 自动      | 附着在配图流程上                   |
| LLM 请求 | `generatePrompt()`（待开放） | ST `generateQuietPrompt()` | ST `generateQuietPrompt()` |
| 出图     | `api.generate()`        | `api.generate()`           | `api.generate()`           |
| 图片存储   | 伴生扩展任务记录                | `message.extra` 三桶         | 伴生扩展任务记录                   |
| 图片展示   | 楼层卡片                    | `.mes_block` 末尾 bar        | 楼层卡片 + canvas 叠字           |
| 分镜规则   | 不涉及                     | 不涉及                        | 纯 prompt 规则 + 纠正           |

三套功能可以共享以下基础设施：

- 柏宝绘 bridge（API 检测、版本检查、等待就绪）
- 角色快照读取
- 上下文构建
- 楼层 DOM 操作
- 错误处理

---

## 5. 技术选型

| 维度     | 选择                               | 理由                                                |
| ------ | -------------------------------- | ------------------------------------------------- |
| 语言     | TypeScript                       | SPEC 要求，类型安全                                      |
| 构建工具   | Vite                             | 快速、输出单文件 IIFE 适配 ST 的 `<script type="module">` 加载 |
| 输出格式   | 单 `index.js` + 单 `style.css`     | ST 扩展标准格式                                         |
| DOM 操作 | 原生 DOM API + 少量 jQuery           | ST 环境已有 jQuery，但不过度依赖                             |
| 状态管理   | 模块内单例 + `extension_settings` 持久化 | 不引入 Vue/React 等框架                                 |
| 测试     | Vitest                           | 纯函数测试（compose、anchor、panel enforce 等）             |
| CSS    | 纯 CSS 文件（不预编译）                   | ST 扩展标准格式                                         |

---

## 6. 项目目录结构

```text
ST-Story-Illustrator/
├── manifest.json                 # ST 扩展清单
├── package.json                  # npm 配置
├── tsconfig.json                 # TypeScript 配置
├── vite.config.ts                # Vite 构建配置
├── README.md                     # 用户文档
├── ANALYSIS.md                   # 本文件
├── src/
│   ├── index.ts                  # 扩展入口（onActivate hook）
│   ├── types.ts                  # 全局类型定义
│   ├── host/
│   │   ├── sillytavern.ts        # ST 环境封装（getContext、eventSource、settings）
│   │   └── messageObserver.ts    # 消息渲染/DOM 观察器
│   ├── baibai/
│   │   ├── bridge.ts             # 柏宝绘 API 检测、版本检查、等待就绪
│   │   ├── characters.ts         # 角色快照读取封装
│   │   ├── promptGeneration.ts   # LLM Tag 生成（mock adapter + 真实接口切换）
│   │   └── imageGeneration.ts    # 图片生成封装（payload 组装、状态检查）
│   ├── selection/
│   │   ├── selector.ts           # 选区检测（只在 .mes_text 内响应）
│   │   ├── floorResolver.ts      # 楼层定位（mesid 提取）
│   │   └── anchor.ts             # 选段锚点保存与匹配
│   ├── context/
│   │   └── contextBuilder.ts     # 上下文构建（选段+楼层全文+前后文+角色）
│   ├── prompt/
│   │   ├── segments.ts           # Tag 分段数据模型
│   │   ├── compose.ts            # 英文 prompt 组装纯函数
│   │   └── validation.ts         # LLM 返回 schema 校验
│   ├── tasks/
│   │   ├── taskManager.ts        # 任务生命周期管理
│   │   └── countPolicy.ts        # 数量策略（后续阶段）
│   ├── storage/
│   │   ├── repository.ts         # 任务持久化（chat_metadata / extension_settings）
│   │   └── migrations.ts         # schema 版本迁移
│   ├── ui/
│   │   ├── selectionToolbar.ts   # 选区工具条
│   │   ├── promptEditor.ts       # Tag 编辑器（着色、双语、重 Roll）
│   │   ├── floorCards.ts         # 楼层图片卡片
│   │   └── lightbox.ts           # 图片放大查看
│   ├── manga/                    # 漫画分镜 + 对白气泡
│   │   ├── panelRule.ts          # 四档分镜规则构建
│   │   ├── panelEnforce.ts       # 发送侧确定性纠正
│   │   ├── dialogueStore.ts      # 台词存储（正文子标签 + 手动表）
│   │   ├── bubblePlan.ts         # 气泡排版纯函数（锚点、防重叠、换行）
│   │   ├── bubbleDraw.ts         # canvas 合成绘制
│   │   ├── bubbleComposite.ts    # 合成入口（CORS 安全加载 + 失败降级）
│   │   └── bubbleTypes.ts        # 气泡类型定义
│   ├── theater/                  # QQ人小剧场 / 彩蛋 / 黑白漫
│   │   ├── kinds.ts              # KIND 差异参数表
│   │   ├── prompts.ts            # 三套 system prompt 构建器
│   │   ├── parseReply.ts         # 模型 JSON 解析与清洗
│   │   ├── seed.ts               # 固定种子（FNV-1a hash）
│   │   ├── safeFilter.ts         # 黑白漫三层安全防护
│   │   ├── runtime.ts            # runOne 主链路（读剧情→出图→落盘）
│   │   ├── queue.ts              # 串行队列 + 看门狗
│   │   ├── store.ts              # 三桶存储读写
│   │   ├── mount.ts              # DOM 挂载 + 卡片构建
│   │   ├── buttons.ts            # 楼层按钮注入
│   │   └── events.ts             # 事件注册
│   └── styles/
│       └── style.css             # 全部样式
├── tests/
│   ├── compose.test.ts           # prompt 组装测试
│   ├── anchor.test.ts            # 锚点匹配测试
│   ├── panelEnforce.test.ts      # 分镜纠正测试
│   ├── bubblePlan.test.ts        # 气泡排版测试
│   └── seed.test.ts              # 种子哈希测试
└── SPEC.md                       # 技术规格（从用户提供文档复制）
```


## 8. 核心原则确认

- [x] 不 Fork、不修改柏宝绘
- [x] 不复制柏宝绘内部代码
- [x] 不调用柏宝绘未公开的私有函数
- [x] 不自行创建第二套副 API 配置（使用 ST 自身 API 做 LLM 请求）
- [x] 不猜测不存在的接口
- [x] 尚未开放的 LLM Tag 生成接口使用 mock adapter，明确标记
- [x] 每完成一个阶段，报告修改内容、测试结果和剩余问题
