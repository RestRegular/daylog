/** 上传前的客户端处理：图片压缩、视频封面截帧、元数据读取 */

export const IMAGE_MAX_EDGE = 1920;
export const IMAGE_QUALITY = 0.84;
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export class MediaError extends Error {
  constructor(message, code = 'media_error') {
    super(message);
    this.code = code;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new MediaError('这张图片无法读取（可能是 HEIC 等浏览器不支持的原图格式）', 'decode_failed'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new MediaError('图片压缩失败'))),
      type,
      quality
    );
  });
}

/** 图片：等比缩放 + 压缩，必要时带进度回调 */
export async function processImage(file, { maxEdge = IMAGE_MAX_EDGE, quality = IMAGE_QUALITY } = {}) {
  const { img, url } = await loadImage(file);
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const c2d = canvas.getContext('2d', { alpha: false });
    c2d.imageSmoothingQuality = 'high';
    c2d.fillStyle = '#fff';
    c2d.fillRect(0, 0, tw, th);
    c2d.drawImage(img, 0, 0, tw, th);
    // 带透明的格式（png/webp/gif/heic…）保留原格式；手机传的图常常 file.type 是空的，
    // 所以再看一眼文件名后缀，免得把透明图压成 jpeg 变黑底
    const hasAlpha =
      /png|webp|gif|avif|heic|heif/i.test(file.type || '') || /\.(png|webp|gif|avif|heic|heif)$/i.test(file.name || '');
    let type = hasAlpha ? 'image/webp' : 'image/jpeg';
    let blob = await canvasToBlob(canvas, type, quality);
    if (!blob || (blob.size > file.size && scale === 1 && type === 'image/webp')) {
      // 原图更小就保留原图
      blob = file;
      type = file.type;
    }
    const ext = type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : 'jpg';
    const outName = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.' + ext;
    return {
      file: new File([blob], outName, { type }),
      width: tw,
      height: th,
      duration: null,
      poster: null,
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadVideoMeta(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const cleanup = () => {
      video.removeAttribute('src');
      video.load?.();
    };
    const timer = setTimeout(() => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new MediaError('读取视频信息超时，请换个视频试试', 'video_timeout'));
    }, 20000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve({
        url,
        video,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      URL.revokeObjectURL(url);
      reject(new MediaError('这个视频浏览器无法读取（试试 MP4/H.264 格式）', 'video_decode_failed'));
    };
  });
}

/** 这一帧是不是"没截到画面"（几乎全黑 / 全白）——只用来在几次尝试之间挑一张更好的 */
function isBlankFrame(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const w = Math.min(32, canvas.width);
    const h = Math.min(32, canvas.height);
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      n += 1;
    }
    if (!n) return true;
    const avg = sum / n;
    // 注意：整屏纯色（比如一片蓝）是**正常画面**，不能当成空白，
    // 只有几乎全黑 / 全白才当作"没截到"（seek 失败时的典型表现）
    return avg < 6 || avg > 250;
  } catch {
    return false;
  }
}

/**
 * 截一帧当封面。
 * 先直接画「当前帧」（多数容器此时已经有第 0 帧，最稳），
 * 糊了/黑了再依次 seek 到 1s、0.2s、时长一半重试，挑第一张不空的。
 */
async function capturePoster(videoUrl, atSecond = 1) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MediaError('视频封面截取超时', 'poster_timeout')), 15000);
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    if (video.readyState >= 2) {
      ready();
      return;
    }
    video.onloadeddata = ready;
    video.onerror = () => {
      clearTimeout(timer);
      reject(new MediaError('无法为视频生成封面', 'poster_failed'));
    };
  });

  const w = video.videoWidth || 720;
  const h = video.videoHeight || 1280;
  const scale = Math.min(1, 720 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(w * scale));
  canvas.height = Math.max(2, Math.round(h * scale));
  const ctx = canvas.getContext('2d', { alpha: false });

  const grab = () => {
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      /* 画不出来就当作废帧 */
    }
    return !isBlankFrame(canvas);
  };
  const seek = (seconds) =>
    new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      video.onseeked = done;
      setTimeout(done, 2500);
      try {
        video.currentTime = Math.max(0, seconds);
      } catch {
        done();
      }
    });

  const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const tries = [null, Math.min(atSecond, total || atSecond), 0.2, total ? total / 2 : 0.5];
  let drew = false;
  for (const at of tries) {
    if (at !== null) await seek(at);
    drew = true;
    if (grab()) break; // 挑到一张"不像空白"的就用
  }
  // 几次都是空白（视频本身就是纯黑/纯白画面）也要用真帧，绝不拿假封面糊弄
  if (!drew) return null;
  try {
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.72);
    return { blob, width: canvas.width, height: canvas.height };
  } catch {
    return null;
  }
}

function findBytes(bytes, pattern, from = 0) {
  const first = pattern[0];
  for (let i = Math.max(0, from); i <= bytes.length - pattern.length; i += 1) {
    if (bytes[i] !== first) continue;
    let hit = true;
    for (let j = 1; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * 有些手机拍的视频文件里自带缩略图（MP4/MOV 的 `thmb` 盒子、iTunes 的 `covr`），
 * 浏览器解不了这种编码时，把它抠出来当封面 —— 是真实画面，比占位图好。
 * 只看文件头尾各 2MB（moov 可能在开头也可能在结尾）。
 */
async function embeddedThumbnail(file) {
  try {
    const CHUNK = 2 * 1024 * 1024;
    const parts = [];
    if (file.size) parts.push(new Uint8Array(await file.slice(0, Math.min(CHUNK, file.size)).arrayBuffer()));
    if (file.size > CHUNK) parts.push(new Uint8Array(await file.slice(Math.max(0, file.size - CHUNK)).arrayBuffer()));
    for (const bytes of parts) {
      for (const marker of [
        [0x74, 0x68, 0x6d, 0x62], // thmb
        [0x63, 0x6f, 0x76, 0x72], // covr
      ]) {
        const at = findBytes(bytes, marker);
        if (at < 0) continue;
        const start = findBytes(bytes, [0xff, 0xd8, 0xff], at);
        if (start < 0) continue;
        const end = findBytes(bytes, [0xff, 0xd9], start + 3);
        if (end > start && end - start > 1024) {
          return new Blob([bytes.slice(start, end + 2)], { type: 'image/jpeg' });
        }
      }
    }
  } catch {
    /* 抠不出来就算了 */
  }
  return null;
}

/** 兜底封面：深色渐变 + 播放图标（保证每个视频附件都有封面） */
async function placeholderPoster({ name = '', width = 720, height = 405 } = {}) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 405;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 720, 405);
    grad.addColorStop(0, '#2a3040');
    grad.addColorStop(1, '#161a24');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 720, 405);
    // 中间一个圆的播放三角
    ctx.beginPath();
    ctx.arc(360, 190, 52, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(344, 162);
    ctx.lineTo(344, 218);
    ctx.lineTo(392, 190);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fill();
    if (name) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '20px system-ui, sans-serif';
      const label = name.length > 28 ? `${name.slice(0, 27)}…` : name;
      ctx.fillText(label, 28, 372);
    }
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.72);
    return { blob, width, height };
  } catch {
    return null;
  }
}

/** 视频：读取时长 / 尺寸，并截一帧当封面（**任何视频都要有封面**） */
export async function processVideo(file) {
  if (file.size > VIDEO_MAX_BYTES) {
    throw new MediaError(`视频超过 ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)}MB，请先压缩或剪短`, 'too_large');
  }
  let meta = null;
  try {
    meta = await loadVideoMeta(file);
  } catch {
    meta = null;
  }
  // 封面三级兜底：① 浏览器截帧 ② 文件里自带的缩略图 ③ 生成的占位封面
  let posterBlob = null;
  if (meta) {
    try {
      posterBlob = (await capturePoster(meta.url, 1))?.blob || null;
    } catch {
      posterBlob = null;
    }
  }
  if (!posterBlob) posterBlob = await embeddedThumbnail(file);
  if (!posterBlob) posterBlob = (await placeholderPoster({ name: file.name }))?.blob || null;

  const previewUrl = meta ? meta.url : URL.createObjectURL(file);
  const posterUrl = posterBlob ? URL.createObjectURL(posterBlob) : null;
  return {
    file,
    width: meta?.width || null,
    height: meta?.height || null,
    duration: meta ? meta.duration : null,
    poster: posterBlob
      ? new File([posterBlob], (file.name || 'video').replace(/\.[^.]+$/, '') + '-poster.jpg', {
          type: 'image/jpeg',
        })
      : null,
    previewUrl,
    posterUrl,
    // 浏览器读不出信息（iPhone 的 HEVC 之类）：还是让用户上传，只是说明一下
    warning: meta ? null : '这个视频读不出信息（常见于 iPhone 的 HEVC），已按原文件上传，封面是自动生成的',
  };
}

/**
 * 按 mime + 文件名后缀判断类型。
 * **手机上传的文件经常没有 mime**（`file.type === ''`，或 `application/octet-stream`），
 * 只认 mime 的话这些视频会被判成「不支持的格式」而根本传不上去。
 */
const EXT_VIDEO = /\.(mp4|m4v|mov|qt|webm|ogv|ogg|mkv|avi|3gp|3g2|mpg|mpeg|m2ts|ts|hevc|flv|wmv)$/i;
const EXT_IMAGE = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)$/i;

export function kindOf(file) {
  const type = String(file?.type || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  const name = String(file?.name || '');
  if (EXT_VIDEO.test(name)) return 'video';
  if (EXT_IMAGE.test(name)) return 'image';
  return 'other';
}

export function isImage(file) {
  return kindOf(file) === 'image';
}

export function isVideo(file) {
  return kindOf(file) === 'video';
}

/** 统一入口 */
export async function prepareFile(file, opts = {}) {
  const kind = kindOf(file);
  if (kind === 'image') return { kind: 'image', ...(await processImage(file, opts)) };
  if (kind === 'video') return { kind: 'video', ...(await processVideo(file)) };
  throw new MediaError(`不支持的格式：${file.type || file.name}`, 'unsupported');
}
