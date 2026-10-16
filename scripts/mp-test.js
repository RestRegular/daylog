// multipart 解析器单元测试：多种报文 × 多种分片大小，逐字节比对
import { Readable } from 'node:stream';
import { parseMultipart } from '../src/lib/multipart.js';

const B = '----xyz';
const enc = (s) => Buffer.from(s, 'utf8');
const part = (name, filename, type, content) => {
  let h = `--${B}\r\nContent-Disposition: form-data; name="${name}"`;
  if (filename) h += `; filename="${filename}"`;
  h += '\r\n';
  if (type) h += `Content-Type: ${type}\r\n`;
  h += '\r\n';
  return Buffer.concat([
    enc(h),
    Buffer.isBuffer(content) ? content : enc(String(content)),
    enc('\r\n'),
  ]);
};
const close = () => enc(`--${B}--\r\n`);

async function parse(raw, chunkSize) {
  const chunks = [];
  for (let i = 0; i < raw.length; i += chunkSize) {
    chunks.push(Buffer.from(raw.subarray(i, i + chunkSize)));
  }
  const fields = {};
  const files = [];
  let error = null;
  try {
    await parseMultipart(Readable.from(chunks), {
      boundary: B,
      maxBytes: 1e9,
      createHandler: (headers, partInfo) => {
        const acc = [];
        const isFile = partInfo.isFile;
        return {
          write(c) {
            acc.push(Buffer.from(c));
          },
          end() {
            const buf = Buffer.concat(acc);
            if (isFile) {
              files.push({ name: partInfo.name, filename: partInfo.filename, buf });
              return;
            }
            const value = buf.toString('utf8');
            // 同名字段按出现顺序累积为数组（与 readMultipartBody 的约定一致）
            if (fields[partInfo.name] === undefined) fields[partInfo.name] = value;
            else if (Array.isArray(fields[partInfo.name])) fields[partInfo.name].push(value);
            else fields[partInfo.name] = [fields[partInfo.name], value];
          },
          error(err) {
            error = err;
          },
        };
      },
    }).result;
  } catch (err) {
    error = err;
  }
  return { fields, files, error };
}

let bad = 0;
let total = 0;
function check(label, cond, extra = '') {
  total += 1;
  if (cond) return true;
  bad += 1;
  console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  return false;
}

const cases = [
  {
    label: '仅一个文本字段（中文）',
    raw: Buffer.concat([part('a', null, null, 'hello 世界'), close()]),
    fields: { a: 'hello 世界' },
    files: [],
  },
  {
    label: '一个文本文件',
    raw: Buffer.concat([part('f', 'x.txt', 'text/plain', 'FILE-CONTENT-1234'), close()]),
    fields: {},
    files: [{ filename: 'x.txt', text: 'FILE-CONTENT-1234' }],
  },
  {
    label: '二进制文件 + 中文字段 + emoji',
    raw: Buffer.concat([
      part('media', 'p.png', 'image/png', Buffer.from([0, 1, 2, 3, 4, 255, 254, 13, 10, 45, 45])),
      part('post', null, null, JSON.stringify({ body: '带图片的记录 🎉', n: 42 })),
      close(),
    ]),
    fields: { post: JSON.stringify({ body: '带图片的记录 🎉', n: 42 }) },
    files: [
      {
        filename: 'p.png',
        buf: Buffer.from([0, 1, 2, 3, 4, 255, 254, 13, 10, 45, 45]),
      },
    ],
  },
  {
    label: '两个文件 + 两个同名字段',
    raw: Buffer.concat([
      part('media', 'a.jpg', 'image/jpeg', 'AAA'),
      part('note', null, null, 'first'),
      part('media', 'b.mp4', 'video/mp4', 'BBBBB'),
      part('note', null, null, 'second'),
      close(),
    ]),
    // 同名字段按出现顺序累积为数组
    fields: { note: ['first', 'second'] },
    files: [
      { filename: 'a.jpg', text: 'AAA' },
      { filename: 'b.mp4', text: 'BBBBB' },
    ],
  },
  {
    label: '正文含类似边界的内容',
    raw: Buffer.concat([
      part('f', 'weird.txt', 'text/plain', 'line\r\n--not-a-real-boundary\r\nend'),
      close(),
    ]),
    fields: {},
    files: [{ filename: 'weird.txt', text: 'line\r\n--not-a-real-boundary\r\nend' }],
  },
  {
    label: '空文件 + 空字段',
    raw: Buffer.concat([part('f', 'empty.bin', 'application/octet-stream', ''), part('e', null, null, ''), close()]),
    fields: { e: '' },
    files: [{ filename: 'empty.bin', bytes: 0 }],
  },
  {
    label: '较长正文（1MB 二进制）',
    raw: (() => {
      const big = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < big.length; i += 1) big[i] = (i * 7 + 13) & 0xff;
      return Buffer.concat([part('media', 'big.bin', 'application/octet-stream', big), part('post', null, null, '{"body":"大文件"}'), close()]);
    })(),
    fields: { post: '{"body":"大文件"}' },
    files: [{ filename: 'big.bin', bytes: 1024 * 1024 }],
  },
];

for (const c of cases) {
  console.log(`\n▸ ${c.label}（报文 ${c.raw.length} 字节）`);
  const sizes = [1, 2, 3, 5, 13, 64, 511, 4096, c.raw.length];
  for (const size of sizes) {
    const { fields, files, error } = await parse(c.raw, size);
    if (error) {
      check(`chunk=${size}`, false, `解析报错：${error.message}`);
      continue;
    }
    let ok = true;
    let detail = '';
    for (const [k, v] of Object.entries(c.fields)) {
      const got = fields[k];
      const same = Array.isArray(v)
        ? Array.isArray(got) && v.length === got.length && v.every((x, idx) => got[idx] === x)
        : got === v;
      if (!same) {
        ok = false;
        detail = `字段 ${k}=${JSON.stringify(got)} 期望 ${JSON.stringify(v)}`;
      }
    }
    if (files.length !== c.files.length) {
      ok = false;
      detail = `文件数 ${files.length} 期望 ${c.files.length}`;
    } else {
      c.files.forEach((ef, i) => {
        const got = files[i];
        if (!got || got.filename !== ef.filename) {
          ok = false;
          detail = `第 ${i} 个文件名 ${got?.filename} 期望 ${ef.filename}`;
        } else if (ef.text !== undefined && got.buf.toString('utf8') !== ef.text) {
          ok = false;
          detail = `第 ${i} 个文件内容 ${JSON.stringify(got.buf.toString('utf8').slice(0, 40))} 期望 ${JSON.stringify(ef.text.slice(0, 40))}`;
        } else if (ef.bytes !== undefined && got.buf.length !== ef.bytes) {
          ok = false;
          detail = `第 ${i} 个文件长度 ${got.buf.length} 期望 ${ef.bytes}`;
        } else if (ef.buf !== undefined && !got.buf.equals(ef.buf)) {
          ok = false;
          detail = `第 ${i} 个文件字节不一致`;
        }
      });
    }
    check(`chunk=${size}`, ok, detail);
  }
  const passed = total - bad;
  console.log(`  （累计 ${passed}/${total} 通过）`);
}

console.log(`\n${'─'.repeat(40)}`);
console.log(bad ? `${bad}/${total} 项失败` : `multipart 解析器全部通过 ✅（${total} 项）`);
process.exit(bad ? 1 : 0);
