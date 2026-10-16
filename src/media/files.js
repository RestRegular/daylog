import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { makeId } from '../lib/crypto.js';
import { HttpError } from '../http/http.js';

const EXT_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heic',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/3gpp': '.3gp',
  'video/mpeg': '.mpg',
  'video/x-m4v': '.m4v',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
};

export const TEMP_DIR = () => path.join(config.uploadDir, 'tmp');

export function ensureUploadDirs() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.mkdirSync(TEMP_DIR(), { recursive: true });
}

export function kindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

export function normalizeMime(mime, filename) {
  let m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!m || m === 'application/octet-stream' || m === 'application/x-unknown') {
    const ext = path.extname(String(filename || '')).toLowerCase();
    const guess = Object.entries(EXT_FOR_MIME).find(([, e]) => e === ext);
    if (guess) m = guess[0];
  }
  if (m === 'image/jpg') m = 'image/jpeg';
  return m;
}

export function extensionFor(mime, filename) {
  const m = normalizeMime(mime, filename);
  if (EXT_FOR_MIME[m]) return EXT_FOR_MIME[m];
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
  return '.bin';
}

export function isAllowedMime(mime, filename) {
  const m = normalizeMime(mime, filename);
  return Boolean(EXT_FOR_MIME[m]);
}

export function publicUrl(mediaId) {
  return `/m/${mediaId}`;
}

export function filePathFor(media) {
  return path.join(config.uploadDir, `${media.id}${media.ext}`);
}

export function posterPathFor(media) {
  if (!media.poster_ext) return null;
  return path.join(config.uploadDir, `${media.id}-poster${media.poster_ext}`);
}

/** 先写入临时文件，确认无误后再移入正式目录 */
export class MediaUpload {
  constructor({ userId, originalName = '', mime = 'application/octet-stream', limit = config.maxTextFileBytes }) {
    ensureUploadDirs();
    this.tempId = makeId('t', 8);
    this.tempPath = path.join(TEMP_DIR(), `${this.tempId}.part`);
    this.userId = userId;
    this.originalName = originalName;
    this.mime = normalizeMime(mime, originalName);
    this.limit = limit;
    this.bytes = 0;
    this.overflow = false;
    this.done = false;
    this.aborted = false;
    this.stream = fs.createWriteStream(this.tempPath, { flags: 'w' });
    this.stream.on('error', () => {
      this.overflow = true;
    });
  }

  write(chunk) {
    if (this.done || this.aborted || this.overflow) return;
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.overflow = true;
      this.stream.end();
      return;
    }
    this.stream.write(chunk);
  }

  finish() {
    if (this.done) return this.summary();
    this.done = true;
    try {
      this.stream.end();
    } catch {
      /* 忽略 */
    }
    return this.summary();
  }

  summary() {
    return {
      tempId: this.tempId,
      tempPath: this.tempPath,
      originalName: this.originalName,
      mime: this.mime,
      kind: kindFromMime(this.mime),
      ext: extensionFor(this.mime, this.originalName),
      bytes: this.bytes,
      overflow: this.overflow,
    };
  }

  abort() {
    this.aborted = true;
    try {
      this.stream.destroy();
    } catch {
      /* 忽略 */
    }
    removeMediaFile(this.tempPath).catch(() => {});
  }
}

export function saveFromStream({ userId, originalName, mime, limit }) {
  const upload = new MediaUpload({ userId, originalName, mime, limit });
  return {
    state: upload,
    write: (chunk) => upload.write(chunk),
    finish: () => upload.finish(),
    abort: () => upload.abort(),
  };
}

export async function removeMediaFile(p) {
  if (!p) return;
  try {
    await fsp.rm(p, { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 把临时文件搬到正式位置并返回媒体记录数据（不含 post_id） */
export async function commitUpload(upload, { userId, postId = null, extra = {} }) {
  if (upload.overflow) {
    await removeMediaFile(upload.tempPath);
    throw new HttpError(413, '文件超过大小限制');
  }
  if (!isAllowedMime(upload.mime, upload.originalName)) {
    await removeMediaFile(upload.tempPath);
    throw new HttpError(415, `不支持的文件类型：${upload.mime || upload.originalName}`);
  }
  const id = makeId('m', 10);
  const ext = extensionFor(upload.mime, upload.originalName);
  const dest = path.join(config.uploadDir, `${id}${ext}`);
  try {
    await fsp.rename(upload.tempPath, dest);
  } catch {
    await fsp.copyFile(upload.tempPath, dest);
    await removeMediaFile(upload.tempPath);
  }
  return {
    id,
    postId,
    userId,
    kind: kindFromMime(upload.mime),
    mime: upload.mime,
    ext,
    bytes: upload.bytes,
    width: extra.width ?? null,
    height: extra.height ?? null,
    duration: extra.duration ?? null,
    posterExt: null,
    originalName: upload.originalName || '',
    createdAt: Date.now(),
  };
}

/** 把视频封面（客户端截帧）写到 <mediaId>-poster<ext> */
export async function commitPoster(upload, media) {
  if (upload.overflow) {
    await removeMediaFile(upload.tempPath);
    return null;
  }
  const ext = extensionFor(upload.mime, upload.originalName || 'poster.jpg');
  const dest = path.join(config.uploadDir, `${media.id}-poster${ext}`);
  try {
    await fsp.rename(upload.tempPath, dest);
  } catch {
    await fsp.copyFile(upload.tempPath, dest);
    await removeMediaFile(upload.tempPath);
  }
  return ext;
}

/** 清理孤儿临时文件（超过 6 小时的上传残片） */
export function cleanupStaleTemp(maxAgeMs = 6 * 3600 * 1000) {
  const dir = TEMP_DIR();
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      /* 忽略 */
    }
  }
  return removed;
}
