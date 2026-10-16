import { HttpError } from '../http.js';
import { requireUser } from '../authRoutes.js';
import { publicUser as sanitizeUser } from '../shared.js';
import { baseUrlFor, channelFromSettings, normalizeWecomKey, notifyFriendRequest } from '../../push.js';
import { recordFriendAcceptedNotifications } from '../../notify.js';
import { maskSecret } from './users.js';

/** 好友条目 -> 前端友好结构（store 有值时带上"我对 TA 的推送设置"） */
function friendJson(entry, viewerId, store = null) {
  const pref = store && viewerId ? store.friendPushPref(viewerId, entry.user.id) : null;
  const hasOverride = Boolean(pref && (pref.secret || pref.url));
  return {
    user: sanitizeUser(entry.user),
    alias: entry.alias || '',
    displayName: entry.displayName,
    since: entry.since,
    direction: entry.direction,
    isFriend: true,
    push: pref
      ? {
          muted: Boolean(pref.muted),
          override: hasOverride,
          kind: pref.kind || '',
          secretHint: maskSecret(pref.secret),
          url: pref.url || '',
          usable: Boolean(channelFromSettings({ ...pref, enabled: 1 })),
        }
      : { muted: false, override: false, kind: '', secretHint: '', url: '', usable: false },
  };
}

function requestJson(entry) {
  return {
    user: sanitizeUser(entry.user),
    alias: entry.alias || '',
    displayName: entry.displayName,
    requestedAt: entry.since,
  };
}

/** 简版用户信息（用于好友列表 / 搜索 / 待处理请求）；store 有值时带上我给 TA 的备注名 */
function briefUser(user, { status = null, meId = null, store = null } = {}) {
  if (!user) return null;
  const alias = store && meId && meId !== user.id ? store.aliasFor(meId, user.id) : '';
  return {
    id: user.id,
    username: user.username,
    displayName: alias || user.display_name || user.username,
    realDisplayName: user.display_name || user.username,
    alias,
    avatarUrl: user.avatar ? `/u/${user.id}/avatar?v=${user.updated_at}` : null,
    bio: user.bio || '',
    isSelf: meId ? user.id === meId : false,
    friendship: status,
  };
}

export function registerFriendRoutes(r) {
  // 好友总览
  r.get('/api/friends', async (ctx) => {
    const me = requireUser(ctx);
    const friends = ctx.store.listFriends(me.id).map((f) => friendJson(f, me.id, ctx.store));
    const incoming = ctx.store.listIncomingRequests(me.id).map(requestJson);
    const outgoing = ctx.store.listOutgoingRequests(me.id).map(requestJson);
    ctx.send(200, {
      friends,
      incoming,
      outgoing,
      counts: { friends: friends.length, incoming: incoming.length, outgoing: outgoing.length },
    });
  });

  // 按用户名精确查找用户（用于添加好友）
  r.get('/api/users/lookup', async (ctx) => {
    const me = requireUser(ctx);
    const username = String(ctx.query.get('username') || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!username) throw new HttpError(400, '请输入用户名', 'bad_username');
    const user = ctx.store.stmt.userByName.get(username);
    if (!user) {
      ctx.send(200, { user: null, friendship: 'none' });
      return;
    }
    const status = me.id === user.id ? 'self' : ctx.store.friendshipStatus(me.id, user.id);
    ctx.send(200, { user: briefUser(user, { status, meId: me.id, store: ctx.store }), friendship: status });
  });

  // 发起好友请求（对方已请求过我时直接成为好友）
  r.post('/api/friends/requests', async (ctx) => {
    const me = requireUser(ctx);
    const body = await ctx.json();
    let target = null;
    if (body.userId) target = ctx.store.stmt.userById.get(String(body.userId));
    else if (body.username) {
      target = ctx.store.stmt.userByName.get(String(body.username).trim().replace(/^@/, '').toLowerCase());
    }
    if (!target) throw new HttpError(404, '没有找到这个用户', 'user_not_found');
    if (target.id === me.id) throw new HttpError(400, '不能添加自己为好友', 'self');

    const result = ctx.store.requestFriend(me.id, target.id);
    if (!result.ok) {
      const messages = {
        already_friends: '你们已经是好友了',
        already_requested: '已经发过请求，等待对方确认',
      };
      throw new HttpError(409, messages[result.reason] || '无法添加该用户', result.reason);
    }
    ctx.send(201, {
      status: result.status,
      user: briefUser(target, { status: result.status === 'accepted' ? 'accepted' : 'pending_out', meId: me.id, store: ctx.store }),
      message: result.status === 'accepted' ? '对方之前已经申请过，现在你们是好友了' : '请求已发送，等待对方确认',
    });
    // 出站通知：有人要加你 → 推给**收请求的那个人**（用他自己的通道；成为好友那种就不推了）
    if (result.status !== 'accepted') {
      void notifyFriendRequest({ store: ctx.store, from: me, to: target, baseUrl: baseUrlFor(ctx) }).catch(() => {});
    }
  });

  // 同意好友请求（:id 是发起请求那一方的用户 id）
  r.post('/api/friends/requests/:id/accept', async (ctx) => {
    const me = requireUser(ctx);
    const targetId = String(ctx.params?.id || '').trim();
    const result = ctx.store.acceptFriend(me.id, targetId);
    if (!result.ok) {
      const messages = { not_found: '请求不存在或已处理', not_addressee: '只能同意发给自己的请求' };
      throw new HttpError(404, messages[result.reason] || '操作失败', result.reason);
    }
    const other = ctx.store.stmt.userById.get(targetId);
    // 通知层：双方收件箱各写一条"你们成为好友了"（这条不推手机，属于"知道就好"）
    recordFriendAcceptedNotifications({ store: ctx.store, accepter: me, requester: other });
    ctx.send(200, { ok: true, user: briefUser(other, { status: 'accepted', meId: me.id, store: ctx.store }) });
  });

  // 拒绝请求 / 解除好友 / 撤回请求
  r.delete('/api/friends/:id', async (ctx) => {
    const me = requireUser(ctx);
    const result = ctx.store.removeFriend(me.id, ctx.params.id);
    if (!result.ok) throw new HttpError(404, '你们之间没有关系记录', 'not_found');
    ctx.send(200, { ok: true, removed: result.removed });
  });

  // 设置备注名（只影响自己的显示）
  r.patch('/api/friends/:id', async (ctx) => {
    const me = requireUser(ctx);
    const body = await ctx.json();
    const alias = String(body.alias ?? '').trim().slice(0, 24);
    const result = ctx.store.setFriendAlias(me.id, ctx.params.id, alias);
    if (!result.ok) throw new HttpError(404, '你们还不是好友', 'not_found');
    const entry = ctx.store.listFriends(me.id).find((f) => f.user.id === ctx.params.id);
    ctx.send(200, { ok: true, friend: entry ? friendJson(entry, me.id, ctx.store) : null });
  });

  /**
   * 我对某个好友的推送设置（**收件人视角**）：
   *   { muted }                 免推送
   *   { kind, secret, url }     单独通道（优先于我的默认通道）
   *   { clear: true }           清掉例外，回到"用默认通道"
   * 只对已经是好友的人有效 —— 免得给陌生人写记录。
   */
  r.patch('/api/friends/:id/push', async (ctx) => {
    const me = requireUser(ctx);
    const friendId = String(ctx.params?.id || '').trim();
    if (!ctx.store.friendIds(me.id).includes(friendId)) throw new HttpError(404, '你们还不是好友', 'not_found');
    const body = await ctx.json();
    if (body.clear) {
      ctx.store.clearFriendPushPref(me.id, friendId);
    } else {
      const kind = body.kind === undefined ? undefined : String(body.kind || '').trim().toLowerCase().slice(0, 16);
      const rawSecret = body.secret === undefined ? undefined : String(body.secret || '').trim().slice(0, 400);
      const secret = rawSecret === undefined ? undefined : kind === 'wecom' ? normalizeWecomKey(rawSecret) : rawSecret;
      ctx.store.setFriendPushPref(me.id, friendId, {
        ...(body.muted === undefined ? {} : { muted: Boolean(body.muted) }),
        ...(kind === undefined ? {} : { kind }),
        ...(secret === undefined ? {} : { secret }),
        ...(body.url === undefined ? {} : { url: String(body.url || '').trim().slice(0, 400) }),
        ...(body.clearSecret ? { clearSecret: true } : {}),
        ...(body.clearUrl ? { clearUrl: true } : {}),
      });
    }
    const entry = ctx.store.listFriends(me.id).find((f) => f.user.id === friendId);
    ctx.send(200, { ok: true, friend: entry ? friendJson(entry, me.id, ctx.store) : null });
  });
}
