/**
 * 限速网络回归测试：模拟手机慢网，验证「刷新后头像条 / 倒计时」不会消失。
 * 用法: node scripts/slownet-test.mjs <username> [password]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:81';
const [USERNAME, PASSWORD = 'demo1234'] = process.argv.slice(2);
if (!USERNAME) { console.error('用法: node scripts/slownet-test.mjs <username> [password]'); process.exit(2); }
const chromePath = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const port = 9100 + Math.floor(Math.random() * 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-slow-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=440,956', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res);
          ws.addEventListener('error', rej);
        });
        return ws;
      }
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('chrome fail');
}
const ws = await connect();
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = (seq += 1);
    waiting.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? { __error: r.result.exceptionDetails.exception?.description } : r.result?.result?.value;
};
const snapshot = () =>
  evaluate(`(() => ({
    hash: location.hash,
    scope: window.__daylogState?.home?.scope,
    loading: window.__daylogState?.home?.loading,
    friendsLoaded: window.daylogDebug?.friends?.().loaded,
    friends: window.daylogDebug?.friends?.().friends?.length,
    strip: document.querySelectorAll('.friend-chip').length,
    countdowns: document.querySelectorAll('#home-top .countdown').length,
  }))()`);

try {
  await send('Page.enable');
  await send('Network.enable');
  // 限速：约 3G，并给 API 单独加延迟
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 600,
    downloadThroughput: (600 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  await send('Network.setBlockedURLs', { urls: [] });

  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(900);
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const pair = loginRes.headers.getSetCookie?.().find((c) => c.startsWith('daylog_session=')) || '';
  const value = pair.split(';')[0].split('=').slice(1).join('=');
  await send('Network.setCookie', { name: 'daylog_session', value, url: BASE, path: '/' });
  await send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  console.log('初次进入(慢网):', JSON.stringify(await snapshot()));

  for (const round of [1, 2]) {
    // 注意：每次导航都会重新加载页面，钩子必须在导航之后重新装
    await send('Page.navigate', { url: `${BASE}/#/home?scope=friends` });
    await evaluate(`(() => {
      window.__paintLog = [];
      if (window.daylogDebug && !window.daylogDebug.__hooked) {
        const orig = window.daylogDebug.paintHome;
        if (orig) {
          window.daylogDebug.paintHome = (...a) => { window.__paintLog.push('paintHome'); return orig(...a); };
          window.daylogDebug.__hooked = true;
        }
      }
      return true;
    })()`);
    await sleep(6000);
    console.log(`\n第 ${round} 次刷新到「好友」标签:`, JSON.stringify(await snapshot()));
    const log = await evaluate(`(() => ({
      paintLog: window.__paintLog || null,
      stripNode: !!document.querySelector('.friend-strip'),
      homeTop: !!document.querySelector('#home-top'),
      friendsInState: (window.daylogDebug.friends().friends || []).map(f => f.user.username),
      userSet: !!window.__daylogState?.user,
      scope: window.__daylogState?.home?.scope,
      loading: window.__daylogState?.home?.loading,
    }))()`);
    console.log('  轨迹:', JSON.stringify(log));
  }
} catch (err) {
  console.error('失败:', err.message);
} finally {
  chrome.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
