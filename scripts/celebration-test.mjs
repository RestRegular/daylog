/**
 * 生日 / 纪念日倒计时单元测试。
 * 运行：node scripts/celebration-test.mjs
 */
import { nextCelebration, celebrationText } from '../public/js/celebration.js';

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

/** 构造一个「本地时间」的基准时刻 */
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

console.log('\n▸ 基本计算');
{
  // 今天是 2026-03-10，生日 6 月 18 日 -> 还有 100 天
  const info = nextCelebration('1995-06-18', { now: at(2026, 3, 10) });
  check('目标日期正确', info && info.target.getFullYear() === 2026 && info.target.getMonth() === 5 && info.target.getDate() === 18, JSON.stringify(info?.target));
  check('剩余天数正确（100 天）', info?.days === 100, `days=${info?.days}`);
  check('不是今天', info?.isToday === false);
  check('岁数正确（31 岁）', info?.age === 31, `age=${info?.age}`);
}

console.log('\n▸ 已过今年的日期要顺延到明年');
{
  // 今天 2026-12-25，生日 6-18 已过 -> 目标 2027-06-18
  const info = nextCelebration('1995-06-18', { now: at(2026, 12, 25) });
  check('顺延到明年', info?.target.getFullYear() === 2027, String(info?.target));
  check('剩余天数 > 0', info?.days > 0, `days=${info?.days}`);
}

console.log('\n▸ 就是今天');
{
  const info = nextCelebration('1995-06-18', { now: at(2026, 6, 18) });
  check('days = 0', info?.days === 0, `days=${info?.days}`);
  check('isToday = true', info?.isToday === true);
  check('文案为「今天」', celebrationText(info).includes('今天是你的生日'), celebrationText(info));
}

console.log('\n▸ 2 月 29 日（闰日）');
{
  // 2026 是平年：2/29 应钳制到 2/28，而不是溢出到 3/1
  const info = nextCelebration('2020-02-29', { now: at(2026, 1, 10) });
  check('平年落在 2 月 28 日', info?.target.getMonth() === 1 && info?.target.getDate() === 28, String(info?.target));
  check('不会溢出到 3 月', info?.target.getMonth() !== 2, String(info?.target));

  // 2028 是闰年：应当正好是 2/29
  const leap = nextCelebration('2020-02-29', { now: at(2028, 1, 10) });
  check('闰年落在 2 月 29 日', leap?.target.getMonth() === 1 && leap?.target.getDate() === 29, String(leap?.target));
}

console.log('\n▸ 纪念日标签与周年');
{
  const info = nextCelebration('2020-05-01', { now: at(2026, 4, 1), label: '纪念日' });
  check('剩余 30 天', info?.days === 30, `days=${info?.days}`);
  check('标签为纪念日', info?.label === '纪念日');
  check('文案用「周年」', celebrationText(info).includes('周年') === false && celebrationText(info).includes('距离纪念日'), celebrationText(info));
  const todayInfo = nextCelebration('2020-05-01', { now: at(2026, 5, 1), label: '纪念日' });
  check('今天显示周年（6 周年）', celebrationText(todayInfo).includes('6 周年'), celebrationText(todayInfo));
}

console.log('\n▸ 边界与容错');
{
  check('空值返回 null', nextCelebration('') === null && nextCelebration(null) === null);
  check('格式不对返回 null', nextCelebration('1995/06/18') === null);
  check('月份非法返回 null', nextCelebration('1995-13-01') === null);
  check('只填月日不合法（必须含年）', nextCelebration('06-18') === null);
  // 没有出生年份（如只记得月日时用户填了 1900）：仍然能算出天数
  const old = nextCelebration('1900-01-01', { now: at(2026, 1, 1) });
  check('久远的年份仍可用（今天）', old?.days === 0, `days=${old?.days}`);
}

console.log('\n▸ 跨月/跨年天数准确性');
{
  // 12-31 的第二天就是 1-1
  const info = nextCelebration('2000-01-01', { now: at(2026, 12, 31) });
  check('年末到年初为 1 天', info?.days === 1, `days=${info?.days}`);
  // 月末边界：3-31 到 4-30 应为 30 天
  const info2 = nextCelebration('2000-04-30', { now: at(2026, 3, 31) });
  check('3/31 到 4/30 为 30 天', info2?.days === 30, `days=${info2?.days}`);
}

console.log(`\n${'─'.repeat(44)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `倒计时单元测试全部通过 ✅（${pass} 项）`);
process.exitCode = fail ? 1 : 0;
