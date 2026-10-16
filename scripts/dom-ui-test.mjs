/**
 * 真实 DOM 联调：用 headless Chrome（CDP）登录并打开首页「我」标签，
 * 把 #home-list 的真实内容抓出来，确认倒计时/头像条是否真的渲染。
 *
 * 用法：node scripts/dom-ui-test.mjs [username] [password]
 * 需要先启动服务，并保证能找到 Chrome。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:81';
const USERNAME = process.argv[2] || '';
const PASSWORD = process.argv[3] || 'demo1234';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome/Edge');
  process.exit(2);
}

const port = 9223 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-cdp-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=440,956',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'eval 出错');
    }
    return res.result.value;
  }
}

async function connect() {
  const url = await findTarget();
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return new Cdp(ws);
}

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

try {
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 收集控制台错误，便于发现"静默失败"
  const consoleErrors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  console.log('\n▸ 登录并进入首页');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(700);

  if (USERNAME) {
    const ok = await cdp.eval(`(async () => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} }),
      });
      return r.status;
    })()`);
    check(`登录 ${USERNAME}`, ok === 200, `status=${ok}`);
    // 登录成功后必须重新加载，让应用用新会话重新 bootstrap
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(900);
  }

  // 进入首页「我」标签，并等网络静默
  await cdp.eval(`(() => { location.hash = '#/home?scope=mine'; return true; })()`);
  await sleep(2500);

  const state = await cdp.eval(`(() => {
    const list = document.querySelector('#home-list');
    const tabs = [...document.querySelectorAll('.scope-tab')].map((b) => b.textContent.trim());
    const active = document.querySelector('.scope-tab.active')?.textContent.trim();
    return {
      hash: location.hash,
      tabs,
      active,
      countdowns: [...document.querySelectorAll('#home-top .countdown')].map((n) => n.textContent.trim()),
      cards: document.querySelectorAll('.post-card').length,
      feedHtml: list ? list.innerHTML.slice(0, 400) : null,
      strip: document.querySelectorAll('.friend-chip').length,
      friendCountBadge: (() => { const n = document.querySelector('[data-friend-count]'); return n ? { text: n.textContent, hidden: n.classList.contains('hidden') } : null; })(),
      listExists: !!list,
    };
  })()`);

  console.log('\n  实际状态:', JSON.stringify({ hash: state.hash, tabs: state.tabs, active: state.active, cards: state.cards, strip: state.strip }, null, 0));

  // 调用页面内置自检，直接看"数据有没有到 / 有没有渲染"
  const diag = await cdp.eval(`window.daylogDebug.home({ verbose: false })`);
  console.log('  自检:', JSON.stringify({
    annLoaded: diag.anniversaries.loaded,
    annCount: diag.anniversaries.count,
    annItems: diag.anniversaries.items,
    wouldRender: diag.wouldRenderCelebrations,
    domCountdowns: diag.dom.countdownNodes,
    scope: diag.home?.scope,
    homePosts: diag.home?.posts,
    firstChild: diag.dom.firstChildClass,
    error: diag.celebrationError,
  }));

  // 直接问应用实例：homeCelebrations() 到底返回什么
  const live = await cdp.eval(`(() => {
    try {
      const items = window.daylogDebug.homeCelebrations();
      const card = items[0] ? window.daylogDebug.celebrationCard(items[0], {}) : null;
      return { count: items.length, hasNext: items.map(i => !!i.next), cardClass: card?.className, cardText: card?.textContent };
    } catch (e) { return { thrown: String(e) }; }
  })()`);
  console.log('  应用实例 homeCelebrations():', JSON.stringify(live));
  check('首页容器存在', state.listExists);
  check('标签顺序为 全部/好友/我', state.tabs.length === 3 && state.tabs[0] === '全部' && /^好友/.test(state.tabs[1]) && state.tabs[2] === '我', JSON.stringify(state.tabs));
  check('当前激活的是「我」', state.active === '我', String(state.active));
  check('「我」标签下渲染出了倒计时', state.countdowns.length > 0, `countdowns=${JSON.stringify(state.countdowns)}`);
  check('页面没有 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('好友计数在刷新后依然显示', state.friendCountBadge && !state.friendCountBadge.hidden && state.friendCountBadge.text === '1', JSON.stringify(state.friendCountBadge));

  console.log('\n▸ 切到「好友」标签');
  await cdp.eval(`(() => { location.hash = '#/home?scope=friends'; return true; })()`);
  await sleep(2500);
  const friendsView = await cdp.eval(`(() => ({
    strip: document.querySelectorAll('.friend-chip').length,
    stripNames: [...document.querySelectorAll('.friend-chip .chip-name')].map((n) => n.textContent.trim()),
    blurred: document.querySelectorAll('.chip-avatar .blur').length,
    countdowns: document.querySelectorAll('#home-top .countdown').length,
    hint: document.querySelectorAll('.friend-strip-hint').length,
  }))()`);
  check('好友标签显示了头像条', friendsView.strip > 0, `chips=${friendsView.strip}`);
  check('头像条首项为「全部好友」', friendsView.stripNames[0] === '全部好友', JSON.stringify(friendsView.stripNames.slice(0, 3)));
  check('「全部好友」用了模糊头像', friendsView.blurred > 0, `blur=${friendsView.blurred}`);
  check('好友标签下不显示倒计时', friendsView.countdowns === 0, `countdowns=${friendsView.countdowns}`);
  check('说明文本已移除', friendsView.hint === 0);

  console.log('\n▸ 在「好友」标签筛选某个人（显示关联的倒计时）');
  // 通过 API 给这个好友关联一条纪念日
  const linked = await cdp.eval(`(async () => {
    const friends = window.daylogDebug.friends().friends;
    const fid = friends[0]?.user?.id;
    const meId = window.__daylogState.user.id;
    // 先建/更新一条关联该好友的纪念日
    const list = (await (await fetch('/api/anniversaries')).json()).anniversaries;
    const target = list.find(a => a.friendId === fid);
    if (target) return { fid, id: target.id, created: false };
    const r = await fetch('/api/anniversaries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '和好友的纪念日', icon: '💍', date: '2024-03-15', note: '关联测试', friendId: fid }),
    });
    const j = await r.json();
    return { fid, id: j.anniversary?.id, created: r.status === 201, meId };
  })()`);
  check('已为好友关联一条纪念日', !!linked.id, JSON.stringify(linked));

  // 上面是用原生 fetch 建的，应用侧缓存还是旧的：拉一次让它同步
  await cdp.eval(`window.daylogDebug.loadAnniversaries().then(() => true)`);
  await sleep(600);

  // 点头像条里的那个好友（等价于用户点击）
  await cdp.eval(`(() => {
    const chip = [...document.querySelectorAll('.friend-chip')].find(c => c.title && !c.classList.contains('me'));
    chip?.click();
    return true;
  })()`);
  await sleep(2800);
  const filtered = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('#home-top .countdown')];
    return {
      hash: location.hash,
      friendFilter: window.__daylogState?.home?.friendFilter,
      countdowns: cards.length,
      texts: cards.map(c => c.textContent.trim()),
      avatars: document.querySelectorAll('#home-top .countdown .cd-friend').length,
      linked: document.querySelectorAll('#home-top .countdown.linked').length,
    };
  })()`);
  check('筛选某好友后显示了倒计时', filtered.countdowns > 0, JSON.stringify(filtered));
  check('倒计时内容提到该纪念日', filtered.texts.some((t) => /纪念日/.test(t)), JSON.stringify(filtered.texts));
  check('倒计时上带关联好友头像', filtered.avatars > 0, `avatars=${filtered.avatars}`);

  // 取消筛选后倒计时消失
  await cdp.eval(`(() => {
    const chip = document.querySelector('.friend-chip.me');
    chip?.click();
    return true;
  })()`);
  await sleep(2500);
  const unfiltered = await cdp.eval(`document.querySelectorAll('#home-top .countdown').length`);
  check('取消筛选后倒计时回到空', unfiltered === 0, `countdowns=${unfiltered}`);

  console.log('\n▸ 日历里显示关联好友头像 + 标注');
  // 建一条落在「本月」的关联纪念日，才能同时验证日历标注
  const monthLinked = await cdp.eval(`(async () => {
    const fid = window.daylogDebug.friends().friends[0]?.user?.id;
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const date = \`\${now.getFullYear()}-\${mm}-15\`;
    const r = await fetch('/api/anniversaries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '本月关联纪念日', icon: '📅', date, friendId: fid }),
    });
    const j = await r.json();
    return { status: r.status, id: j.anniversary?.id, date, fid };
  })()`);
  check('建好本月关联纪念日', !!monthLinked.id, JSON.stringify(monthLinked));

  // 回到日历并刷新数据（换月会重新拉）
  await cdp.eval(`(() => { location.hash = '#/calendar?month=2020-01'; return true; })()`);
  await sleep(1500);
  await cdp.eval(`(() => { location.hash = '#/calendar'; return true; })()`);
  await sleep(3000);
  const cal = await cdp.eval(`(() => ({
    rows: document.querySelectorAll('.cal-an-row').length,
    markedCells: document.querySelectorAll('.cal-cell.has-anniversary').length,
    marks: document.querySelectorAll('.cal-cell .cal-marks').length,
    countdowns: document.querySelectorAll('.cal-countdowns .countdown').length,
    friendAvatars: document.querySelectorAll('.cal-countdowns .cd-friend').length,
    anyFriendAvatar: document.querySelectorAll('.cd-friend').length,
    withFriend: window.daylogDebug.anniversaries().list.filter(a => a.friend).length,
  }))()`);
  check('日历倒计时区有卡片', cal.countdowns > 0, JSON.stringify(cal));
  check('日历倒计时带关联好友头像', cal.anyFriendAvatar > 0, JSON.stringify(cal));
  check('关联好友的卡片带 friend 数据', cal.withFriend > 0, JSON.stringify(cal));
  check('日历格子标注出纪念日', cal.markedCells > 0, JSON.stringify(cal));
  check('日历下方列出本月纪念日', cal.rows > 0, JSON.stringify(cal));

  console.log('\n▸ 刷新页面（关键回归：刷新后倒计时/头像条不能丢）');
  const beforeRefresh = friendsView.strip;
  await cdp.send('Page.navigate', { url: `${BASE}/#/home?scope=friends` });
  await sleep(3000);
  const afterRefreshFriends = await cdp.eval(`document.querySelectorAll('.friend-chip').length`);
  check('刷新后好友头像条仍在', afterRefreshFriends === beforeRefresh && afterRefreshFriends > 0, `before=${beforeRefresh} after=${afterRefreshFriends}`);

  await cdp.send('Page.navigate', { url: `${BASE}/#/home?scope=mine` });
  await sleep(3000);
  const afterRefreshMine = await cdp.eval(`(() => ({
    countdowns: [...document.querySelectorAll('#home-top .countdown')].map((n) => n.textContent.trim()),
    cards: document.querySelectorAll('.post-card').length,
  }))()`);
  check('刷新后「我」标签倒计时仍在', afterRefreshMine.countdowns.length > 0, `countdowns=${JSON.stringify(afterRefreshMine.countdowns)}`);
} catch (err) {
  console.error('\n运行失败:', err.message);
  fail += 1;
} finally {
  chrome.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

console.log(`\n${'─'.repeat(46)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `真实 DOM 联调全部通过 ✅（${pass} 项）`);
process.exit(fail ? 1 : 0);
