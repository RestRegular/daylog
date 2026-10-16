/**
 * pm2 启动回归测试（不需要装 pm2）。
 *
 * pm2 不是 `node src/server.js` 那样直接跑应用的：它 spawn 的是自己的
 * `lib/ProcessContainerFork.js`，再由那个文件 `import(pm_exec_path)` 把应用加载进来。
 * 于是应用里 `process.argv[1]` 是 pm2 的包装脚本，不等于 server.js ——
 * 以前这里是「argv[1] === 本文件」才算直接运行，结果 pm2 里进程 online 却从不监听端口。
 *
 * 这个脚本用同样的方式加载一遍应用（子进程 + 注入 pm_id/pm_exec_path），
 * 然后真的去请求 /api/health，确认端口起来了。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const serverPath = path.join(root, 'src', 'server.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-pm2-'));
const port = 8391 + Math.floor(Math.random() * 100);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};

/** 模拟 pm2 的 ProcessContainerFork.js：只 import，不动 process.argv */
const wrapper = `
import { pathToFileURL } from 'node:url';
await import(pathToFileURL(${JSON.stringify(serverPath)}).href);
`;

function get(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
  });
}

async function waitForHealth(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const res = await get(url);
    if (res.status === 200) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { status: 0, error: 'never came up' };
}

console.log('\n▸ 模拟 pm2 加载方式启动 src/server.js');
const child = spawn(process.execPath, ['--input-type=module', '--eval', wrapper], {
  cwd: root,
  env: {
    ...process.env,
    // pm2 注入的两个变量（ForkMode / ClusterMode 都会注入）
    pm_id: '0',
    pm_exec_path: serverPath,
    PORT: String(port),
    DAYLOG_DATA_DIR: dataDir,
    DAYLOG_ALLOW_SIGNUP: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));

try {
  const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  check('pm2 方式加载后端口真的起来了', health.status === 200, `status=${health.status} ${health.error || ''}`);
  check('启动横幅打印出来了（说明 startServer 跑了）', /DayLog 已启动/.test(out), JSON.stringify(out.slice(0, 200)));
  check('进程进程号不是 0', child.pid > 0);
  const index = await get(`http://127.0.0.1:${port}/`);
  check('首页也返回 200', index.status === 200, `status=${index.status}`);
  check('没有启动报错', !/Error|ERR_/.test(err), JSON.stringify(err.slice(0, 200)));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔删不掉，忽略 */
  }
}

console.log('\n▸ 直接运行（node src/server.js）不受影响');
{
  const directPort = port + 50;
  const child2 = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(directPort), DAYLOG_DATA_DIR: dataDir, pm_id: undefined, pm_exec_path: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out2 = '';
  child2.stdout.on('data', (d) => (out2 += d));
  try {
    const health = await waitForHealth(`http://127.0.0.1:${directPort}/api/health`);
    check('直接 node src/server.js 依然正常', health.status === 200, `status=${health.status}`);
  } finally {
    child2.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
}

console.log('\n▸ 被当模块 import（测试用）时不应该自动起服务');
{
  const res = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(`file://${serverPath.replace(/\\/g, '/')}`)}); console.log('IMPORTED_OK');`], {
      cwd: root,
      env: { ...process.env, PORT: '8399', DAYLOG_DATA_DIR: dataDir, pm_id: undefined, pm_exec_path: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    setTimeout(() => {
      c.kill();
      resolve(o);
    }, 1200);
  });
  check('import 后进程自己退出（没有监听端口）', res.includes('IMPORTED_OK'), JSON.stringify(res));
  const probe = await get('http://127.0.0.1:8399/api/health', 800);
  check('真的没有监听 8399', probe.status === 0, `status=${probe.status}`);
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
