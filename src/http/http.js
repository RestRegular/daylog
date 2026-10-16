import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { parseContentType } from '../lib/multipart.js';

export class HttpError extends Error {
  constructor(status, message, code = 'error', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

export function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

export function jsonBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const type = parseContentType(req.headers['content-type']).type;
    if (!['application/json', 'text/json', ''].includes(type)) {
      reject(new HttpError(415, '请求需要 JSON 格式'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : { value: parsed });
      } catch {
        reject(new HttpError(400, 'JSON 解析失败'));
      }
    });
  });
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text));
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

export function sendHtml(res, status, html, headers = {}) {
  const body = Buffer.from(String(html));
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

/** 支持 Range 的静态文件响应（视频拖动进度条必需） */
export function sendFile(req, res, filePath, { download = false, cache = 'public, max-age=604800', contentType } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: '文件不存在', code: 'not_found' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: '文件不存在', code: 'not_found' });
    return;
  }
  const total = stat.size;
  const type = contentType || MIME[extOf(filePath)] || 'application/octet-stream';
  const lastModified = stat.mtime.toUTCString();
  const baseHeaders = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache,
    'last-modified': lastModified,
  };
  if (download) {
    baseHeaders['content-disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`;
  }
  // 条件请求：文件没改过就回 304。
  // 头像等用 `no-cache` 的地址每次都要校验，有了它就不必重新下载整张图。
  if (!download && !req.headers.range && req.headers['if-modified-since']) {
    const since = Date.parse(String(req.headers['if-modified-since']));
    if (Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
      res.writeHead(304, { 'cache-control': cache, 'last-modified': lastModified });
      res.end();
      return;
    }
  }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end !== null) {
        start = Math.max(0, total - end);
        end = total - 1;
      }
      if (start === null) start = 0;
      if (end === null || end >= total) end = total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': end - start + 1,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...baseHeaders, 'content-length': total });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

export function isSecureRequest(req) {
  if (config.trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto) return String(proto).split(',')[0].trim() === 'https';
  }
  return false;
}

export function publicBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;
  const scheme = isSecureRequest(req) ? 'https' : 'http';
  return `${scheme}://${host}`;
}
