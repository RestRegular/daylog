// 环境自检：不启动服务，只验证运行环境与模块可用性
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const problems = [];
const checks = [];

function ok(name, detail = '') {
  checks.push({ name, ok: true, detail });
}
function bad(name, detail = '') {
  checks.push({ name, ok: false, detail });
  problems.push(`${name}${detail ? `：${detail}` : ''}`);
}

// 1. Node 版本
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major > 22 || (major === 22 && minor >= 5)) {
  ok('Node.js 版本', `v${process.versions.node}（node:sqlite 可用）`);
} else {
  bad('Node.js 版本', `v${process.versions.node} 过低，需要 >= 22.5.0`);
}

// 2. node:sqlite
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  const row = db.prepare('SELECT COUNT(*) AS c FROM t').get();
  db.close();
  ok('node:sqlite', `可用（写入/查询正常，count=${row.c}）`);
} catch (err) {
  bad('node:sqlite', err.message);
}

// 3. 目录可写
for (const dir of ['data', 'data/uploads', 'public', 'public/js', 'public/css']) {
  const full = path.join(root, dir);
  try {
    fs.mkdirSync(full, { recursive: true });
    const probe = path.join(full, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    ok(`目录可写 ${dir}/`);
  } catch (err) {
    bad(`目录可写 ${dir}/`, err.message);
  }
}

// 4. 关键模块能加载
const modules = [
  ['配置', '../src/config.js'],
  ['数据层', '../src/db/store.js'],
  ['HTTP 工具', '../src/http/http.js'],
  ['multipart 解析', '../src/lib/multipart.js'],
  ['媒体存储', '../src/media/files.js'],
  ['二维码', '../src/lib/qr.js'],
  ['服务入口', '../src/server.js'],
];
for (const [label, spec] of modules) {
  try {
    await import(spec);
    ok(`模块加载 ${label}`);
  } catch (err) {
    bad(`模块加载 ${label}`, err.message);
  }
}

// 5. 前端资源齐全
const assets = [
  'index.html',
  'share.html',
  'manifest.webmanifest',
  'sw.js',
  'css/style.css',
  'js/app.js',
  'js/api.js',
  'js/util.js',
  'js/ui.js',
  'js/timeline.js',
  'js/theme.js',
  'js/composer.js',
  'js/attachment-editor.js',
  'js/media.js',
  'js/share.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
  'icons/icon-maskable-512.png',
];
const missing = assets.filter((rel) => !fs.existsSync(path.join(root, 'public', rel)));
if (!missing.length) {
  ok('前端资源', `${assets.length} 个文件齐全`);
} else {
  bad('前端资源缺失', missing.join(', '));
}

// 6. 二维码自检
try {
  const { createQrMatrix } = await import('../src/lib/qr.js');
  const { matrix } = createQrMatrix('http://localhost:81/share/testtoken1', { level: 'M' });
  if (matrix.length >= 21) ok('二维码生成', `${matrix.length}x${matrix.length} 矩阵正常`);
  else bad('二维码生成', '矩阵异常');
} catch (err) {
  bad('二维码生成', err.message);
}

// 输出
const pad = Math.max(...checks.map((c) => c.name.length));
console.log('\nDayLog 环境自检\n' + '─'.repeat(pad + 24));
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(pad)}  ${c.detail}`);
}
console.log('─'.repeat(pad + 24));
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  · ${p}`);
  process.exit(1);
}
console.log('\n全部通过 ✅  运行 `npm start` 启动服务。\n');
