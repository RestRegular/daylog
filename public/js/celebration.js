/**
 * 生日 / 纪念日倒计时计算（纯函数，便于单测）。
 *
 * 关键点：
 *  - 用**本地时间**构造日期，避免 new Date('YYYY-MM-DD') 按 UTC 解析造成差一天
 *  - 处理 2 月 29 日：平年钳制到 2 月 28 日（而不是溢出成 3 月 1 日）
 *  - 「今天」返回 0 天并标记 isToday
 */

/** @returns {{days:number,label:string,target:Date,isToday:boolean,age:number|null}|null} */
export function nextCelebration(dateStr, { label = '生日', now = new Date() } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;

  const startYear = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!month || !day || month > 12 || day > 31) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const build = (year) => {
    const lastDay = new Date(year, month, 0).getDate(); // 该月天数
    return new Date(year, month - 1, Math.min(day, lastDay));
  };

  let target = build(today.getFullYear());
  if (target < today) target = build(today.getFullYear() + 1);

  const days = Math.round((target - today) / 86400000);
  const elapsed = target.getFullYear() - startYear;
  return {
    days,
    label,
    target,
    isToday: days === 0,
    age: elapsed > 0 && elapsed < 200 ? elapsed : null,
  };
}

/** 展示用文案 */
export function celebrationText(info) {
  if (!info) return '';
  const unit = info.label === '纪念日' ? '周年' : '岁';
  const dateText = `${info.target.getMonth() + 1} 月 ${info.target.getDate()} 日`;
  if (info.isToday) {
    return `今天是你的${info.label}！${info.age ? ` ${info.age} ${unit}` : ''}`.trim();
  }
  return `距离${info.label}还有 ${info.days} 天`;
}
