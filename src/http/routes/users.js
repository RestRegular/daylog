import { HttpError } from '../http.js';
import { requireUser } from '../authRoutes.js';
import { publicUser } from '../shared.js';
import { normalizeTimezone } from '../../lib/time.js';
import { channelFromSettings, normalizeWecomKey, sendTestNotification } from '../../push.js';

function str(value, max = 200) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

/** 记录卡片主题色：'' 未设置 / white / avatar / 预设 id / #rrggbb（与前端 theme.js 保持一致） */
const CARD_THEME_PRESETS = new Set(['ocean', 'mint', 'peach', 'lavender', 'sakura']);

function normalizeCardTheme(value) {
  const v = str(value, 16).toLowerCase();
  if (!v || v === 'white' || v === 'avatar' || CARD_THEME_PRESETS.has(v)) return v;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  throw new HttpError(400, '主题色不合法', 'bad_theme');
}

/** 支持的推送通道 */
const PUSH_KINDS = new Set(['wecom', 'ntfy', 'bark', 'webhook']);

function pushKind(value) {
  const v = str(value, 16).toLowerCase();
  if (!v || v === 'none') return 'wecom';
  if (!PUSH_KINDS.has(v)) throw new HttpError(400, `不支持的通道：${v}`, 'bad_push_kind');
  return v;
}

/** 密钥永远不回完整值：只回"有没有配"和尾 4 位，免得泄露到前端/日志里 */
export function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  return s.length <= 4 ? '****' : `…${s.slice(-4)}`;
}

/** 把设置行转成给前端的形状（掩码） */
export function pushJson(row) {
  const channel = channelFromSettings(row);
  return {
    hasSettings: Boolean(row),
    configured: Boolean(channel),
    enabled: Boolean(row?.enabled),
    kind: row?.kind || 'wecom',
    hasSecret: Boolean(row?.secret),
    secretHint: maskSecret(row?.secret),
    url: row?.url || '',
    hasToken: Boolean(row?.token),
    excerpt: Number.isFinite(Number(row?.excerpt)) ? Number(row.excerpt) : 60,
    updatedAt: row?.updated_at || 0,
  };
}



export function registerUserRoutes(r) {
  r.patch('/api/me/profile', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const displayName = (body.displayName !== undefined ? str(body.displayName, 40) : user.display_name) || user.username;
    const bio = body.bio !== undefined ? str(body.bio, 200) : user.bio;

    const parseDate = (value, current, field) => {
      if (value === undefined) return current;
      const v = str(value, 10);
      if (!v) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new HttpError(400, `${field}格式需为 YYYY-MM-DD`, 'bad_date');
      }
      return v;
    };
    const birthday = parseDate(body.birthday, user.birthday, '生日');
    const celebrationDate = parseDate(body.celebrationDate, user.celebration_date, '纪念日');

    const timezone = body.timezone !== undefined ? normalizeTimezone(body.timezone, user.timezone) : user.timezone;
    ctx.store.stmt.updateUserProfile.run(
      displayName,
      bio,
      birthday,
      celebrationDate,
      user.avatar,
      timezone,
      Date.now(),
      user.id
    );
    ctx.send(200, { user: publicUser(ctx.store.stmt.userById.get(user.id)) });
  });

  r.patch('/api/me/settings', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const shareEnabled = body.shareEnabled === undefined ? user.share_enabled : body.shareEnabled ? 1 : 0;
    const showStats = body.showStats === undefined ? user.show_stats : body.showStats ? 1 : 0;
    const cardTheme =
      body.cardTheme === undefined ? user.card_theme || '' : normalizeCardTheme(body.cardTheme);
    ctx.store.stmt.updateUserShare.run(shareEnabled, showStats, cardTheme, Date.now(), user.id);
    ctx.send(200, { user: publicUser(ctx.store.stmt.userById.get(user.id)) });
  });

  r.get('/api/me/stats', async (ctx) => {
    const user = requireUser(ctx);
    ctx.send(200, { stats: ctx.store.stats(user.id) });
  });

  r.get('/api/me/export', async (ctx) => {
    const user = requireUser(ctx);
    const data = ctx.store.exportUser(user.id);
    const body = Buffer.from(JSON.stringify(data, null, 2));
    ctx.res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'content-disposition': `attachment; filename="daylog-${user.username}-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
    });
    ctx.res.end(body);
  });

  // ---------------------------------------------------------------- 手机通知

  /**
   * 收件箱（通知层）：未读概览 + 最近若干条。
   * agent 靠这个"看到人做了什么" —— 既能显式调用，也能从**任何** API 响应的
   * `notifications` 字段捎带看到（见 server.js 的 ctx.send）。
   */
  r.get('/api/me/notifications', async (ctx) => {
    const user = requireUser(ctx);
    const limit = Math.max(1, Math.min(100, Number(ctx.query.get('limit')) || 20));
    const unreadOnly = ctx.query.get('unread') === '1' || ctx.query.get('unread') === 'true';
    ctx.send(200, {
      unread: ctx.store.notificationSummary(user.id),
      items: ctx.store.listNotifications(user.id, { limit, unreadOnly }),
      serverTime: Date.now(),
    });
  });

  /** 标记已读：{ all: true } / { ids: [...] } / { upTo: <毫秒时间戳> } */
  r.post('/api/me/notifications/read', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json().catch(() => ({}));
    const changed = ctx.store.markNotificationsRead(user.id, {
      all: Boolean(body.all),
      ids: Array.isArray(body.ids) ? body.ids : null,
      upTo: body.upTo ?? null,
    });
    ctx.send(200, { ok: true, changed, unread: ctx.store.notificationSummary(user.id) });
  });

  r.get('/api/me/push', async (ctx) => {
    const user = requireUser(ctx);
    ctx.send(200, { push: pushJson(ctx.store.pushSettings(user.id)) });
  });

  r.patch('/api/me/push', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.json();
    const kind = body.kind === undefined ? undefined : pushKind(body.kind);
    // key 字段容忍"整条 Webhook 地址 / key=xxx / 裸 key"三种粘法，存进去前统一成裸 key
    const rawSecret = body.secret === undefined ? undefined : str(body.secret, 400);
    const secret = rawSecret === undefined ? undefined : (kind ?? pushKind(body.kind ?? 'wecom')) === 'wecom' ? normalizeWecomKey(rawSecret) : rawSecret;
    const patch = {
      ...(kind === undefined ? {} : { kind }),
      ...(secret === undefined ? {} : { secret }),
      ...(body.url === undefined ? {} : { url: str(body.url, 400) }),
      ...(body.token === undefined ? {} : { token: str(body.token, 400) }),
      ...(body.excerpt === undefined ? {} : { excerpt: Number(body.excerpt) }),
      ...(body.enabled === undefined ? {} : { enabled: Boolean(body.enabled) }),
      ...(body.clearSecret ? { clearSecret: true } : {}),
      ...(body.clearUrl ? { clearUrl: true } : {}),
      ...(body.clearToken ? { clearToken: true } : {}),
    };
    const row = ctx.store.setPushSettings(user.id, patch);
    // 配好了但没显式说开关 → 自动打开（少一步操作）
    const finalRow =
      patch.enabled === undefined && row && (row.secret || row.url) ? ctx.store.setPushSettings(user.id, { enabled: true }) : row;
    ctx.send(200, { push: pushJson(finalRow) });
  });

  r.post('/api/me/push/test', async (ctx) => {
    const user = requireUser(ctx);
    const result = await sendTestNotification({ store: ctx.store, user });
    if (result.ok) {
      ctx.send(200, { ok: true, status: result.status });
      return;
    }
    const messages = {
      not_configured: '还没配推送通道',
      no_fetch: '服务器不支持出站请求',
    };
    throw new HttpError(400, messages[result.error] || `发送失败：${result.error || `HTTP ${result.status}`}`, result.error || 'push_failed');
  });
}
