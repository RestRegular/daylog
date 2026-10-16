/**
 * 对「已经运行中的服务」做真实冒烟测试。
 * 用 Node 内置 fetch（不经 shell，中文参数不会被破坏）。
 * 用法：node scripts/smoke-live.mjs [baseUrl]
 */
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:81';

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${extra ? ` — ${extra}` : ''}`);
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

let cookie = '';
async function req(method, path, { json, form } = {}) {
  const init = { method, headers: { 'x-daylog-tz': 'Asia/Shanghai' } };
  if (cookie) init.headers.cookie = cookie;
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  }
  const res = await fetch(`${BASE}${path}`, init);
  for (const c of res.headers.getSetCookie?.() || []) {
    const first = c.split(';')[0];
    if (first.startsWith('daylog_session=')) {
      const v = first.slice('daylog_session='.length);
      cookie = v ? `daylog_session=${v}` : '';
    }
  }
  const type = res.headers.get('content-type') || '';
  let payload = null;
  let text = '';
  if (type.includes('json')) {
    payload = await res.json();
  } else {
    text = await res.text();
  }
  return { status: res.status, type, payload, text, headers: res.headers };
}

async function statusOf(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return `${res.status} ${(res.headers.get('content-type') || '').split(';')[0]}`;
}

// 最小合法 PNG（16x16）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR42u3PMQ0AAAgDMLN/0cOChF5VgN1FQEhIaGhoaGhoaGhoaGhoaGhoaGhoaGgI4QNsAQZ8k1u1AAAAAElFTkSuQmCC',
  'base64'
);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4096, 9)]);

console.log(`\n冒烟测试目标: ${BASE}\n`);

// ---------- 静态资源 ----------
console.log('▸ 页面与静态资源');
check('主页 HTML', (await statusOf('/')).startsWith('200 text/html'));
check('样式表', (await statusOf('/css/style.css')).startsWith('200 text/css'));
check('主脚本', (await statusOf('/js/app.js')).startsWith('200 text/javascript'));
check('分享页壳（新版限时链接 /s/<token>）', (await statusOf('/s/whatever')).startsWith('200 text/html'));
check('老分享页壳 /share/<token>（页面会提示链接无效）', (await statusOf('/share/whatever')).startsWith('200 text/html'));
check('PWA manifest', (await statusOf('/manifest.webmanifest')).startsWith('200 application/manifest+json'));
check('Service Worker', (await statusOf('/sw.js')).startsWith('200 text/javascript'));
check('应用图标', (await statusOf('/icons/icon-192.png')).startsWith('200 image/png'));
check('健康检查', (await req('GET', '/api/health')).payload?.ok === true);

// ---------- 账号 ----------
console.log('\n▸ 账号');
const username = `smoke${Date.now().toString().slice(-6)}`;
const signup = await req('POST', '/api/auth/signup', {
  json: { username, password: 'demo1234', displayName: '冒烟测试', timezone: 'Asia/Shanghai' },
});
check('注册成功', signup.status === 201 && signup.payload.user?.username === username, `status=${signup.status}`);
check('登录态 Cookie 生效', cookie.startsWith('daylog_session='));

const me = await req('GET', '/api/auth/me');
check(
  '获取当前用户（不再下发永久分享令牌）',
  !!me.payload.user?.id && !('shareToken' in (me.payload.user || {})) && !('shareEnabled' in (me.payload.user || {})),
  Object.keys(me.payload.user || {}).join(',')
);
check('统计里包含记录数', typeof me.payload.user?.stats?.posts === 'number', JSON.stringify(me.payload.user?.stats));

// ---------- 发布 ----------
console.log('\n▸ 发布内容');
const now = Date.now();
const p1 = await req('POST', '/api/posts', {
  json: {
    body: '早上到公司，先看了会儿邮件 #工作',
    location: '公司',
    mood: '😀',
    tags: '工作,日常',
    createdAt: now,
  },
});
check('文本动态', p1.status === 201 && p1.payload.post?.body?.includes('邮件'), `status=${p1.status}`);
check('返回所属日期', /^\d{4}-\d{2}-\d{2}$/.test(p1.payload.post?.postDay || ''), p1.payload.post?.postDay);

const fd = new FormData();
fd.append('media', new Blob([PNG], { type: 'image/png' }), 'photo.png');
fd.append(
  'post',
  JSON.stringify({
    body: '午饭 🍜 还不错',
    createdAt: now + 3600000,
    timezone: 'Asia/Shanghai',
    mediaMeta: [{ width: 16, height: 16, duration: null }],
  })
);
const p2 = await req('POST', '/api/posts', { form: fd });
const img = p2.payload?.post?.media?.[0];
check('图片动态（真实 multipart）', p2.status === 201 && p2.payload.post?.body?.includes('午饭'), `status=${p2.status}`);
check('图片宽高/体积入库', img?.kind === 'image' && img?.width === 16 && img?.bytes === PNG.length, JSON.stringify(img));
check('图片可访问', (await statusOf(img?.url)).startsWith('200 image/png'));

const fd2 = new FormData();
fd2.append('media', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
fd2.append('poster', new Blob([PNG], { type: 'image/jpeg' }), 'poster.jpg');
fd2.append('post', JSON.stringify({ body: '下午打了会儿球', mediaMeta: [{ width: 1280, height: 720, duration: 8.4 }] }));
const p3 = await req('POST', '/api/posts', { form: fd2 });
const vid = p3.payload?.post?.media?.[0];
check('视频动态（带封面）', p3.status === 201 && vid?.kind === 'video', `status=${p3.status}`);
check('视频时长与封面URL', vid?.duration === 8.4 && !!vid?.posterUrl, JSON.stringify(vid));
check('封面可访问', (await statusOf(vid?.posterUrl)).startsWith('200'));
check(
  '视频支持 Range（拖动进度条）',
  (await fetch(`${BASE}${vid?.url}`, { headers: { range: 'bytes=0-7' } })).status === 206
);

// ---------- 时间线 ----------
console.log('\n▸ 时间线');
const list = await req('GET', '/api/posts?limit=10');
check('列表返回 3 条', list.payload.posts?.length === 3, `count=${list.payload.posts?.length}`);
check('按时间倒序', (list.payload.posts?.[0]?.createdAt || 0) >= (list.payload.posts?.[1]?.createdAt || 0));

const day = p1.payload.post.postDay;
const nextDay = p2.payload.post.postDay; // 图片时间晚 1 小时，可能已跨天
const byDay = await req('GET', `/api/posts?from=${day}&to=${day}`);
const expectedOnDay = [p1, p2, p3].filter((p) => p.payload?.post?.postDay === day).length;
check('按日期过滤', byDay.payload.posts?.length === expectedOnDay, `count=${byDay.payload.posts?.length} 期望 ${expectedOnDay}（另一条在 ${nextDay}）`);

const cal = await req('GET', `/api/calendar?month=${day.slice(0, 7)}`);
const calTotal = (cal.payload.days || []).reduce((sum, d) => sum + d.c, 0);
check('日历统计与记录总数一致', calTotal === 3, JSON.stringify(cal.payload.days));

// 注意：断言用的必须是正文里「连续出现」的子串（'下午打了会儿球' 中并没有连续的 '打球'）
const search = await req('GET', `/api/posts?q=${encodeURIComponent('打了')}`);
check('中文关键词搜索（连续子串）', search.payload.posts?.length === 1, `count=${search.payload.posts?.length}`);

const searchSingle = await req('GET', `/api/posts?q=${encodeURIComponent('球')}`);
check('中文单字搜索', searchSingle.payload.posts?.length === 1, `count=${searchSingle.payload.posts?.length}`);

const searchLoc = await req('GET', `/api/posts?q=${encodeURIComponent('公司')}`);
check('按地点搜索', searchLoc.payload.posts?.length === 1, `count=${searchLoc.payload.posts?.length}`);

const searchNone = await req('GET', `/api/posts?q=${encodeURIComponent('不存在的词xyz')}`);
check('无结果时返回空数组', searchNone.payload.posts?.length === 0, `count=${searchNone.payload.posts?.length}`);

const searchWildcard = await req('GET', `/api/posts?q=${encodeURIComponent('%')}`);
check('通配符 % 被转义（不会匹配全部）', searchWildcard.payload.posts?.length === 0, `count=${searchWildcard.payload.posts?.length}`);

const byTag = await req('GET', `/api/posts?tag=${encodeURIComponent('工作')}`);
check('标签搜索', byTag.payload.posts?.length === 1, `count=${byTag.payload.posts?.length}`);

// ---------- 分享（访客视角） ----------
console.log('\n▸ 限时分享链接（访客视角）');
const shareCreate = await req('POST', '/api/share/links', { json: { scope: 'all', hours: 24 } });
const token = shareCreate.payload?.link?.token;
check(
  '生成限时分享链接（范围绑在链接上）',
  shareCreate.status === 201 && shareCreate.payload?.link?.scope === 'all',
  `status=${shareCreate.status} ${JSON.stringify(shareCreate.payload).slice(0, 160)}`
);
check('链接地址是 /s/<token>', shareCreate.payload?.link?.url === `/s/${token}`, String(shareCreate.payload?.link?.url));
const savedCookie = cookie;
cookie = '';
check('分享页可打开', (await statusOf(`/s/${token}`)).startsWith('200 text/html'));
const anon = await req('GET', `/api/s/${token}/posts?limit=10`);
check('访客能读到 3 条', anon.payload.posts?.length === 3, `count=${anon.payload.posts?.length}`);
check('访客看到作者昵称', anon.payload.profile?.displayName === '冒烟测试', JSON.stringify(anon.payload.profile));
check('访客看到统计', anon.payload.profile?.stats?.posts === 3, JSON.stringify(anon.payload.profile?.stats));
check('访客可加载图片', (await statusOf(img?.url)).startsWith('200'));
check('二维码 SVG', (await statusOf(`/api/qr?data=${encodeURIComponent(`${BASE}/s/${token}`)}`)).startsWith('200 image/svg+xml'));
const badShare = await req('GET', '/api/s/zzzznotexist/posts');
check('无效分享链接返回 404', badShare.status === 404 && badShare.payload.code === 'not_found', `status=${badShare.status}`);
const legacyShare = await req('GET', `/api/share/${token}/posts`);
check('老的 /api/share/<token>/posts 已删除（404）', legacyShare.status === 404, `status=${legacyShare.status}`);

// ---------- 权限边界 ----------
console.log('\n▸ 权限边界');
cookie = savedCookie;
const priv = await req('POST', '/api/posts', { json: { body: '只有我能看到的记录', visibility: 'private' } });
check('发布私密记录', priv.payload.post?.visibility === 'private');
cookie = '';
const anon2 = await req('GET', `/api/s/${token}/posts?limit=10`);
check(
  '访客看不到私密记录',
  !(anon2.payload.posts || []).some((p) => p.body.includes('只有我能看到')),
  JSON.stringify((anon2.payload.posts || []).map((p) => p.body))
);
const noAuth = await req('GET', '/api/posts');
check('未登录访问自己的时间线 → 401', noAuth.status === 401, `status=${noAuth.status}`);
cookie = savedCookie;

// ---------- 分享链接：范围 / 撤销 ----------
console.log('\n▸ 分享链接：范围绑定 + 撤销');
const dayLink = await req('POST', '/api/share/links', { json: { scope: 'day', day, hours: 1 } });
check('生成按天链接', dayLink.status === 201 && dayLink.payload.link?.day === day, `status=${dayLink.status} ${JSON.stringify(dayLink.payload).slice(0, 140)}`);
const dayToken = dayLink.payload.link?.token;
const monthLink = await req('POST', '/api/share/links', { json: { scope: 'month', month: day.slice(0, 7) } });
check('生成按月链接', monthLink.status === 201 && monthLink.payload.link?.month === day.slice(0, 7), `status=${monthLink.status}`);
check('范围不合法被拒绝 400', (await req('POST', '/api/share/links', { json: { scope: 'week' } })).status === 400);
const linkList = await req('GET', '/api/share/links');
check(
  '链接列表能列出自己生成的链接',
  (linkList.payload.links || []).some((l) => l.token === dayToken && l.url === `/s/${dayToken}`),
  JSON.stringify((linkList.payload.links || []).map((l) => l.token))
);
cookie = '';
const dayPosts = await req('GET', `/api/s/${dayToken}/posts?limit=10`);
check('按天链接的 from/to 由服务端按链接决定', dayPosts.payload.from === day && dayPosts.payload.to === day, JSON.stringify({ from: dayPosts.payload.from, to: dayPosts.payload.to }));
const forcedRange = await req('GET', `/api/s/${dayToken}/posts?range=all&date=2001-01-01&from=2001-01-01&to=2001-12-31`);
check('客户端传 range/date 一律无效', forcedRange.payload.from === day && forcedRange.payload.to === day, JSON.stringify({ from: forcedRange.payload.from, to: forcedRange.payload.to }));
cookie = savedCookie;
check('撤销链接', (await req('DELETE', `/api/share/links/${dayToken}`)).status === 200);
cookie = '';
const revoked = await req('GET', `/api/s/${dayToken}/posts`);
check('撤销后 410 share_revoked', revoked.status === 410 && revoked.payload.code === 'share_revoked', `status=${revoked.status} code=${revoked.payload.code}`);
cookie = savedCookie;
check('撤销后不再出现在列表里', !((await req('GET', '/api/share/links')).payload.links || []).some((l) => l.token === dayToken));
check('老的重置令牌接口已删除（404）', (await req('POST', '/api/me/share/rotate')).status === 404);
check('旧的 shareEnabled 开关不再出现在设置返回里', !('shareEnabled' in ((await req('PATCH', '/api/me/settings', { json: { shareEnabled: false } })).payload.user || {})));

// ---------- 编辑时追加图片/视频 ----------
console.log('\n▸ 编辑动态时追加图片 / 视频（曾经会丢）');
{
  const created = await req('POST', '/api/posts', { json: { body: '待编辑的记录' } });
  check('新建纯文本记录', created.status === 201 && created.payload.post.media.length === 0, `status=${created.status}`);
  const editId = created.payload.post.id;

  const fd = new FormData();
  fd.append('media', new Blob([PNG], { type: 'image/png' }), 'edit-added.png');
  fd.append(
    'post',
    JSON.stringify({ body: '编辑后带图', mediaMeta: [{ width: 16, height: 16, duration: null }] })
  );
  const edited = await req('PATCH', `/api/posts/${editId}`, { form: fd });
  check('编辑时追加图片成功', edited.status === 200 && edited.payload.post.media?.length === 1, `status=${edited.status} media=${edited.payload.post.media?.length}`);
  const added = edited.payload.post.media?.[0];
  check('追加的图片可访问', (await statusOf(added?.url)).startsWith('200 image/png'), added?.url);

  const relist = await req('GET', '/api/posts?scope=mine&limit=50');
  const persisted = (relist.payload.posts || []).find((p) => p.id === editId);
  check('重新拉取列表里图片仍在（这是真机上的问题点）', persisted?.media?.length === 1, `media=${persisted?.media?.length}`);
  check('重新拉取正文已更新', persisted?.body === '编辑后带图', persisted?.body);

  await req('DELETE', `/api/posts/${editId}`);
}

// ---------- 好友共享 ----------
console.log('\n▸ 好友共享（添加好友 + 合并时间线）');
{
  const savedCookie = cookie;

  // 1) 新增一个"好友"账号
  cookie = '';
  const friendName = `mate${Date.now().toString().slice(-6)}`;
  const friendSignup = await req('POST', '/api/auth/signup', {
    json: { username: friendName, password: 'demo1234', displayName: '好友小张' },
  });
  check('好友账号注册成功', friendSignup.status === 201, `status=${friendSignup.status}`);
  const friendCookie = cookie;

  // 2) 我按用户名查找并申请
  cookie = savedCookie;
  const lookup = await req('GET', `/api/users/lookup?username=${friendName}`);
  check('按用户名查找好友', lookup.payload.user?.username === friendName, JSON.stringify(lookup.payload));
  const friendId = lookup.payload.user?.id;

  const request = await req('POST', '/api/friends/requests', { json: { username: friendName } });
  check('发送好友申请', request.status === 201 && request.payload.status === 'pending', `status=${request.status}`);
  const dupRequest = await req('POST', '/api/friends/requests', { json: { username: friendName } });
  check('重复申请被拒绝', dupRequest.status === 409, `status=${dupRequest.status}`);

  // 3) 对方收到并同意（同意时必须传"发起人"的 id，所以先记下自己的 id）
  cookie = savedCookie;
  const myId = (await req('GET', '/api/auth/me')).payload.user.id;

  cookie = friendCookie;
  const inbox = await req('GET', '/api/friends');
  check('对方看到待处理请求', inbox.payload.incoming?.length === 1, JSON.stringify(inbox.payload.incoming?.length));
  check('对方能看到申请人是谁', inbox.payload.incoming?.[0]?.user?.id === myId, JSON.stringify(inbox.payload.incoming?.[0]?.user?.username));
  const accepted = await req('POST', `/api/friends/requests/${myId}/accept`);
  check('对方同意申请', accepted.status === 200 && accepted.payload.ok === true, `status=${accepted.status}`);
  await req('POST', '/api/posts', { json: { body: '好友的公开动态', visibility: 'public' } });
  await req('POST', '/api/posts', { json: { body: '好友的私密动态', visibility: 'private' } });

  // 4) 我这边检查三种范围
  cookie = savedCookie;
  const mine = await req('GET', '/api/posts?scope=mine&limit=20');
  check('scope=mine 只有自己', (mine.payload.posts || []).every((p) => p.isOwner), JSON.stringify((mine.payload.posts || []).map((p) => p.body)));
  check('scope=mine 含自己的私密记录', (mine.payload.posts || []).some((p) => p.body.includes('只有我能看到')), '');
  check('scope=mine 不含好友内容', !(mine.payload.posts || []).some((p) => p.body === '好友的公开动态'));

  const onlyFriends = await req('GET', '/api/posts?scope=friends&limit=20');
  const friendBodies = (onlyFriends.payload.posts || []).map((p) => p.body);
  check('scope=friends 看到好友动态', friendBodies.includes('好友的公开动态'), JSON.stringify(friendBodies));
  check('scope=friends 看不到好友私密动态', !friendBodies.includes('好友的私密动态'));
  check('好友动态带作者信息', onlyFriends.payload.posts?.[0]?.author?.username === friendName, JSON.stringify(onlyFriends.payload.posts?.[0]?.author));
  check('scope=friends 不含自己的动态', !friendBodies.some((b) => b.includes('打球') || b.includes('午饭')));

  const all = await req('GET', '/api/posts?scope=all&limit=20');
  const allBodies = (all.payload.posts || []).map((p) => p.body);
  check(
    'scope=all 同时有我 + 好友',
    allBodies.includes('好友的公开动态') && (all.payload.posts || []).some((p) => p.isOwner),
    JSON.stringify(allBodies.slice(0, 4))
  );
  check('scope=all 不含任何私密内容', !allBodies.some((b) => b.includes('私密') || b.includes('只有我能看到')));
  check('scope=all 返回好友数量', all.payload.friendCount === 1, String(all.payload.friendCount));

  // 5) 备注名 + 单独查看好友
  const alias = await req('PATCH', `/api/friends/${friendId}`, { json: { alias: '小张' } });
  check('设置好友备注', alias.status === 200, `status=${alias.status}`);
  const friendList = await req('GET', '/api/friends');
  check('备注名生效', friendList.payload.friends?.[0]?.displayName === '小张', JSON.stringify(friendList.payload.friends?.[0]));

  const only = await req('GET', `/api/posts?scope=only&author=${friendId}&limit=10`);
  check('单独查看某个好友的动态', (only.payload.posts || []).every((p) => p.author?.username === friendName), `count=${(only.payload.posts || []).length}`);

  // 6) 解除好友后不再可见
  const removed = await req('DELETE', `/api/friends/${friendId}`);
  check('解除好友', removed.status === 200, `status=${removed.status}`);
  const afterRemove = await req('GET', '/api/posts?scope=all&limit=20');
  check('解除后看不到对方动态', !(afterRemove.payload.posts || []).some((p) => p.body === '好友的公开动态'));
  check('解除后自己动态仍在', (afterRemove.payload.posts || []).some((p) => p.isOwner), `owner=${(afterRemove.payload.posts || []).filter((p) => p.isOwner).length}`);
}

// ---------- 分享仍然可用（与好友互不影响） ----------
console.log('\n▸ 分享与好友共存');
{
  const mine = cookie;
  const shareAgain = await req('POST', '/api/share/links', { json: { scope: 'all' } });
  const againToken = shareAgain.payload?.link?.token;
  check('好友功能上线后仍能生成分享链接', shareAgain.status === 201 && !!againToken, `status=${shareAgain.status}`);
  cookie = '';
  const read = await req('GET', `/api/s/${againToken}/posts?limit=10`);
  check('访客照常能读分享链接', read.status === 200 && (read.payload.posts || []).length >= 3, `count=${(read.payload.posts || []).length}`);
  check('访客看不到好友相关内容', !(read.payload.posts || []).some((p) => p.body === '好友的公开动态'));
  check('访客看到的是主人自己的记录', (read.payload.posts || []).every((p) => p.author?.username === username), JSON.stringify((read.payload.posts || []).map((p) => p.author?.username)));
  cookie = mine;
}

// ---------- 纪念日（生日 + 多个自定义 + 特别关注） ----------
console.log('\n▸ 纪念日（多个 + 特别关注唯一 + 日历标注）');
{
  const initial = await req('GET', '/api/anniversaries');
  check('初始无纪念日', initial.status === 200 && (initial.payload.anniversaries || []).length === 0, JSON.stringify(initial.payload));

  const birthday = await req('POST', '/api/anniversaries', {
    json: { name: '生日', icon: '🎂', date: '1995-06-18', kind: 'birthday', note: '记得订蛋糕' },
  });
  check('添加生日（自动特别关注）', birthday.status === 201 && birthday.payload.anniversary.special === true, `status=${birthday.status}`);
  check('生日带倒计时数据', typeof birthday.payload.anniversary.next?.days === 'number', JSON.stringify(birthday.payload.anniversary.next));

  const dupBirthday = await req('POST', '/api/anniversaries', { json: { name: '生日2', date: '1990-01-01', kind: 'birthday' } });
  check('只能有一个生日', dupBirthday.status === 409, `status=${dupBirthday.status}`);

  const wedding = await req('POST', '/api/anniversaries', { json: { name: '结婚纪念日', icon: '💍', date: '2020-05-01', note: '订花', special: true } });
  check('添加结婚纪念日并设为特别关注', wedding.status === 201 && wedding.payload.anniversary.special === true, `status=${wedding.status}`);
  const work = await req('POST', '/api/anniversaries', { json: { name: '入职纪念日', icon: '💼', date: '2022-09-01' } });
  check('添加第三个纪念日（非特别关注）', work.status === 201 && work.payload.anniversary.special === false, `status=${work.status}`);

  const afterThird = (await req('GET', '/api/anniversaries')).payload.anniversaries;
  check('共 3 个纪念日', afterThird.length === 3, `count=${afterThird.length}`);
  check(
    '特别关注 = 生日 + 至多 1 个自定义',
    afterThird.filter((a) => a.special && !a.isBirthday).length === 1 && afterThird.some((a) => a.isBirthday && a.special),
    JSON.stringify(afterThird.map((a) => `${a.name}:${a.special}`))
  );

  // 把自定义特别关注换到第三个上
  await req('PATCH', `/api/anniversaries/${work.payload.anniversary.id}`, { json: { special: true } });
  const afterSwitch = (await req('GET', '/api/anniversaries')).payload.anniversaries;
  const specials = afterSwitch.filter((a) => a.special && !a.isBirthday);
  check('切换后自定义特别关注仍只有 1 个', specials.length === 1, JSON.stringify(afterSwitch.map((a) => `${a.name}:${a.special}`)));
  check('切换后是入职纪念日', specials[0]?.name === '入职纪念日', specials[0]?.name);
  check(
    '生日依然是特别关注（不会被顶掉）',
    afterSwitch.some((a) => a.isBirthday && a.special),
    JSON.stringify(afterSwitch.map((a) => `${a.name}:${a.special}`))
  );

  // 修改
  const edited = await req('PATCH', `/api/anniversaries/${work.payload.anniversary.id}`, {
    json: { name: '入职三周年', icon: '🎉', note: '三年了' },
  });
  check('修改名称/图标/说明', edited.payload.anniversary.name === '入职三周年' && edited.payload.anniversary.icon === '🎉' && edited.payload.anniversary.note === '三年了', JSON.stringify(edited.payload.anniversary));

  // 生日不允许取消特别关注
  const unsetBirthday = await req('PATCH', `/api/anniversaries/${birthday.payload.anniversary.id}`, { json: { special: false } });
  check('生日无法取消特别关注', unsetBirthday.payload.anniversary.special === true);

  // 日历标注
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const cal = await req('GET', `/api/calendar?month=${month}`);
  check('日历返回纪念日标注字段', cal.payload.marks !== undefined && Array.isArray(cal.payload.anniversaries), JSON.stringify(Object.keys(cal.payload)));
  const nextMonthDate = afterSwitch.find((a) => a.next && a.next.month === Number(month.slice(5, 7)));
  if (nextMonthDate) {
    check('本月纪念日出现在 marks 里', Object.keys(cal.payload.marks).some((k) => (cal.payload.marks[k] || []).some((m) => m.id === nextMonthDate.id)), JSON.stringify(cal.payload.marks));
  } else {
    check('本月无纪念日时 marks 为空对象', typeof cal.payload.marks === 'object', JSON.stringify(cal.payload.marks));
  }

  // 移除
  const removed = await req('DELETE', `/api/anniversaries/${wedding.payload.anniversary.id}`);
  check('移除纪念日', removed.status === 200, `status=${removed.status}`);
  const afterRemove = (await req('GET', '/api/anniversaries')).payload.anniversaries;
  check('移除后剩 2 个', afterRemove.length === 2, `count=${afterRemove.length}`);

  // 非法输入
  check('非法日期被拒', (await req('POST', '/api/anniversaries', { json: { name: 'x', date: '2020/01/01' } })).status === 400);
  check('空名称被拒', (await req('POST', '/api/anniversaries', { json: { name: '  ', date: '2020-01-01' } })).status === 400);
  check('改不存在的纪念日 404', (await req('PATCH', '/api/anniversaries/nope', { json: { name: 'x' } })).status === 404);

  // 首页需要的数据：接口能算出倒计时（自定义 + 生日）
  const bday = afterRemove.find((a) => a.isBirthday);
  check('首页要用的生日可算出倒计时', !!bday?.next && typeof bday.next.days === 'number', JSON.stringify(bday?.next));
  const custom = afterRemove.find((a) => !a.isBirthday);
  check('首页要用的自定义纪念日可算出倒计时', !!custom?.next && typeof custom.next.days === 'number', JSON.stringify(custom?.next));
  check('接口按「特别关注优先」排序返回', afterRemove[0]?.special === true, JSON.stringify(afterRemove.map((a) => `${a.name}:${a.special}`)));
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`冒烟测试：通过 ${pass} 项，失败 ${fail} 项`);
console.log(`测试账号：${username} / demo1234（可留作演示，也可在数据库里删掉）`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
