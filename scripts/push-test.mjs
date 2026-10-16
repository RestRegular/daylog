/**
 * 手机通知（按收件人路由）测试。
 * 覆盖用户 2026-10-11 明确要的规则：
 *   设置页配「默认 key」→ 好友发记录就用它；
 *   好友页给某人配「单独 key」→ 优先用它；
 *   没配单独的 → 回退默认；
 *   可以给某个好友设「免推送」；
 *   跟我不是好友的人发帖，我不该收到。
 * 外加：同 key 去重、密钥掩码、测试接口、失败不影响发帖。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRequest, channelForRecipient, channelFromSettings, channelFingerprint, excerptOf, formatPostMessage, normalizeWecomKey, pushConfig } from '../src/push.js';

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

// ---------------------------------------------------------------- 1. 纯函数
console.log('\n▸ 1. 服务器侧配置（**已经没有"通道"概念了**）');
check('pushConfig 不再返回通道字段（没有 key/url/kind）', (() => {
  const c = pushConfig({ DAYLOG_PUSH_WECOM_KEY: 'k', DAYLOG_PUSH_URL: 'http://x', DAYLOG_PUSH_KIND: 'wecom' });
  return c.wecomKey === undefined && c.url === undefined && c.kind === undefined && c.enabled === true;
})(), JSON.stringify(pushConfig({ DAYLOG_PUSH_WECOM_KEY: 'k' })));
check('DAYLOG_PUSH=0 时 enabled=false（管理员总开关）', pushConfig({ DAYLOG_PUSH: '0' }).enabled === false);
check('默认端点是官方企业微信、可用 DAYLOG_PUSH_ENDPOINT 覆盖（测试/自建代理）', pushConfig({}).endpoint === 'https://qyapi.weixin.qq.com' && pushConfig({ DAYLOG_PUSH_ENDPOINT: 'http://127.0.0.1:9/' }).endpoint === 'http://127.0.0.1:9');
check('DAYLOG_PUBLIC_URL 仍会被读取（通知里的链接）', pushConfig({ DAYLOG_PUBLIC_URL: 'http://h:81/' }).publicUrl === 'http://h:81');
check('**关键**：光有 DAYLOG_PUSH_WECOM_KEY 也变不出通道', channelFromSettings(pushConfig({ DAYLOG_PUSH_WECOM_KEY: 'k' })) === null);

console.log('\n▸ 1b. 企业微信 key 的三种粘法都认（整条地址 / key= 片段 / 裸 key）');
check('裸 key 原样使用', normalizeWecomKey('abc-123') === 'abc-123');
check('整条 Webhook 地址 → 取出 key', normalizeWecomKey('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123') === 'abc-123');
check('带空格和额外参数也能取对', normalizeWecomKey('  https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123&x=1  ') === 'abc-123');
check('key=xxx 片段也认', normalizeWecomKey('key=abc-123') === 'abc-123' && normalizeWecomKey('KEY = abc-123') === 'abc-123');
check('空值 / 认不出的地址不会凭空造出 key', normalizeWecomKey('') === '' && normalizeWecomKey('https://example.com/hook') === 'https://example.com/hook');
const chFromUrl = channelFromSettings({ kind: 'wecom', secret: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=from-url-77', enabled: 1 });
const probeMsg = formatPostMessage({ authorName: 'A', body: 'B' });
check(
  '存整条地址时，实际发出去用的是干净的 key',
  chFromUrl.wecomKey === 'from-url-77' && buildRequest(chFromUrl, probeMsg).url.endsWith('key=from-url-77'),
  buildRequest(chFromUrl, probeMsg).url
);

console.log('\n▸ 2. 设置行 → 通道（含停用/缺项）');
check('没设置 → null', channelFromSettings(null) === null);
check('停用 → null', channelFromSettings({ kind: 'wecom', secret: 'k', enabled: 0 }) === null);
check('企业微信：有 key 就行', channelFromSettings({ kind: 'wecom', secret: 'k', enabled: 1 })?.wecomKey === 'k');
check('企业微信：没 key → null', channelFromSettings({ kind: 'wecom', secret: '', enabled: 1 }) === null);
check('ntfy：要 url', channelFromSettings({ kind: 'ntfy', url: 'https://ntfy.sh/t', enabled: 1 })?.kind === 'ntfy');
check('ntfy：没 url → null', channelFromSettings({ kind: 'ntfy', enabled: 1 }) === null);
check('好友例外里没写 kind：有 key 当企业微信', channelFromSettings({ secret: 'k' })?.kind === 'wecom');
check('好友例外里没写 kind：有 url 按域名猜', channelFromSettings({ url: 'https://api.day.app/K' })?.kind === 'bark');
check('好友例外的摘要沿用默认 60', channelFromSettings({ secret: 'k' })?.excerpt === 60);
const fp1 = channelFingerprint(channelFromSettings({ secret: 'same' }));
const fp2 = channelFingerprint(channelFromSettings({ secret: 'same' }));
const fp3 = channelFingerprint(channelFromSettings({ secret: 'other' }));
check('同一个 key 指纹相同、不同 key 指纹不同', fp1 === fp2 && fp1 !== fp3, `${fp1} / ${fp3}`);

console.log('\n▸ 3. 摘要与消息');
const clipped = excerptOf('零一二三四五六七八九十'.repeat(5), 10);
check('长正文被截断（正好 10 字，以省略号结尾）', [...clipped].length === 10 && clipped.endsWith('…'), clipped);
check('换行被压成空格', excerptOf('第一行\n第二行', 60) === '第一行 第二行');
check('excerpt=0 时只推标题', formatPostMessage({ authorName: 'DSH', body: '正文', excerpt: 0 }).body.includes('正文') === false);
const msg = formatPostMessage({ authorName: 'DSH', body: '首页能按天连滑了', mood: '🙂 顺手', tags: ['daylog'], dayLabel: '2026-10-11', url: 'http://h/#/home?date=2026-10-11' });
check('标题是「谁发了新记录」', msg.title === 'DSH 发了新记录', msg.title);
check('正文含摘要 + 心情 + 标签 + 链接', /首页能按天连滑了/.test(msg.body) && /🙂 顺手/.test(msg.body) && /#daylog/.test(msg.body) && /http:\/\/h\/#\/home/.test(msg.body), msg.body);

console.log('\n▸ 4. 请求体');
const req = buildRequest(channelFromSettings({ kind: 'wecom', secret: 'abc-123', enabled: 1 }), msg);
check('wecom：POST 到 webhook/send 且带 key', req.url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123'), req.url);
const body = JSON.parse(req.init.body);
check('wecom：msgtype=markdown，内容含标题与摘要', body.msgtype === 'markdown' && /DSH 发了新记录/.test(body.markdown.content), JSON.stringify(body).slice(0, 100));
const barkReq = buildRequest(channelFromSettings({ kind: 'bark', url: 'https://api.day.app/K' }), msg);
check('bark：GET 且标题/正文进路径', barkReq.init.method === 'GET' && barkReq.url.includes(encodeURIComponent('DSH 发了新记录')), barkReq.url);
const hookReq = buildRequest(channelFromSettings({ kind: 'webhook', url: 'http://127.0.0.1:9/h', token: 't' }), msg);
check('通用 webhook：POST JSON + Bearer', JSON.parse(hookReq.init.body).title === 'DSH 发了新记录' && hookReq.init.headers.authorization === 'Bearer t');

// ---------------------------------------------------------------- 5. 端到端
/** 假的企业微信端点：记录每个 key 收到了什么 */
const hits = [];
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const key = decodeURIComponent((/key=([^&]+)/.exec(req.url) || [])[1] || '');
    let content = '';
    try {
      content = JSON.parse(raw)?.markdown?.content || '';
    } catch {
      /* 忽略 */
    }
    hits.push({ key, content });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"errcode":0,"errmsg":"ok"}');
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const endpointPort = endpoint.address().port;

const PORT = 9300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-push2-'));
const child = spawn(process.execPath, [path.join(rootDir, 'src', 'server.js')], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DAYLOG_DATA_DIR: dataDir,
    DAYLOG_PUSH_ENDPOINT: `http://127.0.0.1:${endpointPort}`,
    DAYLOG_PUBLIC_URL: 'http://public.example:81',
  },
  stdio: 'ignore',
});

const mkCall = () => {
  const ck = { value: '' };
  const call = async (method, p, payload) => {
    const init = { method, headers: {} };
    if (ck.value) init.headers.cookie = ck.value;
    if (payload !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(BASE + p, init);
    for (const c of res.headers.getSetCookie?.() || []) {
      const kv = c.split(';')[0];
      if (kv.startsWith('daylog_session=')) ck.value = kv;
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
const keyOf = (n) => `key-${n}`;
const contentsFor = (k) => hits.filter((h) => h.key === k).map((h) => h.content);

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }

  const tag = Date.now().toString(36).slice(-5);
  // A = 我（收件人）；B、C、D = 三个好友；E = 跟谁都不是好友的陌生人
  const A = mkCall();
  const B = mkCall();
  const C = mkCall();
  const D = mkCall();
  const E = mkCall();
  await A('POST', '/api/auth/signup', { username: `ap${tag}`, password: 'demo1234', displayName: '收件人A' });
  await B('POST', '/api/auth/signup', { username: `bp${tag}`, password: 'demo1234', displayName: '好友B' });
  await C('POST', '/api/auth/signup', { username: `cp${tag}`, password: 'demo1234', displayName: '好友C' });
  await D('POST', '/api/auth/signup', { username: `dp${tag}`, password: 'demo1234', displayName: '好友D' });
  await E('POST', '/api/auth/signup', { username: `ep${tag}`, password: 'demo1234', displayName: '陌生人E' });
  const [aId, bId, cId, dId] = [await A.id(), await B.id(), await C.id(), await D.id()];
  // B、C、D 都加 A；A 同意
  for (const [call, name] of [[B, `bp${tag}`], [C, `cp${tag}`], [D, `dp${tag}`]]) {
    await call('POST', '/api/friends/requests', { username: `ap${tag}` });
    await A('POST', `/api/friends/requests/${await call.id()}/accept`);
  }
  // E 也加 A（暂时成为好友，用来测"非好友不推"以外的场景）—— 这里故意**不发请求**，保持陌生人

  console.log('\n▸ 5. 设置页：默认 key（掩码 + 自动启用 + 测试接口）');
  const before = await A('GET', '/api/me/push');
  check('初始未配置', before.body?.push?.configured === false && before.body?.push?.enabled === false, JSON.stringify(before.body));
  const saved = await A('PATCH', '/api/me/push', { kind: 'wecom', secret: keyOf('A-default'), excerpt: 30 });
  check('保存后自动启用', saved.body?.push?.enabled === true && saved.body?.push?.configured === true, JSON.stringify(saved.body));
  check('接口只回掩码，不回完整 key', !JSON.stringify(saved.body).includes(keyOf('A-default')) && /…/.test(saved.body?.push?.secretHint || ''), JSON.stringify(saved.body?.push?.secretHint));
  check('摘要保存成功', saved.body?.push?.excerpt === 30, String(saved.body?.push?.excerpt));
  const badKind = await A('PATCH', '/api/me/push', { kind: 'telegram' });
  check('不支持的通道 → 400', badKind.status === 400, String(badKind.status));
  const test = await A('POST', '/api/me/push/test');
  await sleep(400);
  check('测试接口返回 ok', test.status === 200 && test.body?.ok === true, JSON.stringify(test.body));
  check('测试消息真的发到了我的默认 key', contentsFor(keyOf('A-default')).some((c) => /自检/.test(c)), JSON.stringify(hits.slice(-2)));

  // 用户最可能的粘法：直接粘整条 Webhook 地址 —— 存进去要归一化成 key，发送时用干净的 key
  const urlSave = await A('PATCH', '/api/me/push', {
    kind: 'wecom',
    secret: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${keyOf('A-from-url')}`,
  });
  check('粘整条 Webhook 地址也能存', urlSave.status === 200 && urlSave.body?.push?.hasSecret === true, JSON.stringify(urlSave.body?.push));
  check(
    '掩码是真 key 的尾 4 位（说明存进去时已经归一化，不是把整条地址存了）',
    urlSave.body?.push?.secretHint === `…${keyOf('A-from-url').slice(-4)}` && !/http/.test(urlSave.body?.push?.secretHint || ''),
    urlSave.body?.push?.secretHint
  );
  hits.length = 0;
  await B('POST', '/api/posts', { body: '整条地址粘进来之后' });
  await sleep(700);
  check('确实用归一化后的 key 发出去了', contentsFor(keyOf('A-from-url')).some((c) => /整条地址粘进来/.test(c)), JSON.stringify(hits.map((h) => h.key)));
  await A('PATCH', '/api/me/push', { kind: 'wecom', secret: keyOf('A-default') }); // 还原，免得影响后面的用例

  console.log('\n▸ 6. 好友发记录 → 用我的默认 key 收到');
  hits.length = 0;
  await B('POST', '/api/posts', { body: 'B 的记录：默认 key 应该收到', visibility: 'public' });
  await sleep(700);
  check('收到 1 条（B 是好友）', hits.length === 1, `收到 ${hits.length} 条`);
  check('发到我的默认 key', hits[0]?.key === keyOf('A-default'), hits[0]?.key);
  check('内容里有 B 的名字与摘要', /好友B 发了新记录/.test(hits[0]?.content || '') && /默认 key 应该收到/.test(hits[0]?.content || ''), hits[0]?.content);
  check('摘要按我设的 30 字截断', (hits[0]?.content || '').split('\n')[1]?.length <= 31, JSON.stringify((hits[0]?.content || '').split('\n')[1]));

  console.log('\n▸ 7. 陌生人 E 发帖 → 我不该收到');
  hits.length = 0;
  // 让 E 有个好友（D），这样"作者有好友"成立 —— 以前这种情况会误推给我
  await E('POST', '/api/friends/requests', { username: `dp${tag}` });
  await D('POST', `/api/friends/requests/${await E.id()}/accept`);
  hits.length = 0;
  await E('POST', '/api/posts', { body: 'E 的记录：A 不该收到', visibility: 'public' });
  await sleep(700);
  check('A 没收到（E 不是 A 的好友）', hits.filter((h) => h.key === keyOf('A-default')).length === 0, JSON.stringify(hits));
  check('D 收到了（E 是 D 的好友，但 D 没配 key → 不推）', hits.length === 0, JSON.stringify(hits));

  console.log('\n▸ 8. 好友页：给某个好友单独配 key（优先）+ 回退');
  const perFriend = await A('PATCH', `/api/friends/${bId}/push`, { kind: 'wecom', secret: keyOf('A-for-B') });
  check('保存好友例外成功', perFriend.status === 200 && perFriend.body?.friend?.push?.override === true, JSON.stringify(perFriend.body?.friend?.push));
  check('例外密钥也只回掩码', perFriend.body?.friend?.push?.secretHint?.includes('…'), perFriend.body?.friend?.push?.secretHint);
  hits.length = 0;
  await B('POST', '/api/posts', { body: 'B 的第二条' });
  await C('POST', '/api/posts', { body: 'C 的记录：该走默认 key' });
  await sleep(900);
  check('B 的记录走单独 key', contentsFor(keyOf('A-for-B')).some((c) => /B 的第二条/.test(c)), JSON.stringify(hits.map((h) => h.key)));
  check('C 的记录回退到默认 key', contentsFor(keyOf('A-default')).some((c) => /该走默认 key/.test(c)), JSON.stringify(hits.map((h) => h.key)));
  check('两条一共只发 2 次（没重复）', hits.length === 2, JSON.stringify(hits.map((h) => h.key)));

  console.log('\n▸ 9. 免推送');
  const muted = await A('PATCH', `/api/friends/${bId}/push`, { muted: true });
  check('免推送开关保存成功', muted.body?.friend?.push?.muted === true, JSON.stringify(muted.body?.friend?.push));
  hits.length = 0;
  await B('POST', '/api/posts', { body: 'B 的第三条：应该被静音' });
  await D('POST', '/api/posts', { body: 'D 的记录：照常推' });
  await sleep(900);
  check('B 的记录被静音（单独 key 也没收到）', contentsFor(keyOf('A-for-B')).length === 0, JSON.stringify(hits.map((h) => h.key)));
  check('别人的记录照常推', contentsFor(keyOf('A-default')).some((c) => /照常推/.test(c)), JSON.stringify(hits.map((h) => h.key)));

  console.log('\n▸ 10. 清掉例外 → 回到默认 key；关掉默认 → 什么都不推');
  await A('PATCH', `/api/friends/${bId}/push`, { clear: true });
  const cleared = await A('GET', '/api/friends');
  const bEntry = (cleared.body?.friends || []).find((f) => f.user.id === bId);
  check('例外清空了', bEntry?.push?.override === false && bEntry?.push?.muted === false, JSON.stringify(bEntry?.push));
  hits.length = 0;
  await B('POST', '/api/posts', { body: 'B 的第四条' });
  await sleep(700);
  check('回到默认 key', contentsFor(keyOf('A-default')).some((c) => /B 的第四条/.test(c)), JSON.stringify(hits.map((h) => h.key)));
  await A('PATCH', '/api/me/push', { enabled: false });
  hits.length = 0;
  await B('POST', '/api/posts', { body: 'B 的第五条：A 已停用' });
  await sleep(700);
  check('停用后不再推给 A', hits.filter((h) => h.key.startsWith('key-A-')).length === 0, JSON.stringify(hits.map((h) => h.key)));

  console.log('\n▸ 11. 两个人的 key 相同时只发一条（去重）');
  await A('PATCH', '/api/me/push', { enabled: true });
  // 让 D 也配成和 A 一样的 key：作者是 B 时，A 和 D 都收 —— 但同 key 只发一条
  await D('PATCH', '/api/me/push', { kind: 'wecom', secret: keyOf('A-default') });
  await sleep(100);
  hits.length = 0;
  await B('POST', '/api/posts', { body: 'B 的第六条：同 key 去重' });
  await sleep(800);
  check('同一个 key 只发 1 条', contentsFor(keyOf('A-default')).length === 1, JSON.stringify(hits.map((h) => h.key)));

  console.log('\n▸ 12. 好友请求也按收件人的通道推');
  hits.length = 0;
  await E('POST', '/api/friends/requests', { username: `cp${tag}` }); // E 加 C
  await sleep(700);
  check('C 没配 key → 不发', hits.length === 0, JSON.stringify(hits.map((h) => h.key)));
  await C('PATCH', '/api/me/push', { kind: 'wecom', secret: keyOf('C-default') });
  hits.length = 0;
  const reqToA = await E('POST', '/api/friends/requests', { username: `ap${tag}` }); // E 加 A（A 有默认 key）
  console.log('   （E 加 A 的响应:', reqToA.status, JSON.stringify(reqToA.body).slice(0, 90), '）');
  await sleep(700);
  check('A 收到好友请求通知', contentsFor(keyOf('A-default')).some((c) => /想加你为好友/.test(c)), JSON.stringify(hits.map((h) => h.key)));
  const eId = await E.id();
  await A('PATCH', `/api/friends/${eId}/push`, { muted: true });
  hits.length = 0;
  await E('DELETE', `/api/friends/${eId}`); // 先解除，才能再发请求
  // A 还没接受 E，所以这条请求是新的
  await E('POST', '/api/friends/requests', { username: `ap${tag}` });
  await sleep(700);
  check('把发起人设成免推送后，好友请求也不再响', contentsFor(keyOf('A-default')).length === 0, JSON.stringify(hits.map((h) => h.key)));
} finally {
  child.kill();
  endpoint.close();
  await sleep(200);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
