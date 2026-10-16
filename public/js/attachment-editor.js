/**
 * 附件预览 / 编辑面板：
 *  - 图片：裁剪（自由 / 1:1 / 4:3 / 3:4）+ 涂鸦（颜色 / 粗细 / 撤销）+ emoji 遮挡（拖动 / 缩放 / 删除）
 *  - 视频：选区裁剪（起止时间 + 试看 + MediaRecorder 录制导出）
 *
 * 设计要点：
 *  1. UI 全部走 ui.openSheet（它没有 actions 参数，按钮都放进 content 里）；
 *  2. 图片用「一张 canvas 全量重绘」：原图先按显示尺寸画进离屏底图，之后每帧只重画
 *     涂鸦 / emoji / 裁剪框，指针移动时不会掉帧；
 *  3. 坐标统一用「显示像素」，导出时再换算回原图像素（crop / 显示比例 → 原始像素），
 *     避免两套坐标系互相打架；
 *  4. 交互全用 pointer 事件 + setPointerCapture，canvas 与 stage 上 touch-action:none，
 *     手指在图上画不会带着面板一起滚；
 *  5. 保存不是原地改 item，而是产出新的 File + 预览地址，由 composer 决定怎么替换
 *     （已有附件要变成"新附件"、并把旧的 mediaId 记进 removed）。
 */
import { clamp, el, svgIcon } from './util.js';
import { IMAGE_MAX_EDGE, prepareFile } from './media.js';
import { openSheet, toast } from './ui.js';

/** 裁剪比例预设（value = 宽/高，null 表示自由） */
const RATIOS = [
  { id: 'free', label: '自由', value: null },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '3:4', label: '3:4', value: 3 / 4 },
];

/** 涂鸦颜色（深色 / 浅色底都能看清） */
const DRAW_COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#111111', '#ffffff'];
/** 涂鸦粗细（显示像素） */
const DRAW_WIDTHS = [
  { id: 'thin', label: '细', value: 3 },
  { id: 'mid', label: '中', value: 7 },
  { id: 'thick', label: '粗', value: 14 },
];
/** emoji 遮挡用的表情 */
const EMOJIS = [
  '😀', '😂', '🥲', '😍', '😎', '🤔', '😴', '😭',
  '😡', '🤯', '🤢', '🥳', '🤡', '💩', '🙈', '🙊',
  '👻', '💀', '👀', '🔥', '⭐', '❤️', '💔', '✅',
  '❌', '❓', '❗', '🎉', '🍺', '🍜', '🐶', '🐱',
  '🌸', '🌈', '🚗', '📱',
];

/** 裁剪框最小边长（显示像素） */
const MIN_CROP = 24;
/** 角把手命中范围（显示像素） */
const HANDLE_HIT = 30;
/** 视频最短裁剪长度（秒） */
const MIN_CLIP = 0.3;

const UNSUPPORTED_MSG =
  '当前浏览器不支持视频裁剪（缺少 MediaRecorder 或 captureStream）：可以点「取消」直接保留原视频，或换 Chrome / Edge 再试。';

const round1 = (n) => Math.round(n * 10) / 10;

/** 面板关掉之后回收本地资源（composer 的 blob 地址不归这里管） */
function watchClose(backdrop, cleanup) {
  const obs = new MutationObserver(() => {
    if (backdrop.isConnected) return;
    obs.disconnect();
    cleanup();
  });
  obs.observe(document.body, { childList: true });
}

/**
 * 打开附件编辑面板。
 * @param {object} item composer 里的附件条目（有 file 或 previewUrl 即可）
 * @param {{onChange?: (patch: object) => void}} opts 保存后回调，patch 可以直接 Object.assign 回条目
 * @returns {{close: () => void}|null}
 */
export function openAttachmentEditor(item, { onChange } = {}) {
  if (!item || !item.kind) {
    toast('这个附件暂时没法编辑');
    return null;
  }
  return item.kind === 'video' ? openVideoEditor(item, { onChange }) : openImageEditor(item, { onChange });
}

/* ============================================================ 图片 ============================================================ */

function openImageEditor(item, { onChange } = {}) {
  let url = item.previewUrl || '';
  let ownedUrl = '';
  if (!url && item.file) {
    url = URL.createObjectURL(item.file);
    ownedUrl = url;
  }
  if (!url) {
    toast('找不到这张图片，无法编辑');
    return null;
  }

  const root = el('div', { class: 'ae', 'data-kind': 'image' });
  const stage = el('div', { class: 'ae-stage', 'data-role': 'stage' });
  const canvas = el('canvas', { class: 'ae-canvas', 'data-role': 'canvas' });
  const loading = el('div', { class: 'ae-loading' }, '正在读取图片…');
  stage.append(canvas, loading);

  const modes = el('div', { class: 'ae-modes', 'data-role': 'modes' });
  const panel = el('div', { class: 'ae-panel', 'data-role': 'panel' });
  const hint = el('p', { class: 'ae-hint', 'data-role': 'hint' });
  const undoBtn = el(
    'button',
    { class: 'btn ghost small', type: 'button', 'data-role': 'undo', onclick: () => undo() },
    svgIcon('refresh', 16),
    '撤销'
  );
  const cancelBtn = el('button', { class: 'btn ghost', type: 'button', 'data-role': 'cancel' }, '取消');
  const saveBtn = el('button', { class: 'btn primary', type: 'button', 'data-role': 'save' }, '保存');
  const actions = el('div', { class: 'ae-actions' }, undoBtn, el('span', { class: 'ae-spacer' }), cancelBtn, saveBtn);
  root.append(stage, modes, panel, hint, actions);

  const entry = openSheet({ title: '编辑图片', content: root });
  const backdrop = entry.backdrop;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
  };
  watchClose(backdrop, cleanup);

  const state = {
    mode: 'crop',
    ratio: 'free',
    crop: { x: 0, y: 0, w: 0, h: 0 },
    strokes: [],
    emojis: [],
    selected: null, // 选中的 emoji id
    color: DRAW_COLORS[0],
    width: DRAW_WIDTHS[1].value,
    undo: [],
  };
  const disp = { w: 0, h: 0, scale: 1, dpr: 1 };
  let ctx = canvas.getContext('2d');
  let base = null; // 缩放后的底图（离屏），每帧只 drawImage 它
  let brand = '#2f6df6';
  let gesture = null; // 进行中的手势：裁剪 / 涂鸦 / 拖动 emoji
  let emojiSeq = 0;
  let alphaAnswer = null; // 源图有没有透明像素（决定导出 jpg 还是 png）

  const img = new Image();
  img.decoding = 'async';

  // ---------------- 基础几何 ----------------

  const mapPoint = (p) => ({ x: p.x, y: p.y });

  function roundRect(r) {
    const x = clamp(r.x, 0, Math.max(0, disp.w - MIN_CROP));
    const y = clamp(r.y, 0, Math.max(0, disp.h - MIN_CROP));
    const w = clamp(r.w, MIN_CROP, disp.w - x);
    const h = clamp(r.h, MIN_CROP, disp.h - y);
    return { x, y, w, h };
  }

  function sameRect(a, b) {
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
  }

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------------- 绘制 ----------------

  function paintStroke(c, stroke, map, lineScale) {
    const pts = stroke.points;
    if (!pts.length) return;
    c.save();
    c.strokeStyle = stroke.color;
    c.lineWidth = Math.max(0.6, stroke.width * lineScale);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    pts.forEach((p, i) => {
      const q = map(p);
      if (i === 0) c.moveTo(q.x, q.y);
      else c.lineTo(q.x, q.y);
    });
    if (pts.length === 1) {
      const q = map(pts[0]);
      c.lineTo(q.x + 0.01, q.y); // 单点也要画出一个圆点
    }
    c.stroke();
    c.restore();
  }

  function paintEmoji(c, mark, map, sizeScale) {
    const q = map({ x: mark.x, y: mark.y });
    c.save();
    c.font = `${Math.max(8, mark.size * sizeScale)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(mark.char, q.x, q.y);
    c.restore();
  }

  function drawCropOverlay() {
    const { x, y, w, h } = state.crop;
    const active = state.mode === 'crop';
    ctx.save();
    if (active) {
      // 框外压暗
      ctx.fillStyle = 'rgba(8, 10, 16, 0.55)';
      ctx.fillRect(0, 0, disp.w, y);
      ctx.fillRect(0, y + h, disp.w, Math.max(0, disp.h - y - h));
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, Math.max(0, disp.w - x - w), h);
    }
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeStyle = active ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.6)';
    ctx.setLineDash(active ? [] : [5, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
    if (active) {
      // 四角把手
      const s = 9;
      ctx.fillStyle = brand;
      const corners = [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ];
      for (const [hx, hy] of corners) ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    }
    ctx.restore();
  }

  /** 全量重绘 + 刷新给调试 / 自动化看的 dataset */
  function render() {
    if (!disp.w) return;
    ctx.setTransform(disp.dpr, 0, 0, disp.dpr, 0, 0);
    ctx.clearRect(0, 0, disp.w, disp.h);
    if (base) ctx.drawImage(base, 0, 0, disp.w, disp.h);
    for (const s of state.strokes) paintStroke(ctx, s, mapPoint, 1);
    for (const m of state.emojis) paintEmoji(ctx, m, mapPoint, 1);
    drawCropOverlay();
    syncDataset();
  }

  function syncDataset() {
    root.dataset.mode = state.mode;
    root.dataset.ratio = state.ratio;
    root.dataset.strokes = String(state.strokes.length);
    root.dataset.emojis = String(state.emojis.length);
    root.dataset.undo = String(state.undo.length);
    root.dataset.crop = [state.crop.x, state.crop.y, state.crop.w, state.crop.h].map((n) => Math.round(n)).join(',');
    root.dataset.display = `${disp.w}x${disp.h}`;
    root.dataset.color = state.color;
    root.dataset.width = String(state.width);
    const sel = selectedEmoji();
    root.dataset.selected = sel ? sel.char : '';
    root.dataset.selectedSize = sel ? String(Math.round(sel.size)) : '';
    root.dataset.selectedAt = sel ? `${Math.round(sel.x)},${Math.round(sel.y)}` : '';
    root.dataset.original = `${img.naturalWidth || 0}x${img.naturalHeight || 0}`;
  }

  // ---------------- 布局（只做一次，图片不存在缩放窗口的问题） ----------------

  function layout(tries = 8) {
    const stageW = stage.clientWidth || root.clientWidth || 0;
    if (!stageW && tries > 0) {
      setTimeout(() => layout(tries - 1), 100);
      return;
    }
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    const maxW = Math.max(160, Math.min((stageW || 320) - 18, 560));
    const maxH = Math.max(160, Math.min(Math.round((window.innerHeight || 720) * 0.42), 420));
    // 小图允许放大一点（最多 3 倍），否则 40x40 的图根本没法用手指操作
    const scale = clamp(Math.min(maxW / iw, maxH / ih), 0.02, 3);
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    disp.w = w;
    disp.h = h;
    disp.dpr = dpr;
    disp.scale = w / iw;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx = canvas.getContext('2d');
    base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    const bctx = base.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(img, 0, 0, w, h);
    brand = (getComputedStyle(document.body).getPropertyValue('--brand') || '').trim() || '#2f6df6';
    state.crop = { x: 0, y: 0, w, h };
    loading.remove();
    renderPanel();
    render();
  }

  // ---------------- 撤销栈 ----------------

  function pushUndo(op) {
    state.undo.push(op);
    undoBtn.disabled = false;
    syncDataset();
  }

  function undo() {
    if (gesture) finishGesture();
    const op = state.undo.pop();
    if (!op) return;
    if (op.kind === 'stroke') state.strokes.pop();
    else if (op.kind === 'stroke-clear') state.strokes = op.strokes;
    else if (op.kind === 'emoji-add') {
      state.emojis = state.emojis.filter((m) => m.id !== op.id);
      if (state.selected === op.id) state.selected = null;
    } else if (op.kind === 'emoji-remove') state.emojis.push(op.mark);
    else if (op.kind === 'emoji') {
      const mark = state.emojis.find((m) => m.id === op.id);
      if (mark) {
        mark.x = op.from.x;
        mark.y = op.from.y;
        mark.size = op.from.size;
      }
    } else if (op.kind === 'crop') state.crop = op.from;
    undoBtn.disabled = !state.undo.length;
    renderPanel();
    render();
  }

  // ---------------- 模式与面板 ----------------

  function selectedEmoji() {
    return state.emojis.find((m) => m.id === state.selected) || null;
  }

  function setMode(mode) {
    if (gesture) finishGesture();
    state.mode = mode;
    if (mode !== 'emoji') state.selected = null;
    renderPanel();
    render();
  }

  function syncModes() {
    for (const btn of modes.querySelectorAll('.ae-mode')) {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    }
  }

  function chip(label, active, onClick, data = {}) {
    return el(
      'button',
      { type: 'button', class: `ae-chip${active ? ' active' : ''}`, onclick: onClick, ...data },
      label
    );
  }

  function renderPanel() {
    syncModes();
    panel.textContent = '';
    if (state.mode === 'crop') {
      panel.append(
        el(
          'div',
          { class: 'ae-row' },
          el('span', { class: 'ae-row-label' }, '比例'),
          ...RATIOS.map((r) =>
            chip(r.label, state.ratio === r.id, () => setRatio(r.id), { 'data-ratio': r.id })
          )
        ),
        el(
          'div',
          { class: 'ae-row' },
          chip('整张图', false, () => resetCrop(), { 'data-role': 'crop-reset' }),
          el('span', { class: 'ae-note' }, '拖动框内可移动，拖四角可缩放')
        )
      );
      hint.textContent = '框外的部分会被裁掉';
    } else if (state.mode === 'draw') {
      panel.append(
        el(
          'div',
          { class: 'ae-row' },
          el('span', { class: 'ae-row-label' }, '颜色'),
          ...DRAW_COLORS.map((c) =>
            el('button', {
              type: 'button',
              class: `ae-dot${state.color === c ? ' active' : ''}`,
              'data-color': c,
              'aria-label': `颜色 ${c}`,
              style: { background: c },
              onclick: () => {
                state.color = c;
                renderPanel();
                syncDataset();
              },
            })
          )
        ),
        el(
          'div',
          { class: 'ae-row' },
          el('span', { class: 'ae-row-label' }, '粗细'),
          ...DRAW_WIDTHS.map((w) =>
            chip(w.label, state.width === w.value, () => {
              state.width = w.value;
              renderPanel();
              syncDataset();
            }, { 'data-width': String(w.value) })
          ),
          chip('清空涂鸦', false, () => {
            if (!state.strokes.length) return;
            pushUndo({ kind: 'stroke-clear', strokes: state.strokes });
            state.strokes = [];
            render();
          }, { 'data-role': 'stroke-clear' })
        )
      );
      hint.textContent = '在图上按住画就行，画错了点「撤销」';
    } else {
      const sel = selectedEmoji();
      const grid = el('div', { class: 'ae-emoji-grid', 'data-role': 'emoji-grid' });
      for (const char of EMOJIS) {
        grid.append(
          el(
            'button',
            { type: 'button', class: 'ae-emoji', 'data-emoji': char, onclick: () => addEmoji(char) },
            char
          )
        );
      }
      const slider = el('input', {
        type: 'range',
        class: 'ae-range',
        'data-role': 'emoji-size',
        min: '14',
        max: String(Math.max(40, Math.round(disp.w * 0.7))),
        step: '1',
        value: String(sel ? Math.round(sel.size) : Math.round(Math.max(24, disp.w * 0.22))),
      });
      slider.disabled = !sel;
      let sizeDrag = null;
      slider.addEventListener('input', () => {
        const mark = selectedEmoji();
        if (!mark) return;
        if (!sizeDrag) sizeDrag = { id: mark.id, size: mark.size };
        mark.size = Number(slider.value);
        render();
      });
      slider.addEventListener('change', () => {
        const mark = selectedEmoji();
        if (sizeDrag && mark) pushUndo({ kind: 'emoji', id: mark.id, from: { x: mark.x, y: mark.y, size: sizeDrag.size } });
        sizeDrag = null;
      });
      panel.append(
        grid,
        el(
          'div',
          { class: 'ae-row' },
          el('span', { class: 'ae-row-label' }, '大小'),
          slider,
          chip('删除选中', false, () => removeSelected(), { 'data-role': 'emoji-remove' })
        ),
        el(
          'div',
          { class: 'ae-row' },
          el(
            'span',
            { class: 'ae-note' },
            sel ? '拖动它可以挪位置，滑杆调大小' : '点下面的表情贴到图上（会放在画面中间）'
          )
        )
      );
      hint.textContent = '用表情挡住不想露出来的内容，贴在图上之后可以拖动';
    }
    undoBtn.disabled = !state.undo.length;
    syncModes();
  }

  function setRatio(id) {
    const preset = RATIOS.find((r) => r.id === id);
    if (!preset) return;
    const before = { ...state.crop };
    state.ratio = id;
    if (preset.value) {
      const cx = state.crop.x + state.crop.w / 2;
      const cy = state.crop.y + state.crop.h / 2;
      let w = state.crop.w;
      let h = w / preset.value;
      if (h > disp.h) {
        h = disp.h;
        w = h * preset.value;
      }
      if (w > disp.w) {
        w = disp.w;
        h = w / preset.value;
      }
      const x = clamp(cx - w / 2, 0, Math.max(0, disp.w - w));
      const y = clamp(cy - h / 2, 0, Math.max(0, disp.h - h));
      state.crop = { x, y, w, h };
    }
    if (!sameRect(before, state.crop)) pushUndo({ kind: 'crop', from: before });
    renderPanel();
    render();
  }

  function resetCrop() {
    const before = { ...state.crop };
    state.crop = { x: 0, y: 0, w: disp.w, h: disp.h };
    state.ratio = 'free';
    if (!sameRect(before, state.crop)) pushUndo({ kind: 'crop', from: before });
    renderPanel();
    render();
  }

  function addEmoji(char) {
    // 默认放在裁剪框中心，之后可拖动 / 缩放
    const mark = {
      id: `e${(emojiSeq += 1)}`,
      char,
      x: state.crop.x + state.crop.w / 2,
      y: state.crop.y + state.crop.h / 2,
      size: Math.max(24, Math.round(disp.w * 0.22)),
    };
    state.emojis.push(mark);
    state.selected = mark.id;
    pushUndo({ kind: 'emoji-add', id: mark.id });
    renderPanel();
    render();
  }

  function removeSelected() {
    const mark = selectedEmoji();
    if (!mark) {
      toast('先在图上点一个表情，再删除');
      return;
    }
    state.emojis = state.emojis.filter((m) => m !== mark);
    state.selected = null;
    pushUndo({ kind: 'emoji-remove', mark });
    renderPanel();
    render();
  }

  // ---------------- 命中测试 ----------------

  function hitCrop(p) {
    const { x, y, w, h } = state.crop;
    const corners = [
      ['nw', x, y],
      ['ne', x + w, y],
      ['sw', x, y + h],
      ['se', x + w, y + h],
    ];
    for (const [name, hx, hy] of corners) {
      if (Math.abs(p.x - hx) <= HANDLE_HIT / 2 && Math.abs(p.y - hy) <= HANDLE_HIT / 2) return name;
    }
    if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return 'move';
    return null;
  }

  function hitEmoji(p) {
    for (let i = state.emojis.length - 1; i >= 0; i -= 1) {
      const mark = state.emojis[i];
      const half = mark.size * 0.62 + 8;
      if (Math.abs(p.x - mark.x) <= half && Math.abs(p.y - mark.y) <= half) return mark;
    }
    return null;
  }

  // ---------------- 手势 ----------------

  /** 按当前比例把「对角拖动」换算成裁剪框 */
  function resizeCrop(from, corner, p, ratio) {
    let left = from.x;
    let top = from.y;
    let right = from.x + from.w;
    let bottom = from.y + from.h;
    if (corner.includes('w')) left = Math.min(p.x, right - MIN_CROP);
    if (corner.includes('e')) right = Math.max(p.x, left + MIN_CROP);
    if (corner.includes('n')) top = Math.min(p.y, bottom - MIN_CROP);
    if (corner.includes('s')) bottom = Math.max(p.y, top + MIN_CROP);
    left = clamp(left, 0, disp.w - MIN_CROP);
    right = clamp(right, left + MIN_CROP, disp.w);
    top = clamp(top, 0, disp.h - MIN_CROP);
    bottom = clamp(bottom, top + MIN_CROP, disp.h);
    let w = right - left;
    let h = bottom - top;
    if (ratio) {
      h = w / ratio;
      if (corner.includes('n')) top = bottom - h;
      else bottom = top + h;
      if (top < 0) {
        top = 0;
        bottom = h;
      }
      if (bottom > disp.h) {
        bottom = disp.h;
        top = disp.h - h;
      }
      if (top < 0) {
        // 竖向放不下：以高为准反推宽
        top = 0;
        h = Math.min(disp.h, h);
        w = h * ratio;
        if (corner.includes('w')) left = right - w;
        else right = left + w;
      }
    }
    return roundRect({ x: left, y: top, w: right - left, h: bottom - top });
  }

  function beginGesture(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!disp.w) return;
    e.preventDefault();
    const p = localPoint(e);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 个别浏览器不支持，忽略 */
    }

    if (state.mode === 'crop') {
      const hit = hitCrop(p);
      if (hit === 'move') {
        gesture = { type: 'crop', pointerId: e.pointerId, hit, start: p, from: { ...state.crop } };
      } else if (hit) {
        gesture = { type: 'crop', pointerId: e.pointerId, hit, from: { ...state.crop } };
      } else {
        // 空白处按下：从这一点拉一个新框（真的拉出来了才生效，见 finishGesture）
        gesture = { type: 'crop', pointerId: e.pointerId, hit: 'new', start: p, from: { ...state.crop }, moved: false };
        state.crop = roundRect({ x: p.x, y: p.y, w: MIN_CROP, h: MIN_CROP });
      }
      render();
      return;
    }

    if (state.mode === 'draw') {
      const stroke = { color: state.color, width: state.width, points: [p] };
      state.strokes.push(stroke);
      gesture = { type: 'draw', pointerId: e.pointerId, stroke };
      render();
      return;
    }

    // emoji 模式：点中已放置的表情就拖它，否则取消选中
    const mark = hitEmoji(p);
    if (!mark) {
      state.selected = null;
      renderPanel();
      render();
      return;
    }
    state.selected = mark.id;
    gesture = {
      type: 'emoji',
      pointerId: e.pointerId,
      mark,
      dx: mark.x - p.x,
      dy: mark.y - p.y,
      from: { x: mark.x, y: mark.y, size: mark.size },
      moved: false,
    };
    renderPanel();
    render();
  }

  function moveGesture(e) {
    if (!gesture) return;
    e.preventDefault();
    const p = localPoint(e);
    if (gesture.type === 'draw') {
      const pts = gesture.stroke.points;
      const last = pts[pts.length - 1];
      if (last && Math.abs(last.x - p.x) < 1.2 && Math.abs(last.y - p.y) < 1.2) return; // 抖动点不记
      pts.push(p);
      render();
      return;
    }
    if (gesture.type === 'emoji') {
      const mark = gesture.mark;
      mark.x = clamp(p.x + gesture.dx, 0, disp.w);
      mark.y = clamp(p.y + gesture.dy, 0, disp.h);
      if (Math.abs(mark.x - gesture.from.x) > 1 || Math.abs(mark.y - gesture.from.y) > 1) gesture.moved = true;
      render();
      return;
    }
    // 裁剪
    const ratio = (RATIOS.find((r) => r.id === state.ratio) || {}).value || null;
    if (gesture.hit === 'move') {
      const dx = p.x - gesture.start.x;
      const dy = p.y - gesture.start.y;
      state.crop = roundRect({
        x: clamp(gesture.from.x + dx, 0, disp.w - gesture.from.w),
        y: clamp(gesture.from.y + dy, 0, disp.h - gesture.from.h),
        w: gesture.from.w,
        h: gesture.from.h,
      });
    } else if (gesture.hit === 'new') {
      const x = Math.min(gesture.start.x, p.x);
      const y = Math.min(gesture.start.y, p.y);
      const w = Math.max(MIN_CROP, Math.abs(p.x - gesture.start.x));
      const h = Math.max(MIN_CROP, Math.abs(p.y - gesture.start.y));
      // 拉出来超过 10px 才算「真的要画一个新框」，避免误触把裁剪框缩成一小块
      if (Math.abs(p.x - gesture.start.x) > 10 || Math.abs(p.y - gesture.start.y) > 10) gesture.moved = true;
      state.crop = ratio ? resizeCrop({ x, y, w, h }, 'se', { x: x + w, y: y + h }, ratio) : roundRect({ x, y, w, h });
    } else {
      state.crop = resizeCrop(gesture.from, gesture.hit, p, ratio);
    }
    render();
  }

  function finishGesture() {
    const g = gesture;
    gesture = null;
    if (!g) return;
    try {
      canvas.releasePointerCapture?.(g.pointerId);
    } catch {
      /* 忽略 */
    }
    if (g.type === 'draw') {
      pushUndo({ kind: 'stroke' });
    } else if (g.type === 'emoji') {
      if (g.moved) pushUndo({ kind: 'emoji', id: g.mark.id, from: g.from });
    } else if (g.type === 'crop') {
      // 空白处只是点了一下（没真的拉出框）：还原原来的裁剪框
      if (g.hit === 'new' && !g.moved) state.crop = g.from;
      if (!sameRect(g.from, state.crop)) pushUndo({ kind: 'crop', from: g.from });
    }
    renderPanel();
    render(); // 手势结束后重画一次：上面的「误触还原」必须立刻反映到画面上
  }

  canvas.addEventListener('pointerdown', beginGesture);
  canvas.addEventListener('pointermove', moveGesture);
  canvas.addEventListener('pointerup', finishGesture);
  canvas.addEventListener('pointercancel', finishGesture);
  canvas.addEventListener('dragstart', (e) => e.preventDefault());

  // ---------------- 导出 ----------------

  /** 源图是不是"可能带透明"的格式（决定要不要用 png） */
  async function wantsAlpha() {
    if (alphaAnswer !== null) return alphaAnswer;
    const type = String((item.file && item.file.type) || item.mime || '').toLowerCase();
    const urlish = String(url || '').toLowerCase();
    const mayHaveAlpha = /png|webp|gif|avif/.test(type) || /\.(png|webp|gif|avif)(\?|$)/.test(urlish);
    if (!mayHaveAlpha) {
      alphaAnswer = false;
      return false;
    }
    try {
      const w = Math.max(1, Math.min(256, img.naturalWidth || 1));
      const h = Math.max(1, Math.min(256, img.naturalHeight || 1));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h).data;
      let found = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) {
          found = true;
          break;
        }
      }
      alphaAnswer = found;
    } catch {
      alphaAnswer = false;
    }
    return alphaAnswer;
  }

  async function exportImage() {
    const crop = state.crop;
    const sx = crop.x / disp.scale;
    const sy = crop.y / disp.scale;
    const sw = Math.max(1, crop.w / disp.scale);
    const sh = Math.max(1, crop.h / disp.scale);
    // 按裁剪后的原始像素输出，最长边不超过 IMAGE_MAX_EDGE
    const k = Math.min(1, IMAGE_MAX_EDGE / Math.max(sw, sh));
    const outW = Math.max(1, Math.round(sw * k));
    const outH = Math.max(1, Math.round(sh * k));

    const c = document.createElement('canvas');
    c.width = outW;
    c.height = outH;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

    const rx = outW / crop.w;
    const ry = outH / crop.h;
    const map = (p) => ({ x: (p.x - crop.x) * rx, y: (p.y - crop.y) * ry });
    g.save();
    g.beginPath();
    g.rect(0, 0, outW, outH);
    g.clip();
    for (const s of state.strokes) paintStroke(g, s, map, rx);
    for (const m of state.emojis) paintEmoji(g, m, map, rx);
    g.restore();

    const type = (await wantsAlpha()) ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), type, 0.9);
    });
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const baseName = String(item.name || (item.file && item.file.name) || 'image').replace(/\.[^.]+$/, '') || 'image';
    const file = new File([blob], `${baseName}.${ext}`, { type });
    // 这里不再走 processImage：尺寸已经按 IMAGE_MAX_EDGE 夹好，
    // 再压一次既会二次损失画质，也会把 png 的透明通道换成白色。
    return { file, previewUrl: URL.createObjectURL(blob), width: outW, height: outH };
  }

  async function save() {
    if (!disp.w) {
      toast('图片还没加载好，稍等一下');
      return;
    }
    if (gesture) finishGesture();
    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    try {
      const out = await exportImage();
      onChange?.({
        kind: 'image',
        file: out.file,
        previewUrl: out.previewUrl,
        poster: null,
        posterUrl: null,
        width: out.width,
        height: out.height,
        duration: null,
        name: out.file.name,
        size: out.file.size,
      });
      cleanup();
      entry.close();
      toast('图片已更新');
    } catch (err) {
      toast(err?.message || '图片处理失败');
      saveBtn.disabled = false;
      saveBtn.classList.remove('loading');
    }
  }

  cancelBtn.addEventListener('click', () => {
    cleanup();
    entry.close();
  });
  saveBtn.addEventListener('click', save);

  for (const [mode, label] of [
    ['crop', '裁剪'],
    ['draw', '涂鸦'],
    ['emoji', '表情'],
  ]) {
    modes.append(
      el(
        'button',
        { type: 'button', class: 'ae-mode', 'data-mode': mode, onclick: () => setMode(mode) },
        label
      )
    );
  }

  img.onload = () => layout();
  img.onerror = () => {
    loading.textContent = '这张图片读不出来（可能是格式不支持）';
    toast('这张图片读不出来，没法编辑');
  };
  img.src = url;

  return { close: () => entry.close() };
}

/* ============================================================ 视频 ============================================================ */

/** 视频录制容器：优先 mp4，不支持就退回 webm */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

function videoSupport() {
  const hasRecorder = typeof MediaRecorder !== 'undefined';
  const proto = typeof HTMLVideoElement !== 'undefined' ? HTMLVideoElement.prototype : null;
  const hasCapture = Boolean(proto && (typeof proto.captureStream === 'function' || typeof proto.mozCaptureStream === 'function'));
  return { ok: hasRecorder && hasCapture, hasRecorder, hasCapture };
}

function captureStreamOf(video) {
  if (typeof video.captureStream === 'function') return video.captureStream();
  if (typeof video.mozCaptureStream === 'function') return video.mozCaptureStream();
  throw new Error('captureStream 不可用');
}

/** 已有视频只有封面地址，需要真正的视频地址 */
function videoUrlOf(item) {
  if (item.videoUrl) return item.videoUrl;
  const poster = String(item.previewUrl || '');
  if (/\/poster(\?|$)/.test(poster)) return poster.replace(/\/poster(\?.*)?$/, '');
  return '';
}

/**
 * 把一个已经在播的 <video> 的真实时长问出来。
 * Chrome 里 MediaRecorder 录出来的 webm 没有时长头，video.duration 是 Infinity，
 * 标准绕法是 seek 到一个极大的时间点、逼浏览器把真实时长算出来。
 */
function resolveLiveDuration(video) {
  return new Promise((resolve) => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      resolve(video.duration);
      return;
    }
    let settled = false;
    const done = (d) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('durationchange', onChange);
      try {
        video.currentTime = 0;
      } catch {
        /* 忽略 */
      }
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    };
    const onChange = () => {
      if (Number.isFinite(video.duration)) done(video.duration);
    };
    video.addEventListener('durationchange', onChange);
    try {
      video.currentTime = 1e6;
    } catch {
      done(null);
      return;
    }
    setTimeout(() => done(video.duration), 4000);
  });
}

/**
 * 读一段视频的真实时长。
 * Chrome 里 MediaRecorder 录出来的 webm 没有时长头，video.duration 会是 Infinity；
 * 标准绕法是 seek 到一个极大的时间点，逼浏览器把真实时长算出来。
 */
function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    let done = false;
    const finish = (duration) => {
      if (done) return;
      done = true;
      try {
        v.removeAttribute('src');
        v.load?.();
      } catch {
        /* 忽略 */
      }
      URL.revokeObjectURL(url);
      resolve({ duration: Number.isFinite(duration) && duration > 0 ? duration : null, width: v.videoWidth || null, height: v.videoHeight || null });
    };
    const timer = setTimeout(() => finish(v.duration), 12000);
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) {
        clearTimeout(timer);
        finish(v.duration);
        return;
      }
      // Infinity：seek 到超大时间点逼它算时长
      const t2 = setTimeout(() => {
        clearTimeout(timer);
        finish(v.duration);
      }, 4000);
      const onSeek = () => {
        clearTimeout(t2);
        clearTimeout(timer);
        finish(v.duration);
      };
      v.addEventListener('seeked', onSeek, { once: true });
      v.addEventListener('durationchange', () => {
        if (Number.isFinite(v.duration)) onSeek();
      });
      try {
        v.currentTime = 1e6;
      } catch {
        clearTimeout(t2);
        clearTimeout(timer);
        finish(null);
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    v.src = url;
  });
}

/**
 * 录制 [start, end] 区间（画面 + 声音）。
 * @returns {Promise<{blob: Blob, seconds: number}>} seconds 是实际录制耗时（兜底时长）
 */
function recordClip(video, start, end, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let recorder = null;
    let stream = null;
    let tick = 0;
    let overshoot = 0;
    let settled = false;
    const chunks = [];
    const startedAt = performance.now();

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      clearTimeout(overshoot);
      try {
        video.pause();
      } catch {
        /* 忽略 */
      }
      for (const track of stream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {
          /* 忽略 */
        }
      }
      if (err) {
        reject(err);
        return;
      }
      const seconds = Math.max(0.1, round1((performance.now() - startedAt) / 1000));
      const type = recorder?.mimeType || '';
      resolve({ blob: new Blob(chunks, type ? { type } : undefined), seconds });
    };

    try {
      stream = captureStreamOf(video);
      const mime = pickMime();
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 })
        : new MediaRecorder(stream);
    } catch (err) {
      finish(new Error(`无法开始录制这段视频：${err?.message || '未知错误'}`));
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onerror = () => finish(new Error('录制失败，请再试一次'));
    recorder.onstop = () => finish();

    const seekToStart = new Promise((resolve) => {
      let fired = false;
      const once = () => {
        if (fired) return;
        fired = true;
        resolve();
      };
      video.addEventListener('seeked', once, { once: true });
      setTimeout(once, 3000);
      try {
        video.currentTime = start;
      } catch {
        once();
      }
    });

    seekToStart.then(() => {
      if (settled) return;
      // 尽量带声音：autoplay 被拦时再静音重试（静音只影响本机播放，不影响录制轨道）
      video.play().catch(() => {
        video.muted = true;
        return video.play().catch(() => {
          finish(new Error('浏览器不允许播放这个视频，无法裁剪'));
        });
      });
      try {
        recorder.start(200);
      } catch (err) {
        finish(new Error(`无法开始录制：${err?.message || '未知错误'}`));
        return;
      }
      tick = setInterval(() => {
        const t = video.currentTime;
        if (onProgress) onProgress(clamp((t - start) / Math.max(0.1, end - start), 0, 1));
        if (t >= end - 0.05 || video.ended) {
          try {
            recorder.stop();
          } catch {
            finish();
          }
        }
      }, 60);
      // 兜底：万一 timeupdate 没触发（比如视频卡住），别让录制永远不停
      overshoot = setTimeout(() => {
        try {
          recorder.stop();
        } catch {
          finish();
        }
      }, Math.max(4000, (end - start) * 1000 + 10000));
    });
  });
}

/** 字节数说成人话（小于 1MB 用 KB），压完给用户看清楚小了多少 */
export function fmtMb(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/**
 * 压缩整条视频：把画面缩到 720p 左右、用较低码率重录一遍（画面 + 声音）。
 * 手机原视频动辄几十上百 MB、码率很高，直接播放会又慢又卡；压完通常小一个数量级。
 * @returns {Promise<{blob: Blob, seconds: number}>}
 */
function compressVideo(video, { maxWidth = 1280, bitrate = 2_500_000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let recorder = null;
    let outStream = null;
    let srcStream = null;
    let raf = 0;
    let settled = false;
    const chunks = [];
    const startedAt = performance.now();

    const stopAll = () => {
      cancelAnimationFrame(raf);
      try {
        video.pause();
      } catch {
        /* 忽略 */
      }
      for (const track of outStream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {
          /* 忽略 */
        }
      }
      for (const track of srcStream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {
          /* 忽略 */
        }
      }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      stopAll();
      if (err) {
        reject(err);
        return;
      }
      const seconds = Math.max(0.1, round1((performance.now() - startedAt) / 1000));
      const type = recorder?.mimeType || '';
      resolve({ blob: new Blob(chunks, type ? { type } : undefined), seconds });
    };

    // 目标尺寸：按原比例缩到 maxWidth 以内（不会放大）
    const vw = Number(video.videoWidth) || 1280;
    const vh = Number(video.videoHeight) || 720;
    const scale = Math.min(1, maxWidth / vw);
    const cw = Math.max(2, Math.round((vw * scale) / 2) * 2);
    const ch = Math.max(2, Math.round((vh * scale) / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false });

    try {
      outStream = canvas.captureStream(30);
      // 声音从原视频轨道接过来（拿不到就只录画面）
      try {
        srcStream = captureStreamOf(video);
        for (const track of srcStream.getAudioTracks?.() || []) outStream.addTrack(track);
      } catch {
        /* 没有声音也能压 */
      }
      const mime = pickMime();
      recorder = mime
        ? new MediaRecorder(outStream, { mimeType: mime, videoBitsPerSecond: bitrate })
        : new MediaRecorder(outStream);
    } catch (err) {
      finish(new Error(`无法开始压缩：${err?.message || '未知错误'}`));
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onerror = () => finish(new Error('压缩失败，请再试一次'));
    recorder.onstop = () => finish();

    const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const drawLoop = () => {
      if (settled) return;
      ctx.drawImage(video, 0, 0, cw, ch);
      if (onProgress && total) onProgress(Math.min(0.99, video.currentTime / total));
      raf = requestAnimationFrame(drawLoop);
    };

    (async () => {
      try {
        video.currentTime = 0;
      } catch {
        /* 忽略 */
      }
      await new Promise((r) => {
        if (video.readyState >= 2) {
          r();
          return;
        }
        video.addEventListener('loadeddata', r, { once: true });
        setTimeout(r, 3000);
      });
      try {
        video.loop = false;
        await video.play();
      } catch {
        video.muted = true;
        try {
          await video.play();
        } catch {
          finish(new Error('浏览器不允许播放这个视频，无法压缩'));
          return;
        }
      }
      try {
        recorder.start(250);
      } catch (err) {
        finish(new Error(`无法开始压缩：${err?.message || '未知错误'}`));
        return;
      }
      drawLoop();
      const onEnded = () => {
        try {
          recorder.stop();
        } catch {
          finish();
        }
      };
      video.addEventListener('ended', onEnded, { once: true });
      // 兜底：别让压缩永远停不下来
      setTimeout(() => {
        if (!settled) onEnded();
      }, Math.max(8000, (total || 60) * 1000 + 15000));
    })();
  });
}

/**
 * 给一个视频文件做压缩（外面也能用：发布面板加了大视频时会问用户要不要压）。
 * 内部会自己建 <video> 读元数据，压完返回新的 File。
 */
export async function compressFile(file, { onProgress, maxWidth = 1280, bitrate = 2_500_000 } = {}) {
  const url = URL.createObjectURL(file);
  const video = el('video', { src: url, playsinline: true, muted: true, preload: 'metadata' });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('读取视频信息超时，没法压缩')), 15000);
      const ready = () => {
        clearTimeout(timer);
        resolve();
      };
      if (video.readyState >= 1) {
        ready();
        return;
      }
      video.addEventListener('loadedmetadata', ready, { once: true });
      video.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('这个视频读不出来，没法压缩'));
      });
    });
    const { blob } = await compressVideo(video, { onProgress, maxWidth, bitrate });
    if (!blob.size) throw new Error('压缩结果是空的');
    const type = blob.type || 'video/webm';
    const ext = /mp4/i.test(type) ? 'mp4' : 'webm';
    const baseName = String(file.name || 'video').replace(/\.[^.]+$/, '') || 'video';
    return new File([blob], `${baseName}-720p.${ext}`, { type });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openVideoEditor(item, { onChange } = {}) {
  const own = item.file ? URL.createObjectURL(item.file) : '';
  const src = own || videoUrlOf(item) || item.previewUrl || '';
  if (!src) {
    toast('找不到这个视频，无法裁剪');
    return null;
  }
  const support = videoSupport();

  const video = el('video', {
    class: 'ae-video',
    src,
    'data-role': 'video',
    controls: true,
    playsinline: true,
    preload: 'metadata',
  });
  const state = el('p', { class: 'ae-note', 'data-role': 'status' }, '正在读取视频信息…');
  const startLabel = el('b', { 'data-role': 'start-label' }, '0.0s');
  const endLabel = el('b', { 'data-role': 'end-label' }, '0.0s');
  const startInput = el('input', {
    type: 'range',
    class: 'ae-range',
    'data-role': 'start',
    min: '0',
    max: '1',
    step: '0.1',
    value: '0',
  });
  const endInput = el('input', {
    type: 'range',
    class: 'ae-range',
    'data-role': 'end',
    min: '0',
    max: '1',
    step: '0.1',
    value: '1',
  });
  const info = el('div', { class: 'ae-trim-info', 'data-role': 'info' }, '');
  const previewBtn = el('button', { class: 'btn ghost small', type: 'button', 'data-role': 'preview' }, '试看选区');
  const shrinkBtn = el('button', { class: 'btn ghost small', type: 'button', 'data-role': 'shrink' }, '压缩到 720p');
  const cancelBtn = el('button', { class: 'btn ghost', type: 'button', 'data-role': 'cancel' }, '取消');
  const saveBtn = el('button', { class: 'btn primary', type: 'button', 'data-role': 'save' }, '保存裁剪');

  const warn = support.ok
    ? null
    : el('div', { class: 'ae-warn', 'data-role': 'unsupported' }, UNSUPPORTED_MSG);

  const trim = el(
    'div',
    { class: 'ae-trim' },
    el('div', { class: 'ae-trim-row' }, el('div', { class: 'ae-trim-label' }, el('span', {}, '开始'), startLabel), startInput),
    el('div', { class: 'ae-trim-row' }, el('div', { class: 'ae-trim-label' }, el('span', {}, '结束'), endLabel), endInput),
    info
  );
  const actions = el('div', { class: 'ae-actions' }, previewBtn, shrinkBtn, el('span', { class: 'ae-spacer' }), cancelBtn, saveBtn);
  // 用 el() 组装：它会把 null（支持裁剪时没有 warn）过滤掉；
  // 直接 root.append(video, warn, …) 会把 null 变成字面量文本「null」插到面板里
  const root = el(
    'div',
    { class: 'ae', 'data-kind': 'video', 'data-support': support.ok ? 'yes' : 'no' },
    video,
    warn,
    state,
    trim,
    actions
  );

  const entry = openSheet({ title: '裁剪视频', content: root });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      video.pause();
    } catch {
      /* 忽略 */
    }
    if (own) URL.revokeObjectURL(own);
  };
  watchClose(entry.backdrop, cleanup);

  let duration = 0;
  let ready = false;
  let busy = false;

  function readRange() {
    const start = Number(startInput.value) || 0;
    const end = Number(endInput.value) || 0;
    return { start, end: Math.max(start + MIN_CLIP, end) };
  }

  function updateInfo() {
    const { start, end } = readRange();
    root.dataset.start = String(round1(start));
    root.dataset.end = String(round1(end));
    root.dataset.clip = String(round1(end - start));
    root.dataset.duration = String(round1(duration));
    startLabel.textContent = `${round1(start).toFixed(1)}s`;
    endLabel.textContent = `${round1(end).toFixed(1)}s`;
    const clipped = Math.max(0, end - start);
    info.textContent = `原 ${round1(duration).toFixed(1)}s · 选区 ${round1(start).toFixed(1)}s – ${round1(end).toFixed(1)}s · 裁剪后 ${round1(clipped).toFixed(1)}s`;
    // 环境不支持时不锁按钮：点一下也要给出明确中文提示，而不是静默失败
    saveBtn.disabled = support.ok ? !ready || busy : false;
    previewBtn.disabled = !ready;
  }

  function onStartInput() {
    let start = Number(startInput.value) || 0;
    const end = Number(endInput.value) || 0;
    if (start > end - MIN_CLIP) {
      start = Math.max(0, round1(end - MIN_CLIP));
      startInput.value = String(start);
    }
    updateInfo();
  }

  function onEndInput() {
    let end = Number(endInput.value) || 0;
    const start = Number(startInput.value) || 0;
    if (end < start + MIN_CLIP) {
      end = Math.min(duration || end, round1(start + MIN_CLIP));
      endInput.value = String(end);
    }
    updateInfo();
  }

  startInput.addEventListener('input', onStartInput);
  endInput.addEventListener('input', onEndInput);

  function previewClip() {
    if (!ready) return;
    const { start, end } = readRange();
    try {
      video.currentTime = start;
    } catch {
      /* 忽略 */
    }
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => toast('浏览器不让自动播放，可以手动点视频播放'));
    });
    const stop = () => {
      if (video.currentTime >= end) {
        video.pause();
        video.removeEventListener('timeupdate', stop);
      }
    };
    video.addEventListener('timeupdate', stop);
  }
  previewBtn.addEventListener('click', previewClip);

  /**
   * 元数据到手后才知道时长。
   * 注意两点：① src 是建元素时就设好的，loadedmetadata 可能早于监听器挂上；
   * ② MediaRecorder 录出来的 webm 没有时长头，duration 会是 Infinity —— 用 seek 逼出来。
   */
  let metaHandled = false;
  async function onMeta() {
    if (metaHandled) return;
    metaHandled = true;
    let d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!d) d = (await resolveLiveDuration(video)) || 0;
    duration = d;
    if (duration > 0) {
      endInput.max = String(round1(duration));
      endInput.value = String(round1(duration));
      startInput.max = String(round1(duration));
      ready = true;
      state.textContent = support.ok
        ? `时长 ${round1(duration).toFixed(1)}s，拖动下面的滑杆选要保留的区间`
        : '当前环境不支持视频裁剪，可以点「取消」保留原视频';
    } else {
      state.textContent = '读不到这个视频的时长，没法裁剪（可以先取消）';
    }
    updateInfo();
  }

  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('loadeddata', onMeta);
  // src 是在建元素时就设好的，元数据有可能在监听器挂上之前就到了 —— 补一次检查
  if (video.readyState >= 1) onMeta();
  video.addEventListener('error', () => {
    // 现在这种视频也能上传（media.js 会降级处理），只是没法在这里裁剪：
    // 给出说明并禁用裁剪，用户直接关掉面板保存即可，原文件照样传得上去
    state.textContent = '这个视频浏览器读不出来，没法裁剪；关掉面板直接保存，会用原文件上传';
    saveBtn.disabled = true;
    previewBtn.disabled = true;
    startInput.disabled = true;
    endInput.disabled = true;
  });

  async function save() {
    if (!support.ok) {
      toast(UNSUPPORTED_MSG);
      return;
    }
    if (!ready || busy) return;
    const { start, end } = readRange();
    busy = true;
    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    state.textContent = '正在录制选中的片段…（要按原速播一遍，请稍等）';
    try {
      const { blob, seconds } = await recordClip(video, start, end, {
        onProgress: (r) => {
          state.textContent = `正在录制选中的片段… ${Math.round(r * 100)}%`;
        },
      });
      if (!blob.size) throw new Error('录制出来的片段是空的，请重试');
      const type = blob.type || 'video/webm';
      const ext = /mp4/i.test(type) ? 'mp4' : 'webm';
      const baseName = String(item.name || (item.file && item.file.name) || 'video').replace(/\.[^.]+$/, '') || 'video';
      const file = new File([blob], `${baseName}-clip.${ext}`, { type });
      // 兜底：探针读不出时长就用实际录制耗时（误差在一个 tick 量级）
      let measured = null;
      try {
        const probed = await probeVideo(file);
        measured = probed.duration;
      } catch {
        measured = null;
      }
      let patch = {
        kind: 'video',
        file,
        previewUrl: URL.createObjectURL(file),
        poster: null,
        posterUrl: null,
        width: Number(video.videoWidth) || null,
        height: Number(video.videoHeight) || null,
        duration: measured || seconds,
        name: file.name,
        size: file.size,
      };
      try {
        // 复用上传前的处理：读元数据 + 截一帧当封面
        const prepared = await prepareFile(file);
        if (patch.previewUrl) URL.revokeObjectURL(patch.previewUrl);
        patch = {
          kind: 'video',
          file: prepared.file,
          previewUrl: prepared.previewUrl,
          poster: prepared.poster,
          posterUrl: prepared.posterUrl,
          width: prepared.width || patch.width,
          height: prepared.height || patch.height,
          duration: Number.isFinite(prepared.duration) ? prepared.duration : patch.duration,
          name: prepared.file.name,
          size: prepared.file.size,
        };
      } catch {
        /* 封面 / 元数据失败也不影响替换，用上面的兜底数据 */
      }
      onChange?.(patch);
      cleanup();
      entry.close();
      toast(`视频已裁剪到 ${round1(patch.duration).toFixed(1)} 秒`);
    } catch (err) {
      state.textContent = err?.message || '裁剪失败，请重试';
      toast(err?.message || '视频裁剪失败');
      busy = false;
      updateInfo();
      saveBtn.classList.remove('loading');
    }
  }

  cancelBtn.addEventListener('click', () => {
    cleanup();
    entry.close();
  });
  saveBtn.addEventListener('click', save);

  /** 压缩整条视频（画面缩到 720p + 低码率重录），完成后替换这个附件 */
  async function shrink() {
    if (!support.ok) {
      toast(UNSUPPORTED_MSG);
      return;
    }
    if (busy) return;
    busy = true;
    shrinkBtn.disabled = true;
    saveBtn.disabled = true;
    shrinkBtn.classList.add('loading');
    const before = Number(item.size) || (item.file ? item.file.size : 0);
    state.textContent = '正在压缩…（要按原速过一遍，请稍等）';
    try {
      const { blob, seconds } = await compressVideo(video, {
        onProgress: (r) => {
          state.textContent = `正在压缩… ${Math.round(r * 100)}%（要按原速过一遍）`;
        },
      });
      if (!blob.size) throw new Error('压缩结果是空的，请重试');
      if (before && blob.size >= before * 0.95) {
        // 压完反而没小多少：别折腾用户，保留原文件
        state.textContent = `压完是 ${fmtMb(blob.size)}，和原文件差不多，就不替换了`;
        toast('这个视频已经很省了，不用压缩');
        busy = false;
        shrinkBtn.disabled = false;
        shrinkBtn.classList.remove('loading');
        updateInfo();
        return;
      }
      const type = blob.type || 'video/webm';
      const ext = /mp4/i.test(type) ? 'mp4' : 'webm';
      const baseName = String(item.name || (item.file && item.file.name) || 'video').replace(/\.[^.]+$/, '') || 'video';
      const file = new File([blob], `${baseName}-720p.${ext}`, { type });
      let patch = {
        kind: 'video',
        file,
        previewUrl: URL.createObjectURL(file),
        poster: null,
        posterUrl: null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        duration: seconds,
        name: file.name,
        size: file.size,
      };
      try {
        const prepared = await prepareFile(file);
        if (patch.previewUrl) URL.revokeObjectURL(patch.previewUrl);
        patch = {
          kind: 'video',
          file: prepared.file,
          previewUrl: prepared.previewUrl,
          poster: prepared.poster,
          posterUrl: prepared.posterUrl,
          width: prepared.width || patch.width,
          height: prepared.height || patch.height,
          duration: Number.isFinite(prepared.duration) ? prepared.duration : patch.duration,
          name: prepared.file.name,
          size: prepared.file.size,
        };
      } catch {
        /* 元数据 / 封面失败不影响替换 */
      }
      onChange?.(patch);
      cleanup();
      entry.close();
      toast(`已压缩：${fmtMb(before)} → ${fmtMb(patch.size)}`);
    } catch (err) {
      state.textContent = err?.message || '压缩失败，请重试';
      toast(err?.message || '压缩失败');
      busy = false;
      shrinkBtn.disabled = false;
      shrinkBtn.classList.remove('loading');
      updateInfo();
    }
  }
  shrinkBtn.addEventListener('click', shrink);

  if (!support.ok) {
    state.textContent = '当前环境不支持视频裁剪，可以点「取消」保留原视频';
    previewBtn.disabled = false;
  }

  updateInfo();
  return { close: () => entry.close() };
}
