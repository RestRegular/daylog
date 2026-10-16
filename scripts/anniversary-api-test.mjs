/**
 * 纪念日 API 联调测试（断言式，退出码可靠）
 * 运行：node scripts/anniversary-api-test.mjs [baseUrl]
 */
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:81';

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
      const first = c.split(';')[0];
      if (first.startsWith('daylog_session=')) {
        const v = first.slice('daylog_session='.length);
        cookie = v ? `daylog_session=${v}` : '';
      }
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
const other = client();
const stamp = Date.now().toString().slice(-6);
await me('POST', '/api/auth/signup', { username: `an${stamp}`, password: 'demo1234' });
await other('POST', '/api/auth/signup', { username: `ao${stamp}`, password: 'demo1234' });

console.log('\n▸ 增删改查');
const empty = await me('GET', '/api/anniversaries');
check('新账号没有纪念日', empty.status === 200 && empty.body.anniversaries.length === 0);

const birthday = await me('POST', '/api/anniversaries', {
  name: '生日',
  icon: '🎂',
  date: '1995-06-18',
  note: '订蛋糕',
  kind: 'birthday',
});
check('添加生日（自动特别关注）', birthday.status === 201 && birthday.body.anniversary.special === true, `status=${birthday.status}`);
check('生日返回倒计时', typeof birthday.body.anniversary.next?.days === 'number', JSON.stringify(birthday.body.anniversary.next));

const wedding = await me('POST', '/api/anniversaries', { name: '结婚纪念日', icon: '💍', date: '2020-05-01', special: true });
const work = await me('POST', '/api/anniversaries', { name: '入职纪念日', icon: '💼', date: '2022-09-01' });
check('可添加多个自定义纪念日', wedding.status === 201 && work.status === 201);

const list = await me('GET', '/api/anniversaries');
check('共 3 条', list.body.anniversaries.length === 3, `count=${list.body.anniversaries.length}`);
check('排序：特别关注优先', list.body.anniversaries[0].special === true, JSON.stringify(list.body.anniversaries.map((a) => `${a.name}:${a.special}`)));

console.log('\n▸ 唯一性约束');
const dupBirthday = await me('POST', '/api/anniversaries', { name: '生日2', date: '1990-01-01', kind: 'birthday' });
check('只能有一个生日', dupBirthday.status === 409, `status=${dupBirthday.status}`);

await me('PATCH', `/api/anniversaries/${work.body.anniversary.id}`, { special: true });
const afterSwitch = (await me('GET', '/api/anniversaries')).body.anniversaries;
check(
  '自定义特别关注全局唯一',
  afterSwitch.filter((a) => a.special && !a.isBirthday).length === 1,
  JSON.stringify(afterSwitch.map((a) => `${a.name}:${a.special}`))
);
check('生日不会被顶掉', afterSwitch.some((a) => a.isBirthday && a.special));

console.log('\n▸ 修改与移除');
const edited = await me('PATCH', `/api/anniversaries/${work.body.anniversary.id}`, { name: '入职三周年', icon: '🎉', note: '三年了' });
check(
  '修改名称/图标/说明',
  edited.status === 200 && edited.body.anniversary.name === '入职三周年' && edited.body.anniversary.icon === '🎉' && edited.body.anniversary.note === '三年了',
  JSON.stringify(edited.body.anniversary)
);
const unsetBirthday = await me('PATCH', `/api/anniversaries/${birthday.body.anniversary.id}`, { special: false });
check('生日无法取消特别关注', unsetBirthday.body.anniversary.special === true);
check('移除纪念日', (await me('DELETE', `/api/anniversaries/${wedding.body.anniversary.id}`)).status === 200);
const afterRemove = (await me('GET', '/api/anniversaries')).body.anniversaries;
check('移除后剩 2 条', afterRemove.length === 2, `count=${afterRemove.length}`);
check('移除后再删返回 404', (await me('DELETE', `/api/anniversaries/${wedding.body.anniversary.id}`)).status === 404);

console.log('\n▸ 闰日与倒计时');
const leap = await me('POST', '/api/anniversaries', { name: '闰日', icon: '📅', date: '2020-02-29' });
const next = leap.body.anniversary.next;
check('2/29 只落在 2 月', next.month === 2, JSON.stringify(next));
check('平年钳制到 2 月 28 日或闰年为 29 日', next.day === 28 || next.day === 29, JSON.stringify(next));

console.log('\n▸ 日历标注');
const now = new Date();
const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const cal = await me('GET', `/api/calendar?month=${month}`);
check('日历返回 marks 与 anniversaries 字段', cal.body.marks !== undefined && Array.isArray(cal.body.anniversaries), JSON.stringify(Object.keys(cal.body)));
const inMonth = cal.body.anniversaries || [];
if (inMonth.length) {
  const first = inMonth[0];
  const key = Object.keys(cal.body.marks).find((k) => (cal.body.marks[k] || []).some((m) => m.id === first.id));
  check('本月纪念日出现在 marks 中且日期正确', key === `${month}-${String(first.date.slice(8, 10)).padStart(2, '0')}` || !!key, `key=${key}`);
} else {
  check('本月无纪念日时 marks 为空对象', Object.keys(cal.body.marks).length === 0, JSON.stringify(cal.body.marks));
}

console.log('\n▸ 说明与图标长度（前端 20 字上限的服务端兜底）');
{
  const longNote = '一二三四五六七八九十一二三四五六七八九十超出部分不该保存';
  const capped = await me('POST', '/api/anniversaries', { name: '长说明', icon: '🐳', date: '2021-01-01', note: longNote });
  check('说明最多保留 20 个字', [...capped.body.anniversary.note].length === 20, `len=${[...capped.body.anniversary.note].length}`);
  check('自定义 emoji 图标可用', capped.body.anniversary.icon === '🐳', capped.body.anniversary.icon);

  const zwj = await me('POST', '/api/anniversaries', { name: '组合图标', icon: '👨‍👩‍👧', date: '2021-02-02' });
  check('组合 emoji（ZWJ）不会被截坏', zwj.body.anniversary.icon === '👨‍👩‍👧', zwj.body.anniversary.icon);

  const textIcon = await me('POST', '/api/anniversaries', { name: '文字图标', icon: 'abc生日', date: '2021-02-03' });
  check('纯文字图标被拒绝（退回默认）', textIcon.body.anniversary.icon === '🎉', textIcon.body.anniversary.icon);
  const mixedIcon = await me('POST', '/api/anniversaries', { name: '混合图标', icon: '🎂生日', date: '2021-02-04' });
  check('表情混文字只留表情', mixedIcon.body.anniversary.icon === '🎂', mixedIcon.body.anniversary.icon);
  const keepIcon = await me('PATCH', `/api/anniversaries/${capped.body.anniversary.id}`, { icon: 'hello' });
  check('修改时传纯文字不覆盖原图标', keepIcon.body.anniversary.icon === '🐳', keepIcon.body.anniversary.icon);

  const patched = await me('PATCH', `/api/anniversaries/${capped.body.anniversary.id}`, { note: longNote });
  check('修改时同样截断到 20 字', [...patched.body.anniversary.note].length === 20, patched.body.anniversary.note);

  const longName = await me('POST', '/api/anniversaries', { name: '名'.repeat(40), date: '2021-03-03' });
  check('名称最多 24 个字', [...longName.body.anniversary.name].length === 24, `len=${[...longName.body.anniversary.name].length}`);
}

console.log('\n▸ 权限与非法输入');
const peek = await other('GET', '/api/anniversaries');
check('各账号纪念日互相隔离', peek.body.anniversaries.length === 0, JSON.stringify(peek.body.anniversaries));
check('改别人的纪念日 404', (await other('PATCH', `/api/anniversaries/${birthday.body.anniversary.id}`, { name: 'x' })).status === 404);
check('删别人的纪念日 404', (await other('DELETE', `/api/anniversaries/${birthday.body.anniversary.id}`)).status === 404);
check('非法日期 400', (await me('POST', '/api/anniversaries', { name: 'x', date: '2020/01/01' })).status === 400);
check('空名称 400', (await me('POST', '/api/anniversaries', { name: '   ', date: '2020-01-01' })).status === 400);
check('未登录 401', (await client()('GET', '/api/anniversaries')).status === 401);

console.log(`\n${'─'.repeat(44)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `纪念日 API 测试全部通过 ✅（${pass} 项）`);
process.exitCode = fail ? 1 : 0;
