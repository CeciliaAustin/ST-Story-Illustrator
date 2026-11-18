# 分层配置 + 楼层完全访问 修复报告

日期：2026-11-18
版本提交：见 git log（本报告同批次）

---

## 一、按创作模式分出图方案（新增）

### 需求
上次只做了「按模式分 LLM 渠道」（读剧情/写 Tag 那一步），这次要**再叠加一层**：
按模式分「出图方案」（模型 / 接入点 / 尺寸），两层都保留。

### 实现
- `types.ts` 新增 `modeOutPlans: Partial<Record<CreationMode, string>>`，存柏宝绘方案 id。
- 选段弹窗新增「**出图方案**」区域，5 个模式各一个下拉：
  - `跟随当前方案`（默认，不切换）
  - 柏宝绘里的全部方案（显示 `方案名 · NAI版本 · 接入点`）
  - 已删除的方案显示「已失效方案」，不会静默丢失选中态
- 切换即时保存并广播 `sti-settings-changed`，运行中的队列立刻拿到新设置，**不用重启**。
- 出图前 `ensureModeOutPlan()`：
  1. 该模式没指定方案 → 什么都不做（沿用当前方案）
  2. 指定了但已不存在 → 打日志，改用当前方案，**不中断出图**
  3. 指定了且与当前不同 → 走柏宝绘自己的切换逻辑，失败只警告，仍继续出图

### 为什么必须这样切
柏宝绘的公开出图接口（`generate`）**不接受 planId 参数**，永远用它自己的「当前方案」。
所以只能"临时切成当前方案"，这是唯一合法路径，没有改柏宝绘源码。

任务队列是**串行**的（`taskQueue.ts` 的 `running` 标志 + while 逐条消费），所以
"切 → 出图 → 下个任务按需再切"不会互相打断。

### 体验优化
`switchBaiBaiPlan()` 改为：
1. 柏宝绘面板**本来就开着** → 直接点方案按钮，不额外弹面板
2. 面板没开 → 才调它自己的入口打开
3. 点击后轮询 `activePlanId` 确认生效

---

## 二、楼层完全访问（隐藏楼层）

### 根因
SillyTavern 的「隐藏楼层」= `message.is_system === true`（源码 `chats.js` 注释：
"Mark a range of messages as hidden ("is_system") or not."）。
我们的 `isSystemMessage()` 默认把这些过滤掉了，所以用户把前面楼层隐藏后，
「单楼 / 勾选」列表里只剩可见的那几层。

### 实现
- `getAvailableFloors({ includeHidden })`：为 true 时一并列出隐藏楼层，并带 `hidden: true` 标记。
- 面板新增开关「**查看所有楼层（含已隐藏的楼层）**」，位置在每个楼层选择区顶部（「局部」页不需要，不显示）。
- 列表里隐藏楼层显示为 `[5]（隐藏） 名字: 预览...`，勾选列表里弱化显示（斜体 + 半透明）。
- `buildSingleSegment` / `buildRangeSegment` / `buildPickedSegment` 统一接受 `includeHidden`，
  抽出 `SegmentBuildOptions`，`extractMessage` 内做过滤（原来是各 build 函数里各写一遍，容易漏）。

---

## 三、范围改为直接填楼层号

### 改动
原来的「从 [下拉] 到 [下拉]」换成「从 [数字框] 到 [数字框] 楼」：

- 支持直接输入任意楼层号，不受可见楼层列表限制（隐藏楼层也能填进区间）
- 上界自动夹到 `chat.length - 1`，下界夹到 0（`buildRangeSegment` 内 clamp，防越界）
- 支持回车提交，失焦也生效
- 提示「当前共 N 层，楼层号 0–N-1」
- 区间超过 50 层提示只取前 50 条（这是原有的 prompt 长度保护）
- 区间内有隐藏楼层且开关未开时，提示「有 N 层是隐藏楼层，当前会被跳过」

排除楼层勾选列表保留，跟随区间与隐藏开关变化。

---

## 四、验证

| 项 | 结果 |
|---|---|
| `npm test` | **272 / 272 通过**（新增 11 个：隐藏楼层访问、区间 clamp、楼层计数） |
| `tsc --noEmit` | 0 错误 |
| `npm run build` | 成功，`index.js` 156.93 kB / `style.css` 24.64 kB |
| 同步酒馆扩展目录 | 3 个关键文件字节一致 |
| 产物抽查 | 隐藏开关 / 隐藏标记 / 数字输入 / 出图方案选择 / `modeOutPlans` / 切换逻辑 全部命中 |

---

## 五、需要用户在真实环境确认的点

1. **出图方案切换是否可靠** —— 依赖柏宝绘 DOM（shadow DOM `#bbi-app-host` 里的
   `button.item-main[role=radio]`）。柏宝绘改版可能失效，失效只会退回"用当前方案"，不会中断出图。
2. **切方案会改动柏宝绘的全局当前方案** —— 切完不会自动切回，这意味着所有用柏宝绘出图的
   地方都会用新方案。如果需要严格隔离，得等柏宝绘开放方案参数。
3. **隐藏楼层被选作锚点时的挂载** —— 隐藏楼层的 DOM 存在但不可见，图片写进正文后会藏在
   折叠区里。如果希望这种情况下仍能看到结果，需要额外处理（下一步可做）。
4. **NAI4.5 方案仍需先在柏宝绘里创建** —— 目前三套方案全是 NAI5，光靠本扩展无法凭空造出 4.5。

---

## 六、改动文件清单

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `modeOutPlans` 字段 + 默认值 |
| `src/selection/storySegment.ts` | `SegmentBuildOptions` / `FloorOption` / `getChatFloorCount`；三个 build 函数支持 `includeHidden`；`buildRangeSegment` 加区间 clamp |
| `src/ui/selectionPanel.ts` | 隐藏楼层开关、楼层显示标记、范围改数字输入、新增出图方案选择区、LLM 渠道区改标题 |
| `src/tasks/workflow.ts` | `ensureModeOutPlan()`，在插画 / 漫画 / 小剧场出图前调用 |
| `src/baibai/planSwitch.ts` | 面板已开则不重复弹；抽出 `tryClickPlanRadio` / `confirmSwitched` |
| `src/ui/configPanel.ts` | 新增「各创作模式指定的方案」只读展示 |
| `src/index.ts` | 设置广播监听改名（同时覆盖渠道和方案） |
| `src/styles/style.css` | `.sti-hidden-toggle` / `.sti-floor-number` / `.is-hidden-floor` |
| `tests/storySegment.test.ts` | 新增 11 个隐藏楼层与区间测试 |
