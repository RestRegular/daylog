import { config } from '../config.js';
import { HttpError, jsonBody } from './http.js';
import { parseContentType, parseMultipart } from '../lib/multipart.js';
import { StringDecoder } from 'node:string_decoder';
import {
  publicUrl,
  removeMediaFile,
  saveFromStream,
  TEMP_DIR,
} from '../media/files.js';

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    bio: user.bio || '',
    // 必须带版本号：头像地址否则不变，浏览器会把上一张头像按 24h 缓存钉住
    // （表现就是「换了头像、刷新后还是旧的 / 显示不出来」）
    avatarUrl: user.avatar ? `/u/${user.id}/avatar?v=${user.updated_at}` : null,
    // 记录卡片主题色（'' 未设置 / white / avatar / 预设 id / #rrggbb）
    cardTheme: user.card_theme || '',
    birthday: user.birthday || null,
    celebrationDate: user.celebration_date || null,
    timezone: user.timezone || config.timezone,
    // 注：不再下发永久 share_token —— 分享改成「每次生成一条限时链接」了
    showStats: !!user.show_stats,
    isAdmin: !!user.is_admin,
    createdAt: user.created_at,
  };
}

export function mediaJson(m) {
  return {
    id: m.id,
    kind: m.kind,
    mime: m.mime,
    name: m.original_name || '',
    bytes: m.bytes,
    width: m.width || null,
    height: m.height || null,
    duration: m.duration === null || m.duration === undefined ? null : m.duration,
    posterUrl: m.poster_ext ? `/m/${m.id}/poster` : null,
    url: publicUrl(m.id),
  };
}

export function postJson(row, viewer) {
  const isOwner = !!viewer && viewer.id === row.user_id;
  // 只有「这条记录确实是 viewer 自己发的」才允许用 viewer 兜底。
  // 以前不管作者是谁都拿 viewer 顶上——于是别人分享页里（帖子没带 author）自己的记录
  // 被显示成了访问者的头像和用户名。
  const authorRow =
    row.author ||
    (isOwner
      ? {
          id: viewer.id,
          username: viewer.username,
          displayName: viewer.display_name || viewer.username,
          realDisplayName: viewer.display_name || viewer.username,
          avatar: viewer.avatar,
          updatedAt: viewer.updated_at,
          cardTheme: viewer.card_theme || '',
        }
      : null);
  return {
    id: row.id,
    body: row.body || '',
    createdAt: row.created_at,
    // 「记录的事儿真正发生的时间」（编辑时可以改；排序 / 分组按它）
    occurredAt: row.occurred_at || row.created_at,
    updatedAt: row.updated_at,
    postDay: row.post_day || null,
    location: row.location || '',
    mood: row.mood || '',
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    visibility: row.visibility,
    isOwner,
    // 合并时间线（我 + 好友）时用来区分作者
    author: authorRow
      ? {
          id: authorRow.id,
          username: authorRow.username,
          // 显示名：我给 TA 起的备注名优先（attachAuthors 里已经算好了）
          displayName: authorRow.displayName || authorRow.username,
          // 真实昵称 + 备注名，客户端要在分享页里写成「昵称（备注）」
          realDisplayName: authorRow.realDisplayName || authorRow.display_name || authorRow.username,
          alias: authorRow.alias || '',
          // 带版本号，理由同 publicUser：否则换了头像这里一直是旧的
          avatarUrl: authorRow.avatar
            ? `/u/${authorRow.id}/avatar?v=${authorRow.updatedAt || authorRow.updated_at || ''}`
            : null,
          // 作者自己选的主题色；空表示没设置（别人看他时用头像取色）
          cardTheme: authorRow.cardTheme || authorRow.card_theme || '',
        }
      : null,
    media: (row.media || listMedia(row.id)).map(mediaJson),
  };
}

/** 解析 JSON 或 multipart 请求体 */
export async function readBody(req) {
  const { type, params } = parseContentType(req.headers['content-type']);
  if (type === 'multipart/form-data') {
    if (!params.boundary) throw new HttpError(400, '缺少 multipart boundary');
    return readMultipartBody(req, params.boundary);
  }
  return { fields: await jsonBody(req, { limit: 2 * 1024 * 1024 }), files: [] };
}

/**
 * multipart：普通字段收集到 fields，文件走磁盘临时区。
 * 字段名约定：
 *   - media        动态附件（图片 / 视频）
 *   - avatar       头像
 *   - poster       视频封面
 *   - 其他任意字段 -> fields[name]（同名多次出现则为数组）
 */
export async function readMultipartBody(req, boundary, { userId } = {}) {
  if (!userId) throw new HttpError(401, '上传需要登录');
  const fields = {};
  const files = [];
  const maxTotal = config.maxRequestBytes;

  let parser;
  parser = parseMultipart(req, {
    boundary,
    maxBytes: maxTotal,
    createHandler: (headers, part) => {
      const name = part.name;
      if (!name || (!part.isFile && name.startsWith('__'))) return null;

      if (part.isFile) {
        let saved = null;
        let tooLarge = false;
        return {
          write(chunk) {
            if (tooLarge) return;
            if (!saved) {
              const over = (part.contentType || '').startsWith('video/')
                ? config.maxVideoBytes
                : (part.contentType || '').startsWith('image/')
                  ? config.maxImageBytes
                  : config.maxTextFileBytes;
              saved = saveFromStream({
                userId,
                originalName: part.filename || 'file',
                mime: part.contentType || 'application/octet-stream',
                limit: over,
              });
              saved.state.onLimit = () => {
                tooLarge = true;
              };
            }
            saved.write(chunk);
          },
          end() {
            if (tooLarge) {
              saved?.abort();
              return;
            }
            if (!saved) {
              saved = saveFromStream({
                userId,
                originalName: part.filename || 'file',
                mime: part.contentType || 'application/octet-stream',
                limit: config.maxImageBytes,
              });
            }
            const done = saved.finish();
            files.push({
              field: name,
              tempId: done.tempId,
              tempPath: done.tempPath,
              originalName: part.filename || '',
              mime: done.mime,
              kind: done.kind,
              ext: done.ext,
              bytes: done.bytes,
              overflow: done.overflow,
            });
          },
          error() {
            saved?.abort();
          },
        };
      }

      // 普通字段：用 StringDecoder 正确处理跨分片的多字节 UTF-8 字符
      const decoder = new StringDecoder('utf8');
      const parts = [];
      let size = 0;
      return {
        write(chunk) {
          if (size > 512 * 1024) return;
          const text = decoder.write(chunk);
          parts.push(text);
          size += text.length;
        },
        end() {
          const tail = decoder.end();
          if (tail) parts.push(tail);
          const value = parts.join('');
          if (fields[name] === undefined) fields[name] = value;
          else if (Array.isArray(fields[name])) fields[name].push(value);
          else fields[name] = [fields[name], value];
        },
      };
    },
  });

  await parser.result;
  return { fields, files };
}

export function fieldText(fields, key, fallback = '') {
  const v = fields[key];
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return String(v[0]);
  return String(v);
}

export function fieldJson(fields, key) {
  const raw = fieldText(fields, key, '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function cleanupTempFiles(files) {
  for (const f of files) {
    try {
      await removeMediaFile(f.tempPath);
    } catch {
      /* 忽略 */
    }
  }
}

export { TEMP_DIR };
