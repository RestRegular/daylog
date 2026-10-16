// 分享模式测试：限时分享链接（范围绑定 / 失效语义）+ 应用内好友时间线门禁
//
// 新模型：每次分享都生成一条独立、限时的链接，看的范围（day / month / all）和过期时间
// 都绑在这条记录上，链接里**不再有** range/date 参数；页面上也不再有筛选标签。
// 用法：node scripts/sharemode-test.mjs [baseUrl]
// 想让「过期」那一项真正跑起来，需要能读到服务用的数据库：
//   DAYLOG_DATA_DIR=<数据目录> node scripts/sharemode-test.mjs http://127.0.0.1:8199
// 不给也会自动找（见 findDbWith），找不到就把那一项标成「跳过」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.argv[2] || 'http://127.0.0.1:81';
const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
let skipped = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}
function skip(label, why) {
  skipped += 1;
  console.log(`  ⊘ ${label}（跳过：${why}）`);
}

function client() {
  let cookie = '';
  return async (method, path, json) => {
    const init = { method, headers: { 'x-daylog-tz': 'Asia/Shanghai' } };
    if (cookie) init.headers.cookie = cookie;
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(BASE + path, init);
    for (const c of res.headers.getSetCookie?.() || []) {
      const f = c.split(';')[0];
      if (f.startsWith('daylog_session=')) {
        const v = f.slice('daylog_session='.length);
        cookie = v ? `daylog_session=${v}` : '';
      }
    }
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 150) };
    }
    return { status: res.status, body: payload };
  };
}

/** 在几个候选位置里找出「真正含这条链接」的 daylog.db（服务用哪个就用哪个） */
function findDbWith(token) {
  const roots = [
    process.env.DAYLOG_DATA_DIR,
    path.resolve(here, '..'),
    path.resolve(here, '..', '..'),
    path.resolve(here, '..', '..', '..'),
  ].filter(Boolean);
  const files = [];
  for (const root of roots) {
    files.push(path.join(root, 'daylog.db'));
    try {
      for (const sub of fs.readdirSync(root)) {
        files.push(path.join(root, sub, 'daylog.db'));
        files.push(path.join(root, sub, 'data', 'daylog.db'));
      }
    } catch {
      /* 读不了就算了 */
    }
  }
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const db = new DatabaseSync(file);
      const row = db.prepare('SELECT token FROM share_links WHERE token = ?').get(token);
      db.close();
      if (row) return file;
    } catch {
      /* 打不开就算了 */
    }
  }
  return null;
}

/**
 * 直接把某条链接的过期时间改到过去。
 * 服务端没有小于 1 小时的有效期选项，所以「过期」用改库最直接。
 */
function expireLinkNow(token) {
  const file = findDbWith(token);
  if (!file) return null;
  const db = new DatabaseSync(file);
  try {
    const info = db.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
    if (!info.changes) return null;
  } finally {
    db.close();
  }
  return file;
}

const owner = client();
const guest = client();
const friend = client();
const stranger = client();
const st = Date.now().toString().slice(-6);
const ownerName = `ow${st}`;
const friendName = `fr${st}`;
const strangerName = `sr${st}`;
const ownerSignup = await owner('POST', '/api/auth/signup', { username: ownerName, password: 'demo1234', displayName: '分享者' });
await friend('POST', '/api/auth/signup', { username: friendName, password: 'demo1234', displayName: '好友' });
await stranger('POST', '/api/auth/signup', { username: strangerName, password: 'demo1234', displayName: '路人' });
check('三个账号注册成功', ownerSignup.status === 201, `status=${ownerSignup.status} ${JSON.stringify(ownerSignup.body).slice(0, 80)}`);

// 日期：今天 / 昨天 / 上个月 15 号（跨月，用来验证月范围）
const d = new Date();
const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const month = iso.slice(0, 7);
const yesterday = (() => {
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  return `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
})();
const prevDay = (() => {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 15);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-15`;
})();

console.log('\n▸ 准备数据（今天 / 昨天 / 上个月各一条 + 一条私密）');
const p1 = await owner('POST', '/api/posts', { body: '今天的记录', postDay: iso, visibility: 'public' });
const p2 = await owner('POST', '/api/posts', { body: '昨天的记录', postDay: yesterday, visibility: 'public' });
const p3 = await owner('POST', '/api/posts', { body: '上个月的记录', postDay: prevDay, visibility: 'public' });
const p4 = await owner('POST', '/api/posts', { body: '私密记录', postDay: iso, visibility: 'private' });
check('四条记录都发布成功', [p1, p2, p3, p4].every((r) => r.status === 201), `${p1.status}/${p2.status}/${p3.status}/${p4.status}`);
check('postDay 落库正确', p1.body?.post?.postDay === iso && p3.body?.post?.postDay === prevDay, `${p1.body?.post?.postDay} / ${p3.body?.post?.postDay}`);

const me = await owner('GET', '/api/auth/me');
check('登录态不再下发永久 shareToken', !('shareToken' in (me.body.user || {})), Object.keys(me.body.user || {}).join(','));
check('设置里也没有 shareEnabled 开关', !('shareEnabled' in (me.body.user || {})));

console.log('\n▸ 页面壳（三条入口都能打开）');
for (const [label, url] of [
  ['/s/<token>（限时链接）', `/s/whatevertoken`],
  ['/share/<token>（老链接，页面会提示无效）', `/share/whatevertoken`],
  ['/u/<username>/timeline（好友的时间线）', `/u/${ownerName}/timeline`],
]) {
  const res = await fetch(`${BASE}${url}`);
  const html = await res.text();
  check(`${label} 返回分享页`, res.status === 200 && html.includes('share.js'), `status=${res.status}`);
}

console.log('\n▸ 生成三种范围的链接');
const dayLink = await owner('POST', '/api/share/links', { scope: 'day', day: iso, hours: 24 });
check('生成 day 链接', dayLink.status === 201 && dayLink.body.link?.scope === 'day' && dayLink.body.link?.day === iso, `status=${dayLink.status} ${JSON.stringify(dayLink.body).slice(0, 160)}`);
check('day 链接的时效回传 24 小时', dayLink.body.hours === 24, String(dayLink.body.hours));
const monthLink = await owner('POST', '/api/share/links', { scope: 'month', month, hours: 720 });
check('生成 month 链接', monthLink.status === 201 && monthLink.body.link?.scope === 'month' && monthLink.body.link?.month === month, `status=${monthLink.status} ${JSON.stringify(monthLink.body).slice(0, 160)}`);
const allLink = await owner('POST', '/api/share/links', { scope: 'all' });
check('生成 all 链接（默认 7 天）', allLink.status === 201 && allLink.body.link?.scope === 'all' && allLink.body.hours === 168, `status=${allLink.status} hours=${allLink.body.hours}`);
const dayToken = dayLink.body.link.token;
const monthToken = monthLink.body.link.token;
const allToken = allLink.body.link.token;
check('链接地址统一是 /s/<token>（不带任何参数）', [dayLink, monthLink, allLink].every((r) => r.body.link.url === `/s/${r.body.link.token}`), JSON.stringify([dayLink.body.link.url, monthLink.body.link.url, allLink.body.link.url]));
check('三条链接互不相同', new Set([dayToken, monthToken, allToken]).size === 3);

console.log('\n▸ 非法入参');
check('范围不合法 400', (await owner('POST', '/api/share/links', { scope: 'week' })).status === 400);
check('day 缺日期 400', (await owner('POST', '/api/share/links', { scope: 'day', day: '2024/01/01' })).status === 400);
check('month 格式不对 400', (await owner('POST', '/api/share/links', { scope: 'month', month: '2024-1' })).status === 400);
check('未登录不能生成链接 401', (await guest('POST', '/api/share/links', { scope: 'all' })).status === 401);
check('未登录不能看链接列表 401', (await guest('GET', '/api/share/links')).status === 401);

console.log('\n▸ 已生成的链接列表（只含未撤销且未过期）');
const list = await owner('GET', '/api/share/links');
const listed = (list.body.links || []).map((l) => l.token);
check('列表包含刚生成的三条', [dayToken, monthToken, allToken].every((t) => listed.includes(t)), JSON.stringify(listed));
check('列表项带范围和过期时间', (list.body.links || []).every((l) => l.url === `/s/${l.token}` && typeof l.expiresAt === 'number' && l.expiresAt > Date.now()));

console.log('\n▸ day 链接：访客只能看到那一天');
const dayPosts = await guest('GET', `/api/s/${dayToken}/posts?limit=50`);
const dayBodies = (dayPosts.body.posts || []).map((p) => p.body);
check('day 链接返回 200', dayPosts.status === 200, `status=${dayPosts.status}`);
check('day 链接的范围由服务端回传', dayPosts.body.from === iso && dayPosts.body.to === iso, JSON.stringify({ from: dayPosts.body.from, to: dayPosts.body.to }));
check('只看得到今天那条', dayBodies.includes('今天的记录'), JSON.stringify(dayBodies));
check('看不到昨天 / 上个月的', !dayBodies.includes('昨天的记录') && !dayBodies.includes('上个月的记录'), JSON.stringify(dayBodies));
check('看不到私密记录', !dayBodies.some((b) => b.includes('私密')), JSON.stringify(dayBodies));
check('回传所属链接（scope=day）', dayPosts.body.link?.scope === 'day' && dayPosts.body.link?.token === dayToken, JSON.stringify(dayPosts.body.link));

console.log('\n▸ 客户端传 range / date 一律无效');
const forced = await guest('GET', `/api/s/${dayToken}/posts?range=all&date=${prevDay}&from=${prevDay}&to=${prevDay}&limit=50`);
const forcedBodies = (forced.body.posts || []).map((p) => p.body);
check('传了 range=all + 别的日期，仍然只给链接锁定的那一天', !forcedBodies.includes('上个月的记录') && forcedBodies.includes('今天的记录'), JSON.stringify(forcedBodies));
check('回传的 from/to 也没被参数带偏', forced.body.from === iso && forced.body.to === iso, JSON.stringify({ from: forced.body.from, to: forced.body.to }));

console.log('\n▸ month 链接：整月，且不跨月');
const expectMonth = [iso, yesterday, prevDay].filter((x) => x.startsWith(month)).length;
const monthPosts = await guest('GET', `/api/s/${monthToken}/posts?limit=50`);
const monthBodies = (monthPosts.body.posts || []).map((p) => p.body);
check('month 链接回传整月范围', monthPosts.body.from === `${month}-01` && monthPosts.body.to === `${month}-31`, JSON.stringify({ from: monthPosts.body.from, to: monthPosts.body.to }));
check('month 链接的条数 = 本月记录数', monthBodies.length === expectMonth, `实际 ${monthBodies.length} 期望 ${expectMonth}：${JSON.stringify(monthBodies)}`);
check('month 链接不包含上个月的记录', !monthBodies.includes('上个月的记录'), JSON.stringify(monthBodies));

console.log('\n▸ all 链接：能看到全部公开内容');
const allPosts = await guest('GET', `/api/s/${allToken}/posts?limit=50`);
const allBodies = (allPosts.body.posts || []).map((p) => p.body);
check('all 链接 from/to 都是 null', allPosts.body.from === null && allPosts.body.to === null, JSON.stringify({ from: allPosts.body.from, to: allPosts.body.to }));
check('all 链接能看到跨月的记录', allBodies.includes('上个月的记录') && allBodies.includes('今天的记录'), JSON.stringify(allBodies));
check('all 链接也不给私密记录', !allBodies.some((b) => b.includes('私密')), JSON.stringify(allBodies));

console.log('\n▸ 单条接口同样受范围限制');
const prevPostId = p3.body.post.id;
const outOfScope = await guest('GET', `/api/s/${dayToken}/posts/${prevPostId}`);
check('day 链接读范围外的单条 → 404', outOfScope.status === 404, `status=${outOfScope.status}`);
const inScope = await guest('GET', `/api/s/${allToken}/posts/${prevPostId}`);
check('all 链接能读同一条', inScope.status === 200 && inScope.body.post?.body === '上个月的记录', `status=${inScope.status}`);
const privatePost = await guest('GET', `/api/s/${allToken}/posts/${p4.body.post.id}`);
check('访客读私密单条 → 404', privatePost.status === 404, `status=${privatePost.status}`);
const ownerSeesPrivate = await owner('GET', `/api/s/${allToken}/posts/${p4.body.post.id}`);
check('主人读自己的私密单条 → 200', ownerSeesPrivate.status === 200 && ownerSeesPrivate.body.post?.visibility === 'private', `status=${ownerSeesPrivate.status}`);
check('主人打开自己的链接 isOwner=true', (await owner('GET', `/api/s/${allToken}`)).body.isOwner === true);
check('访客打开链接 isOwner=false', (await guest('GET', `/api/s/${allToken}`)).body.isOwner === false);

console.log('\n▸ 撤销：只能撤销自己的，撤销后 410 share_revoked');
check('别人撤销 → 404', (await stranger('DELETE', `/api/share/links/${dayToken}`)).status === 404);
check('本人撤销 → 200', (await owner('DELETE', `/api/share/links/${dayToken}`)).status === 200);
const afterRevoke = await guest('GET', `/api/s/${dayToken}/posts`);
check('撤销后 410 share_revoked', afterRevoke.status === 410 && afterRevoke.body.code === 'share_revoked', `status=${afterRevoke.status} code=${afterRevoke.body.code}`);
check('撤销后资料接口同样 410', (await guest('GET', `/api/s/${dayToken}`)).status === 410);
check('撤销后单条接口同样 410', (await guest('GET', `/api/s/${dayToken}/posts/${p1.body.post.id}`)).status === 410);
check('列表里不再有被撤销的链接', !((await owner('GET', '/api/share/links')).body.links || []).some((l) => l.token === dayToken));

console.log('\n▸ 过期：410 share_expired');
const short = await owner('POST', '/api/share/links', { scope: 'all', hours: 1 });
const shortToken = short.body.link?.token;
const dbFile = shortToken ? expireLinkNow(shortToken) : null;
if (!dbFile) {
  skip('过期后 410 share_expired', '找不到该链接所在的数据库（可用 DAYLOG_DATA_DIR 指定数据目录）');
  skip('过期的链接不再出现在列表里', '同上');
} else {
  const expired = await guest('GET', `/api/s/${shortToken}/posts`);
  check('过期后 410 share_expired', expired.status === 410 && expired.body.code === 'share_expired', `status=${expired.status} code=${expired.body.code} db=${path.basename(path.dirname(dbFile))}`);
  check('过期后资料接口同样 410', (await guest('GET', `/api/s/${shortToken}`)).status === 410);
  check('过期的链接不再出现在列表里', !((await owner('GET', '/api/share/links')).body.links || []).some((l) => l.token === shortToken));
}

console.log('\n▸ 不存在的链接 / 老接口');
check('不存在的 token → 404 not_found', (await guest('GET', '/api/s/zzzznotexist/posts')).status === 404);
check('老接口 /api/share/<token> 已删除 → 404', (await guest('GET', `/api/share/${allToken}`)).status === 404);
check('老接口 /api/share/<token>/posts 已删除 → 404', (await guest('GET', `/api/share/${allToken}/posts`)).status === 404);
check('老接口 /api/me/share/rotate 已删除 → 404', (await owner('POST', '/api/me/share/rotate')).status === 404);

console.log('\n▸ 好友的时间线：需要登录 + 是好友');
const noLogin = await guest('GET', `/api/u/${ownerName}/timeline`);
check('未登录 → 401 login_required', noLogin.status === 401 && noLogin.body.code === 'login_required', `status=${noLogin.status} code=${noLogin.body.code}`);
const notFriend = await stranger('GET', `/api/u/${ownerName}/timeline`);
check('非好友 → 403 not_friend', notFriend.status === 403 && notFriend.body.code === 'not_friend', `status=${notFriend.status} code=${notFriend.body.code}`);
const notFriendPosts = await stranger('GET', `/api/u/${ownerName}/timeline/posts`);
check('非好友读数据接口也是 403', notFriendPosts.status === 403 && notFriendPosts.body.code === 'not_friend', `status=${notFriendPosts.status}`);
const selfView = await owner('GET', `/api/u/${ownerName}/timeline`);
check('本人 → 200', selfView.status === 200 && selfView.body.isOwner === true, `status=${selfView.status}`);
check('不存在的用户名 → 404', (await stranger('GET', '/api/u/nobody_here_xyz/timeline')).status === 404);

// 建立好友关系后再看
const ownerId = me.body.user.id;
const friendId = (await owner('GET', `/api/users/lookup?username=${friendName}`)).body.user?.id;
await owner('POST', '/api/friends/requests', { username: friendName });
await friend('POST', `/api/friends/requests/${ownerId}/accept`);
const friendView = await friend('GET', `/api/u/${ownerName}/timeline`);
check('好友 → 200（viaFriend=true）', friendView.status === 200 && friendView.body.viaFriend === true, `status=${friendView.status}`);
check('好友视图不带分享链接（link=null）', friendView.body.link === null, JSON.stringify(friendView.body.link));
const friendPosts = await friend('GET', `/api/u/${ownerName}/timeline/posts?limit=50`);
const friendBodies = (friendPosts.body.posts || []).map((p) => p.body);
check('好友能看到主人的公开记录', friendPosts.status === 200 && friendBodies.includes('今天的记录'), `status=${friendPosts.status} ${JSON.stringify(friendBodies)}`);
check('好友看不到主人的私密记录', !friendBodies.some((b) => b.includes('私密')), JSON.stringify(friendBodies));
check('好友视图可以自己按日期筛（date=昨天）', (await friend('GET', `/api/u/${ownerName}/timeline/posts?date=${yesterday}`)).body.posts?.every((p) => p.body === '昨天的记录'));
check('绑定好友关系后 stranger 仍不能看', (await stranger('GET', `/api/u/${ownerName}/timeline`)).status === 403);

console.log(`\n${'─'.repeat(46)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `分享模式测试全部通过 ✅（${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}）`);
console.log(`测试账号：${ownerName} / ${friendName} / ${strangerName}（密码 demo1234）`);
process.exitCode = fail ? 1 : 0;
