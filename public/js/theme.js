/**
 * 记录卡片的主题色。
 *
 * 自己和好友的记录用**同一套卡片框架**，只靠底色区分：
 *   - 自己：设置里的主题色（'' = 默认白）
 *   - 好友：他们自己设置过就用他们的；没设置就**从头像取色**
 *
 * 头像取色的做法：把头像画到 12×12 的小画布上（缩小本身就等于先模糊再取平均），
 * 再把平均色规范化到"当底色看得出来、又不影响读文字"的饱和度/亮度。
 */

export const CARD_THEME_PRESETS = [
  { id: 'ocean', name: '海蓝', color: '#2f6df6' },
  { id: 'mint', name: '薄荷', color: '#12b48a' },
  { id: 'peach', name: '暖橙', color: '#ef8a3c' },
  { id: 'lavender', name: '薰衣草', color: '#8b6cf0' },
  { id: 'sakura', name: '樱花', color: '#e8699a' },
];

const PRESET_COLORS = new Map(CARD_THEME_PRESETS.map((p) => [p.id, p.color]));
export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const avatarCache = new Map(); // avatarUrl -> Promise<hex|null>

/** 静态主题色：预设 / 自定义 #rrggbb；''、white、avatar 都返回 null */
export function themeAccent(value) {
  const v = String(value || '').trim().toLowerCase();
  if (PRESET_COLORS.has(v)) return PRESET_COLORS.get(v);
  if (HEX_COLOR_RE.test(v)) return v;
  return null;
}

/**
 * 一张卡片该用什么强调色。
 * @param {{theme?: string, avatarUrl?: string|null, isMine?: boolean}} opts
 * @returns {{accent: string|null, avatarUrl: string|null}}
 */
export function resolveCardTheme({ theme, avatarUrl, isMine }) {
  const value = String(theme || '').trim().toLowerCase();
  const accent = themeAccent(value);
  if (accent) return { accent, avatarUrl: null }; // 预设 / 自定义
  if (value === 'white') return { accent: null, avatarUrl: null };
  if (value === 'avatar') return { accent: null, avatarUrl: avatarUrl || null };
  // 没设置过：自己的记录保持默认白，别人的记录用他的头像取色
  if (isMine) return { accent: null, avatarUrl: null };
  return { accent: null, avatarUrl: avatarUrl || null };
}

/** 从头像算主题色（带缓存；取不到就返回 null，卡片退回默认白） */
export function themeFromAvatar(url) {
  if (!url) return Promise.resolve(null);
  if (avatarCache.has(url)) return avatarCache.get(url);
  const task = new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(extractTheme(img));
    img.onerror = () => resolve(null);
    img.src = url;
  });
  avatarCache.set(url, task);
  return task;
}

function extractTheme(img) {
  try {
    const size = 12; // 缩到 12×12：等于先模糊再取平均
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 16) continue; // 透明像素不算
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (!n) return null;
    return normalizeTheme(r / n, g / n, b / n);
  } catch {
    return null; // 隐私模式 / 跨域等取不到像素：退回默认白
  }
}

/** 平均色 → 能当底色的主题色：太灰就提饱和，太亮/太暗就夹到中间 */
function normalizeTheme(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = Math.min(0.82, Math.max(0.42, s));
  const light = Math.min(0.62, Math.max(0.44, l));
  return hslToHex(h, sat, light);
}

function rgbToHsl(r, g, b) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}
