/** DOM / 格式化 / 图标等通用工具 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svgIcon(name, size = 24, extraClass = '') {
  const d = ICONS[name] || ICONS.dot;
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', size);
  node.setAttribute('height', size);
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.8');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  if (extraClass) node.setAttribute('class', extraClass);
  for (const item of Array.isArray(d) ? d : [d]) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', item);
    node.append(p);
  }
  return node;
}

export const ICONS = {
  dot: 'M12 12h.01',
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  calendar: 'M7 3v3M17 3v3M4 8h16M5 5.5h14A1.5 1.5 0 0 1 20.5 7v12A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5Z',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3.7 8.6a1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1.1Z',
  share: 'M12 16V4m0 0L8 8m4-4 4 4M5 14v5.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V14',
  link: 'M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.5-4.5',
  image: 'M4 5.5h16A1.5 1.5 0 0 1 21.5 7v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V7A1.5 1.5 0 0 1 4 5.5Z M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z m12.5 5-4.5-5-6 7',
  video: 'M4 6.5h11A1.5 1.5 0 0 1 16.5 8v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 16V8A1.5 1.5 0 0 1 4 6.5Z M16.5 10.5 21.5 8v8l-5-2.5',
  camera:
    'M4 8.5h2.5L8 6h8l1.5 2.5H20A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m-8 0 1 12.5a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5L17 7',
  edit: 'M4 20h4l10.5-10.5a2 2 0 0 0-2.8-2.8L5 17v3Z M14.5 6.5l3 3',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  check: 'M5 13l4.5 4.5L19 7',
  location: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M8.5 14s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01',
  text: 'M5 5.5h14M5 12h14M5 18.5h9',
  send: 'M4.5 12 20 4.5 12.5 20l-2-6.5-6-1.5Z',
  user: 'M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4.5 20.5c1.3-3.3 4-5 7.5-5s6.2 1.7 7.5 5',
  lock: 'M6.5 10.5h11A1.5 1.5 0 0 1 19 12v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19v-7a1.5 1.5 0 0 1 1.5-1.5Z M8.5 10.5V8a3.5 3.5 0 1 1 7 0v2.5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M3.5 9.5h17M3.5 14.5h17M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9S9.5 5.5 12 3Z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  // 手机通知（好友页那个"推送设置"按钮用它）
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2.5h-14l1.5-2.5Z M10 20a2 2 0 0 0 4 0',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14',
  refresh: 'M20 11a8 8 0 1 0-2.3 6M20 5v6h-6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7.5V12l3 2',
  filter: 'M4 6h16M7 12h10M10 18h4',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  playback: 'M7 4.5v15l13-7.5-13-7.5Z',
  star: 'M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85L12 3.5Z',
};

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** emoji 判定（和纪念日图标同一套规则） */
const EMOJI_RE = /(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

/**
 * 自定义心情：一个 emoji + 可选一小段说明（例如「😭 累瘫了」）。
 * 没有 emoji 就只当纯文字（最多 8 个字），保证列表里不会撑破。
 */
export function normalizeMood(input) {
  const raw = String(input || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const segments =
    typeof Intl !== 'undefined' && Intl.Segmenter
      ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(raw)].map((s) => s.segment)
      : Array.from(raw);
  const isEmoji = (s) => EMOJI_RE.test(s) && !/[\p{L}\p{N}]/u.test(s);
  const at = segments.findIndex(isEmoji);
  if (at < 0) return segments.join('').slice(0, 8);
  const emoji = segments[at];
  const rest = segments
    .slice(at + 1)
    .join('')
    .trim()
    .slice(0, 8);
  return rest ? `${emoji} ${rest}` : emoji;
}

/** 「😭 累瘫了」→ { emoji: '😭', label: '累瘫了' }（没有 emoji 就用 🙂 + 整段文字） */
export function splitMood(value) {
  const text = String(value || '').trim();
  if (!text) return { emoji: '🙂', label: '' };
  const segments =
    typeof Intl !== 'undefined' && Intl.Segmenter
      ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
      : Array.from(text);
  const first = segments[0] || '';
  const isEmoji = EMOJI_RE.test(first) && !/[\p{L}\p{N}]/u.test(first);
  if (!isEmoji) return { emoji: '🙂', label: text };
  return { emoji: first, label: segments.slice(1).join('').trim() };
}

export function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`)
    .replace(/(^|[\s（(])(#[\u4e00-\u9fa5\w-]{1,24})/g, (m, pre, tag) => `${pre}<a href="#/search?tag=${encodeURIComponent(tag.slice(1))}" class="hashtag">${tag}</a>`);
}

// ---------------- 日期 ----------------

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 取本地日期键 YYYY-MM-DD */
export function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function clockOf(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** <input type="datetime-local"> 需要的值 */
export function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : Date.now();
}

export function dayKeyOfInput(value) {
  return String(value || '').slice(0, 10);
}

export function weekdayOf(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

export function dayLabel(day, today = dayKeyOf(Date.now())) {
  if (!day) return '';
  if (day === today) return '今天';
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = dayKeyOf(new Date(y, m - 1, d - 1).getTime());
  if (day === yesterday) return '昨天';
  const [yy, mm, dd] = day.split('-').map(Number);
  const sameYear = yy === y;
  const wd = weekdayOf(day);
  return sameYear ? `${mm} 月 ${dd} 日 ${wd}` : `${yy} 年 ${mm} 月 ${dd} 日 ${wd}`;
}

export function relativeTime(ms, now = Date.now()) {
  const diff = now - ms;
  const min = 60000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 0) return '刚刚';
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
  return `${Math.floor(diff / (365 * day))} 年前`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 通用开关按钮（设置页 / 好友推送设置都用它）。
 * 放在 util 是因为 friends.js 也要用，而 app.js 会 import friends.js —— 反向 import 会成环。
 */
export function toggleSwitch(checked, onChange) {
  const btn = el(
    'button',
    {
      class: `switch${checked ? ' on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
    },
    el('span', { class: 'knob' })
  );
  btn.addEventListener('click', () => {
    const value = !btn.classList.contains('on');
    btn.classList.toggle('on', value);
    btn.setAttribute('aria-checked', value ? 'true' : 'false');
    onChange(value);
  });
  return btn;
}

export function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${pad2(s)}`;
}

export function monthLabel(month) {
  const [y, m] = String(month).split('-');
  return `${y} 年 ${Number(m)} 月`;
}

export function addMonths(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function daysInMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function firstWeekdayOfMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(y, m - 1, 1).getDay();
}

export function todayKey() {
  return dayKeyOf(Date.now());
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function storage(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

export function isTouch() {
  return window.matchMedia('(hover: none)').matches;
}

/** 触发文件选择 */
export function pickFiles({ accept = 'image/*,video/*', multiple = true, capture = null } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple: multiple ? true : null });
    if (capture) input.setAttribute('capture', capture);
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试降级方案 */
  }
  try {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
