/**
 * 通知层（2026-10-11 用户提的方案）：
 *   人做了事（好友发新记录 / 有人加你好友 / 好友申请被同意）→ 写进**收件人的收件箱**，
 *   并（对前两类）顺手推到他手机（走 push.js，通道是收件人自己配的）。
 *
 * 为什么要有"收件箱"这一层：
 *   agent 不是常驻进程 —— 没有东西能"推送"给它，它也不会被叫醒。
 *   所以反过来做：把未读摘要**捎带在每个 API 响应里**（见 server.js 的 ctx.send），
 *   于是"人做了事 → agent 下次一调用 API 就必然看到"，即使不是实时的。
 *
 * 这里只管收件箱（纯数据操作，不碰 HTTP、不碰网络），手机推送在 push.js 里。
 */

const DEFAULT_EXCERPT = 80;

/** 截断成一句话摘要（按字符数，换行压成空格） */
export function excerptOf(text, max = DEFAULT_EXCERPT) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!max || !flat) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 事件类型（前端/CLI 用它们做图标和文案） */
export const NOTIFY_KIND = {
  post: 'post',
  friendRequest: 'friend_request',
  friendAccepted: 'friend_accepted',
};

/** 给一批收件人写收件箱条目（跳过作者自己），并顺手裁剪长度 */
export function recordNotifications({ store, kind, actor, recipients = [], postId = null, summary = '', dayKey = null } = {}) {
  if (!store || !kind || !actor?.id) return 0;
  let n = 0;
  for (const recipient of recipients) {
    const userId = typeof recipient === 'string' ? recipient : recipient?.id || recipient?.user?.id;
    if (!userId || userId === actor.id) continue;
    store.addNotification({ userId, kind, actorId: actor.id, postId, summary, dayKey });
    store.pruneNotifications(userId, 500);
    n += 1;
  }
  return n;
}

/** 好友发了新记录 → 给每个好友写一条 */
export function recordPostNotifications({ store, author, post, dayKey = '' } = {}) {
  const friends = store.listFriends(author.id).filter((f) => f?.user?.id && f.user.id !== author.id);
  const authorName = author.display_name || author.username;
  const text = excerptOf(post?.body, 80);
  return recordNotifications({
    store,
    kind: NOTIFY_KIND.post,
    actor: author,
    recipients: friends.map((f) => f.user),
    postId: post?.id || null,
    dayKey: dayKey || null,
    summary: text ? `${authorName} 发了新记录：${text}` : `${authorName} 发了新记录`,
  });
}

/** 收到好友申请 → 给收请求的人写一条 */
export function recordFriendRequestNotification({ store, from, to } = {}) {
  if (!store || !from?.id || !to?.id) return 0;
  const name = from.display_name || from.username;
  return recordNotifications({
    store,
    kind: NOTIFY_KIND.friendRequest,
    actor: from,
    recipients: [to],
    summary: `${name} 想加你为好友`,
  });
}

/** 好友申请被同意 → 双方各写一条（"你们成为好友了"） */
export function recordFriendAcceptedNotifications({ store, accepter, requester } = {}) {
  if (!store || !accepter?.id || !requester?.id) return 0;
  const aName = accepter.display_name || accepter.username;
  const rName = requester.display_name || requester.username;
  let n = 0;
  n += recordNotifications({
    store,
    kind: NOTIFY_KIND.friendAccepted,
    actor: accepter,
    recipients: [requester],
    summary: `${aName} 同意了你的好友申请，你们现在是好友了`,
  });
  n += recordNotifications({
    store,
    kind: NOTIFY_KIND.friendAccepted,
    actor: requester,
    recipients: [accepter],
    summary: `你和 ${rName} 成为好友了`,
  });
  return n;
}

/**
 * 给 API / 捎带字段用的形状（**纯读**：看它不会把任何东西标成已读）。
 * 只在"有未读"时才有意义 —— 调用方自己决定要不要带上（没未读就别塞空壳）。
 */
export function notificationsPayload(store, userId, { limit = 10 } = {}) {
  if (!store || !userId) return null;
  const unread = store.notificationSummary(userId);
  if (!unread.total) return null;
  const items = store.listNotifications(userId, { limit, unreadOnly: true });
  return {
    unread,
    items,
    hint: unreadHint(unread),
    serverTime: Date.now(),
  };
}

/** 一句话人话摘要，agent 扫一眼就知道该干什么 */
export function unreadHint(unread = {}) {
  const parts = [];
  const post = unread.byKind?.post || 0;
  const req = unread.byKind?.friend_request || 0;
  const accepted = unread.byKind?.friend_accepted || 0;
  if (post) parts.push(`${post} 条好友新记录`);
  if (req) parts.push(`${req} 个好友申请待处理`);
  if (accepted) parts.push(`${accepted} 条好友关系变化`);
  if (!parts.length) return '';
  return `你有 ${parts.join('、')}（GET /api/me/notifications 查看，POST 同一个地址 + /read 标记已读）`;
}
