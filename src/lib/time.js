/** 轻量时间工具：全部以「客户端本地时间」为准，避免服务器时区造成日期错位。 */

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;

/** 校验并规范化 IANA 时区名 */
export function normalizeTimezone(tz, fallback = 'Asia/Shanghai') {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

const dtfCache = new Map();
function partsFormatter(timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** 在指定时区下，某时刻的 { year, month, day, hour, minute, second } */
export function zonedParts(ms, timeZone) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  let hour = get('hour');
  if (hour === 24) hour = 0; // 某些实现把午夜输出为 24
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** YYYY-MM-DD */
export function dayKey(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** HH:MM */
export function clockLabel(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** YYYY-MM-DDTHH:MM（用于 <input type="datetime-local"> 与客户端解析） */
export function localInputValue(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * 把「客户端本地墙上时间」转成真实 UTC 毫秒。
 * 例：wallToUtcMs('2024-05-01T21:30', 'Asia/Shanghai') -> 该时刻的 epoch
 */
export function wallToUtcMs(wall, timeZone) {
  const m = String(wall).match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) {
    const t = Date.parse(wall);
    return Number.isFinite(t) ? t : null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] || 0);
  const target = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // 迭代两次即可收敛（处理夏令时切换）
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function dayStartMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return wallToUtcMs(
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T00:00`,
    timeZone
  );
}

export function addDays(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * DAY;
  const dt = new Date(t);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function isValidDayKey(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
}

export function pad(n, len = 2) {
  return String(Math.abs(Math.trunc(n))).padStart(len, '0');
}

export function weekdayIndex(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 相对时间（中文），例如「3 分钟前」 */
export function relativeLabel(ms, now = Date.now()) {
  const diff = now - ms;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < MINUTE) return '刚刚';
    if (ahead < 60 * MINUTE) return `${Math.round(ahead / MINUTE)} 分钟后`;
    if (ahead < DAY) return `${Math.round(ahead / (60 * MINUTE))} 小时后`;
    return `${Math.round(ahead / DAY)} 天后`;
  }
  if (diff < MINUTE) return '刚刚';
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / (60 * MINUTE))} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 个月前`;
  return `${Math.floor(diff / (365 * DAY))} 年前`;
}
