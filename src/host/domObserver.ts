/**
 * `#chat` 子树变更的统一观察器。
 *
 * 为什么必须有这一层：ST 的 `printMessages()` 走 `redisplayChat()` →
 * `updateMessageElement()`，**整批重建 `.mes` 却不发任何事件**；消息重渲
 * （`.mes_text.html(...)`、编辑保存、右滑生成）同样不发 `CHARACTER_MESSAGE_RENDERED`。
 * 于是插件只在 `onActivate` 里挂一次的话，刷新网页 = 卡片全部消失，而且再没机会回来。
 * 柏宝绘的图片卡片刷新后还在，靠的正是它自己的 `#chat` observer 自愈——这里照同一套做。
 *
 * 节流用 rAF + 最小间隔：流式渲染时每个 token 都会产生一次 mutation，同一帧合并成一次；
 * 再加一道时间闸，避免「每帧都去遍历所有楼层」把聊天窗口拖卡。
 * 订阅者的回调必须是**便宜的对账**：只比对「该有的卡片在不在」，缺了才重建。
 */

type ChatMutationListener = () => void;

const listeners = new Set<ChatMutationListener>();

let observer: MutationObserver | null = null;
let scheduled = false;
let lastFlush = 0;

/** 两次对账之间的最小间隔（毫秒）。流式输出时 mutation 极密，这是唯一的节流阀。 */
const MIN_INTERVAL_MS = 250;

function flush(): void {
  scheduled = false;
  lastFlush = Date.now();
  for (const listener of listeners) {
    // 一个订阅者抛异常不能连坐其它订阅者，更不能让自愈整条链路断掉
    try {
      listener();
    } catch (error) {
      console.error('[ST-Story-Illustrator] #chat 变更回调异常', error);
    }
  }
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastFlush));
  if (wait === 0) {
    requestAnimationFrame(flush);
    return;
  }
  window.setTimeout(() => requestAnimationFrame(flush), wait);
}

/** 绑定观察器（幂等）。`#chat` 不在 DOM 里时返回 false，调用方不要退化成轮询。 */
export function ensureChatObserver(): boolean {
  if (observer) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;
  observer = new MutationObserver(schedule);
  // 只要 childList+subtree：属性变更（我们自己写 data-* 、ST 翻 is_system）不进这里，
  // 否则「自愈写属性」会反过来唤醒自愈，变成自激循环。
  observer.observe(chat, { childList: true, subtree: true });
  return true;
}

/** 订阅 `#chat` 变更（自动确保观察器已绑定）。返回退订函数。 */
export function onChatMutation(listener: ChatMutationListener): () => void {
  listeners.add(listener);
  ensureChatObserver();
  return () => {
    listeners.delete(listener);
  };
}

/** 卸载：清空订阅者并断开观察器（扩展被关掉时调用）。 */
export function destroyChatObserver(): void {
  listeners.clear();
  observer?.disconnect();
  observer = null;
  scheduled = false;
  lastFlush = 0;
}
