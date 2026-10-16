/**
 * 端到端自测：真实启动服务器（独立数据目录），用 HTTP 走完全部核心流程。
 * 运行：node scripts/e2e.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daylog-e2e-'));
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n▸ ${title}`);
}

// ---- 构造一张最小合法 PNG（客户端上传测试用）----
function makePng(width = 8, height = 8) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + 1 + x * 3;
      raw[i] = (x * 32) % 256;
      raw[i + 1] = (y * 32) % 256;
      raw[i + 2] = 180;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of Buffer.concat([typeBuf, data])) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = makePng(16, 12);

// ---- HTTP 辅助 ----
let cookie = '';
async function req(method, url, { body, json, form, headers = {}, raw = false } = {}) {
  const init = { method, headers: { 'x-daylog-tz': 'Asia/Shanghai', ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  } else if (body) {
    init.body = body;
  }
  const res = await fetch(`${BASE}${url}`, init);
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const c of setCookies) {
    const first = c.split(';')[0];
    if (!first.startsWith('daylog_session=')) continue;
    const value = first.slice('daylog_session='.length);
    cookie = value ? `daylog_session=${value}` : '';
  }
  if (raw) return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 200) };
  }
  return { res, payload };
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 继续等待 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务器启动超时');
}

// ---- 启动服务器 ----
console.log(`启动测试服务器（数据目录：${dataDir}）…`);
const child = spawn(
  process.execPath,
  ['--no-warnings=ExperimentalWarning', path.join(root, 'src', 'server.js')],
  {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DAYLOG_DATA_DIR: dataDir, DAYLOG_LOG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let serverOut = '';
child.stdout.on('data', (d) => {
  serverOut += d.toString();
});
child.stderr.on('data', (d) => {
  serverOut += d.toString();
});

let exitCode = 0;
try {
  const health = await waitForServer();
  check('服务启动 /api/health', health.ok === true, JSON.stringify(health));

  section('账号');
  const signup = await req('POST', '/api/auth/signup', {
    json: { username: 'tester', password: 'secret123', displayName: '测试用户', timezone: 'Asia/Shanghai' },
  });
  check('注册成功并返回用户', signup.res.status === 201 && signup.payload.user?.username === 'tester', `status=${signup.res.status}`);
  check('注册返回会话 Cookie', cookie.startsWith('daylog_session='), cookie);

  const me = await req('GET', '/api/auth/me');
  check('会话有效 /api/auth/me', me.payload.user?.username === 'tester');
  check(
    '不再下发永久分享令牌（分享改成每次生成限时链接）',
    !('shareToken' in (me.payload.user || {})),
    Object.keys(me.payload.user || {}).join(',')
  );

  const dupe = await req('POST', '/api/auth/signup', { json: { username: 'tester', password: 'secret123' } });
  check('重复用户名被拒绝', dupe.res.status === 409, `status=${dupe.res.status}`);

  const badPass = await req('POST', '/api/auth/signup', { json: { username: 'another', password: '123' } });
  check('弱密码被拒绝', badPass.res.status === 400, `status=${badPass.res.status}`);

  section('发布动态');
  const now = Date.now();
  const p1 = await req('POST', '/api/posts', {
    json: { body: '今天写了一个小工具 #开发', location: '家', mood: '😀', tags: '开发,效率', createdAt: now },
  });
  check('纯文本动态发布成功', p1.res.status === 201 && p1.payload.post?.body.includes('小工具'), `status=${p1.res.status}`);
  const postId = p1.payload.post?.id;
  check('返回 postDay（本地日期）', /^\d{4}-\d{2}-\d{2}$/.test(p1.payload.post?.postDay || ''), p1.payload.post?.postDay);

  const empty = await req('POST', '/api/posts', { json: { body: '   ' } });
  check('空内容被拒绝', empty.res.status === 400, `status=${empty.res.status}`);

  const future = await req('POST', '/api/posts', { json: { body: '未来', createdAt: now + 48 * 3600 * 1000 } });
  check('过远的未来时间被拒绝', future.res.status === 400, `status=${future.res.status}`);

  section('图片 / 视频附件');
  const fd = new FormData();
  fd.append('media', new Blob([png], { type: 'image/png' }), 'photo.png');
  fd.append(
    'post',
    JSON.stringify({
      body: '带图片的记录',
      createdAt: now,
      timezone: 'Asia/Shanghai',
      mediaMeta: [{ width: 16, height: 12, duration: null }],
    })
  );
  const p2 = await req('POST', '/api/posts', { form: fd });
  check('multipart 图片发布成功', p2.res.status === 201, `status=${p2.res.status} ${JSON.stringify(p2.payload).slice(0, 160)}`);
  const media = p2.payload.post?.media?.[0];
  check('附件元数据入库', media?.kind === 'image' && media?.width === 16 && media?.bytes > 0, JSON.stringify(media));

  const mediaRes = await req('GET', media.url, { raw: true });
  check('附件可访问且是 PNG', mediaRes.res.status === 200 && mediaRes.buffer.subarray(1, 4).toString() === 'PNG', `status=${mediaRes.res.status}`);

  const rangeRes = await fetch(`${BASE}${media.url}`, { headers: { range: 'bytes=0-7' } });
  check('附件支持 Range（视频拖动进度条）', rangeRes.status === 206 && rangeRes.headers.get('content-range')?.startsWith('bytes 0-7/'), `status=${rangeRes.status}`);

  section('视频 + 封面');
  const fakeVideo = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2048, 7)]);
  const fd2 = new FormData();
  fd2.append('media', new Blob([fakeVideo], { type: 'video/mp4' }), 'clip.mp4');
  fd2.append('poster', new Blob([png], { type: 'image/jpeg' }), 'poster.jpg');
  fd2.append('post', JSON.stringify({ body: '带视频的记录', mediaMeta: [{ width: 1280, height: 720, duration: 12.5 }] }));
  const p3 = await req('POST', '/api/posts', { form: fd2 });
  check('视频发布成功', p3.res.status === 201, `status=${p3.res.status}`);
  const video = p3.payload.post?.media?.[0];
  check('视频元数据与封面', video?.kind === 'video' && video?.duration === 12.5 && !!video?.posterUrl, JSON.stringify(video));
  if (video?.posterUrl) {
    const poster = await req('GET', video.posterUrl, { raw: true });
    check('封面可访问', poster.res.status === 200 && poster.buffer.length > 0, `status=${poster.res.status}`);
  }

  section('时间线查询');
  const list = await req('GET', '/api/posts?limit=10');
  check('列表返回 3 条', list.payload.posts?.length === 3, `count=${list.payload.posts?.length}`);
  check('按时间倒序', (list.payload.posts?.[0]?.createdAt || 0) >= (list.payload.posts?.[1]?.createdAt || 0));

  const day = p1.payload.post.postDay;
  const byDay = await req('GET', `/api/posts?from=${day}&to=${day}`);
  check('按日期过滤', byDay.payload.posts?.length === 3, `count=${byDay.payload.posts?.length}`);

  const search = await req('GET', '/api/posts?q=' + encodeURIComponent('小工具'));
  check('关键词搜索', search.payload.posts?.length === 1, `count=${search.payload.posts?.length}`);

  const byTag = await req('GET', '/api/posts?tag=' + encodeURIComponent('开发'));
  check('标签搜索', byTag.payload.posts?.length === 1, `count=${byTag.payload.posts?.length}`);

  const cal = await req('GET', `/api/calendar?month=${day.slice(0, 7)}`);
  check('日历统计', (cal.payload.days || []).some((d) => d.day_key === day && d.c >= 3), JSON.stringify(cal.payload.days));

  section('编辑与删除');
  const patched = await req('PATCH', `/api/posts/${postId}`, { json: { body: '改过的内容', location: '公司' } });
  check('编辑动态', patched.payload.post?.body === '改过的内容' && patched.payload.post?.location === '公司');

  // 两个时间：createdAt 是发布时间（发布后固定），occurredAt 是「事情发生的时间」（可改）
  section('发布时间 / 事情发生时间');
  {
    const madeAt = (await req('GET', `/api/posts/${postId}`)).payload.post?.createdAt;
    const happened = Date.parse('2024-03-05T09:30:00+08:00');
    const moved = await req('PATCH', `/api/posts/${postId}`, { json: { occurredAt: happened } });
    check('改 occurredAt 后重算日期', moved.payload.post?.postDay === '2024-03-05', moved.payload.post?.postDay);
    check('occurredAt 落库', moved.payload.post?.occurredAt === happened, String(moved.payload.post?.occurredAt));
    check('发布时间 createdAt 一点没变', moved.payload.post?.createdAt === madeAt, `${moved.payload.post?.createdAt} vs ${madeAt}`);

    const backdated = await req('POST', '/api/posts', {
      json: { body: '补记前天的事', occurredAt: Date.parse('2024-03-01T08:00:00+08:00') },
    });
    check('创建时可以只给 occurredAt', backdated.payload.post?.occurredAt === Date.parse('2024-03-01T08:00:00+08:00'), String(backdated.payload.post?.occurredAt));
    check('创建时发布时间是"现在"', Math.abs(backdated.payload.post?.createdAt - Date.now()) < 60_000, String(backdated.payload.post?.createdAt));
    check('postDay 按 occurredAt 算', backdated.payload.post?.postDay === '2024-03-01', String(backdated.payload.post?.postDay));

    // 排序按 occurredAt：把上面那条改到"最晚发生"，它应该排在"前天那条"前面
    await req('PATCH', `/api/posts/${postId}`, { json: { occurredAt: Date.parse('2024-03-09T09:30:00+08:00') } });
    const ordered = await req('GET', '/api/posts?limit=100&scope=mine');
    const ids = (ordered.payload.posts || []).map((p) => p.id);
    check(
      '时间线按 occurredAt 排序（后发生的排前面）',
      ids.indexOf(postId) >= 0 && ids.indexOf(postId) < ids.indexOf(backdated.payload.post?.id),
      JSON.stringify((ordered.payload.posts || []).map((p) => [p.id, p.postDay]))
    );
    await req('PATCH', `/api/posts/${postId}`, { json: { occurredAt: Date.parse('2024-03-05T09:30:00+08:00') } });
    check('缺 occurredAt 的老记录也返回（回填成 created_at）', (ordered.payload.posts || []).every((p) => Number.isFinite(p.occurredAt)), JSON.stringify((ordered.payload.posts || []).map((p) => p.occurredAt)));
  }

  const del = await req('DELETE', `/api/posts/${postId}`);
  check('删除动态', del.res.status === 200 && del.payload.ok === true, `status=${del.res.status}`);
  const afterDel = await req('GET', `/api/posts/${postId}`);
  check('删除后不可访问', afterDel.res.status === 404, `status=${afterDel.res.status}`);

  section('隐私与分享');
  const priv = await req('POST', '/api/posts', { json: { body: '这是私密内容', visibility: 'private' } });
  check('发布私密动态', priv.res.status === 201);

  // 新模型：链接要现场生成，范围和有效期都绑在这条记录上（链接里不再有 range/date 参数）
  const allLinkRes = await req('POST', '/api/share/links', { json: { scope: 'all' } });
  check(
    '生成「全部」限时分享链接',
    allLinkRes.res.status === 201 && allLinkRes.payload.link?.scope === 'all',
    `status=${allLinkRes.res.status} ${JSON.stringify(allLinkRes.payload).slice(0, 160)}`
  );
  const allToken = allLinkRes.payload.link?.token || '';
  check('链接地址是 /s/<token>', allLinkRes.payload.link?.url === `/s/${allToken}`, String(allLinkRes.payload.link?.url));
  check('不传 hours 时默认 7 天', allLinkRes.payload.hours === 168, String(allLinkRes.payload.hours));

  const other = await req('POST', '/api/auth/signup', { json: { username: 'viewer', password: 'secret123' } });
  check('第二个账号注册成功', other.res.status === 201, `status=${other.res.status}`);
  const viewerCookie = cookie;

  cookie = '';
  const anonProfile = await req('GET', `/api/s/${allToken}`);
  check('陌生人可读取分享页资料', anonProfile.res.status === 200 && anonProfile.payload.profile?.username === 'tester', `status=${anonProfile.res.status}`);
  check('访客不是主人（isOwner=false）', anonProfile.payload.isOwner === false, String(anonProfile.payload.isOwner));
  const anonPosts = await req('GET', `/api/s/${allToken}/posts?limit=20`);
  const bodies = (anonPosts.payload.posts || []).map((p) => p.body);
  check('陌生人能看到公开内容', bodies.some((b) => b.includes('带图片的记录')), JSON.stringify(bodies));
  check('陌生人看不到 private 内容', !bodies.some((b) => b.includes('私密')), JSON.stringify(bodies));
  const anonMedia = await req('GET', media.url, { raw: true });
  check('陌生人可加载分享内容中的图片', anonMedia.res.status === 200, `status=${anonMedia.res.status}`);

  const badToken = await req('GET', '/api/s/notexisttoken/posts');
  check('无效分享链接返回 404', badToken.res.status === 404, `status=${badToken.res.status}`);

  cookie = viewerCookie;
  const viewerSeesPrivate = await req('GET', `/api/s/${allToken}/posts`);
  check('他人登录后同样看不到 private', !(viewerSeesPrivate.payload.posts || []).some((p) => p.body.includes('私密')));

  section('限时分享链接（范围绑定 / 失效语义 / 管理）');
  cookie = '';
  const login = await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
  check('重新登录成功', login.res.status === 200 && login.payload.user?.username === 'tester', `status=${login.res.status}`);
  const ownerMe = await req('GET', '/api/auth/me');
  check('登录态里没有 shareToken', !('shareToken' in (ownerMe.payload.user || {})), Object.keys(ownerMe.payload.user || {}).join(','));
  check('登录态里没有 shareEnabled（旧开关已删除）', !('shareEnabled' in (ownerMe.payload.user || {})));

  // 造一条「很久以前」的记录：它不在 day / month 链接的范围内，用来证明范围真的被链接锁死
  const oldDay = '2024-03-05';
  const oldPost = await req('POST', '/api/posts', {
    json: { body: '很久以前的一条', createdAt: Date.parse('2024-03-05T09:30:00+08:00') },
  });
  check('造一条旧日期的记录', oldPost.res.status === 201 && oldPost.payload.post?.postDay === oldDay, oldPost.payload.post?.postDay);
  const oldPostId = oldPost.payload.post?.id;

  // 三种范围：day / month / all
  const dayLinkRes = await req('POST', '/api/share/links', { json: { scope: 'day', day, hours: 24 } });
  check(
    '生成「某一天」的链接',
    dayLinkRes.res.status === 201 && dayLinkRes.payload.link?.scope === 'day' && dayLinkRes.payload.link?.day === day,
    `status=${dayLinkRes.res.status} ${JSON.stringify(dayLinkRes.payload).slice(0, 160)}`
  );
  check('按天链接的时效可选 24 小时', dayLinkRes.payload.hours === 24, String(dayLinkRes.payload.hours));
  const monthLinkRes = await req('POST', '/api/share/links', { json: { scope: 'month', month: day.slice(0, 7) } });
  check(
    '生成「某个月」的链接',
    monthLinkRes.res.status === 201 && monthLinkRes.payload.link?.scope === 'month' && monthLinkRes.payload.link?.month === day.slice(0, 7),
    `status=${monthLinkRes.res.status} ${JSON.stringify(monthLinkRes.payload).slice(0, 160)}`
  );
  const dayToken = dayLinkRes.payload.link.token;
  const monthToken = monthLinkRes.payload.link.token;

  check('非法范围被拒绝', (await req('POST', '/api/share/links', { json: { scope: 'week' } })).res.status === 400);
  check('按天但没给日期被拒绝', (await req('POST', '/api/share/links', { json: { scope: 'day' } })).res.status === 400);
  check('按月但月份格式不对被拒绝', (await req('POST', '/api/share/links', { json: { scope: 'month', month: '2024-1' } })).res.status === 400);
  {
    const ownerCookie = cookie;
    cookie = '';
    check('未登录不能生成链接', (await req('POST', '/api/share/links', { json: { scope: 'all' } })).res.status === 401);
    check('未登录不能看链接列表', (await req('GET', '/api/share/links')).res.status === 401);
    check('未登录不能撤销链接', (await req('DELETE', `/api/share/links/${allToken}`)).res.status === 401);
    cookie = ownerCookie;
  }

  const linkList = await req('GET', '/api/share/links');
  const listedTokens = (linkList.payload.links || []).map((l) => l.token);
  check(
    '链接列表返回刚生成的三条',
    [allToken, dayToken, monthToken].every((t) => listedTokens.includes(t)),
    JSON.stringify(listedTokens)
  );

  cookie = '';
  const dayPosts = await req('GET', `/api/s/${dayToken}/posts?limit=50`);
  const dayBodies = (dayPosts.payload.posts || []).map((p) => p.body);
  check('按天链接回传范围内的 from/to', dayPosts.payload.from === day && dayPosts.payload.to === day, JSON.stringify({ from: dayPosts.payload.from, to: dayPosts.payload.to }));
  check('按天链接能读到那一天的内容', dayBodies.includes('带图片的记录'), JSON.stringify(dayBodies));
  check('按天链接读不到别的日期', !dayBodies.includes('很久以前的一条'), JSON.stringify(dayBodies));
  check('按天链接读不到 private', !dayBodies.some((b) => b.includes('私密')), JSON.stringify(dayBodies));
  check('分享页回传所属链接信息', dayPosts.payload.link?.scope === 'day' && dayPosts.payload.link?.token === dayToken, JSON.stringify(dayPosts.payload.link));

  // 客户端传 range / date / from / to 一律无效：范围只认链接
  const forced = await req('GET', `/api/s/${dayToken}/posts?range=all&date=2024-03-05&from=2024-03-01&to=2024-03-31&limit=50`);
  const forcedBodies = (forced.payload.posts || []).map((p) => p.body);
  check(
    '客户端传 range/date 被忽略（仍然只给链接范围内那天的）',
    forced.res.status === 200 &&
      !forcedBodies.includes('很久以前的一条') &&
      forced.payload.from === day &&
      forced.payload.to === day,
    JSON.stringify({ status: forced.res.status, from: forced.payload.from, to: forced.payload.to, bodies: forcedBodies })
  );

  const monthPosts = await req('GET', `/api/s/${monthToken}/posts?limit=50`);
  const monthBodies = (monthPosts.payload.posts || []).map((p) => p.body);
  check('按月链接回传整月范围', monthPosts.payload.from === `${day.slice(0, 7)}-01` && monthPosts.payload.to === `${day.slice(0, 7)}-31`, JSON.stringify({ from: monthPosts.payload.from, to: monthPosts.payload.to }));
  check('按月链接能读到本月内容', monthBodies.includes('带图片的记录'), JSON.stringify(monthBodies));
  check('按月链接读不到别的月份', !monthBodies.includes('很久以前的一条'), JSON.stringify(monthBodies));

  cookie = '';
  const allPosts = await req('GET', `/api/s/${allToken}/posts?limit=50`);
  const allBodies = (allPosts.payload.posts || []).map((p) => p.body);
  check('全部链接能看到跨月的内容', allBodies.includes('很久以前的一条'), JSON.stringify(allBodies));
  check('全部链接也不给 private', !allBodies.some((b) => b.includes('私密')), JSON.stringify(allBodies));

  // 单条：范围外的记录对这条链接同样是 404
  const outOfScope = await req('GET', `/api/s/${dayToken}/posts/${oldPostId}`);
  check('按天链接读范围外的单条 → 404', outOfScope.res.status === 404, `status=${outOfScope.res.status}`);
  const inScope = await req('GET', `/api/s/${allToken}/posts/${oldPostId}`);
  check('全部链接能读同一条', inScope.res.status === 200 && inScope.payload.post?.body === '很久以前的一条', `status=${inScope.res.status}`);

  // 撤销：只能撤销自己的，撤销后 410 share_revoked
  cookie = viewerCookie;
  const otherRevoke = await req('DELETE', `/api/share/links/${dayToken}`);
  check('不能撤销别人的链接（404）', otherRevoke.res.status === 404, `status=${otherRevoke.res.status}`);
  cookie = '';
  await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
  const revoked = await req('DELETE', `/api/share/links/${dayToken}`);
  check('撤销自己的链接', revoked.res.status === 200 && revoked.payload.ok === true, `status=${revoked.res.status}`);
  check('列表里不再有被撤销的链接', !((await req('GET', '/api/share/links')).payload.links || []).some((l) => l.token === dayToken));
  cookie = '';
  const afterRevoke = await req('GET', `/api/s/${dayToken}/posts`);
  check(
    '撤销后链接 410 share_revoked',
    afterRevoke.res.status === 410 && afterRevoke.payload.code === 'share_revoked',
    `status=${afterRevoke.res.status} code=${afterRevoke.payload.code}`
  );
  check('撤销后资料接口同样 410', (await req('GET', `/api/s/${dayToken}`)).res.status === 410);
  check('撤销后单条也读不到', (await req('GET', `/api/s/${dayToken}/posts/${oldPostId}`)).res.status === 410);

  // 过期：没有小于 1 小时的有效期选项，直接把库里的 expires_at 改到过去
  cookie = '';
  await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
  const shortLink = await req('POST', '/api/share/links', { json: { scope: 'all', hours: 1 } });
  const shortToken = shortLink.payload.link.token;
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'daylog.db'));
    db.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, shortToken);
    db.close();
  }
  const beforeExpire = await req('GET', '/api/share/links');
  check('列表不含已过期的链接', !(beforeExpire.payload.links || []).some((l) => l.token === shortToken), JSON.stringify((beforeExpire.payload.links || []).map((l) => l.token)));
  cookie = '';
  const afterExpire = await req('GET', `/api/s/${shortToken}/posts`);
  check(
    '过期后链接 410 share_expired',
    afterExpire.res.status === 410 && afterExpire.payload.code === 'share_expired',
    `status=${afterExpire.res.status} code=${afterExpire.payload.code}`
  );
  check('过期后资料接口同样 410', (await req('GET', `/api/s/${shortToken}`)).res.status === 410);

  // 老模型残留的接口/字段必须彻底消失
  cookie = '';
  await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
  check('老的 /api/share/<token> 已删除（404）', (await req('GET', `/api/share/${allToken}`)).res.status === 404);
  check('老的 /api/share/<token>/posts 已删除（404）', (await req('GET', `/api/share/${allToken}/posts`)).res.status === 404);
  check('重置令牌接口 /api/me/share/rotate 已删除（404）', (await req('POST', '/api/me/share/rotate')).res.status === 404);
  const offRes = await req('PATCH', '/api/me/settings', { json: { shareEnabled: false } });
  check(
    '旧的分享开关不再出现在设置返回里',
    offRes.res.status === 200 && !('shareEnabled' in (offRes.payload.user || {})),
    JSON.stringify(offRes.payload.user)
  );

  section('资料与头像');
  cookie = '';
  await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
  const prof = await req('PATCH', '/api/me/profile', {
    json: { displayName: '测试用户改名', bio: '每天都在折腾', birthday: '1995-06-18', timezone: 'Asia/Shanghai' },
  });
  check(
    '更新资料',
    prof.payload.user?.displayName === '测试用户改名' && prof.payload.user?.birthday === '1995-06-18',
    JSON.stringify(prof.payload.user)
  );
  const badBirthday = await req('PATCH', '/api/me/profile', { json: { birthday: '1995/06/18' } });
  check('非法生日被拒绝', badBirthday.res.status === 400, `status=${badBirthday.res.status}`);

  const avatarForm = new FormData();
  avatarForm.append('avatar', new Blob([png], { type: 'image/png' }), 'me.png');
  const avatarRes = await req('POST', '/api/uploads/avatar', { form: avatarForm });
  check('上传头像', avatarRes.res.status === 200 && String(avatarRes.payload.avatarUrl || '').startsWith('/u/'), `status=${avatarRes.res.status}`);
  const avatarFetch = await req('GET', avatarRes.payload.avatarUrl, { raw: true });
  check('头像可访问', avatarFetch.res.status === 200 && avatarFetch.buffer.length > 0, `status=${avatarFetch.res.status}`);
  {
    // 防回归：头像地址必须带版本号，否则浏览器会把旧头像缓存住
    // （表现：换了头像、刷新后还是旧的 / 显示不出来）
    const meAfterUpload = await req('GET', '/api/auth/me');
    const meUrl = meAfterUpload.payload.user?.avatarUrl || '';
    check('登录态返回的头像地址带版本号', /\?v=\d+/.test(meUrl), meUrl);
    const postsAfterUpload = await req('GET', '/api/posts?limit=1&scope=all');
    const postUrl = postsAfterUpload.payload.posts?.[0]?.author?.avatarUrl || '';
    check('帖子里的作者头像地址带版本号', /\?v=\d+/.test(postUrl), postUrl);

    // 不带版本的老地址（老链接 / 老缓存里可能就是这个形态）必须每次校验
    const plainUrl = String(avatarRes.payload.avatarUrl).split('?')[0];
    const plainFetch = await fetch(BASE + plainUrl, { headers: { cookie } });
    const plain = plainFetch.headers.get('cache-control') || '';
    await plainFetch.arrayBuffer().catch(() => {});
    check('不带版本的头像地址必须校验（no-cache）', /no-cache/.test(plain), `${plainUrl} → ${plain}`);
    const versioned = await fetch(BASE + avatarRes.payload.avatarUrl, { headers: { cookie } });
    check(
      '带版本的头像地址可长期缓存',
      /max-age=31536000/.test(versioned.headers.get('cache-control') || ''),
      versioned.headers.get('cache-control')
    );
    await versioned.arrayBuffer().catch(() => {});
    const lm = avatarFetch.res.headers.get('last-modified') || '';
    const conditional = await fetch(BASE + meUrl.split('?')[0], { headers: { 'if-modified-since': lm } });
    check('条件请求命中 304（不会重复下整张图）', conditional.status === 304, `status=${conditional.status}`);
    await conditional.arrayBuffer().catch(() => {});

    // 换一张头像：地址里的版本号必须跟着变
    const secondForm = new FormData();
    secondForm.append('avatar', new Blob([png], { type: 'image/png' }), 'me2.png');
    const second = await req('POST', '/api/uploads/avatar', { form: secondForm });
    const meAfterSecond = await req('GET', '/api/auth/me');
    check(
      '换头像后地址版本号变化（刷新不会拿到旧图）',
      (meAfterSecond.payload.user?.avatarUrl || '') !== meUrl && /\?v=\d+/.test(meAfterSecond.payload.user?.avatarUrl || ''),
      `${meUrl} -> ${meAfterSecond.payload.user?.avatarUrl}`
    );
    check('两次上传都成功', second.res.status === 200, `status=${second.res.status}`);
  }


  section('统计与导出');
  {
    // 记录卡片主题色：预设 / 跟随头像 / 自定义 #rrggbb，非法值要拒绝
    const preset = await req('PATCH', '/api/me/settings', { json: { cardTheme: 'ocean' } });
    check('可以设置预设主题色', preset.payload.user?.cardTheme === 'ocean', JSON.stringify(preset.payload.user?.cardTheme));
    const custom = await req('PATCH', '/api/me/settings', { json: { cardTheme: '#123456' } });
    check('可以设置自定义主题色', custom.payload.user?.cardTheme === '#123456', JSON.stringify(custom.payload.user?.cardTheme));
    const follow = await req('PATCH', '/api/me/settings', { json: { cardTheme: 'avatar' } });
    check('可以设置为跟随头像', follow.payload.user?.cardTheme === 'avatar');
    const badTheme = await req('PATCH', '/api/me/settings', { json: { cardTheme: 'rainbow' } });
    check('非法主题色被拒绝', badTheme.res.status === 400, `status=${badTheme.res.status}`);
    const meTheme = await req('GET', '/api/auth/me');
    check('登录态返回主题色', meTheme.payload.user?.cardTheme === 'avatar', String(meTheme.payload.user?.cardTheme));
    const postsTheme = await req('GET', '/api/posts?limit=1&scope=all');
    check(
      '记录里也带作者主题色（别人看你的记录要用）',
      'cardTheme' in (postsTheme.payload.posts?.[0]?.author || {}),
      JSON.stringify(postsTheme.payload.posts?.[0]?.author)
    );
    const reset = await req('PATCH', '/api/me/settings', { json: { cardTheme: '' } });
    check('可以恢复默认白', reset.payload.user?.cardTheme === '', JSON.stringify(reset.payload.user?.cardTheme));
  }

  const stats = await req('GET', '/api/me/stats');
  check('统计接口', stats.payload.stats?.posts >= 2, JSON.stringify(stats.payload.stats));
  const exportRes = await fetch(`${BASE}/api/me/export`, { headers: { cookie } });
  const exportJson = await exportRes.json();
  check('导出数据', exportRes.status === 200 && Array.isArray(exportJson.posts) && !('password_hash' in (exportJson.user || {})), `status=${exportRes.status}`);
  check('导出不含密码哈希', !JSON.stringify(exportJson).includes('password_hash'));

  section('好友：查找 / 申请 / 同意 / 合并时间线');
  {
    // tester(当前登录) 与 viewer 建立好友关系
    const me = await req('GET', '/api/auth/me');
    const myId = me.payload.user?.id;

    const lookup = await req('GET', '/api/users/lookup?username=viewer');
    check('按用户名查到用户', lookup.payload.user?.username === 'viewer', JSON.stringify(lookup.payload));
    const viewerId = lookup.payload.user?.id;
    check('查到的关系状态为 none', lookup.payload.friendship === 'none');

    const selfLookup = await req('GET', `/api/users/lookup?username=${me.payload.user.username}`);
    check('查自己返回 isSelf', selfLookup.payload.user?.isSelf === true);

    const missing = await req('GET', '/api/users/lookup?username=nobody_here_xyz');
    check('查不到返回 user=null', missing.payload.user === null);

    const request = await req('POST', '/api/friends/requests', { json: { username: 'viewer' } });
    check('发送好友申请', request.res.status === 201 && request.payload.status === 'pending', `status=${request.res.status}`);

    const dup = await req('POST', '/api/friends/requests', { json: { username: 'viewer' } });
    check('重复申请被拒绝', dup.res.status === 409 && dup.payload.code === 'already_requested', `status=${dup.res.status}`);

    const selfAdd = await req('POST', '/api/friends/requests', { json: { userId: myId } });
    check('不能加自己', selfAdd.res.status === 400 && selfAdd.payload.code === 'self');

    const ghost = await req('POST', '/api/friends/requests', { json: { username: 'no_such_user_xyz' } });
    check('加不存在的用户 404', ghost.res.status === 404, `status=${ghost.res.status}`);

    // viewer 视角：应该看到待处理请求，并同意
    cookie = viewerCookie;
    const inbox = await req('GET', '/api/friends');
    check('对方看到待处理请求', inbox.payload.incoming?.length === 1, JSON.stringify(inbox.payload.incoming));
    const outboxBefore = await req('GET', '/api/friends');
    check('对方好友列表仍为空', outboxBefore.payload.friends?.length === 0);

    const acceptWrong = await req('POST', `/api/friends/requests/${viewerId}/accept`);
    check('同意时传错 id 会失败', acceptWrong.res.status === 404, `status=${acceptWrong.res.status}`);

    const accepted = await req('POST', `/api/friends/requests/${myId}/accept`);
    check('同意好友申请', accepted.res.status === 200 && accepted.payload.ok === true, `status=${accepted.res.status}`);
    const viewerFriends = await req('GET', '/api/friends');
    check('对方好友列表出现 1 人', viewerFriends.payload.friends?.length === 1, JSON.stringify(viewerFriends.payload.friends));

    // 双方各发一条动态，验证合并时间线
    await req('POST', '/api/posts', { json: { body: 'viewer 的公开动态', visibility: 'public' } });
    await req('POST', '/api/posts', { json: { body: 'viewer 的私密动态', visibility: 'private' } });

    cookie = '';
    await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
    await req('POST', '/api/posts', { json: { body: 'tester 的公开动态', visibility: 'public' } });

    const friendScope = await req('GET', '/api/posts?scope=friends&limit=20');
    const friendBodies = (friendScope.payload.posts || []).map((p) => p.body);
    check('scope=friends 只看好友', friendBodies.includes('viewer 的公开动态') && !friendBodies.includes('tester 的公开动态'), JSON.stringify(friendBodies));
    check('好友的私密动态看不到', !friendBodies.some((b) => b.includes('私密')), JSON.stringify(friendBodies));
    check('好友动态带作者信息', friendScope.payload.posts?.[0]?.author?.username === 'viewer', JSON.stringify(friendScope.payload.posts?.[0]?.author));

    // 备注名：给好友起备注后，时间线里的作者显示名要用备注名（真实昵称放 realDisplayName）
    const viewerName = lookup.payload.user?.displayName || 'viewer';
    const aliasRes = await req('PATCH', `/api/friends/${viewerId}`, { json: { alias: '老板' } });
    check('可以设置好友备注名', aliasRes.res.status === 200, `status=${aliasRes.res.status}`);
    const aliasScope = await req('GET', '/api/posts?scope=friends&limit=5');
    const aliasAuthor = aliasScope.payload.posts?.[0]?.author || {};
    check('时间线里显示的是我起的备注名', aliasAuthor.displayName === '老板', JSON.stringify(aliasAuthor));
    check('同时保留真实昵称（供分享页写「昵称（备注）」）', aliasAuthor.realDisplayName === viewerName && aliasAuthor.alias === '老板', JSON.stringify(aliasAuthor));
    await req('PATCH', `/api/friends/${viewerId}`, { json: { alias: '' } });

    // 反方向：**接收方**（当初是对方来加的我）设备注名。
    // 这里踩过坑：UPDATE 只按 `requester_id = ? AND addressee_id = ?` 定位这一行，
    // 接收方设置时命中 0 行 —— 接口回 200、前端提示"已保存"，实际什么都没改。
    {
      cookie = viewerCookie;
      const viewerAlias = await req('PATCH', `/api/friends/${myId}`, { json: { alias: '对面的备注' } });
      check('接收方也能设置备注名', viewerAlias.res.status === 200, `status=${viewerAlias.res.status}`);
      const viewerList = await req('GET', '/api/friends');
      check(
        '接收方设的备注名真的存下来了',
        viewerList.payload.friends?.[0]?.displayName === '对面的备注',
        JSON.stringify(viewerList.payload.friends?.[0])
      );
      const testerTimeline = await req('GET', `/api/u/${me.payload.user.username}/timeline`);
      check(
        '好友时间线页的名片用我的备注名（不再显示真名）',
        testerTimeline.payload.profile?.displayName === '对面的备注' &&
          testerTimeline.payload.profile?.realDisplayName === me.payload.user.displayName,
        JSON.stringify(testerTimeline.payload.profile)
      );
      await req('PATCH', `/api/friends/${myId}`, { json: { alias: '' } });
      const cleared = await req('GET', '/api/friends');
      check(
        '清空备注名后回到真名',
        cleared.payload.friends?.[0]?.displayName === me.payload.user.displayName,
        JSON.stringify(cleared.payload.friends?.[0])
      );
    }

    // 防回归：别人分享页里的记录属于 TA 自己，绝不能被算成"当前登录的访问者"的
    {
      cookie = viewerCookie;
      const viewerLink = await req('POST', '/api/share/links', { json: { scope: 'all', hours: 1 } });
      const viewerToken = viewerLink.payload.link?.token;
      check('用自己的账号也能生成分享链接', viewerLink.res.status === 201 && !!viewerToken, `status=${viewerLink.res.status}`);
      cookie = '';
      await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
      const seen = await req('GET', `/api/s/${viewerToken}/posts?limit=5`);
      const authors = (seen.payload.posts || []).map((p) => p.author?.username);
      check('分享页里的记录不会被算成访问者的', authors.every((name) => name !== 'tester'), JSON.stringify(authors));
      check('分享页里的作者是主人自己', authors.every((name) => name === 'viewer'), JSON.stringify(authors));
      check('别人打开时 isOwner=false', seen.payload.isOwner === false, String(seen.payload.isOwner));

      // 主人打开自己的链接：isOwner=true，自己的私密记录也能看到
      cookie = '';
      await req('POST', '/api/auth/login', { json: { username: 'viewer', password: 'secret123' } });
      const ownView = await req('GET', `/api/s/${viewerToken}/posts?limit=20`);
      check(
        '主人打开自己的链接 isOwner=true 且能看到私密',
        ownView.payload.isOwner === true && (ownView.payload.posts || []).some((p) => p.body.includes('私密')),
        JSON.stringify({ isOwner: ownView.payload.isOwner, bodies: (ownView.payload.posts || []).map((p) => p.body) })
      );
      cookie = '';
      await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
    }

    const allScope = await req('GET', '/api/posts?scope=all&limit=20');
    const allBodies = (allScope.payload.posts || []).map((p) => p.body);
    check('scope=all 同时包含我和好友', allBodies.includes('viewer 的公开动态') && allBodies.includes('tester 的公开动态'), JSON.stringify(allBodies));
    check('scope=all 不含任何私密内容', !allBodies.some((b) => b.includes('私密')), JSON.stringify(allBodies));
    check('scope=all 返回好友数量', typeof allScope.payload.friendCount === 'number' && allScope.payload.friendCount === 1, String(allScope.payload.friendCount));

    const mineScope = await req('GET', '/api/posts?scope=mine&limit=20');
    const mineBodies = (mineScope.payload.posts || []).map((p) => p.body);
    check('scope=mine 只有自己（含私密）', mineBodies.includes('tester 的公开动态') && !mineBodies.includes('viewer 的公开动态'), JSON.stringify(mineBodies));

    const onlyFriend = await req('GET', `/api/posts?scope=only&author=${viewerId}&limit=20`);
    check('scope=only 看指定好友', (onlyFriend.payload.posts || []).every((p) => p.author?.username === 'viewer'), JSON.stringify((onlyFriend.payload.posts || []).map((p) => p.author?.username)));

    // 备注名
    const alias = await req('PATCH', `/api/friends/${viewerId}`, { json: { alias: '小明' } });
    check('设置好友备注', alias.res.status === 200, `status=${alias.res.status}`);
    const afterAlias = await req('GET', '/api/friends');
    check('备注名生效（只影响自己）', afterAlias.payload.friends?.[0]?.displayName === '小明', JSON.stringify(afterAlias.payload.friends?.[0]));

    // 非好友不能通过 scope=only 偷看
    const carol = await req('POST', '/api/auth/signup', { json: { username: 'carol_e2e', password: 'secret123' } });
    check('第三个账号注册成功', carol.res.status === 201, `status=${carol.res.status}`);
    const peek = await req('GET', `/api/posts?scope=only&author=${viewerId}`);
    check('非好友不能看别人时间线', peek.res.status === 403, `status=${peek.res.status}`);

    // 反向申请 -> 直接成为好友
    cookie = '';
    await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
    const reverse = await req('POST', '/api/friends/requests', { json: { username: 'carol_e2e' } });
    check('对陌生人申请成功', reverse.payload.status === 'pending', JSON.stringify(reverse.payload));
    cookie = '';
    await req('POST', '/api/auth/login', { json: { username: 'carol_e2e', password: 'secret123' } });
    const backReq = await req('POST', '/api/friends/requests', { json: { username: 'tester' } });
    check('对方反向申请后直接成为好友', backReq.payload.status === 'accepted', JSON.stringify(backReq.payload));

    // 解除好友
    cookie = '';
    await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
    const removed = await req('DELETE', `/api/friends/${viewerId}`);
    check('解除好友', removed.res.status === 200 && removed.payload.ok === true, `status=${removed.res.status}`);
    const afterRemove = await req('GET', '/api/posts?scope=friends&limit=10');
    check('解除后看不到对方动态', !(afterRemove.payload.posts || []).some((p) => p.body === 'viewer 的公开动态'), JSON.stringify((afterRemove.payload.posts || []).map((p) => p.body)));

    // 分享功能不受影响（新模型：现场生成一条限时链接）
    const again = await req('POST', '/api/share/links', { json: { scope: 'all' } });
    const againToken = again.payload.link?.token;
    cookie = '';
    const shared = await req('GET', `/api/s/${againToken}/posts?limit=10`);
    check('分享链接依然可用', again.res.status === 201 && shared.res.status === 200 && (shared.payload.posts || []).length >= 1, `create=${again.res.status} read=${shared.res.status}`);
    check(
      '分享页里只有主人自己的记录（没有好友的）',
      (shared.payload.posts || []).every((p) => p.author?.username === 'tester'),
      JSON.stringify((shared.payload.posts || []).map((p) => p.author?.username))
    );
  }

  section('编辑动态时追加图片 / 视频');
  {
    // 曾经的问题：编辑模式只发 JSON，新加的附件被丢掉
    cookie = '';
    await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
    const created = await req('POST', '/api/posts', { json: { body: '编辑前的文本' } });
    const editTarget = created.payload.post?.id;
    check('新建纯文本动态', created.res.status === 201 && created.payload.post?.media?.length === 0, `status=${created.res.status}`);

    const editForm = new FormData();
    editForm.append('media', new Blob([png], { type: 'image/png' }), 'added.png');
    editForm.append(
      'post',
      JSON.stringify({ body: '编辑后带图', mediaMeta: [{ width: 16, height: 12, duration: null }] })
    );
    const edited = await req('PATCH', `/api/posts/${editTarget}`, { form: editForm });
    check('PATCH 支持 multipart 并追加图片', edited.res.status === 200 && edited.payload.post.media?.length === 1, `status=${edited.res.status} media=${edited.payload.post.media?.length}`);
    check('编辑后正文已更新', edited.payload.post.body === '编辑后带图', edited.payload.post.body);
    const addedMedia = edited.payload.post.media?.[0];
    check('追加的图片元数据正确', addedMedia?.kind === 'image' && addedMedia?.width === 16, JSON.stringify(addedMedia));
    const mediaFetch = await req('GET', addedMedia.url, { raw: true });
    check('追加的图片可访问', mediaFetch.res.status === 200 && mediaFetch.buffer.length > 0, `status=${mediaFetch.res.status}`);

    // 再追加一个视频 + 封面
    const videoForm = new FormData();
    videoForm.append('media', new Blob([Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(1024, 5)])], { type: 'video/mp4' }), 'added.mp4');
    videoForm.append('poster', new Blob([png], { type: 'image/jpeg' }), 'poster.jpg');
    videoForm.append('post', JSON.stringify({ body: '编辑后带图带视频', mediaMeta: [{ width: 16, height: 12, duration: null }, { width: 640, height: 360, duration: 3.2 }] }));
    const edited2 = await req('PATCH', `/api/posts/${editTarget}`, { form: videoForm });
    const videoMedia = (edited2.payload.post.media || []).find((m) => m.kind === 'video');
    check('再次编辑追加视频（附件累积为 2）', edited2.payload.post.media?.length === 2, `media=${edited2.payload.post.media?.length}`);
    check('追加的视频带封面', !!videoMedia?.posterUrl, JSON.stringify(videoMedia));

    // 重新拉取列表，确认持久化
    const relist = await req('GET', '/api/posts?scope=mine&limit=50');
    const persisted = (relist.payload.posts || []).find((p) => p.id === editTarget);
    check('重新拉取仍能看到两个附件', persisted?.media?.length === 2, `media=${persisted?.media?.length}`);
    check('重新拉取正文正确', persisted?.body === '编辑后带图带视频', persisted?.body);

    // 清理
    await req('DELETE', `/api/posts/${editTarget}`);
  }

  section('生日 / 纪念日');
  {
    cookie = '';
    await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'secret123' } });
    const saved = await req('PATCH', '/api/me/profile', {
      json: { birthday: '1995-06-18', celebrationDate: '2020-02-29' },
    });
    check(
      '保存生日与纪念日',
      saved.payload.user?.birthday === '1995-06-18' && saved.payload.user?.celebrationDate === '2020-02-29',
      JSON.stringify(saved.payload.user)
    );

    const reread = await req('GET', '/api/auth/me');
    check('回读一致', reread.payload.user?.celebrationDate === '2020-02-29', JSON.stringify(reread.payload.user?.celebrationDate));

    const badFormat = await req('PATCH', '/api/me/profile', { json: { celebrationDate: '2020/02/29' } });
    check('非法日期格式被拒', badFormat.res.status === 400 && badFormat.payload.code === 'bad_date', `status=${badFormat.res.status}`);

    const keepOnOtherEdit = await req('PATCH', '/api/me/profile', { json: { displayName: '测试用户改名2' } });
    check(
      '只改昵称不会清掉日期',
      keepOnOtherEdit.payload.user?.birthday === '1995-06-18' && keepOnOtherEdit.payload.user?.celebrationDate === '2020-02-29',
      JSON.stringify(keepOnOtherEdit.payload.user)
    );

    const cleared = await req('PATCH', '/api/me/profile', { json: { celebrationDate: '' } });
    check(
      '可以单独清空纪念日（保留生日）',
      cleared.payload.user?.celebrationDate === null && cleared.payload.user?.birthday === '1995-06-18',
      JSON.stringify(cleared.payload.user)
    );
  }

  section('鉴权边界');
  cookie = '';
  const noAuth = await req('GET', '/api/posts');
  check('未登录访问我的时间线被拒', noAuth.res.status === 401, `status=${noAuth.res.status}`);
  const noAuthPost = await req('POST', '/api/posts', { json: { body: 'hi' } });
  check('未登录发布被拒', noAuthPost.res.status === 401, `status=${noAuthPost.res.status}`);
  const noAuthUpload = await req('POST', '/api/uploads', { form: new FormData() });
  check('未登录上传被拒', noAuthUpload.res.status === 401 || noAuthUpload.res.status === 400, `status=${noAuthUpload.res.status}`);

  cookie = viewerCookie;
  const otherProfile = await req('GET', '/api/posts?scope=mine&limit=50');
  const otherBodies = (otherProfile.payload.posts || []).map((p) => p.body);
  check(
    '不同账号数据互相隔离',
    !otherBodies.some((b) => b.includes('tester') || b.includes('小工具')),
    `viewer 看到 ${otherBodies.length} 条：${JSON.stringify(otherBodies.slice(0, 4))}`
  );
  check(
    '默认 scope 只返回自己的动态',
    otherProfile.payload.scope === 'mine',
    `scope=${otherProfile.payload.scope}`
  );

  const wrongLogin = await req('POST', '/api/auth/login', { json: { username: 'tester', password: 'wrong' } });
  check('错误密码登录失败', wrongLogin.res.status === 401, `status=${wrongLogin.res.status}`);

  section('静态资源与页面');
  for (const [url, expectType] of [
    ['/', 'text/html'],
    [`/s/${allToken}`, 'text/html'],
    // 老链接页仍然返回分享页壳，但页面里的 share.js 会因为查不到这条链接显示「链接无效」
    ['/share/legacytoken0001', 'text/html'],
    ['/u/tester/timeline', 'text/html'],
    ['/css/style.css', 'text/css'],
    ['/js/app.js', 'text/javascript'],
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript'],
    ['/icons/icon-192.png', 'image/png'],
  ]) {
    const res = await fetch(`${BASE}${url}`);
    const type = res.headers.get('content-type') || '';
    check(`GET ${url}`, res.ok && type.includes(expectType), `status=${res.status} type=${type}`);
  }
  const qr = await fetch(`${BASE}/api/qr?data=${encodeURIComponent(`${BASE}/s/${allToken}`)}`);
  const qrText = await qr.text();
  check('二维码接口返回 SVG', qr.ok && qrText.startsWith('<svg') && qrText.includes('<rect'), `status=${qr.status}`);

  const missing = await req('GET', '/api/not-exist');
  check('未知接口返回 404 JSON', missing.res.status === 404 && missing.payload.code === 'not_found', `status=${missing.res.status}`);

  section('大文件与异常请求');
  const bigPng = makePng(64, 64);
  const okSmall = await req('POST', '/api/uploads', {
    form: (() => {
      const f = new FormData();
      f.append('media', new Blob([bigPng], { type: 'image/png' }), 'ok.png');
      return f;
    })(),
  });
  check('预上传接口可用', okSmall.res.status === 201 && okSmall.payload.media?.length === 1, `status=${okSmall.res.status}`);
  const orphanId = okSmall.payload.media?.[0]?.id;
  const orphanDel = await req('DELETE', `/api/media/${orphanId}`);
  check('删除未挂载的附件', orphanDel.res.status === 200, `status=${orphanDel.res.status}`);

  const wrongType = await req('POST', '/api/uploads', {
    form: (() => {
      const f = new FormData();
      f.append('media', new Blob([Buffer.from('#!/bin/sh\necho hi')], { type: 'text/x-shellscript' }), 'evil.sh');
      return f;
    })(),
  });
  check('拒绝不支持的文件类型', wrongType.res.status === 415, `status=${wrongType.res.status}`);

  const badJson = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: '{not json',
  });
  check('非法 JSON 返回 400', badJson.status === 400, `status=${badJson.status}`);
} catch (err) {
  failed += 1;
  failures.push(`运行异常：${err.message}`);
  console.error('\n运行异常：', err);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  if (serverOut && process.env.DAYLOG_E2E_VERBOSE) console.log('\n服务器输出：\n' + serverOut);
  exitCode = 1;
} else {
  console.log('端到端测试全部通过 ✅');
}
process.exit(exitCode);
