/**
 * 纪念日「关联好友」功能测试：
 *   1) 后端：只能关联好友、可解除、解除好友关系后自动清空
 *   2) 日历接口：标注与倒计时里带关联好友信息
 *   3) 按好友查询接口
 * 运行：node scripts/anniversary-friend-test.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:81';

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
      if (f.startsWith('daylog_session=')) cookie = f;
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 150) };
    }
    return { status: res.status, body };
  };
}

const me = client();
const friend = client();
const stranger = client();
const st = Date.now().toString().slice(-6);
const meName = `af${st}`;
const friendName = `ag${st}`;
const strangerName = `ah${st}`;

await me('POST', '/api/auth/signup', { username: meName, password: 'demo1234', displayName: '我' });
await friend('POST', '/api/auth/signup', { username: friendName, password: 'demo1234', displayName: '好友小明' });
await stranger('POST', '/api/auth/signup', { username: strangerName, password: 'demo1234', displayName: '陌生人' });

const meId = (await me('GET', '/api/auth/me')).body.user.id;
const friendInfo = (await me('GET', `/api/users/lookup?username=${friendName}`)).body.user;
const strangerInfo = (await me('GET', `/api/users/lookup?username=${strangerName}`)).body.user;

// 成为好友
await me('POST', '/api/friends/requests', { username: friendName });
await friend('POST', `/api/friends/requests/${meId}/accept`);

console.log('\n▸ 关联好友（合法路径）');
const created = await me('POST', '/api/anniversaries', {
  name: '和小明的纪念日',
  icon: '💍',
  date: '2024-03-15',
  note: '认识的日子',
  friendId: friendInfo.id,
});
check('可以关联好友', created.status === 201 && created.body.anniversary.friendId === friendInfo.id, `status=${created.status}`);
check('返回关联好友信息（含头像字段）', created.body.anniversary.friend?.username === friendName, JSON.stringify(created.body.anniversary.friend));
check('返回 displayName 用于展示', created.body.anniversary.friend?.displayName === '好友小明', JSON.stringify(created.body.anniversary.friend));

console.log('\n▸ 不关联也可以（不强制）');
const noLink = await me('POST', '/api/anniversaries', { name: '不关联的纪念日', icon: '🎉', date: '2023-01-01' });
check('不传 friendId 时为 null', noLink.status === 201 && noLink.body.anniversary.friendId === null, JSON.stringify(noLink.body.anniversary.friendId));
check('friend 字段为 null', noLink.body.anniversary.friend === null);

console.log('\n▸ 校验');
const notFriend = await me('POST', '/api/anniversaries', { name: 'x', date: '2024-01-01', friendId: strangerInfo.id });
check('不能关联非好友', notFriend.status === 400 && notFriend.body.code === 'not_friend', `status=${notFriend.status} code=${notFriend.body.code}`);
const self = await me('POST', '/api/anniversaries', { name: 'x', date: '2024-01-01', friendId: meId });
check('不能关联自己', self.status === 400 && self.body.code === 'bad_friend', `status=${self.status}`);

console.log('\n▸ 修改与解除关联');
const target = created.body.anniversary.id;
const switched = await me('PATCH', `/api/anniversaries/${target}`, { friendId: '' });
check('传空字符串可解除关联', switched.status === 200 && switched.body.anniversary.friendId === null, JSON.stringify(switched.body.anniversary.friendId));
const relink = await me('PATCH', `/api/anniversaries/${target}`, { friendId: friendInfo.id });
check('可以重新关联', relink.body.anniversary.friendId === friendInfo.id);
const onlyName = await me('PATCH', `/api/anniversaries/${target}`, { name: '改名后仍关联' });
check('只改名称不会丢关联', onlyName.body.anniversary.friendId === friendInfo.id && onlyName.body.anniversary.name === '改名后仍关联', JSON.stringify(onlyName.body.anniversary));

console.log('\n▸ 按好友查询');
const ofFriend = await me('GET', `/api/anniversaries/of/${friendInfo.id}`);
check('能查到关联该好友的纪念日', ofFriend.status === 200 && ofFriend.body.anniversaries.length === 1, `count=${ofFriend.body.anniversaries?.length}`);
check('返回的正是那一条', ofFriend.body.anniversaries[0]?.id === target, ofFriend.body.anniversaries[0]?.id);
check('回传 friendId', ofFriend.body.friendId === friendInfo.id);
const noneForStranger = await me('GET', `/api/anniversaries/of/${strangerInfo.id}`);
check('非好友查询被拒 403', noneForStranger.status === 403, `status=${noneForStranger.status}`);
const meQuery = await me('GET', `/api/anniversaries/of/${meId}`);
check('可以查自己（返回空，因为没人关联我）', meQuery.status === 200 && meQuery.body.anniversaries.length === 0);

console.log('\n▸ 日历接口带关联好友信息');
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const monthWithAnn = '2024-03';
const cal = await me('GET', `/api/calendar?month=${monthWithAnn}`);
check('日历返回 anniversaries', Array.isArray(cal.body.anniversaries), JSON.stringify(Object.keys(cal.body)));
const linked = (cal.body.anniversaries || []).find((a) => a.id === target);
check('本月纪念日在列表里', !!linked, JSON.stringify(cal.body.anniversaries?.map((a) => a.name)));
check('列表项带 friend（头像用）', linked?.friend?.username === friendName, JSON.stringify(linked?.friend));
check('marks 里也带 friendId', Object.values(cal.body.marks || {}).some((arr) => arr.some((m) => m.friendId === friendInfo.id)), JSON.stringify(cal.body.marks));

console.log('\n▸ 解除好友关系后自动清空关联');
await me('DELETE', `/api/friends/${friendInfo.id}`);
const afterRemove = await me('GET', '/api/anniversaries');
const row = afterRemove.body.anniversaries.find((a) => a.id === target);
check('关联被自动清空（不留悬空引用）', row?.friendId === null, JSON.stringify(row?.friendId));
check('纪念日本身还在', !!row, 'row 不存在');

console.log(`\n${'─'.repeat(48)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `纪念日关联好友测试全部通过 ✅（${pass} 项）`);
process.exitCode = fail ? 1 : 0;
