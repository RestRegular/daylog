/**
 * 静态健全性检查：在 app.js 里找出「被调用但没有定义」的函数。
 * 目的：防止再次出现"残留调用已删除的函数 -> 抛 ReferenceError -> 整页空白"这类回归。
 * 运行：node scripts/undefined-scan.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.resolve(here, '..', 'public', 'js');

const BUILTINS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'async', 'await', 'constructor', 'super', 'import', 'export', 'new', 'delete', 'void',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise',
  'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'Intl', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'fetch', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'console', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader',
  'Image', 'Audio', 'Video', 'AbortController', 'TextEncoder', 'TextDecoder',
  'decodeURIComponent', 'encodeURIComponent', 'decodeURI', 'encodeURI',
  'btoa', 'atob', 'alert', 'confirm', 'prompt', 'structuredClone', 'queueMicrotask',
  'XMLHttpRequest', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'getComputedStyle', 'matchMedia', 'performance', 'navigator', 'require',
  // Promise 构造器参数 / 回调形参（在简化解析里可能没被收集到）
  'resolve', 'reject', 'done', 'next',
]);

/** 去掉注释与字符串，避免把注释里的名字当成调用（这是本次自检的教训） */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
}

/** 收集文件里定义的名字（function 声明、const/let/var、import、class、参数） */
function collectDefined(src) {
  const defined = new Set();
  const add = (name) => {
    const n = String(name || '').trim();
    if (n) defined.add(n);
  };

  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) add(piece.split(':').pop().split('=')[0]);
  }
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const piece of m[1].split(',')) add(piece.split(' as ').pop());
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) add(m[1]);
  // 函数参数（简化：抓括号内的标识符）
  for (const m of src.matchAll(/(?:function\s*[\w$]*|\([^)]*\)\s*=>|\b[\w$]+\s*)\s*\(([^)]*)\)\s*\{/g)) {
    for (const piece of m[1].split(',')) add(piece.split('=')[0].replace(/[{}[\].:]/g, ''));
  }
  return defined;
}

const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const report = [];
let problems = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(jsDir, file), 'utf8');
  const src = stripCommentsAndStrings(raw);
  const defined = collectDefined(src);
  const missing = new Set();

  // 只看「像函数调用」的：小写开头标识符 + 左括号
  for (const m of src.matchAll(/(?<![\w.$])([a-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (BUILTINS.has(name) || defined.has(name)) continue;
    // 排除紧跟关键字的情况（如 `else (`、`do (`）
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:else|do|in|of|typeof|void|new|return|case)\s*$/.test(before)) continue;
    missing.add(name);
  }

  const unknown = [...missing].filter((n) => !/^(?:t|e|r|n|v|p|s|a|b|c|d|f|g|h|i|j|k|l|m|o|q|u|w|x|y|z)$/.test(n));
  report.push({ file, unknown });
  if (unknown.length) problems += unknown.length;
}

console.log('\n静态检查：被调用但未定义的函数\n');
console.log('  文件            可疑调用');
console.log('  ' + '─'.repeat(60));
for (const r of report) {
  console.log(`  ${r.file.padEnd(16)}${r.unknown.length ? r.unknown.join(', ') : '无 ✓'}`);
}
console.log('  ' + '─'.repeat(60));
// known-good：这些是通过 window/全局或动态方式提供的
const ALLOW = new Set([
  'daylogDebugLayout',
  'daylogDebug',
  'scrollTo',
  'focus',
  'reload',
  'append',
  'remove',
  // 返回对象上的方法：xxx.update() / yyy.repaint() 等（简化解析抓不到）
  'update',
  'repaint',
  'refresh',
  'close',
  'open',
  'destroy',
]);
const real = report.flatMap((r) => r.unknown).filter((n) => !ALLOW.has(n));
if (real.length) {
  console.log(`\n⚠️ 发现 ${real.length} 个可疑调用：${real.join(', ')}`);
  console.log('（如果确认是浏览器全局 API，请在脚本的 BUILTINS 里补充）');
} else {
  console.log('\n未发现「调用未定义函数」的情况 ✅');
}
process.exitCode = real.length ? 1 : 0;
