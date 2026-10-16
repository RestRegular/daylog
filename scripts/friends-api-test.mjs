// 好友 API 快速联调
const BASE = process.argv[2] || 'http://127.0.0.1:81';

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
      const first = c.split(';')[0];
      if (first.startsWith('daylog_session=')) {
        const v = first.slice('daylog_session='.length);
        cookie = v ? `daylog_session=${v}` : '';
      }
    }
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 120) };
    }
    return { status: res.status, body: payload };
  };
}

const me = client();
const friend = client();
const other = client();
const stamp = Date.now().toString().slice(-6);
const u1 = `alice${stamp}`;
const u2 = `bob${stamp}`;
const u3 = `carol${stamp}`;

await me('POST', '/api/auth/signup', { username: u1, password: 'demo1234', displayName: '爱丽丝' });
await friend('POST', '/api/auth/signup', { username: u2, password: 'demo1234', displayName: '鲍勃' });
await other('POST', '/api/auth/signup', { username: u3, password: 'demo1234', displayName: '卡罗尔' });

console.log('\n1) 查找用户');
console.log('   找到:', JSON.stringify((await me('GET', `/api/users/lookup?username=${u2}`)).body));
console.log('   查不到:', JSON.stringify((await me('GET', '/api/users/lookup?username=nobody_xyz')).body));

console.log('\n2) 发送好友请求');
const req = await me('POST', '/api/friends/requests', { username: u2 });
console.log('   ' + req.status, JSON.stringify(req.body));
console.log('   重复请求:', JSON.stringify((await me('POST', '/api/friends/requests', { username: u2 })).body));
console.log('   加自己:', JSON.stringify((await me('POST', '/api/friends/requests', { username: u1 })).body));

console.log('\n3) 对方看到的待处理请求');
const inbox = await friend('GET', '/api/friends');
console.log('   incoming:', JSON.stringify(inbox.body.incoming.map((i) => i.displayName)));
console.log('   outgoing(我这边):', JSON.stringify((await me('GET', '/api/friends')).body.outgoing.map((i) => i.displayName)));

const bobId = req.body.user.id;
const aliceId = (await me('GET', '/api/auth/me')).body.user.id;
console.log('\n4) 同意（bob 同意 alice 发来的请求，要传发起人 alice 的 id）');
console.log('   ' + JSON.stringify((await friend('POST', `/api/friends/requests/${aliceId}/accept`)).body));

console.log('\n5) 双向好友列表');
console.log('   alice:', JSON.stringify((await me('GET', '/api/friends')).body.friends.map((f) => f.displayName)));
console.log('   bob  :', JSON.stringify((await friend('GET', '/api/friends')).body.friends.map((f) => f.displayName)));

console.log('\n6) 各自发动态');
await me('POST', '/api/posts', { body: '爱丽丝的动态（公开）', visibility: 'public' });
await me('POST', '/api/posts', { body: '爱丽丝的动态（私密）', visibility: 'private' });
await friend('POST', '/api/posts', { body: '鲍勃的动态（公开）', visibility: 'public' });
await friend('POST', '/api/posts', { body: '鲍勃的动态（私密）', visibility: 'private' });
await other('POST', '/api/posts', { body: '卡罗尔的动态', visibility: 'public' });

const mine = await me('GET', '/api/posts?scope=mine&limit=10');
const friends = await me('GET', '/api/posts?scope=friends&limit=10');
const all = await me('GET', '/api/posts?scope=all&limit=10');
console.log('   mine   :', mine.body.posts.map((p) => p.body).join(' | '));
console.log('   friends:', friends.body.posts.map((p) => p.body).join(' | '));
console.log('   all    :', all.body.posts.map((p) => `${p.author.displayName}→${p.body}`).join(' | '));
console.log('   all 里是否包含私密内容:', all.body.posts.some((p) => p.body.includes('私密')) ? '❌ 包含了' : '✓ 没有');
console.log('   all 里是否包含非好友:', all.body.posts.some((p) => p.author.username === u3) ? '❌ 包含了' : '✓ 没有');

console.log('\n7) 备注名');
await me('PATCH', `/api/friends/${bobId}`, { alias: '小鲍' });
console.log('   alice 看到:', JSON.stringify((await me('GET', '/api/friends')).body.friends.map((f) => `${f.displayName}(${f.user.username})`)));
console.log('   bob 看到 :', JSON.stringify((await friend('GET', '/api/friends')).body.friends.map((f) => `${f.displayName}(${f.user.username})`)));

console.log('\n8) 非好友不能看');
const only = await other('GET', `/api/posts?scope=only&author=${bobId}`);
console.log('   卡罗尔看爱丽丝:', only.status, JSON.stringify(only.body));

console.log('\n9) 解除好友');
console.log('   ' + JSON.stringify((await me('DELETE', `/api/friends/${bobId}`)).body));
console.log('   解除后 friends scope:', (await me('GET', '/api/posts?scope=friends&limit=5')).body.posts.length, '条');

console.log('\n10) 反向申请直接成为好友');
console.log('   卡罗尔申请爱丽丝:', JSON.stringify((await other('POST', '/api/friends/requests', { username: u1 })).body.message));
console.log('   爱丽丝申请卡罗尔（对方已申请）:', JSON.stringify((await me('POST', '/api/friends/requests', { username: u3 })).body));

console.log('\n11) 限时分享链接（新模型：范围 + 有效期绑在这条链接上）');
let problems = 0;
const expect = (label, cond, extra = '') => {
  if (cond) console.log(`   ✓ ${label}`);
  else {
    problems += 1;
    console.log(`   ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
};
const todayKey = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
})();

expect('登录态里不再下发 shareToken', !('shareToken' in ((await me('GET', '/api/auth/me')).body.user || {})));
expect('设置里也没有 shareEnabled 开关', !('shareEnabled' in ((await me('GET', '/api/auth/me')).body.user || {})));

const dayLink = await me('POST', '/api/share/links', { scope: 'day', day: todayKey, hours: 24 });
expect('生成按天链接（201）', dayLink.status === 201 && dayLink.body.link?.day === todayKey, `status=${dayLink.status} ${JSON.stringify(dayLink.body).slice(0, 120)}`);
const dayToken = dayLink.body.link?.token;
expect('链接地址是 /s/<token>', dayLink.body.link?.url === `/s/${dayToken}`, String(dayLink.body.link?.url));

const anon = await fetch(`${BASE}/api/s/${dayToken}/posts?limit=5`).then((r) => r.json());
console.log('   陌生人看爱丽丝的分享链接:', (anon.posts || []).map((p) => p.body).join(' | '));
expect('访客拿到的范围就是链接锁定的那一天', anon.from === todayKey && anon.to === todayKey, JSON.stringify({ from: anon.from, to: anon.to }));
expect('访客看不到私密内容', !(anon.posts || []).some((p) => p.body.includes('私密')), JSON.stringify((anon.posts || []).map((p) => p.body)));
expect('访客看到的都是爱丽丝的记录', (anon.posts || []).every((p) => p.author?.username === u1), JSON.stringify((anon.posts || []).map((p) => p.author?.username)));

const forced = await fetch(`${BASE}/api/s/${dayToken}/posts?range=all&date=2001-01-01&from=2001-01-01&to=2001-12-31`).then((r) => r.json());
expect('客户端传 range/date/from/to 一律无效', forced.from === todayKey && forced.to === todayKey, JSON.stringify({ from: forced.from, to: forced.to }));
expect('不存在的链接 → 404', (await fetch(`${BASE}/api/s/zzzznotexist/posts`)).status === 404);

expect('撤销自己的链接', (await me('DELETE', `/api/share/links/${dayToken}`)).status === 200);
const afterRevoke = await fetch(`${BASE}/api/s/${dayToken}/posts`);
const revokedBody = await afterRevoke.json();
expect('撤销后 410 share_revoked', afterRevoke.status === 410 && revokedBody.code === 'share_revoked', `status=${afterRevoke.status} code=${revokedBody.code}`);
expect('老接口 /api/share/<token>/posts 已删除（404）', (await fetch(`${BASE}/api/share/${dayToken}/posts`)).status === 404);
expect('老接口 /api/me/share/rotate 已删除（404）', (await me('POST', '/api/me/share/rotate')).status === 404);

console.log('\n12) 好友的时间线：需要登录 + 是好友');
const anonTimeline = await fetch(`${BASE}/api/u/${u1}/timeline`);
const anonTimelineBody = await anonTimeline.json();
console.log('   未登录看爱丽丝的时间线:', anonTimeline.status, JSON.stringify(anonTimelineBody));
expect('未登录 → 401 login_required', anonTimeline.status === 401 && anonTimelineBody.code === 'login_required', `status=${anonTimeline.status} code=${anonTimelineBody.code}`);
const bobView = await friend('GET', `/api/u/${u1}/timeline`);
console.log('   已解除好友的鲍勃:', bobView.status, JSON.stringify(bobView.body));
expect('非好友 → 403 not_friend', bobView.status === 403 && bobView.body.code === 'not_friend', `status=${bobView.status} code=${bobView.body.code}`);
const carolView = await other('GET', `/api/u/${u1}/timeline`);
console.log('   好友卡罗尔:', carolView.status, JSON.stringify(carolView.body));
expect('好友 → 200（viaFriend=true）', carolView.status === 200 && carolView.body.viaFriend === true, `status=${carolView.status}`);
const selfView = await me('GET', `/api/u/${u1}/timeline`);
expect('本人 → 200', selfView.status === 200 && selfView.body.isOwner === true, `status=${selfView.status}`);
const timelinePosts = await other('GET', `/api/u/${u1}/timeline/posts?limit=10`);
console.log('   卡罗尔看到爱丽丝的公开记录:', (timelinePosts.body.posts || []).map((p) => p.body).join(' | '));
expect('好友时间线同样不含私密内容', !(timelinePosts.body.posts || []).some((p) => p.body.includes('私密')), JSON.stringify((timelinePosts.body.posts || []).map((p) => p.body)));
expect('不存在的用户名 → 404', (await other('GET', '/api/u/nobody_here_xyz/timeline')).status === 404);

console.log(`\n${'─'.repeat(46)}`);
console.log(problems ? `分享 / 好友时间线检查失败 ${problems} 项` : '分享 / 好友时间线检查全部通过 ✅');
process.exit(problems ? 1 : 0);
