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

---

# 追加复盘（同日）：上一版「自己导航」依旧没切，根因是判"面板开着"用错了元素

## 现象

上一版修完后用户再测：「方案（NAI4.5 / 5 + 画师串这种）完全没切」。

## 根因：`shadowRoot()` 永远非空

柏宝绘的 `mount()` 在酒馆启动时就把 `#bbi-app-host` 挂到 `document.body`，
**shadow root 一直存在**；真正受 `ui.open` 控制的是里面的 `.bbi-window`
（`App.vue`：`<div v-if="ui.open" class="bbi-overlay">`）。

上一版的 `openPanelIfNeeded()` 是这么写的：

```ts
if (shadowRoot()) return;   // ← 永远为真
```

于是：

1. 面板没打开时**从来不去点菜单**；
2. 空 shadow 树里没有 `.bbi-nav-item`、没有 `role=tab`、没有 `.plan-item`；
3. 轮询 12 秒超时 → `no-ui` → 抛错。

换句话说：**只要用户没手动把柏宝绘面板开着，方案就一定切不动。**
（面板恰好开着时反而能切，所以表现为"时好时坏"，更难查。）

## 第二个坑：`plan-item` 不是 NAI 专属

`ComfyUIPanel.vue` 也有 `.grp-item.plan-item`。上一版靠「方案行数量 > 0」判断
「已经在 NAI 页签」，页签停在 ComfyUI 时会拿着 ComfyUI 的方案名去匹配 NAI 方案名，
永远匹配不上，同样切不动。

## 修复

| 位置 | 改动 |
| --- | --- |
| `baibai/planSwitch.ts` | ① 判「面板开着」改看 **`.bbi-window`**；② 没开就按 `#bbi-menu-item` → `#bbi-topbar-button` → `.bbi-orb` 依次点开，并等 `.bbi-window` 出现；③ 每轮**显式确认**导航高亮在「渠道」、`role=tab` 的 NAI 是 `is-on`，再找方案行（不再用"有方案行"当判据）；④ 每轮重新查 DOM（Vue 会重建节点）；⑤ 成功判据改成**目标方案行的 `aria-checked="true"`**（这是它内部状态的直接反映），读设置快照只用于交叉核对，绝不拿它去否定已成功的切换；⑥ 失败信息带上现场（面板开没开 / 导航有哪些 / 页签有哪些 / 方案行几个） |
| `baibai/planConfig.ts` | 新增 `activePlanModel()`，供日志记录"这次用的是哪个模型" |
| `tasks/modePlan.ts` | 每次切换都往「出图日志」写一条（成功/失败都写），失败抛错中止 |
| `tasks/workflow.ts` | 小剧场**每张图出图前**再复核一次方案（幂等：已经是目标方案时只读一次配置），防止读剧情那几十秒里方案被改动；日志补 `模型` 字段 |
| `log/imageLog.ts` | 新增 `kind:'plan'` 与 `recordPlanSwitch()`，日志条目带 `model` |
| `ui/configPanel.ts` | 出图日志能显示「切方案」条目与「模型」字段，事后能直接对账"到底切没切、用的是 NAI5 还是 4.5" |

## 为什么不再"静默降级"

`ensureModeOutPlan` 失败一律抛错：宁可这一份不出，也不要用贵方案偷偷出。
用户按模式分配 NAI4.5 就是为了省钱，用错方案比不出图更贵。

## 验证

- `tsc --noEmit` 0 错误
- `vitest` 21 文件 / **338 用例**全过（`tests/planSwitch.test.ts` 新增导航/页签选择规则 9 例）
- `npm run build` 成功，`index.js` / `style.css` 已同步到酒馆扩展目录

## 自查清单（下次再有人报"没切"）

1. 打开「配图设置 → 出图日志」，看有没有 `切方案 · 成功` 条目 → 没有就是根本没走到切换；
2. 有 `切方案 · 失败` → 看括号里的现场（面板是否打开、页签是不是 NAI）；
3. 有 `切方案 · 成功` 但图不对 → 看该方案里配的模型/画师串本身，不是切换的问题；
4. 出图日志的「模型」字段 = 方案里写的模型 → 说明出图时用的就是这套。
