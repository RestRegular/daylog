import { HttpError } from '../http.js';
import { requireUser } from '../authRoutes.js';
import { cleanupTempFiles, fieldJson, postJson, readMultipartBody } from '../shared.js';
import { parseContentType } from '../../lib/multipart.js';
import { config } from '../../config.js';
import {
  commitPoster,
  commitUpload,
  filePathFor,
  removeMediaFile,
} from '../../media/files.js';
import { dayKey, isValidDayKey, normalizeTimezone } from '../../lib/time.js';
import { anniversaryJson } from './anniversaries.js';
import { baseUrlFor, notifyNewPost } from '../../push.js';

const VISIBILITY = new Set(['public', 'link', 'private']);

function str(value, max = 200) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);
}

export function normalizeVisibility(value, fallback = 'public') {
  const v = String(value || '').toLowerCase();
  return VISIBILITY.has(v) ? v : fallback;
}

export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，\s#]+/);
  const out = [];
  for (const raw of list) {
    const t = str(raw, 24).replace(/^#/, '');
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out.join(',');
}

/** 时间戳合法性：不接受太远的未来或过远的过去 */
export function normalizeCreatedAt(value, fallback = Date.now()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const ms = n < 1e12 ? n * 1000 : n; // 兼容秒级时间戳
  const now = Date.now();
  if (ms > now + 6 * 3600 * 1000) throw new HttpError(400, '时间不能晚于现在太多', 'bad_time');
  if (ms < Date.UTC(2000, 0, 1)) throw new HttpError(400, '时间过早', 'bad_time');
  return Math.round(ms);
}

function normalizePostInput(source = {}) {
  return {
    body: str(source.body ?? source.text ?? '', 4000),
    location: str(source.location, 80),
    mood: str(source.mood, 32),
    tags: normalizeTags(source.tags),
    visibility: normalizeVisibility(source.visibility),
  };
}

/**
 * 落库上传文件，并按顺序把封面挂到视频上。
 * metas[i] 对应 uploads[i]：{ width, height, duration }
 */
async function finalizeMedia(store, uploads, posterFiles, userId, postId, metas = []) {
  // 注意 Number(null) === 0：读不出信息的视频（没有时长 / 尺寸）不能被写成 0，
  // 否则数据里分不清「0 秒」和「不知道多久」
  const num = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const created = [];
  for (let i = 0; i < uploads.length; i += 1) {
    const meta = metas[i] || {};
    const row = await commitUpload(uploads[i], {
      userId,
      postId,
      extra: {
        width: num(meta.width),
        height: num(meta.height),
        duration: num(meta.duration),
      },
    });
    created.push(store.createMedia(row));
  }
  const videos = created.filter((m) => m.kind === 'video');
  for (let i = 0; i < posterFiles.length && i < videos.length; i += 1) {
    const ext = await commitPoster(posterFiles[i], videos[i]);
    if (ext) store.setPoster(videos[i].id, ext);
  }
  return created;
}

async function multipartBody(ctx, userId) {
  const { params } = parseContentType(ctx.req.headers['content-type']);
  if (!params.boundary) throw new HttpError(400, '缺少 multipart boundary');
  return readMultipartBody(ctx.req, params.boundary, { userId });
}

export function registerPostRoutes(r) {
  // 输入候选：我最近用过的地点 / 标签 / 心情（编辑记录时可直接点选）
  r.get('/api/suggestions', async (ctx) => {
    const user = requireUser(ctx);
    ctx.send(200, { suggestions: ctx.store.recentMeta(user.id) });
  });

  /**
   * 时间线。scope：
   *   mine    —— 只看自己的（含 private）  ← 默认，兼容旧行为
   *   friends —— 只看好友的（public/link）
   *   all     —— 我 + 好友，按时间合并，带作者信息
   *   only    —— 只按作者过滤（配合 author 参数，用于"点开某个好友"）
   */
  r.get('/api/posts', async (ctx) => {
    const user = requireUser(ctx);
    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 20, 1), 100);
    const scope = String(ctx.query.get('scope') || 'mine').toLowerCase();
    const friendIds = ctx.store.friendIds(user.id);
    const onlyAuthor = String(ctx.query.get('author') || '').trim();

    let authorIds;
    let includePrivate;
    let withAuthor = false;
    let resolvedScope = scope;

    if (scope === 'friends') {
      authorIds = friendIds;
      includePrivate = false;
      withAuthor = true;
    } else if (scope === 'all') {
      authorIds = [user.id, ...friendIds];
      includePrivate = false; // 合并视图里不显示自己的 private，避免混淆
      withAuthor = true;
    } else if (scope === 'only' && onlyAuthor) {
      if (onlyAuthor !== user.id && !friendIds.includes(onlyAuthor)) {
        throw new HttpError(403, '你们还不是好友', 'not_friend');
      }
      authorIds = [onlyAuthor];
      includePrivate = onlyAuthor === user.id;
      withAuthor = true;
      resolvedScope = 'only';
    } else {
      authorIds = [user.id];
      includePrivate = true;
      resolvedScope = 'mine';
    }

    const rows = authorIds.length
      ? ctx.store.queryPosts({
          authorIds,
          includePrivate,
          withAuthor,
          // 传给作者信息用：好友的显示名用「我给他起的备注名」
          viewerId: user.id,
          from: ctx.query.get('from') || null,
          to: ctx.query.get('to') || null,
          q: str(ctx.query.get('q'), 80),
          tag: str(ctx.query.get('tag'), 24),
          limit: limit + 1,
          cursor: ctx.query.get('cursor') || null,
        })
      : [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // 前端好友筛选条：只按某个人筛选
    const friendId = String(ctx.query.get('friendId') || '').trim();
    if (friendId && friendId !== user.id && !friendIds.includes(friendId)) {
      throw new HttpError(403, '你们还不是好友', 'not_friend');
    }

    // 各作者在当前日期/筛选下的条数（用于筛选条显示条数、以及"某人今天没记录"的判断）
    const countRows = ctx.store.queryPosts({
      authorIds: [user.id, ...friendIds],
      includePrivate: true,
      from: ctx.query.get('from') || null,
      to: ctx.query.get('to') || null,
      q: str(ctx.query.get('q'), 80),
      tag: str(ctx.query.get('tag'), 24),
      limit: 500,
    });
    const counts = {};
    for (const row of countRows) counts[row.user_id] = (counts[row.user_id] || 0) + 1;

    const finalPosts = friendId ? page.filter((p) => p.user_id === friendId) : page;

    ctx.send(200, {
      scope: resolvedScope,
      friendId: friendId || null,
      friendCount: friendIds.length,
      counts,
      posts: ctx.store.postsWithMedia(finalPosts).map((p) => postJson(p, user)),
      nextCursor: hasMore && finalPosts.length ? finalPosts[finalPosts.length - 1].id : null,
      hasMore,
    });
  });

  // 新建动态（JSON 或 multipart）
  r.post('/api/posts', async (ctx) => {
    const user = requireUser(ctx);
    const contentType = String(ctx.req.headers['content-type'] || '');
    let body = {};
    let files = [];

    if (contentType.startsWith('multipart/form-data')) {
      const parsed = await multipartBody(ctx, user.id);
      body = fieldJson(parsed.fields, 'post');
      files = parsed.files;
    } else {
      body = await ctx.json();
    }

    const uploads = files.filter((f) => f.field === 'media');
    const posterFiles = files.filter((f) => f.field === 'poster');
    const input = normalizePostInput(body);
    const createdAt = normalizeCreatedAt(body.createdAt);

    if (!input.body && files.length === 0) {
      await cleanupTempFiles(files);
      throw new HttpError(400, '内容不能为空', 'empty');
    }
    if (uploads.length > config.maxFilesPerPost) {
      await cleanupTempFiles(files);
      throw new HttpError(400, `最多上传 ${config.maxFilesPerPost} 个附件`, 'too_many_files');
    }
    const oversized = files.find((f) => f.overflow);
    if (oversized) {
      const limitMb = Math.round(
        (oversized.kind === 'video' ? config.maxVideoBytes : config.maxImageBytes) / 1024 / 1024
      );
      await cleanupTempFiles(files);
      throw new HttpError(
        413,
        `${oversized.kind === 'video' ? '视频' : '图片'}超过 ${limitMb}MB 限制，请压缩后再上传`,
        'file_too_large',
        { name: oversized.originalName, limitMb }
      );
    }

    const tz = normalizeTimezone(body.timezone || ctx.timezone);
    // occurredAt = 「这件事真正发生的时间」（可以不填，默认就是现在）
    const occurredAt = normalizeCreatedAt(body.occurredAt ?? body.createdAt);
    const postDay = isValidDayKey(body.postDay) ? body.postDay : dayKey(occurredAt, tz);
    let post = null;
    try {
      post = ctx.store.createPost({
        userId: user.id,
        body: input.body,
        createdAt,
        occurredAt,
        postDay,
        location: input.location,
        mood: input.mood,
        tags: input.tags,
        visibility: input.visibility,
      });
      await finalizeMedia(ctx.store, uploads, posterFiles, user.id, post.id, body.mediaMeta || []);
    } catch (err) {
      if (post) {
        for (const m of ctx.store.mediaOfPost(post.id)) {
          const row = ctx.store.deleteMedia(m.id);
          if (row) await removeMediaFile(filePathFor(row));
        }
        ctx.store.deletePost(post.id, user.id);
      }
      await cleanupTempFiles(files);
      throw err;
    }
    const fresh = ctx.store.postsWithMedia([ctx.store.stmt.postById.get(post.id)])[0];
    ctx.send(201, { post: postJson(fresh, user) });
    // 出站通知：好友发了新记录 → 推到手机上（没配通道/没好友就自动跳过）
    // 注意：**必须在 send 之后**，而且它自己吞异常，绝不能拖慢或影响发帖
    void notifyNewPost({
      store: ctx.store,
      author: user,
      post: fresh,
      dayKey: postDay,
      baseUrl: baseUrlFor(ctx),
    }).catch(() => {});
  });

  r.get('/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.store.stmt.postById.get(ctx.params.id);
    if (!row || row.deleted_at || row.user_id !== user.id) {
      throw new HttpError(404, '动态不存在', 'not_found');
    }
    const fresh = ctx.store.postsWithMedia([row])[0];
    ctx.send(200, { post: postJson(fresh, user) });
  });

  r.patch('/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx);
    const existing = ctx.store.stmt.postByIdForUser.get(ctx.params.id, user.id);
    if (!existing || existing.deleted_at) throw new HttpError(404, '动态不存在', 'not_found');

    // 支持两种请求体：JSON（只改文字/元信息）或 multipart（同时追加图片/视频）
    const contentType = String(ctx.req.headers['content-type'] || '');
    let body = {};
    let extraFiles = [];
    if (contentType.startsWith('multipart/form-data')) {
      const parsed = await multipartBody(ctx, user.id);
      body = fieldJson(parsed.fields, 'post');
      extraFiles = parsed.files;
      const oversized = extraFiles.find((f) => f.overflow);
      if (oversized) {
        await cleanupTempFiles(extraFiles);
        throw new HttpError(413, '文件超过大小限制', 'file_too_large', { name: oversized.originalName });
      }
    } else {
      body = await ctx.json();
    }

    const patch = {};
    if (body.body !== undefined || body.text !== undefined) patch.body = str(body.body ?? body.text, 4000);
    if (body.location !== undefined) patch.location = str(body.location, 80);
    if (body.mood !== undefined) patch.mood = str(body.mood, 32);
    if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
    if (body.visibility !== undefined) {
      patch.visibility = normalizeVisibility(body.visibility, existing.visibility);
    }
    // 编辑时改的是「事情发生的时间」occurredAt；发布时间 created_at 固定不动
    if (body.occurredAt !== undefined || body.createdAt !== undefined) {
      const next = body.occurredAt !== undefined ? body.occurredAt : body.createdAt;
      patch.occurredAt = normalizeCreatedAt(next, existing.occurred_at || existing.created_at);
      const tz = normalizeTimezone(body.timezone || ctx.timezone);
      patch.postDay = isValidDayKey(body.postDay) ? body.postDay : dayKey(patch.occurredAt, tz);
    }
    // ① 先删掉用户移除的附件（放在上限校验之前，删了再传就不会被总数卡住）
    const removeIds = Array.isArray(body.removeMediaIds) ? body.removeMediaIds.map(String).slice(0, 64) : [];
    if (removeIds.length) {
      const mine = new Map(ctx.store.mediaOfPost(existing.id).map((m) => [m.id, m]));
      for (const mediaId of removeIds) {
        if (!mine.has(mediaId)) continue; // 不属于这条记录的直接忽略
        const deleted = ctx.store.deleteMedia(mediaId);
        if (deleted) await removeMediaFile(filePathFor(deleted));
      }
    }

    if (Array.isArray(body.mediaIds) && body.mediaIds.length) {
      ctx.store.attachMedia(existing.id, body.mediaIds.slice(0, config.maxFilesPerPost), user.id);
    }

    // multipart 追加的附件：直接挂到这条动态上（含视频封面）
    let created = [];
    if (extraFiles.length) {
      const uploads = extraFiles.filter((f) => f.field === 'media');
      const posterFiles = extraFiles.filter((f) => f.field === 'poster');
      const current = ctx.store.mediaOfPost(existing.id).length;
      if (current + uploads.length > config.maxFilesPerPost) {
        await cleanupTempFiles(extraFiles);
        throw new HttpError(400, `最多 ${config.maxFilesPerPost} 个附件`, 'too_many_files');
      }
      try {
        created = await finalizeMedia(ctx.store, uploads, posterFiles, user.id, existing.id, body.mediaMeta || []);
      } catch (err) {
        await cleanupTempFiles(extraFiles);
        throw err;
      }
    }

    // ② 附件顺序：mediaOrder 里可以混「已有的附件 id」和「new:0 / new:1…」（对应本次上传的文件）
    if (Array.isArray(body.mediaOrder)) {
      const resolved = [];
      for (const token of body.mediaOrder.slice(0, 64)) {
        const value = String(token);
        if (value.startsWith('new:')) {
          const item = created[Number(value.slice(4))];
          if (item) resolved.push(item.id);
        } else if (value) {
          resolved.push(value);
        }
      }
      // 没在 mediaOrder 里出现的附件按原顺序补在后面，避免客户端漏传就乱序
      const seen = new Set(resolved);
      for (const m of ctx.store.mediaOfPost(existing.id)) {
        if (!seen.has(m.id)) resolved.push(m.id);
      }
      ctx.store.setMediaOrder(existing.id, resolved);
    }

    const updated = ctx.store.updatePost(existing.id, user.id, patch);
    const fresh = ctx.store.postsWithMedia([updated])[0];
    ctx.send(200, { post: postJson(fresh, user) });
  });

  r.delete('/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx);
    const row = ctx.store.stmt.postByIdForUser.get(ctx.params.id, user.id);
    if (!row) throw new HttpError(404, '动态不存在', 'not_found');
    const media = ctx.store.mediaOfPost(row.id);
    ctx.store.deletePost(row.id, user.id);
    for (const m of media) {
      const deleted = ctx.store.deleteMedia(m.id);
      if (deleted) await removeMediaFile(filePathFor(deleted));
    }
    ctx.send(200, { ok: true, removedMedia: media.length });
  });

  // 日历：某月每天的动态条数
  r.get('/api/calendar', async (ctx) => {
    const user = requireUser(ctx);
    const monthParam = ctx.query.get('month') || '';
    const month = /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam
      : dayKey(Date.now(), ctx.timezone).slice(0, 7);
    const rows = ctx.store.db
      .prepare(
        `SELECT COALESCE(post_day, '') AS day_key, COUNT(*) AS c FROM posts
         WHERE user_id = ? AND deleted_at IS NULL AND COALESCE(post_day, '') LIKE ?
         GROUP BY day_key`
      )
      .all(user.id, `${month}%`);

    // 纪念日落在本月哪几天（只比月日，忽略年份）
    const all = ctx.store.listAnniversaries(user.id).map((row) => anniversaryJson(row, new Date(), ctx));
    const inMonth = all.filter((a) => a.next && a.next.month === Number(month.slice(5, 7)));
    const marks = {};
    for (const a of inMonth) {
      const key = `${month}-${String(a.next.day).padStart(2, '0')}`;
      (marks[key] ||= []).push({ id: a.id, name: a.name, icon: a.icon, special: a.special, friendId: a.friendId });
    }

    ctx.send(200, {
      month,
      days: rows.filter((row) => row.day_key),
      anniversaries: inMonth.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        special: a.special,
        isBirthday: a.isBirthday,
        date: a.date,
        friendId: a.friendId,
        friend: a.friend,
        days: a.next.days,
      })),
      marks,
    });
  });
}
