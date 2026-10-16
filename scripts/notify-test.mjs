/**
 * 通知层（收件箱）测试 —— 2026-10-11 用户提的方案：
 *   好友发新记录 / 收到好友申请 / 申请被同意 → 写进收件人的收件箱；
 *   未读摘要**捎带在每个 API 响应**里，于是 agent 一调用就能看到。
 * 重点验证：不推给作者自己、不泄露给无关的人、关掉手机推送也照样记、
 *          标记已读有效、已读后不再捎带、按人隔离。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(here, '..');

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};

// 假的企业微信端点（用于确认"关掉推送也照样记收件箱"以及推送与收件箱互不干扰）
const hits = [];
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    hits.push({ key: decodeURIComponent((/key=([^&]+)/.exec(req.url) || [])[1] || ''), raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"errcode":0,"errmsg":"ok"}');
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const endpointPort = endpoint.address().port;

const PORT = 9500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-notify-'));
const child = spawn(process.execPath, [path.join(rootDir, 'src', 'server.js')], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DAYLOG_DATA_DIR: dataDir,
    DAYLOG_PUSH_ENDPOINT: `http://127.0.0.1:${endpointPort}`,
    DAYLOG_PUBLIC_URL: BASE,
  },
  stdio: 'ignore',
});

const mk = () => {
  const ck = { v: '' };
  const call = async (m, p, b) => {
    const init = { method: m, headers: {} };
    if (ck.v) init.headers.cookie = ck.v;
    if (b !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(b);
    }
    const res = await fetch(BASE + p, init);
    for (const c of res.headers.getSetCookie?.() || []) {
      const kv = c.split(';')[0];
      if (kv.startsWith('daylog_session=')) ck.v = kv;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body: json };
  };
  call.id = async () => (await call('GET', '/api/auth/me')).body.user.id;
  return call;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }

  const tag = Date.now().toString(36).slice(-5);
  const A = mk(); // 发帖的人（相当于我）
  const B = mk(); // 收件人（相当于用户）
  const C = mk(); // 和 A 不是好友的第三方（验证不泄露）
  await A('POST', '/api/auth/signup', { username: `na${tag}`, password: 'demo1234', displayName: '爱丽丝' });
  await B('POST', '/api/auth/signup', { username: `nb${tag}`, password: 'demo1234', displayName: '鲍勃' });
  await C('POST', '/api/auth/signup', { username: `nc${tag}`, password: 'demo1234', displayName: '路人' });
  const [aId, bId, cId] = [await A.id(), await B.id(), await C.id()];

  console.log('\n▸ 1. 空收件箱');
  const empty = await B('GET', '/api/me/notifications');
  check('新账号收件箱是空的', empty.status === 200 && empty.body?.unread?.total === 0 && empty.body.items.length === 0, JSON.stringify(empty.body));
  const plain = await B('GET', '/api/posts?scope=all&limit=1');
  check('没未读时，响应里不塞 notifications 空壳', plain.body?.notifications === undefined, JSON.stringify(Object.keys(plain.body || {})));

  console.log('\n▸ 2. 好友申请 → 写进收件人的收件箱');
  await B('POST', '/api/friends/requests', { username: `na${tag}` }); // B 加 A
  await sleep(300);
  const aInbox1 = await A('GET', '/api/me/notifications');
  check('A 收到"好友申请"一条', aInbox1.body?.unread?.byKind?.friend_request === 1, JSON.stringify(aInbox1.body?.unread));
  check('摘要写了申请人', /鲍勃 想加你为好友/.test(aInbox1.body?.items?.[0]?.summary || ''), aInbox1.body?.items?.[0]?.summary);
  check('带上了申请人 username', aInbox1.body?.items?.[0]?.actorUsername === `nb${tag}`, aInbox1.body?.items?.[0]?.actorUsername);
  const cInbox1 = await C('GET', '/api/me/notifications');
  check('跟这事无关的路人收件箱没变化（不泄露）', cInbox1.body?.unread?.total === 0, JSON.stringify(cInbox1.body?.unread));

  console.log('\n▸ 3. 同意好友 → 双方各一条');
  await A('POST', `/api/friends/requests/${bId}/accept`);
  await sleep(300);
  const bInbox2 = await B('GET', '/api/me/notifications');
  check('B 收到"成为好友"一条', bInbox2.body?.unread?.byKind?.friend_accepted === 1, JSON.stringify(bInbox2.body?.unread));
  const aInbox2 = await A('GET', '/api/me/notifications');
  check('A 也收到一条（关系变化是双方共享的）', (aInbox2.body?.unread?.byKind?.friend_accepted || 0) === 1, JSON.stringify(aInbox2.body?.unread));

  console.log('\n▸ 4. 好友发新记录 → 收件人拿到摘要 + postId + dayKey');
  await A('POST', '/api/posts', { body: '今天把收件箱做好了，你发东西我下次一定能看到', mood: '🙂 顺手', tags: 'daylog,通知' });
  await sleep(300);
  const bInbox3 = await B('GET', '/api/me/notifications?unread=1');
  const postItem = (bInbox3.body?.items || []).find((n) => n.kind === 'post');
  console.log('  ', JSON.stringify(postItem));
  check('B 收到"新记录"', Boolean(postItem));
  check('摘要里有作者名和正文摘要', /爱丽丝 发了新记录/.test(postItem?.summary || '') && /收件箱做好了/.test(postItem?.summary || ''), postItem?.summary);
  check('带上 postId 和 dayKey（agent 能直接去处理）', Boolean(postItem?.postId) && /^\d{4}-\d{2}-\d{2}$/.test(postItem?.dayKey || ''), `${postItem?.postId} / ${postItem?.dayKey}`);
  check('标记为未读', postItem?.read === false);
  check('只写了一条（不重复）', (bInbox3.body?.items || []).filter((n) => n.kind === 'post').length === 1);

  console.log('\n▸ 5. 作者自己不会被自己的帖子打扰');
  const aInbox3 = await A('GET', '/api/me/notifications?unread=1');
  check('A 的收件箱里没有自己那条 post', !(aInbox3.body?.items || []).some((n) => n.kind === 'post'), JSON.stringify((aInbox3.body?.items || []).map((n) => n.kind)));

  console.log('\n▸ 6. 捎带：任何 API 响应都会带上未读摘要（这才是给 agent 用的）');
  const piggy = await B('GET', '/api/posts?scope=all&limit=1');
  check('响应里有 notifications 字段', Boolean(piggy.body?.notifications), JSON.stringify(Object.keys(piggy.body || {})));
  check('带一句人话 hint', /你有 .*条好友新记录/.test(piggy.body?.notifications?.hint || ''), piggy.body?.notifications?.hint);
  check('hint 里给了下一步怎么做', /\/api\/me\/notifications/.test(piggy.body?.notifications?.hint || ''));
  check('带上未读分类计数', (piggy.body?.notifications?.unread?.byKind?.post || 0) === 1, JSON.stringify(piggy.body?.notifications?.unread));
  const friendsResp = await B('GET', '/api/friends');
  check('别的接口同样捎带（好友列表）', Boolean(friendsResp.body?.notifications?.hint), JSON.stringify(Object.keys(friendsResp.body || {})));
  const inboxResp = await B('GET', '/api/me/notifications');
  check('收件箱接口自己不再套一层捎带（避免重复）', inboxResp.body?.notifications === undefined);

  console.log('\n▸ 7. 标记已读');
  const oneId = postItem?.id;
  const readOne = await B('POST', '/api/me/notifications/read', { ids: [oneId] });
  check('按 id 只标记那一条', readOne.body?.changed === 1, JSON.stringify(readOne.body));
  const afterOne = await B('GET', '/api/me/notifications?unread=1');
  check('剩下的未读还在（好友申请/成为好友）', (afterOne.body?.unread?.total || 0) >= 1, JSON.stringify(afterOne.body?.unread));
  check('已读那条不再出现在未读列表', !(afterOne.body?.items || []).some((n) => n.id === oneId));
  const upTo = await B('POST', '/api/me/notifications/read', { upTo: Date.now() });
  check('upTo 可以一次清掉更早的', upTo.body?.changed >= 1, JSON.stringify(upTo.body));
  const readAll = await B('POST', '/api/me/notifications/read', { all: true });
  check('all 清空未读', readAll.body?.unread?.total === 0, JSON.stringify(readAll.body?.unread));
  const noPiggy = await B('GET', '/api/posts?scope=all&limit=1');
  check('全部已读后，响应里又不再捎带', noPiggy.body?.notifications === undefined);
  const all = await B('GET', '/api/me/notifications?limit=50');
  check('历史仍在（只是已读）', (all.body?.items || []).length >= 2, String((all.body?.items || []).length));

  console.log('\n▸ 7b. "看到"不等于"已读"：只有显式标记才会变');
  {
    // 重新制造一条未读（A 再发一条）
    await A('POST', '/api/posts', { body: '再发一条用来验证已读语义' });
    await sleep(400);
    const seen1 = await B('GET', '/api/posts?scope=all&limit=1');
    check('捎带看到了未读', (seen1.body?.notifications?.unread?.total || 0) >= 1, JSON.stringify(seen1.body?.notifications?.unread));
    const seen2 = await B('GET', '/api/friends');
    check('再看一次依然还是未读（看不会自动标已读）', (seen2.body?.notifications?.unread?.total || 0) >= 1, JSON.stringify(seen2.body?.notifications?.unread));
    const opened = await B('GET', '/api/me/notifications');
    check('打开收件箱看明细也不自动已读', (opened.body?.unread?.total || 0) >= 1, JSON.stringify(opened.body?.unread));
    const stillUnread = await B('GET', '/api/me/notifications?unread=1');
    check('明细里仍是未读状态', (stillUnread.body?.items || []).some((n) => n.read === false), JSON.stringify((stillUnread.body?.items || []).map((n) => n.read)));
    const explicit = await B('POST', '/api/me/notifications/read', { all: true });
    check('只有显式标记才清零', explicit.body?.unread?.total === 0, JSON.stringify(explicit.body?.unread));
    const gone = await B('GET', '/api/posts?scope=all&limit=1');
    check('标记后响应里不再捎带', gone.body?.notifications === undefined);
  }

  console.log('\n▸ 8. 关掉手机推送也照样记收件箱（两层互相独立）');
  hits.length = 0;
  const hitsBefore = hits.length;
  await A('POST', '/api/posts', { body: '第二条：这层跟手机推送无关' });
  await sleep(400);
  const bInbox4 = await B('GET', '/api/me/notifications?unread=1');
  check('收件箱记下了第二条', (bInbox4.body?.unread?.byKind?.post || 0) === 1, JSON.stringify(bInbox4.body?.unread));
  check('B 没配推送通道 → 手机没收到（但收件箱有）', hits.length === hitsBefore, JSON.stringify(hits.map((h) => h.key)));

  console.log('\n▸ 9. 收件箱接口的小约束');
  const bigLimit = await B('GET', '/api/me/notifications?limit=9999');
  check('limit 被夹在合理范围（不炸数据库）', bigLimit.status === 200 && (bigLimit.body?.items || []).length <= 100, String((bigLimit.body?.items || []).length));
  const anon = await fetch(`${BASE}/api/me/notifications`);
  check('未登录访问收件箱 → 401', anon.status === 401, String(anon.status));
} finally {
  child.kill();
  endpoint.close();
  await sleep(200);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
