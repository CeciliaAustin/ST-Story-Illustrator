# 三模式同选事故复盘：方案没切 / 少一份 / 图与剧情无关

日期：2026-11-19

## 现象

同一次勾选「QQ 人彩蛋 + QQ 人状态栏 + 黑白漫小剧场」，三套各配了不同出图方案：

1. 只出了两份（彩蛋没了）；
2. 出的两份**都用柏宝绘原方案**（贵的那套），方案切换完全没生效；
3. 出图与选段剧情毫无关联。

## 根因

### 1. 方案切换静默失败（花钱的直接原因）

`switchBaiBaiPlan` 只做了两件事：点开柏宝绘主入口 → 在 shadow DOM 里找 `button[role=radio]`。
但方案列表只存在于「渠道 → NAI」页签里：

- `openPanel()` 不带参数 → 回到 localStorage 里上次那一页（常常是「设置」）；
- 页签停在 ComfyUI 时，NAI 方案列表根本不在 DOM。

于是轮询几秒后 `no-ui`，而调用方 `ensureModeOutPlan` **只 console.warn 就继续**，
出图照旧用「当前方案」。用户按 NAI4.5 分配方案就是为了省钱，静默降级等于替他多花钱还瞒着他。

### 2. 少一份彩蛋

`settings.modes` 在存档里是**整体替换**的（`getSettings` 只做浅合并）。旧存档里没有
后来新增的 `chibi-bonus` 键 → `resolveModeSettings` 之前直接 `settings.modes[mode]` →
`modeSettings.shots` 抛 `TypeError`，任务在「读配置」这一步就死了，只看到一张失败 toast。

### 3. 图与剧情无关

- 模型的 JSON 里，动作写在 `characters[].act`（最具体的信息），运行时**只取了 tags**，
  act 整段丢掉；
- 角色外貌只做 name 精确匹配，正文写「小红」而库里是「小红（我）」→ 匹配失败 →
  没有外貌 tag，出图变成「随便哪个人」；
- 读剧情没有任何体检，模型给几个空景词（`1girl, solo, standing`）也照样出图。

## 修复

| 位置 | 改动 |
| --- | --- |
| `baibai/planSwitch.ts` | 自己导航：打开面板 → 点 `button.bbi-nav-item` 的「渠道」→ 点 `role=tab` 的「NAI」→ 按方案名点 radio；**必须确认 activePlanId 真的变了**才返回成功；名字有歧义直接报 ambiguous 不猜；当前渠道不是 NAI 直接报 wrong-backend；用我们打开的面板会顺手关掉 |
| `tasks/modePlan.ts` | 切不过去**抛错中止**，绝不降级用当前方案；切完再读一次快照做双保险；与 workflow 里的重复实现合并成唯一一份 |
| `types.ts` | 新增 `resolveModeSettings()`：缺键补齐，旧存档不再炸；新增 `MODE_LABEL` |
| `tasks/workflow.ts`、`tasks/theaterRun.ts` | 三处 `settings.modes[mode]` 全部改走 `resolveModeSettings` |
| `index.ts` | 失败 toast 带模式名（`QQ 人彩蛋 生成失败：…`）；自动出图同样走兜底读法 |
| `theater/runtime.ts` | 新增 `combinedPanelTags()` 把 act 合进出图词（去重、丢中文）；新增 `checkReading()` 出图前体检（tag 够不够 / 角色在不在正文里），不合格**重问一次**，仍不合格就**不出图**并说明原因 |
| `tasks/theaterRun.ts` | 新增 `makeLookReader()`：名字归一化匹配 + 括号前主名 + 主角色兜底 |
| `theater/prompts.ts` | 强化「动作必须具体、禁止空景词」规则 |
| `log/imageLog.ts` + `ui/configPanel.ts` | 出图日志记录并显示**这次实际用的方案名**，下次这类问题一眼可见 |

## 行为变化（用户可感知）

- 方案切不过去 → 该任务**直接失败**并说明原因，不会再用贵方案偷偷出图；
- 读剧情不合格 → 先重问一次（文本调用便宜），仍不合格就不出图；
- 日志每条都带「方案 XXX」，能直接对账。

## 验证

- `tsc --noEmit` 0 错误
- `vitest` 21 文件 / 329 用例全过（新增 `tests/theaterReading.test.ts`、`tests/planSwitch.test.ts`）
- `npm run build` 成功，`index.js` 已同步到酒馆扩展目录

## 已知边界

- 方案切换只能走柏宝绘的 DOM（它的设置是启动时的内存快照，外部改 `extension_settings` 不生效）。
  柏宝绘若改结构，切换会失败——但现在失败会中止，不会误花钱。
- 切换是全局的，不自动切回原方案；每个任务按自己的模式需要再切。
