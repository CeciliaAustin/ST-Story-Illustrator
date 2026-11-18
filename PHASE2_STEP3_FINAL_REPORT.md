# Phase 2 Step 3 + 全流程接线 — 最终完成报告

> 日期：2026-11-18
> 范围：接着上次「任务 #16 分镜计划纯函数」继续，把整个扩展从骨架推到**可构建的完整实现**。

---

## 1. 本次做了什么

在上次纯函数地基之上，把剩下的全部模块搓出来并接通全流程。现在这是一个**能 `npm run build` 出可直接安装扩展**的完整项目。

### 1.1 LLM 接线（Step 3 核心）
- `src/manga/planPrompts.ts` — 插画/漫画两套 system+user prompt 构建；容错 JSON 提取（`extractJson` 支持代码围栏、夹带解释、字符串内括号）；角色快照→Tag 段；响应解析
- `src/manga/planGenerator.ts` — 异步生成器，**LLM 调用器注入**（`LlmCaller`），默认走 ST `generateQuietPrompt`；可塞 mock 测试
- `src/tasks/taskQueue.ts` — 串行任务队列：入队去重、取消、进度回调、看门狗超时、失败隔离

### 1.2 Canvas 气泡合成
- `src/manga/bubbleTypes.ts` / `bubblePlan.ts` — 样式归一化、九宫格锚点、逐字符贪心换行、融入式横竖排、防重叠、WCAG 字色推导（**全纯函数**）
- `src/manga/bubbleDraw.ts` / `bubbleComposite.ts` — canvas 绘制（有框尾巴/融入式/小爱心）、CORS 安全字节加载、失败降级、代次令牌防乱序

### 1.3 出图 + 持久化 + 挂载
- `src/baibai/imageAdapter.ts` — `ImageBackendAdapter` 接柏宝绘公开 `generate()`；size/payload 归一化
- `src/storage/repository.ts` — `message.extra.sti_artifacts` 作品存储 + schema 版本迁移
- `src/ui/floorCards.ts` / `lightbox.ts` — inline（正文锚点定位，失败降级）/ trailing（楼层底部）卡片挂载、大图查看
- `theater/store.ts` / `mount.ts` — 小剧场三桶存储 + trailing 卡片

### 1.4 小剧场三套（Step 4）
- `src/theater/parseReply.ts` — tag 清洗（挡画风词）、容忍式 JSON 解析（旧格式/单引号/去重/限额）
- `src/theater/seed.ts` — FNV-1a 固定种子 + 按后端分离的重出种子
- `src/theater/safeFilter.ts` — 黑白漫三层防护（词边界 \b、整项剔除、分镜洗白）
- `src/theater/prompts.ts` — 三套读剧情 system prompt + Q版强档画风串 + 出图拼词层
- `src/theater/runtime.ts` — `runTheaterOne`：读剧情→解析→安全洗→逐格出图→返回故事（依赖全注入）

### 1.5 全流程接线
- `src/tasks/workflow.ts` — 模式分派（5 种），插画/漫画/小剧场三条工作链路，选段→LLM→出图→落盘→挂载
- `src/index.ts` — 重写：引入 CSS、修 `showToast` 类型断言、任务队列初始化、消息渲染/swipe 后重挂、事件注册
- `src/host/sillytavern.ts` — `initSTEnvironment` 改为优先全局 `getContext` + `@vite-ignore` 动态 import（**修好了构建失败的根因**）
- `src/baibai/bridge.ts` — 修 `getBackendStatus` 未配置分支的字段缺失（历史遗留 tsc 错误）
- `src/types.ts` — `BbiStatusInfo` 增加 `imagePath` 字段
- `vite.config.ts` + `scripts/copy-build.mjs` + `package.json` — 构建产物从 `dist/` 复制到扩展根目录（manifest 从根目录加载）

---

## 2. 验证结果

```
Test Files  12 passed (12)
     Tests  223 passed (223)

TypeScript  tsc --noEmit → 0 errors（含修好的历史遗留错误）
Build       vite build → 30 modules transformed
产物        index.js 117 KB + style.css 19 KB → 扩展根目录
```

12 个测试文件：anchor / compose / bridge / storySegment（原有 4）+ panelPlan / panelEnforce / planPrompts / planGenerator / bubblePlan / imageAdapter / taskQueue / theater（新增 8）。

关键回归覆盖：JSON 容错提取、LLM 未解析返回、队列串行/取消/看门狗、气泡防重叠/手动钉位/字幕条、黑白漫词边界（glass/brush 不误删）、中文主体 nl 判断、固定种子确定性、裸词判重幂等。

---

## 3. 数据流全景

```
用户划线 → 工具条 → 选段面板(选段方式+模式)
  → 确认 → VisualTask → 串行队列
       ├─ 插画: buildIllustrationSystemPrompt → LLM → parseIllustrationResponse
       │        → composeEnglishPrompt → generate() → inline 卡片
       ├─ 漫画: buildComicSystemPrompt(+buildPanelRule) → LLM → parseComicPagePlan
       │        → enforceForGeneration → 逐格 generate() → inline 卡片
       └─ 小剧场: buildTheaterPrompt → LLM → parseStatusReply → 安全洗
                → buildTheaterImagePrompt → 逐格 generate() → trailing 卡片
  → message.extra 落盘 → 重挂（消息渲染/swipe/chat 切换）
```

---

## 4. 剩余 / 需注意

1. **需在真实 ST + 柏宝绘环境验证**：`api.generate()` 的精确 payload schema、图片路径可访问性、`generateQuietPrompt` 的 system/user 合并行为、事件参数格式（`extractFloorFromEventArg` 做了多字段兜底）。
2. **设置面板 UI 未做**：类型与默认值齐全（`StoryIllustratorSettings` 五模式开关），但没有可视化设置界面——目前靠 `extension_settings.STStoryIllustrator` 直接编辑。可作为下一步。
3. **Tag 编辑器 UI 未做**：CSS 已预留 `.sti-prompt-editor`，但着色/双语/重 Roll 编辑器未实现。SPEC MVP 要求之一。
4. **漫画对话框气泡合成已实现但交互未接**：`compositeDialogue` 可用，但"编辑台词/钉位置/切换形态"的 UI 未做，当前出图后显示的是无字原图。
5. **Profile 选择 UI 未做**：`VisualProfile` 类型与选择逻辑（按 mode 匹配）已有，但没有 UI。
6. `api.generatePrompt()` 柏宝绘未开放，全程用 ST `generateQuietPrompt` + 自建 system prompt 替代（符合 ANALYSIS.md 策略）。

**一句话**：核心链路（选段→LLM→出图→挂载）五种模式全部打通并验证；剩下的是设置/编辑类 UI 和真实环境联调。
