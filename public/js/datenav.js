/**
 * 可复用的「日期导航」控件：主页和分享页共用。
 * 两排结构：第一排 = 左箭头 + 标签/日期 + 右箭头；第二排 = 日期选择 + 快捷按钮。
 */
import {
  addMonths,
  dayKeyOf,
  dayLabel,
  el,
  monthLabel,
  svgIcon,
  todayKey,
} from './util.js';

/**
 * @param {object} opts
 * @param {string} opts.date        当前日期（YYYY-MM-DD）
 * @param {boolean} [opts.all]      是否是「全部」模式（隐藏日期、显示区间提示）
 * @param {string} [opts.allLabel]  全部模式下的标题，如「全部记录」
 * @param {(date: string) => void} opts.onDate
 * @param {() => void} [opts.onToggleAll]
 * @param {string} [opts.allToggleText]
 */
export function buildDateNav({
  date,
  all = false,
  allLabel = '全部记录',
  allSubLabel = '按时间倒序',
  onDate,
  onToggleAll = null,
  allToggleText = '看全部',
}) {
  const prev = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '前一天' }, svgIcon('back', 18));
  const next = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '后一天' }, svgIcon('chevron', 18));

  const label = el(
    'div',
    { class: 'day-nav-label' },
    el('strong', {}, all ? allLabel : dayLabel(date)),
    el('span', {}, all ? allSubLabel : date)
  );

  const datePicker = el('input', {
    type: 'date',
    class: 'date-picker',
    value: date,
    'aria-label': '选择日期',
  });
  const allToggle = el(
    'button',
    { class: `chip-btn${all ? ' active' : ''}`, type: 'button' },
    all ? '看单日' : allToggleText
  );
  const todayBtn = el('button', { class: 'chip-btn today-btn', type: 'button' }, '今天');

  const shift = (delta) => {
    const [y, m, d] = date.split('-').map(Number);
    const target = new Date(y, m - 1, d + delta);
    onDate(dayKeyOf(target.getTime()));
  };
  prev.addEventListener('click', () => shift(-1));
  next.addEventListener('click', () => shift(1));
  datePicker.addEventListener('change', () => onDate(datePicker.value || todayKey()));
  todayBtn.addEventListener('click', () => onDate(todayKey()));
  if (onToggleAll) allToggle.addEventListener('click', () => onToggleAll());

  const rows = [
    el('div', { class: 'day-nav-row main-row' }, prev, label, next),
    el('div', { class: 'day-nav-row ctrl-row' }, datePicker, allToggle, todayBtn),
  ];

  return {
    node: el('div', { class: 'day-nav' }, ...rows),
    /** 只更新文字，不重建 DOM */
    update(nextDate, nextAll = all) {
      label.querySelector('strong').textContent = nextAll ? allLabel : dayLabel(nextDate);
      label.querySelector('span').textContent = nextAll ? allSubLabel : nextDate;
      datePicker.value = nextDate;
      allToggle.textContent = nextAll ? '看单日' : allToggleText;
      allToggle.classList.toggle('active', nextAll);
    },
  };
}

/** 月份导航（分享页的「按月翻」用） */
export function buildMonthNav({ month, onMonth }) {
  const prev = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '上个月' }, svgIcon('back', 18));
  const next = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '下个月' }, svgIcon('chevron', 18));
  const label = el('strong', {}, monthLabel(month));
  prev.addEventListener('click', () => onMonth(addMonths(month, -1)));
  next.addEventListener('click', () => onMonth(addMonths(month, 1)));
  return { node: el('div', { class: 'month-nav' }, prev, label, next) };
}
