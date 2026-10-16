// 好友筛选 + 分享时间范围 API 联调
const BASE = process.argv[2] || 'http://127.0.0.1:81';

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
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

const me = client();
const f1 = client();
const f2 = client();
const st = Date.now().toString().slice(-6);
const meName = `fs${st}`;
const f1Name = `fa${st}`;
const f2Name = `fb${st}`;

const s1 = await me('POST', '/api/auth/signup', { username: meName, password: 'demo1234', displayName: '我' });
const s2 = await f1('POST', '/api/auth/signup', { username: f1Name, password: 'demo1234', displayName: '好友A' });
const s3 = await f2('POST', '/api/auth/signup', { username: f2Name, password: 'demo1234', displayName: '好友B' });
check('三个账号注册成功', s1.status === 201 && s2.status === 201 && s3.status === 201, `${s1.status}/${s2.status}/${s3.status} ${JSON.stringify(s2.body).slice(0, 80)}`);

// 建立好友关系
const idOf = async (c, name) => {
  const r = await c('GET', `/api/users/lookup?username=${name}`);
  return r.body?.user?.id || null;
};
const meId = (await me('GET', '/api/auth/me')).body.user.id;
const f1Id = await idOf(me, f1Name);
const f2Id = await idOf(me, f2Name);
check('能查到好友A', !!f1Id, `f1Id=${f1Id}`);
check('能查到好友B', !!f2Id, `f2Id=${f2Id}`);
if (!f1Id || !f2Id) {
  console.log('\n前置条件失败，终止');
  process.exit(1);
}

const r1 = await me('POST', '/api/friends/requests', { username: f1Name });
const a1 = await f1('POST', `/api/friends/requests/${meId}/accept`);
check(
  '与好友A 建立关系',
  r1.status === 201 && a1.status === 200,
  `req=${r1.status} ${JSON.stringify(r1.body).slice(0, 100)} accept=${a1.status} ${JSON.stringify(a1.body).slice(0, 80)} meId=${meId} f1Id=${f1Id}`
);
const r2 = await me('POST', '/api/friends/requests', { username: f2Name });
const a2 = await f2('POST', `/api/friends/requests/${meId}/accept`);
check('与好友B 建立关系', r2.status === 201 && a2.status === 200, `req=${r2.status} accept=${a2.status}`);
const friendList = await me('GET', '/api/friends');
check('我的好友数为 2', friendList.body.friends.length === 2, JSON.stringify(friendList.body.friends.map((f) => f.user.username)));

// 发记录（今天我 2 条，好友A 1 条，好友B 0 条）
const today = new Date();
const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const p1 = await me('POST', '/api/posts', { body: '我的记录1', postDay: iso });
const p2 = await me('POST', '/api/posts', { body: '我的记录2', postDay: iso });
const p3 = await f1('POST', '/api/posts', { body: '好友A的记录', postDay: iso });
check(
  '发记录的请求都成功',
  p1.status === 201 && p2.status === 201 && p3.status === 201,
  `${p1.status}/${p2.status}/${p3.status} ${JSON.stringify(p1.body).slice(0, 120)}`
);
check('postDay 记录为今天', p1.body?.post?.postDay === iso, `postDay=${p1.body?.post?.postDay} 期望=${iso}`);

console.log('\n▸ 好友筛选条所需数据（counts）');
const all = await me('GET', `/api/posts?scope=all&from=${iso}&to=${iso}&limit=50`);
check('scope=all 返回 counts', all.body.counts && typeof all.body.counts === 'object', JSON.stringify(all.body.counts));
check('我的条数 = 2', all.body.counts[meId] === 2, `counts[me]=${all.body.counts[meId]}`);
check('好友A 条数 = 1', all.body.counts[f1Id] === 1, `counts[A]=${all.body.counts[f1Id]}`);
check('好友B 没有记录（counts 里应为 0/缺省）', !all.body.counts[f2Id], `counts[B]=${all.body.counts[f2Id]}`);
check('返回 friendCount = 2', all.body.friendCount === 2, String(all.body.friendCount));

console.log('\n▸ 按好友筛选（friendId）');
const onlyA = await me('GET', `/api/posts?scope=all&from=${iso}&to=${iso}&friendId=${f1Id}`);
check('只返回好友A的记录', onlyA.body.posts.length === 1 && onlyA.body.posts[0].body === '好友A的记录', JSON.stringify(onlyA.body.posts.map((p) => p.body)));
check('回传 friendId', onlyA.body.friendId === f1Id, String(onlyA.body.friendId));
check('counts 仍是全部人的（筛选条要用）', onlyA.body.counts[meId] === 2 && onlyA.body.counts[f1Id] === 1, JSON.stringify(onlyA.body.counts));

const onlyMe = await me('GET', `/api/posts?scope=all&from=${iso}&to=${iso}&friendId=${meId}`);
check('按自己筛选返回我的 2 条', onlyMe.body.posts.length === 2, `count=${onlyMe.body.posts.length}`);

const noPost = await me('GET', `/api/posts?scope=all&from=${iso}&to=${iso}&friendId=${f2Id}`);
check('筛选没记录的好友返回空', noPost.body.posts.length === 0, `count=${noPost.body.posts.length}`);

console.log('\n▸ 非好友不能按 friendId 偷看');
const stranger = client();
await stranger('POST', '/api/auth/signup', { username: `sx${st}`, password: 'demo1234' });
const peek = await stranger('GET', `/api/posts?scope=all&friendId=${f1Id}`);
check('非好友筛选被拒 403', peek.status === 403 && peek.body.code === 'not_friend', `status=${peek.status}`);

console.log('\n▸ 分享链接（新模型：范围 + 有效期绑在这条链接上）');
const anon = client(); // 无 cookie = 访客

// 每次分享生成一条独立链接，范围（day / month / all）写在这条记录里，
// 链接本身不带 range/date，页面上也不再给访客筛选入口。
const shareAllLink = await me('POST', '/api/share/links', { scope: 'all' });
check('生成「全部」链接', shareAllLink.status === 201 && shareAllLink.body.link?.scope === 'all', `status=${shareAllLink.status} ${JSON.stringify(shareAllLink.body).slice(0, 120)}`);
const shareDayLink = await me('POST', '/api/share/links', { scope: 'day', day: iso, hours: 24 });
check('生成「按天」链接', shareDayLink.status === 201 && shareDayLink.body.link?.day === iso && shareDayLink.body.hours === 24, `status=${shareDayLink.status}`);
const shareMonthLink = await me('POST', '/api/share/links', { scope: 'month', month: iso.slice(0, 7) });
check('生成「按月」链接', shareMonthLink.status === 201 && shareMonthLink.body.link?.month === iso.slice(0, 7), `status=${shareMonthLink.status}`);

const allToken = shareAllLink.body.link.token;
const dayToken = shareDayLink.body.link.token;
const monthToken = shareMonthLink.body.link.token;

const shareAll = await anon('GET', `/api/s/${allToken}/posts?limit=20`);
check('all 链接 = 我的全部时间线（2 条）', shareAll.body.posts.length === 2, `count=${shareAll.body.posts.length}`);
check('回传链接信息（页面据此显示范围 / 过期时间）', shareAll.body.link?.scope === 'all' && shareAll.body.from === null && shareAll.body.to === null, JSON.stringify({ link: shareAll.body.link, from: shareAll.body.from, to: shareAll.body.to }));
check('不会混进好友的记录', !shareAll.body.posts.some((p) => p.body === '好友A的记录'), JSON.stringify(shareAll.body.posts.map((p) => p.body)));

const shareDay = await anon('GET', `/api/s/${dayToken}/posts`);
check('day 链接只给那一天（2 条）', shareDay.body.posts.length === 2, `count=${shareDay.body.posts.length}`);
check('day 链接的 from/to = 那一天', shareDay.body.from === iso && shareDay.body.to === iso, JSON.stringify({ from: shareDay.body.from, to: shareDay.body.to }));
check('day 链接读不到别的日期', (await anon('GET', `/api/s/${dayToken}/posts?from=2001-01-01&to=2001-12-31`)).body.posts.length === 2, '客户端传的 from/to 应被忽略');
check('日期参数被忽略（传别的日期也一样）', (await anon('GET', `/api/s/${dayToken}/posts?date=2001-01-01`)).body.from === iso, '客户端传的 date 应被忽略');

const shareMonth = await anon('GET', `/api/s/${monthToken}/posts?limit=20`);
check('month 链接回传整月范围', shareMonth.body.from === `${iso.slice(0, 7)}-01` && shareMonth.body.to === `${iso.slice(0, 7)}-31`, JSON.stringify({ from: shareMonth.body.from, to: shareMonth.body.to }));
check('month 链接能拿到本月记录', shareMonth.body.posts.length === 2, `count=${shareMonth.body.posts.length}`);

const emptyLink = await me('POST', '/api/share/links', { scope: 'day', day: '2001-01-01' });
const emptyPosts = await anon('GET', `/api/s/${emptyLink.body.link.token}/posts`);
check('分享没有记录的一天 → 空列表', emptyLink.status === 201 && emptyPosts.body.posts.length === 0, `count=${emptyPosts.body.posts.length}`);

console.log('\n▸ 分享链接还能被撤销 / 失效语义');
const listBefore = await me('GET', '/api/share/links');
check('列表里能看出自己生成的链接', (listBefore.body.links || []).length >= 4, `count=${(listBefore.body.links || []).length}`);
check('撤销一条链接', (await me('DELETE', `/api/share/links/${monthToken}`)).status === 200);
const afterRevoke = await anon('GET', `/api/s/${monthToken}/posts`);
check('撤销后 410 share_revoked', afterRevoke.status === 410 && afterRevoke.body.code === 'share_revoked', `status=${afterRevoke.status} code=${afterRevoke.body.code}`);
check('被撤销的链接不再出现在列表里', !((await me('GET', '/api/share/links')).body.links || []).some((l) => l.token === monthToken));
check('不存在的链接 → 404 not_found', (await anon('GET', '/api/s/zzzznotexist/posts')).status === 404);

console.log('\n▸ 分享仍然只暴露公开内容');
await me('POST', '/api/posts', { body: '今天的私密记录', visibility: 'private', postDay: iso });
const afterPrivate = await anon('GET', `/api/s/${dayToken}/posts`);
check('访客看不到私密记录', !afterPrivate.body.posts.some((p) => p.body.includes('私密')), JSON.stringify(afterPrivate.body.posts.map((p) => p.body)));
check('访客能看到公开记录', afterPrivate.body.posts.length === 2, `count=${afterPrivate.body.posts.length}`);

console.log(`\n${'─'.repeat(46)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `好友筛选 + 限时分享链接测试全部通过 ✅（${pass} 项）`);
process.exitCode = fail ? 1 : 0;
