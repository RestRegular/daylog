/**
 * 零依赖的 multipart/form-data 流式解析器。
 * 文件分片直接写盘，大视频也不会占满内存。
 *
 * 设计（刻意保持简单，避免缓冲区记账出错）：
 *   - 始终只维护一个待处理缓冲 `buf` 和一个游标 `i`（buf 中已消费的字节数）。
 *   - 需要匹配边界时，只在「完整可能出现边界」的范围内搜索，找不到就交付安全的部分。
 *   - 每次交付后立刻截断 buf，i 归零，不存在「已消费但仍计入长度」的状态。
 */

export function parseContentType(header) {
  const raw = String(header || '');
  const [type, ...rest] = raw.split(';');
  const params = {};
  for (const piece of rest) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    const key = piece.slice(0, idx).trim().toLowerCase();
    let val = piece.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type: type.trim().toLowerCase(), params };
}

function parseContentDisposition(value) {
  const out = { name: null, filename: null };
  if (!value) return out;
  const nameMatch = value.match(/;\s*name="([^"]*)"/i) || value.match(/;\s*name=([^;]+)/i);
  if (nameMatch) out.name = nameMatch[1].trim();
  const fileMatch =
    value.match(/;\s*filename\*?=(?:UTF-8'')?"([^"]*)"/i) ||
    value.match(/;\s*filename\*?=(?:UTF-8'')?([^;]+)/i);
  if (fileMatch) {
    out.filename = fileMatch[1].trim();
    try {
      out.filename = decodeURIComponent(out.filename);
    } catch {
      /* 保留原值 */
    }
  }
  return out;
}

function parseHeaders(buf) {
  const headers = {};
  for (const line of buf.toString('utf8').split(/\r\n|\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

const MAX_HEADER_BYTES = 128 * 1024;
const MAX_PREAMBLE_BYTES = 64 * 1024;

/**
 * @param {import('node:stream').Readable} stream
 * @param {object} opts
 * @param {string} opts.boundary
 * @param {(headers: object, info: object) => ({write(chunk: Buffer): void, end(): void, error?(err: Error): void} | null)} opts.createHandler
 * @param {number} [opts.maxBytes]
 */
export function parseMultipart(stream, { boundary, createHandler, maxBytes = Infinity }) {
  const open = Buffer.from(`--${boundary}`);
  const delim = Buffer.from(`\r\n--${boundary}`);

  let buf = Buffer.alloc(0);
  let i = 0;                 // buf 中已消费的字节数
  let state = 'preamble';    // preamble | after-open | after-delim | headers | body | done | error
  let part = null;           // { handler } | { discard: true } | null
  let bytesRead = 0;
  let failure = null;

  const result = new Promise((resolve, reject) => {
    const isClean = () => state === 'done' || state === 'error';

    function fail(err) {
      if (state === 'error') return;
      state = 'error';
      failure = err;
      try {
        part?.handler?.error?.(err);
      } catch {
        /* 忽略 */
      }
      reject(err);
    }

    /**
     * 把 buf[i..endOffset) 交给当前 part。
     * 注意：endOffset 是 buf 中的绝对下标（不是长度）。
     */
    function deliverTo(endOffset) {
      if (endOffset <= i) return;
      if (part && !part.discard && part.handler) {
        part.handler.write(buf.subarray(i, endOffset));
      }
      i = endOffset;
    }

    /** 交付到缓冲区末尾 */
    function deliverRest() {
      deliverTo(buf.length);
    }

    function closePart() {
      const handler = part && !part.discard ? part.handler : null;
      part = null;
      if (handler) handler.end();
    }

    /** 丢弃已消费部分；prefix 用于把「已经越过消费点」的字节放回缓冲 */
    function compact(prefix = null) {
      const rest = i < buf.length ? buf.subarray(i) : null;
      if (prefix && prefix.length && rest && rest.length) buf = Buffer.concat([prefix, rest]);
      else if (prefix && prefix.length) buf = Buffer.from(prefix);
      else if (rest && rest.length) buf = Buffer.from(rest);
      else buf = Buffer.alloc(0);
      i = 0;
    }

    function finishAll() {
      closePart();
      buf = Buffer.alloc(0);
      i = 0;
      state = 'done';
      resolve({ ok: true, bytes: bytesRead });
    }

    function beginHeaders() {
      state = 'headers';
    }

    function handleHeaders() {
      const pos = buf.indexOf('\r\n\r\n', i);
      if (pos === -1) {
        if (buf.length - i > MAX_HEADER_BYTES) return fail(new Error('multipart 头部过大'));
        return false;
      }
      const raw = buf.subarray(i, pos);
      const headers = parseHeaders(raw);
      const cd = parseContentDisposition(headers['content-disposition']);
      const info = {
        name: cd.name || '',
        filename: cd.filename,
        contentType: headers['content-type'] || 'application/octet-stream',
        headers,
        isFile: cd.filename !== null && cd.filename !== undefined,
      };
      let handler = null;
      try {
        handler = createHandler(headers, info);
      } catch (err) {
        fail(err);
        return false;
      }
      part = handler ? { handler } : { discard: true };
      i = pos + 4;              // 跳过 \r\n\r\n
      state = 'body';
      return true;
    }

    function drain() {
      for (;;) {
        if (isClean()) return;

        // ---- 前导：定位起始边界 ----
        if (state === 'preamble') {
          const at = buf.indexOf(open, i);
          if (at === -1) {
            // 只保留可能是边界前缀的尾部
            const keep = Math.max(0, buf.length - (open.length - 1));
            if (keep > MAX_PREAMBLE_BYTES) return fail(new Error('multipart 起始边界缺失'));
            i = keep;
            compact();
            return;
          }
          i = at + open.length;
          state = 'after-open';
          continue;
        }

        // ---- 起始边界之后：跳过 CRLF，然后读头部 ----
        if (state === 'after-open') {
          if (buf.length - i < 2) return;
          if (buf[i] === 0x0d && buf[i + 1] === 0x0a) i += 2;
          else if (buf[i] === 0x0a) i += 1;
          beginHeaders();
          continue;
        }

        // ---- 头部 ----
        if (state === 'headers') {
          if (!handleHeaders()) return;
          continue;
        }

        // ---- 正文：找下一个边界 ----
        if (state === 'body') {
          const rest = buf.length - i;
          if (rest <= delim.length) return; // 数据太短，无法判断是否是边界
          const at = buf.indexOf(delim, i);
          if (at === -1) {
            // 无法确定边界：保留尾部 delim.length 字节（至少保留 1 字节，保证仍然有进展）
            deliverTo(Math.min(buf.length - 1, buf.length - delim.length));
            compact();
            return;
          }
          // delim = "\r\n--boundary"：其中的 \r\n 就是本分片正文的结束符，
          // 因此正文区间是 [i, at) —— 不要再减 2（这是一个曾经导致丢字节的坑）。
          deliverTo(Math.max(i, at));
          closePart();
          i = at + delim.length;
          state = 'after-delim';
          continue;
        }

        // ---- 边界之后：判断是结束标记还是下一个分片 ----
        if (state === 'after-delim') {
          if (buf.length - i < 1) return;
          if (buf[i] === 0x2d && buf[i + 1] === 0x2d) {
            // 结束标记 "--"
            i += 2;
            return finishAll();
          }
          if (buf[i] === 0x0d) {
            if (buf.length - i < 2) return;
            if (buf[i + 1] !== 0x0a) return fail(new Error('multipart 边界格式错误'));
            i += 2;
          } else if (buf[i] === 0x0a) {
            i += 1;
          }
          beginHeaders();
          continue;
        }

        return;
      }
    }

    stream.on('data', (chunk) => {
      if (isClean()) return;
      const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += c.length;
      if (bytesRead > maxBytes) return fail(new Error('请求体超过大小限制'));
      buf = buf.length - i > 0 ? Buffer.concat([buf.subarray(i), c]) : c;
      i = 0;
      drain();
    });

    stream.on('aborted', () => fail(new Error('客户端中断了上传')));
    stream.on('error', (err) => fail(err));

    stream.on('end', () => {
      if (isClean()) return;
      try {
        drain();
        if (isClean()) return;
        if (state === 'body') {
          // 缺少结束边界：宽容处理，把剩余内容当正文
          deliverRest();
        }
        closePart();
        buf = Buffer.alloc(0);
        i = 0;
        state = 'done';
        resolve({ ok: true, bytes: bytesRead, incomplete: true });
      } catch (err) {
        fail(err);
      }
    });
  });

  return {
    result,
    get aborted() {
      return state === 'error';
    },
    failure: () => failure,
  };
}
