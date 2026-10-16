import { HttpError } from '../http.js';
import { requireUser } from '../authRoutes.js';

/** 与前端 public/js/celebration.js 保持一致的计算（服务端用于列表与日历标注） */
export function nextOccurrence(dateStr, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const startYear = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!month || !day || month > 12 || day > 31) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const build = (year) => {
    const lastDay = new Date(year, month, 0).getDate();
    return new Date(year, month - 1, Math.min(day, lastDay));
  };
  let target = build(today.getFullYear());
  if (target < today) target = build(today.getFullYear() + 1);
  const days = Math.round((target - today) / 86400000);
  const elapsed = target.getFullYear() - startYear;
  return {
    days,
    month,
    day,
    year: target.getFullYear(),
    isToday: days === 0,
    age: elapsed > 0 && elapsed < 200 ? elapsed : null,
  };
}

function validateDate(value) {
  const v = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new HttpError(400, '日期格式需为 YYYY-MM-DD', 'bad_date');
  }
  const [, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new HttpError(400, '日期不合法', 'bad_date');
  return v;
}

/** 说明最多 20 个字（与前端 public/js/anniversaries.js 的 NOTE_MAX 保持一致） */
export const NOTE_MAX = 20;

/** 按码点截断（不会把 emoji 切成两半） */
function clip(value, max) {
  const chars = [...String(value ?? '').trim()];
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

const EMOJI_RE = /(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

/**
 * 图标**只收一个表情**（纯文字一律不认，和前端 normalizeIcon 一致）。
 * 按字素取第一个表情：👨‍👩‍👧、🇨🇳、❤️ 这类多码点 emoji 不会被切坏。
 */
export function sanitizeIcon(value, fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  let segments;
  try {
    segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw)].map((s) => s.segment);
  } catch {
    segments = [...raw];
  }
  return segments.find((g) => EMOJI_RE.test(g)) || fallback;
}

/** 关联好友的公开信息（只给头像和名字，够前端显示即可） */
function friendBrief(ctx, friendId) {
  if (!friendId) return null;
  const u = ctx.store.stmt.userById.get(friendId);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    avatarUrl: u.avatar ? `/u/${u.id}/avatar?v=${u.updated_at}` : null,
  };
}

export function anniversaryJson(row, now = new Date(), ctx = null) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    date: row.date,
    note: row.note || '',
    special: !!row.special,
    kind: row.kind,
    isBirthday: row.kind === 'birthday',
    friendId: row.friend_id || null,
    friend: ctx ? friendBrief(ctx, row.friend_id) : null,
    next: nextOccurrence(row.date, now),
  };
}

/**
 * 校验并归一化关联好友：必须是自己的好友（不强制关联，传空即解除）。
 */
function normalizeFriendId(ctx, me, value) {
  if (value === undefined) return undefined;
  const id = value === null || value === '' ? null : String(value);
  if (!id) return null;
  if (id === me.id) throw new HttpError(400, '不能关联自己', 'bad_friend');
  if (!ctx.store.friendIds(me.id).includes(id)) {
    throw new HttpError(400, '只能关联已经成为好友的人', 'not_friend');
  }
  return id;
}

export function registerAnniversaryRoutes(r) {
  r.get('/api/anniversaries', async (ctx) => {
    const me = requireUser(ctx);
    const rows = ctx.store.listAnniversaries(me.id);
    ctx.send(200, { anniversaries: rows.map((row) => anniversaryJson(row, new Date(), ctx)) });
  });

  /** 某个好友关联到的纪念日（首页按好友筛选时用） */
  r.get('/api/anniversaries/of/:friendId', async (ctx) => {
    const me = requireUser(ctx);
    const friendId = String(ctx.params.friendId);
    if (friendId !== me.id && !ctx.store.friendIds(me.id).includes(friendId)) {
      throw new HttpError(403, '你们还不是好友', 'not_friend');
    }
    const rows = ctx.store.listAnniversariesOfFriend(me.id, friendId);
    ctx.send(200, { friendId, anniversaries: rows.map((row) => anniversaryJson(row, new Date(), ctx)) });
  });

  r.post('/api/anniversaries', async (ctx) => {
    const me = requireUser(ctx);
    const body = await ctx.json();
    const name = clip(body.name, 24);
    if (!name) throw new HttpError(400, '请填写名称', 'bad_name');
    const date = validateDate(body.date);
    const isBirthday = body.kind === 'birthday';
    const friendId = normalizeFriendId(ctx, me, body.friendId);
    const result = ctx.store.createAnniversary(me.id, {
      name,
      icon: sanitizeIcon(body.icon, isBirthday ? '🎂' : '🎉'),
      date,
      note: clip(body.note, NOTE_MAX),
      // 生日自动"特别关注"，且全局只有一条生日
      special: isBirthday ? true : !!body.special,
      kind: isBirthday ? 'birthday' : 'custom',
      friendId: friendId || null,
    });
    if (!result.ok) {
      throw new HttpError(409, '只能设置一个生日', result.reason);
    }
    ctx.send(201, { anniversary: anniversaryJson(result.row, new Date(), ctx) });
  });

  r.patch('/api/anniversaries/:id', async (ctx) => {
    const me = requireUser(ctx);
    const body = await ctx.json();
    const patch = {};
    if (body.name !== undefined) {
      const name = clip(body.name, 24);
      if (!name) throw new HttpError(400, '请填写名称', 'bad_name');
      patch.name = name;
    }
    if (body.icon !== undefined) {
      // 传了但不是一个表情（纯文字）→ 保持原图标不动
      const icon = sanitizeIcon(body.icon);
      if (icon) patch.icon = icon;
    }
    if (body.date !== undefined) patch.date = validateDate(body.date);
    if (body.note !== undefined) patch.note = clip(body.note, NOTE_MAX);
    if (body.friendId !== undefined) patch.friendId = normalizeFriendId(ctx, me, body.friendId);
    if (body.special !== undefined) {
      const existing = ctx.store.getAnniversary(ctx.params.id, me.id);
      if (!existing) throw new HttpError(404, '纪念日不存在', 'not_found');
      // 生日永远是特别关注，不允许取消
      patch.special = existing.kind === 'birthday' ? true : !!body.special;
    }
    const result = ctx.store.updateAnniversary(ctx.params.id, me.id, patch);
    if (!result.ok) throw new HttpError(404, '纪念日不存在', 'not_found');
    ctx.send(200, { anniversary: anniversaryJson(result.row, new Date(), ctx) });
  });

  r.delete('/api/anniversaries/:id', async (ctx) => {
    const me = requireUser(ctx);
    const ok = ctx.store.deleteAnniversary(ctx.params.id, me.id);
    if (!ok) throw new HttpError(404, '纪念日不存在', 'not_found');
    ctx.send(200, { ok: true });
  });
}
