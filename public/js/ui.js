/** 通用 UI 组件：吐司、底部面板、确认框、灯箱 */
import { el, svgIcon } from './util.js';

// ---------------- 吐司 ----------------

let toastTimer = null;
export function toast(message, { duration = 2600, action = null } = {}) {
  const host = document.querySelector('#toast-host');
  if (!host) return;
  host.textContent = '';
  const box = el('div', { class: 'toast' }, el('span', {}, message));
  if (action) {
    box.append(
      el(
        'button',
        {
          class: 'toast-action',
          type: 'button',
          onclick: () => {
            action.onClick();
            host.textContent = '';
          },
        },
        action.label
      )
    );
  }
  host.append(box);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.add('out');
    setTimeout(() => {
      host.textContent = '';
    }, 200);
  }, duration);
}

// ---------------- 底部面板 ----------------

const sheetStack = [];

/**
 * 打开底部面板。
 *
 * 两种用法（二选一，不要混用）：
 *  1) 传 content/title：内部自建遮罩层 + .sheet 面板；
 *  2) 传 node：调用方自备整个遮罩层（例如 composer 自己组装好的 backdrop + .sheet），
 *     此时**绝不能**再往里 append 一个空的 .sheet —— 否则同一遮罩层里会出现两个
 *     并排的 flex 子项，各自被压成一半宽度并整体偏移。
 *
 * 另外：同一次 layout 中如果被复用同一个遮罩层（例如「用同一个 backdrop 又开了一个面板」），
 * 会因为一个遮罩层里塞进两个 .sheet 而重现上面那个错位问题，所以这里做了强制隔离：
 * 检测到复用就另起一层遮罩，保证「一层遮罩 = 一个面板」这个不变量。
 */
export function openSheet({ node = null, title = '', content = null, compact = false, onBackdrop = null }) {
  const custom = node !== null && node !== undefined;

  if (custom) {
    const backdrop = node;
    backdrop.classList.add('sheet-backdrop');
    const sheet = backdrop.querySelector('.sheet') || backdrop.firstElementChild;
    const entry = { backdrop, sheet };

    // 复用保护：该遮罩层已被别的面板占用时，直接复用它，绝不再塞第二个 .sheet
    //（一个遮罩层里两个 .sheet 会让每个被压成一半宽度并整体偏移）
    const reused = sheetStack.some((e) => e.backdrop === backdrop);

    const close = () => {
      backdrop.classList.add('closing');
      setTimeout(() => {
        backdrop.remove();
        cleanupBackdrops();
      }, 160);
      const idx = sheetStack.indexOf(entry);
      if (idx >= 0) sheetStack.splice(idx, 1);
    };
    entry.close = close;

    // 点遮罩空白处（而不是面板内部）时关闭
    backdrop.addEventListener('click', (e) => {
      if (e.target !== backdrop) return;
      if (sheet && sheet.contains(e.target)) return;
      if (onBackdrop) onBackdrop();
      else close();
    });

    if (!reused && !backdrop.isConnected) document.body.append(backdrop);
    document.body.classList.add('no-scroll');
    sheetStack.push(entry);
    return entry;
  }

  const backdrop = el('div', { class: 'sheet-backdrop' });
  const sheet = el('div', {
    class: `sheet${compact ? ' compact' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
  });
  const closeBtn = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '关闭' },
    svgIcon('close', 20)
  );
  const body = el('div', { class: 'sheet-body' });
  if (title) {
    sheet.append(el('div', { class: 'sheet-head' }, el('div', { class: 'sheet-title' }, title), closeBtn));
    if (content) body.append(content);
  } else if (content) {
    body.append(content);
    body.prepend(closeBtn);
    closeBtn.classList.add('float-close');
  }
  sheet.append(body);
  backdrop.append(sheet);

  const entry = { backdrop, sheet };
  const close = () => {
    backdrop.classList.add('closing');
    setTimeout(() => {
      backdrop.remove();
      cleanupBackdrops();
    }, 160);
    const idx = sheetStack.indexOf(entry);
    if (idx >= 0) sheetStack.splice(idx, 1);
  };
  entry.close = close;
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target !== backdrop) return;
    if (onBackdrop) onBackdrop();
    else close();
  });
  document.body.append(backdrop);
  document.body.classList.add('no-scroll');
  sheetStack.push(entry);
  return entry;
}

export function cleanupBackdrops() {
  for (const el of document.querySelectorAll('.sheet-backdrop')) {
    // 只回收「空了」的遮罩层（可能是复用保护产生的外层包装）
    if (!el.querySelector('.sheet')) el.remove();
  }
  if (!document.querySelector('.sheet-backdrop')) document.body.classList.remove('no-scroll');
}

export function closeSheet() {
  const top = sheetStack[sheetStack.length - 1];
  if (top) top.close();
}

/** 自检用：当前打开的面板层数与每层的 .sheet 数量 */
export function sheetDebugInfo() {
  return sheetStack.map((entry, i) => ({
    index: i,
    sheetsInBackdrop: entry.backdrop.querySelectorAll('.sheet').length,
    sheetClass: entry.sheet?.className || '',
    connected: entry.backdrop.isConnected,
  }));
}

export function openConfirm({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    let entry = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      entry?.close();
      resolve(value);
    };
    const body = el(
      'div',
      { class: 'dialog-body' },
      message ? el('p', {}, message) : null,
      el(
        'div',
        { class: 'dialog-actions' },
        el('button', { class: 'btn ghost', type: 'button', onclick: () => done(false) }, cancelText),
        el(
          'button',
          { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => done(true) },
          confirmText
        )
      )
    );
    entry = openSheet({ title, content: body, compact: true, onBackdrop: () => done(false) });
  });
}

// ---------------- 灯箱 ----------------

export function openLightbox(mediaList, startIndex = 0) {
  const list = (mediaList || []).filter(Boolean);
  if (!list.length) return null;
  let index = Math.min(Math.max(startIndex, 0), list.length - 1);
  const layer = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' });
  const stage = el('div', { class: 'lb-stage' });
  const counter = el('div', { class: 'lb-counter' });
  const closeBtn = el('button', { class: 'icon-btn lb-close', 'aria-label': '关闭' }, svgIcon('close', 22));
  const prevBtn = el('button', { class: 'icon-btn lb-nav prev', 'aria-label': '上一张' }, svgIcon('back', 22));
  const nextBtn = el('button', { class: 'icon-btn lb-nav next', 'aria-label': '下一张' }, svgIcon('chevron', 22));

  function render() {
    stage.textContent = '';
    const item = list[index];
    if (!item) return;
    if (item.kind === 'video') {
      stage.append(
        el('video', {
          src: item.url,
          poster: item.posterUrl || null,
          controls: true,
          playsinline: true,
          autoplay: true,
          preload: 'metadata',
        })
      );
    } else {
      stage.append(el('img', { src: item.url, alt: item.name || '' }));
    }
    counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === list.length - 1;
  }

  function go(delta) {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    index = next;
    render();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    layer.remove();
    if (!document.querySelector('.sheet-backdrop')) document.body.classList.remove('no-scroll');
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'ArrowLeft') go(-1);
  }

  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    go(-1);
  });
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    go(1);
  });
  layer.addEventListener('click', (e) => {
    if (e.target === layer || e.target === stage) close();
  });

  let startX = 0;
  let startY = 0;
  let tracking = false;
  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = (e.changedTouches[0]?.clientX || 0) - startX;
      const dy = (e.changedTouches[0]?.clientY || 0) - startY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) close();
    },
    { passive: true }
  );

  layer.append(stage, counter, closeBtn);
  if (list.length > 1) layer.append(prevBtn, nextBtn);
  document.body.append(layer);
  document.body.classList.add('no-scroll');
  document.addEventListener('keydown', onKey);
  render();
  return { close };
}
