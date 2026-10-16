import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError, sendFile } from '../http.js';
import { requireUser } from '../authRoutes.js';
import { cleanupTempFiles, fieldJson, mediaJson, publicUser, readMultipartBody } from '../shared.js';
import { parseContentType } from '../../lib/multipart.js';
import {
  commitPoster,
  commitUpload,
  filePathFor,
  posterPathFor,
  removeMediaFile,
} from '../../media/files.js';
import { config } from '../../config.js';

function canViewMedia(ctx, media) {
  if (ctx.user && ctx.user.id === media.user_id) return true;
  if (!media.post_id) return Boolean(ctx.user && ctx.user.id === media.user_id);
  const post = ctx.store.stmt.postById.get(media.post_id);
  if (!post || post.deleted_at) return false;
  if (post.visibility === 'private') return Boolean(ctx.user && ctx.user.id === post.user_id);
  return true;
}

function serveMedia(ctx, media, { poster = false } = {}) {
  const user = ctx.store.stmt.userById.get(media.user_id);
  let allow = canViewMedia(ctx, media);
  // 分享链接令牌同样可以访问对应作者的附件
  if (!allow && user?.share_enabled) {
    const token = ctx.query.get('t') || ctx.query.get('token');
    if (token && token === user.share_token) allow = true;
  }
  if (!allow) throw new HttpError(403, '无权访问该文件', 'forbidden');
  const file = poster ? posterPathFor(media) : filePathFor(media);
  if (!file) throw new HttpError(404, '封面不存在', 'not_found');
  // 附件 id 是一次性的，内容永不改变 → 可以长期缓存；配合 Range 支持，
  // 同一个视频再看就是秒开，不用重新走一遍网络（手机流量 / WiFi 都省）
  sendFile(ctx.req, ctx.res, file, {
    cache: 'public, max-age=31536000, immutable',
    contentType: poster ? undefined : media.mime,
  });
}

export function registerMediaRoutes(r) {
  r.get('/m/:id', async (ctx) => {
    const media = ctx.store.stmt.mediaById.get(ctx.params.id);
    if (!media) throw new HttpError(404, '文件不存在', 'not_found');
    serveMedia(ctx, media);
  });

  r.get('/m/:id/poster', async (ctx) => {
    const media = ctx.store.stmt.mediaById.get(ctx.params.id);
    if (!media) throw new HttpError(404, '文件不存在', 'not_found');
    serveMedia(ctx, media, { poster: true });
  });

  r.get('/u/:id/avatar', async (ctx) => {
    const user = ctx.store.stmt.userById.get(ctx.params.id);
    if (!user || !user.avatar) throw new HttpError(404, '头像不存在', 'not_found');
    const ext = path.extname(user.avatar) || '.jpg';
    const file = path.join(config.uploadDir, user.avatar.replace(/^\//, ''));
    // 带 ?v= 的地址可以长期缓存（换头像时 URL 会变）；
    // 不带版本的老地址必须每次校验，否则会被浏览器缓存住、换了头像也不更新
    const versioned = ctx.query.get('v');
    sendFile(ctx.req, ctx.res, file, {
      cache: versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
      contentType: undefined,
    });
  });

  // 一次性上传（先传后发）：供「先预览再发布」的交互使用
  r.post('/api/uploads', async (ctx) => {
    const user = requireUser(ctx);
    const { params } = parseContentType(ctx.req.headers['content-type']);
    if (!params.boundary) throw new HttpError(400, '缺少 multipart boundary');
    const parsed = await readMultipartBody(ctx.req, params.boundary, { userId: user.id });
    const meta = fieldJson(parsed.fields, 'meta');
    const oversized = parsed.files.find((f) => f.overflow);
    if (oversized) {
      await cleanupTempFiles(parsed.files);
      throw new HttpError(413, '文件超过大小限制', 'file_too_large', { name: oversized.originalName });
    }
    const created = [];
    let posterExt = null;
    try {
      for (let i = 0; i < parsed.files.length; i += 1) {
        const f = parsed.files[i];
        if (f.field === 'poster') {
          if (created[0]) {
            posterExt = await commitPoster(f, created[0]);
            if (posterExt) ctx.store.setPoster(created[0].id, posterExt);
          }
          continue;
        }
        const m = meta[i] || meta[f.field] || {};
        const row = await commitUpload(f, {
          userId: user.id,
          extra: {
            width: Number.isFinite(Number(m.width)) ? Number(m.width) : null,
            height: Number.isFinite(Number(m.height)) ? Number(m.height) : null,
            duration: Number.isFinite(Number(m.duration)) ? Number(m.duration) : null,
          },
        });
        created.push(ctx.store.createMedia(row));
      }
    } catch (err) {
      await cleanupTempFiles(parsed.files);
      throw err;
    }
    ctx.send(201, { media: created.map(mediaJson) });
  });

  // 删除一个「还没挂到动态上」的附件
  r.delete('/api/media/:id', async (ctx) => {
    const user = requireUser(ctx);
    const media = ctx.store.stmt.mediaById.get(ctx.params.id);
    if (!media || media.user_id !== user.id) throw new HttpError(404, '文件不存在', 'not_found');
    if (media.post_id) throw new HttpError(400, '请通过删除动态来移除已发布的附件', 'attached');
    const row = ctx.store.deleteMedia(media.id);
    if (row) await removeMediaFile(filePathFor(row));
    ctx.send(200, { ok: true });
  });

  // 头像上传（单独接口，避免和动态附件混淆）
  r.post('/api/uploads/avatar', async (ctx) => {
    const user = requireUser(ctx);
    const { params } = parseContentType(ctx.req.headers['content-type']);
    if (!params.boundary) throw new HttpError(400, '缺少 multipart boundary');
    const parsed = await readMultipartBody(ctx.req, params.boundary, { userId: user.id });
    const file = parsed.files.find((f) => f.field === 'avatar' || f.field === 'file');
    if (!file || file.overflow) {
      await cleanupTempFiles(parsed.files);
      throw new HttpError(413, '头像文件无效或过大', 'bad_avatar');
    }
    if (file.kind !== 'image') {
      await cleanupTempFiles(parsed.files);
      throw new HttpError(415, '头像必须是图片', 'bad_avatar');
    }
    const stored = await commitUpload(file, { userId: user.id });
    // 头像单独存放，避免出现在动态附件表里
    const ext = stored.ext;
    const destName = `avatar-${user.id}-${stored.id}${ext}`;
    await fsp.rename(
      path.join(config.uploadDir, `${stored.id}${ext}`),
      path.join(config.uploadDir, destName)
    );
    ctx.store.db
      .prepare('UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?')
      .run(destName, Date.now(), user.id);
    const fresh = ctx.store.stmt.userById.get(user.id);
    ctx.send(200, { user: publicUser(fresh), avatarUrl: `/u/${user.id}/avatar?v=${Date.now()}` });
  });
}
