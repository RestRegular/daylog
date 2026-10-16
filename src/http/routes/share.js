import { HttpError } from '../http.js';
import { requireUser } from '../authRoutes.js';
import { postJson } from '../shared.js';
import { isValidDayKey } from '../../lib/time.js';

/** 分享链接的有效期可选值（小时） */
export const SHARE_TTL_HOURS = [1, 24, 168, 720];
const DEFAULT_TTL_HOURS = 168;

/** 解析请求中的分享令牌（路径参数或 query） */
export function resolveShareToken(ctx) {
  const pathToken = ctx.params?.token;
  const queryToken = ctx.query?.get('token') || ctx.query?.get('t');
  const token = String(pathToken || queryToken || '').trim();
  if (!token || token.length < 6 || token.length > 64 || !/^[a-z0-9]+$/i.test(token)) return null;
  return token;
}

/**
 * 取一条有效的分享链接。
 * 每次分享都是独立的一条：内容范围（某天 / 某月 / 全部）和过期时间都绑在这条记录上，
 * 所以链接里**不需要**再带 range/date 之类的参数 —— 换一个范围就是换一条链接。
 */
export function resolveShareLink(ctx) {
  const token = resolveShareToken(ctx);
  if (!token) throw new HttpError(404, '分享链接无效', 'not_found');
  const link = ctx.store.shareLink(token);
  if (!link) throw new HttpError(404, '分享链接无效或已被撤销', 'not_found');
  if (link.revoked_at) throw new HttpError(410, '这个分享链接已被撤销', 'share_revoked');
  if (link.expires_at <= Date.now()) throw new HttpError(410, '这个分享链接已过期', 'share_expired');
  const owner = ctx.store.stmt.userById.get(link.user_id);
  if (!owner) throw new HttpError(404, '分享链接无效', 'not_found');
  const isOwner = Boolean(ctx.user && ctx.user.id === owner.id);
  return { owner, isOwner, link, token };
}

/**
 * 「好友的时间线」视图（应用内点好友头像打开的那个页面）。
 * 它不是给外人看的分享链接，所以要求**已登录且是好友**（或本人），
 * 免得别人靠猜用户名就能翻你的记录。
 */
export function resolveFriendTimeline(ctx) {
  const raw = String(ctx.params?.name || ctx.query.get('user') || '')
    .trim()
    .replace(/^@/, '');
  if (!raw || raw.length > 64) throw new HttpError(404, '用户不存在', 'not_found');
  const owner = ctx.store.stmt.userByName.get(raw.toLowerCase());
  if (!owner) throw new HttpError(404, '用户不存在', 'not_found');
  const viewer = ctx.user;
  const isOwner = Boolean(viewer && viewer.id === owner.id);
  if (!isOwner) {
    if (!viewer) throw new HttpError(401, '请先登录再查看好友的时间线', 'login_required');
    if (!ctx.store.friendIds(viewer.id).includes(owner.id)) {
      throw new HttpError(403, '只有好友才能查看 TA 的时间线', 'not_friend');
    }
  }
  return { owner, isOwner };
}

export function shareLinkJson(link) {
  return {
    token: link.token,
    scope: link.scope,
    day: link.day || '',
    month: link.month || '',
    expiresAt: link.expires_at,
    createdAt: link.created_at,
    url: `/s/${link.token}`,
  };
}

/**
 * 分享页 / 好友时间线页顶部那张名片。
 * viewerId 有值（= 已登录的访问者）时，用**访问者给 TA 起的备注名**当显示名 ——
 * 「好友的时间线」必须这样，否则我在好友页设的备注名到了他的时间线页就白设了。
 */
function ownerProfile(ctx, owner, viewerId = null) {
  const stats = ctx.store.stats(owner.id);
  const realName = owner.display_name || owner.username;
  const alias = viewerId && viewerId !== owner.id ? ctx.store.aliasFor(viewerId, owner.id) : '';
  return {
    id: owner.id,
    username: owner.username,
    displayName: alias || realName,
    realDisplayName: realName,
    alias,
    bio: owner.bio || '',
    avatarUrl: owner.avatar ? `/u/${owner.id}/avatar?v=${owner.updated_at}` : null,
    cardTheme: owner.card_theme || '',
    timezone: owner.timezone,
    stats: owner.show_stats ? stats : null,
  };
}

/** 分享链接能看到的范围（服务端说了算，客户端不能再改） */
function rangeOf(link) {
  if (link.scope === 'day' && isValidDayKey(link.day)) return { from: link.day, to: link.day };
  if (link.scope === 'month' && /^\d{4}-\d{2}$/.test(link.month)) {
    return { from: `${link.month}-01`, to: `${link.month}-31` };
  }
  return { from: null, to: null };
}

function sendPage(ctx, { owner, isOwner, link = null, viaFriend = false }) {
  const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 20, 1), 100);
  const { from, to } = link ? rangeOf(link) : { from: null, to: null };
  const rows = ctx.store.queryPosts({
    userId: owner.id,
    includePrivate: isOwner,
    from,
    to,
    limit: limit + 1,
    cursor: ctx.query.get('cursor') || null,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  // 分享页里的记录都属于 owner：显式把 TA 作为作者写上，
  // 并且**不要**把「当前登录的访问者」当作者兜底（那会把主人的记录显示成访问者的头像/用户名）
  ctx.store.attachAuthors(page, null);
  ctx.send(200, {
    profile: ownerProfile(ctx, owner),
    link: link ? shareLinkJson(link) : null,
    viaFriend,
    isOwner,
    from,
    to,
    posts: ctx.store.postsWithMedia(page).map((p) => postJson(p, null)),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    hasMore,
    generatedAt: Date.now(),
  });
}

export function registerShareRoutes(r) {
  // ---- 生成 / 管理自己的分享链接（需登录）----

  r.post('/api/share/links', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const scope = String(body.scope || 'all').toLowerCase();
    if (!['day', 'month', 'all'].includes(scope)) throw new HttpError(400, '分享范围不合法', 'bad_scope');

    const day = scope === 'day' ? String(body.day || '') : '';
    const month = scope === 'month' ? String(body.month || '') : '';
    if (scope === 'day' && !isValidDayKey(day)) throw new HttpError(400, '请选择要分享的日期', 'bad_day');
    if (scope === 'month' && !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, '请选择要分享的月份', 'bad_month');

    const hours = SHARE_TTL_HOURS.includes(Number(body.hours)) ? Number(body.hours) : DEFAULT_TTL_HOURS;
    const link = ctx.store.createShareLink({
      userId: user.id,
      scope,
      day,
      month,
      ttlMs: hours * 3600 * 1000,
    });
    ctx.store.purgeShareLinks();
    ctx.send(201, { link: shareLinkJson(link), hours });
  });

  r.get('/api/share/links', async (ctx) => {
    const user = requireUser(ctx);
    ctx.send(200, { links: ctx.store.myShareLinks(user.id).map(shareLinkJson) });
  });

  r.delete('/api/share/links/:token', async (ctx) => {
    const user = requireUser(ctx);
    const ok = ctx.store.revokeShareLink(user.id, String(ctx.params.token || ''));
    if (!ok) throw new HttpError(404, '链接不存在', 'not_found');
    ctx.send(200, { ok: true });
  });

  // ---- 访客看分享链接（无需登录，范围由链接决定）----

  r.get('/api/s/:token', async (ctx) => {
    const { owner, isOwner, link } = resolveShareLink(ctx);
    ctx.send(200, {
      profile: ownerProfile(ctx, owner),
      link: shareLinkJson(link),
      isOwner,
      allowSignup: ctx.store.userCount() === 0,
    });
  });

  r.get('/api/s/:token/posts', async (ctx) => {
    const { owner, isOwner, link } = resolveShareLink(ctx);
    sendPage(ctx, { owner, isOwner, link });
  });

  r.get('/api/s/:token/posts/:id', async (ctx) => {
    const { owner, isOwner, link } = resolveShareLink(ctx);
    const row = ctx.store.stmt.postById.get(ctx.params.id);
    if (!row || row.deleted_at || row.user_id !== owner.id) throw new HttpError(404, '动态不存在', 'not_found');
    const { from, to } = rangeOf(link);
    const day = row.post_day || '';
    if (from && (day < from || day > to)) throw new HttpError(404, '动态不存在', 'not_found');
    if (row.visibility === 'private' && !isOwner) throw new HttpError(404, '动态不存在', 'not_found');
    const fresh = ctx.store.postsWithMedia([row])[0];
    ctx.store.attachAuthors([fresh], null);
    ctx.send(200, { post: postJson(fresh, null), profile: ownerProfile(ctx, owner), link: shareLinkJson(link) });
  });

  // ---- 应用内：好友的时间线（需登录 + 好友关系）----

  r.get('/api/u/:name/timeline', async (ctx) => {
    const { owner, isOwner } = resolveFriendTimeline(ctx);
    ctx.send(200, {
      // 好友视图：显示名要用「访问者给 TA 起的备注名」
      profile: ownerProfile(ctx, owner, ctx.user?.id || null),
      link: null,
      viaFriend: true,
      isOwner,
      allowSignup: false,
    });
  });

  r.get('/api/u/:name/timeline/posts', async (ctx) => {
    const { owner, isOwner } = resolveFriendTimeline(ctx);
    // 好友视图允许访客（= 已登录的我）自己按 今天 / 选日期 / 全部 筛
    const dayParam = String(ctx.query.get('date') || '');
    const fromParam = String(ctx.query.get('from') || '');
    const toParam = String(ctx.query.get('to') || '');
    const from = isValidDayKey(dayParam) ? dayParam : isValidDayKey(fromParam) ? fromParam : null;
    const to = isValidDayKey(dayParam) ? dayParam : isValidDayKey(toParam) ? toParam : null;
    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 20, 1), 100);
    const rows = ctx.store.queryPosts({
      userId: owner.id,
      includePrivate: isOwner,
      from,
      to,
      limit: limit + 1,
      cursor: ctx.query.get('cursor') || null,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    ctx.store.attachAuthors(page, ctx.user?.id || null);
    ctx.send(200, {
      profile: ownerProfile(ctx, owner, ctx.user?.id || null),
      link: null,
      viaFriend: true,
      isOwner,
      from,
      to,
      posts: ctx.store.postsWithMedia(page).map((p) => postJson(p, ctx.user)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      hasMore,
      generatedAt: Date.now(),
    });
  });
}
