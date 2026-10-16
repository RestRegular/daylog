/** 发布 / 编辑动态的面板（底部弹出，移动端优先） */
import {
  el,
  formatDuration,
  fromLocalInput,
  normalizeMood,
  pickFiles,
  splitMood,
  svgIcon,
  toLocalInput,
} from './util.js';
import { MOODS, VISIBILITY_LABEL } from './timeline.js';
import { IMAGE_MAX_EDGE, kindOf, prepareFile } from './media.js';
import { closeSheet, openConfirm, openSheet, toast } from './ui.js';
import { openAttachmentEditor } from './attachment-editor.js';
import { api } from './api.js';

const MAX_FILES = 12;
/** 超过这个体积的视频会问用户要不要压缩（手机原视频码率很高，直接播又慢又卡） */
const BIG_VIDEO_BYTES = 24 * 1024 * 1024;
/** 长按多久进入「拖动排序」（毫秒） */
const REORDER_HOLD_MS = 320;
/** 长按期间允许的手指抖动，超过就当作横向滚动而不是拖动 */
const REORDER_TOLERANCE = 8;
/** 轻点时允许的手指抖动（和横向滚动用同一个容差） */
const TAP_MOVE_TOLERANCE = REORDER_TOLERANCE;

/** 附件自增 key：拖动排序靠它把 DOM 顺序映射回 state.attachments */
let attachSeq = 0;

/** 当前正在拖动的面板的收尾函数（手指在面板外松开也能收尾） */
let endActiveDrag = null;
if (typeof window !== 'undefined') {
  const finishDrag = () => {
    const fn = endActiveDrag;
    endActiveDrag = null;
    fn?.();
  };
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('pointercancel', finishDrag);
}

/**
 * @param {object} opts
 * @param {object|null} opts.post 编辑时传入原动态
 * @param {(payload: {formData?: FormData, json?: object, id?: string}) => Promise<void>} opts.onSubmit
 */
export function openComposer({ post = null, onSubmit, defaultVisibility = 'public' } = {}) {
  const editing = Boolean(post);
  const state = {
    attachments: [], // 新加的：{ key, kind, file, poster, previewUrl, posterUrl, ... }
    // 编辑时：已有的附件也要放进附件条，否则根本没法删 / 拖动排序。
    // existing: true 的条目没有 file，提交时只发 id 和顺序。
    mood: post?.mood || '',
    location: post?.location || '',
    tags: (post?.tags || []).join(' '),
    visibility: post?.visibility || defaultVisibility,
    // occurredAt = 「这件事真正发生的时间」，可以在面板里改；
    // createdAt（发布时间）由服务端在发布时定下，之后不再变
    occurredAt: post?.occurredAt || post?.createdAt || Date.now(),
    createdAt: post?.createdAt || Date.now(),
    busy: false,
    removed: [], // 编辑时被移除的已有附件 id
  };

  // 把已有附件铺进附件条（保持服务端顺序，拖动排序才有意义）
  (post?.media || []).forEach((m, index) => {
    const isVideo = m.kind === 'video';
    state.attachments.push({
      key: `m${index}`,
      mediaId: m.id,
      existing: true,
      kind: m.kind,
      // 视频用封面当预览图；没有封面就显示兜底图标
      previewUrl: isVideo ? m.posterUrl || '' : m.url,
      posterUrl: isVideo ? m.posterUrl || '' : '',
      // 附件编辑器要用：已有的视频只有封面地址，裁剪时需要真正的视频地址；
      // mime 用来判断源图是否可能是带透明的格式
      videoUrl: isVideo ? m.url || '' : '',
      mime: m.mime || '',
      width: m.width || null,
      height: m.height || null,
      duration: m.duration ?? null,
      name: m.name || '',
    });
  });

  const backdrop = el('div', { class: 'sheet-backdrop' });
  const sheet = el('div', { class: 'sheet composer', role: 'dialog', 'aria-modal': 'true' });
  const textarea = el('textarea', {
    class: 'composer-text',
    rows: 4,
    placeholder: '现在在做什么？',
    maxlength: 4000,
  });
  textarea.value = post?.body || '';
  const attachStrip = el('div', { class: 'attach-strip' });
  const reorderHint = el('p', { class: 'attach-hint', hidden: true }, '长按图片 / 视频可拖动调整顺序');
  /** 拖动排序的瞬时状态 */
  const drag = {
    key: null,
    pointerId: null,
    active: false,
    timer: 0,
    startX: 0,
    startY: 0,
    // 浮层：baseX/baseY 是起始视口坐标，x/y 是相对起始位置的位移
    baseX: 0,
    baseY: 0,
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    tilt: 0,
    raf: 0,
    ghost: null,
    placeholder: null,
  };
  /**
   * 「轻点附件」的瞬时状态。
   * 只有「短按（< REORDER_HOLD_MS）且几乎没移动（<= TAP_MOVE_TOLERANCE）」才算轻点，
   * 其余情况（长按进入拖动排序、或手指移动想在附件条里横向滚动）都不打开编辑器。
   */
  const tap = { key: null, at: 0, x: 0, y: 0, moved: false };
  const metaRow = el('div', { class: 'meta-row' });
  const progressBar = el('div', { class: 'progress' }, el('i'));
  const progressWrap = el(
    'div',
    { class: 'progress-wrap' },
    progressBar,
    el('span', { class: 'progress-text' })
  );
  progressWrap.hidden = true;

  const sendBtn = el(
    'button',
    { class: 'btn primary', type: 'button' },
    editing ? '保存' : '发布',
    svgIcon('send', 18)
  );
  const closeBtn = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': '关闭' },
    svgIcon('close', 20)
  );

  const header = el(
    'div',
    { class: 'sheet-head' },
    el('div', { class: 'sheet-title' }, editing ? '编辑记录' : '记录此刻'),
    el('div', { class: 'sheet-head-actions' }, closeBtn, sendBtn)
  );

  function timezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }

  // ---- 元信息行 ----
  /** 最近用过的地点 / 标签 / 心情（进面板时拉一次，60 秒内复用） */
  let suggestions = { locations: [], tags: [], moods: [] };
  let suggestionsAt = 0;
  async function loadSuggestions() {
    if (Date.now() - suggestionsAt < 60_000) return suggestions;
    try {
      const res = await api.suggestions();
      suggestions = { locations: [], tags: [], moods: [], ...(res.suggestions || {}) };
      suggestionsAt = Date.now();
    } catch {
      /* 拿不到候选不影响写记录 */
    }
    return suggestions;
  }

  /**
   * 地点 / 标签选择面板：候选卡片在上面、输入框 + 确定在下面一行。
   * 标签支持多选（点候选是加/去），地点是单选。
   * 进来**不自动聚焦输入框** —— 用户很可能直接点上面的已有项。
   * 候选是异步拉的，所以先等它回来再开面板（60 秒内复用，几乎无感）。
   */
  async function openValuePicker({ title, kind, placeholder, value, max, multiple = false, onSave }) {
    const s = await loadSuggestions();
    const options = (multiple ? s.tags : s.locations || [])
      .filter(Boolean)
      .map((item) => ({ value: item, emoji: multiple ? '#' : '📍', label: item }));
    openOptionSheet({ title, kind, options, placeholder, value, max, multiple, onSave });
  }

  function renderMeta() {
    metaRow.textContent = '';
    const timeInput = el('input', {
      type: 'datetime-local',
      class: 'time-input',
      value: toLocalInput(state.occurredAt),
      max: toLocalInput(Date.now() + 60 * 60 * 1000),
    });
    timeInput.addEventListener('change', () => {
      state.occurredAt = fromLocalInput(timeInput.value);
    });
    metaRow.append(
      el('label', { class: 'meta-item time', title: '这件事发生的时间（发布时间不会变）' }, svgIcon('clock', 15), timeInput),
      el(
        'button',
        {
          type: 'button',
          class: `meta-item${state.location ? ' active' : ''}`,
          onclick: () =>
            openValuePicker({
              title: '此刻的地点',
              kind: 'location',
              placeholder: '例如：公司 / 家 / 上海',
              value: state.location,
              max: 40,
              onSave: (v) => {
                state.location = v;
                renderMeta();
              },
            }),
        },
        svgIcon('location', 15),
        state.location || '地点'
      ),
      el(
        'button',
        {
          type: 'button',
          class: `meta-item${state.mood ? ' active' : ''}`,
          onclick: () => openMoodPicker(),
        },
        svgIcon('smile', 15),
        state.mood ? `${state.mood} ${MOODS[state.mood] || ''}`.trim() : '心情'
      ),
      el(
        'button',
        {
          type: 'button',
          class: `meta-item${state.tags ? ' active' : ''}`,
          onclick: () =>
            openValuePicker({
              title: '标签',
              kind: 'tag',
              placeholder: '例如：加班 旅行（空格分隔）',
              value: state.tags,
              max: 120,
              multiple: true,
              onSave: (v) => {
                state.tags = v;
                renderMeta();
              },
            }),
        },
        svgIcon('text', 15),
        state.tags ? `#${state.tags.split(/[\s,，]+/)[0]}` : '标签'
      ),
      (() => {
        const btn = el(
          'button',
          { type: 'button', class: `meta-item vis ${state.visibility}` },
          svgIcon(state.visibility === 'public' ? 'globe' : 'lock', 15),
          VISIBILITY_LABEL[state.visibility]
        );
        btn.addEventListener('click', () => {
          const order = ['public', 'link', 'private'];
          const idx = order.indexOf(state.visibility);
          state.visibility = order[(idx + 1) % order.length];
          renderMeta();
        });
        return btn;
      })()
    );
  }

  // ---- 选项面板（心情 / 地点 / 标签共用一套结构与样式）----

  /** 隐藏掉的选项（长按卡片右上角 ✕ 删除），按类别存在本机 */
  const HIDDEN_PREFIX = 'daylog.hiddenOptions';
  function hiddenOptions(kind) {
    try {
      return new Set(JSON.parse(localStorage.getItem(`${HIDDEN_PREFIX}.${kind}`) || '[]'));
    } catch {
      return new Set();
    }
  }
  function persistHidden(kind, set) {
    try {
      localStorage.setItem(`${HIDDEN_PREFIX}.${kind}`, JSON.stringify([...set]));
    } catch {
      /* 隐私模式下写不了也不影响使用 */
    }
  }


  /**
   * 三种弹窗（此刻的心情 / 此刻的地点 / 标签）共用：
   *   上面是**选项卡片网格**（和心情预设同一套 .mood-grid / .mood-option），
   *   下面是**输入框 + 确定按钮同一行**（确定是给自定义输入用的）。
   *   - 单选（心情 / 地点）：点卡片=选中并立刻生效（和以前一样快），确定=用输入框里自己写的
   *   - 多选（标签）：点卡片=加/去，确定=提交
   *   - **长按**卡片 → 右上角出现删除键（✕），点它就删掉这个选项；点别处自动收起
   */
  function openOptionSheet({ title, kind, options, placeholder, value = '', max, multiple = false, onSave }) {
    let current = value || '';
    const input = el('input', { class: 'input', value: current, placeholder, maxlength: max });
    const grid = el('div', { class: 'mood-grid' });
    const save = el('button', { class: 'btn primary', type: 'button' }, '确定');
    const hidden = hiddenOptions(kind);

    const parts = () => current.split(/[\s,，]+/).filter(Boolean);
    const commit = (next) => {
      onSave(String(next || '').trim().slice(0, max));
      closeSheet();
    };
    const pick = (item) => {
      if (multiple) {
        current = `${current ? `${current.replace(/[\s,，]+$/, '')} ` : ''}${item.value} `;
        input.value = current;
        render();
        return;
      }
      commit(item.value);
    };

    // 长按唤出的删除键
    let armed = null;
    let armTimer = 0;
    const disarm = () => {
      if (armTimer) clearTimeout(armTimer);
      armTimer = 0;
      if (!armed) return;
      armed.classList.remove('armed');
      armed.querySelector('.option-del')?.remove();
      armed = null;
    };
    const arm = (card, item) => {
      disarm();
      armed = card;
      card.classList.add('armed');
      card.append(
        el(
          'button',
          {
            type: 'button',
            class: 'option-del',
            'aria-label': `删除选项 ${item.value}`,
            onclick: (e) => {
              e.stopPropagation();
              hidden.add(item.value);
              persistHidden(kind, hidden);
              disarm();
              render();
              toast('已删除这个选项');
            },
          },
          svgIcon('close', 12)
        )
      );
    };

    function render() {
      disarm();
      grid.textContent = '';
      const typedRaw = multiple ? input.value.split(/[\s,，]+/).pop() : input.value;
      const typed = String(typedRaw || '').trim().toLowerCase();
      const chosen = multiple ? parts() : [];
      const items = options
        .filter((item) => !hidden.has(item.value))
        .filter((item) => !typed || item.label.toLowerCase().includes(typed) || item.value.toLowerCase().includes(typed))
        .filter((item) => !chosen.includes(item.value))
        .slice(0, 24);
      for (const item of items) {
        const active = multiple ? parts().includes(item.value) : current === item.value;
        const card = el(
          'button',
          {
            type: 'button',
            class: `mood-option${active ? ' active' : ''}`,
            onclick: () => {
              // 长按唤出删除键后，第一次点击只是收起它
              if (armed === card) {
                disarm();
                return;
              }
              pick(item);
            },
          },
          el('span', { class: 'emoji' }, item.emoji),
          el('span', { class: 'label' }, item.label || item.value)
        );
        card.addEventListener('pointerdown', () => {
          if (armTimer) clearTimeout(armTimer);
          armTimer = setTimeout(() => {
            armTimer = 0;
            arm(card, item);
          }, 450);
        });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
          card.addEventListener(type, () => {
            if (armTimer) clearTimeout(armTimer);
            armTimer = 0;
          });
        }
        grid.append(card);
      }
      grid.hidden = !items.length;
    }

    input.addEventListener('input', () => {
      current = input.value;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
    });
    save.addEventListener('click', () => {
      // 直接读输入框：用户可能改了内容但没触发 input（例如粘贴后立刻点确定）
      const typed = String(input.value || '').trim() || String(current || '').trim();
      if (!typed) {
        toast('先写点内容或点上面的选项吧');
        return;
      }
      commit(typed);
    });

    const body = el(
      'div',
      { class: 'picker-body' },
      grid,
      el('div', { class: 'picker-row' }, input, save)
    );
    const entry = openSheet({ title, content: body, compact: true });
    // 点面板里其它地方 → 收起删除键（capture 阶段，先于卡片自己的点击）
    entry.backdrop.addEventListener(
      'pointerdown',
      (e) => {
        if (armed && !armed.contains(e.target)) disarm();
      },
      true
    );
    render();
  }

  /** 此刻的心情：预设 + 你自己写过的心情，都放在同一个网格里 */
  async function openMoodPicker() {
    const isPreset = (value) => Object.prototype.hasOwnProperty.call(MOODS, value);
    const s = await loadSuggestions();
    const options = Object.entries(MOODS).map(([emoji, label]) => ({ value: emoji, emoji, label }));
    // 「自定义」过的也一起放进上面那排，和预设同一个网格
    for (const mood of s.moods || []) {
      if (isPreset(mood)) continue;
      const { emoji, label } = splitMood(mood);
      options.push({ value: mood, emoji, label: label || mood });
    }
    openOptionSheet({
      title: '此刻的心情',
      kind: 'mood',
      options,
      placeholder: '😭 累瘫了',
      max: 24,
      value: state.mood,
      onSave: (next) => {
        const mood = normalizeMood(next);
        if (!mood) {
          toast('先写点心情吧，比如 😭 累瘫了');
          return;
        }
        state.mood = mood;
        renderMeta();
      },
    });
  }

  // ---- 附件 ----
  function renderAttachments() {
    attachStrip.textContent = '';
    // 轻点附件就能预览 / 编辑，所以只有一个附件时也给出提示
    reorderHint.hidden = state.attachments.length < 1;
    reorderHint.textContent =
      state.attachments.length >= 2 ? '轻点预览 / 编辑，长按拖动可调整顺序' : '轻点附件可以预览 / 编辑';
    if (!state.attachments.length) {
      attachStrip.hidden = true;
      return;
    }
    attachStrip.hidden = false;
    state.attachments.forEach((item) => {
      const tile = el('div', {
        class: `attach-tile ${item.kind}`,
        dataset: { key: item.key || '' },
        title: '轻点预览 / 编辑',
      });
      const src = item.kind === 'video' ? item.posterUrl : item.previewUrl;
      if (src) tile.append(el('img', { src, alt: '' }));
      else tile.append(el('div', { class: 'attach-fallback' }, svgIcon('video', 22)));
      if (item.kind === 'video') {
        tile.append(el('span', { class: 'attach-badge' }, svgIcon('playback', 12)));
        if (item.duration) {
          tile.append(el('span', { class: 'attach-duration' }, formatDuration(item.duration)));
        }
      }
      tile.append(
        el(
          'button',
          {
            type: 'button',
            class: 'attach-remove',
            'aria-label': '移除',
            onclick: () => {
              // 已有附件是服务端地址，不能 revokeObjectURL（那是给本地预览 blob 用的）
              if (!item.existing) {
                if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
                if (item.posterUrl) URL.revokeObjectURL(item.posterUrl);
              } else if (item.mediaId) {
                state.removed.push(item.mediaId);
              }
              // 按 key 删除：拖动排序后 DOM 顺序和 state 顺序可能不同，
              // 用渲染时捕获的下标会删错那一个
              state.attachments = state.attachments.filter((a) => a !== item);
              renderAttachments();
              updateSendState();
            },
          },
          svgIcon('close', 14)
        )
      );
      if (item.uploading) {
        // 压缩时会带进度，普通处理就转圈
        tile.append(
          el(
            'div',
            { class: 'attach-mask' },
            item.progress ? el('span', { class: 'attach-progress' }, `${Math.round(item.progress * 100)}%`) : el('span', { class: 'spinner' })
          )
        );
      }
      attachStrip.append(tile);
    });
  }

  // ---- 长按拖动排序（图片 / 视频）----
  function cancelHold() {
    if (drag.timer) clearTimeout(drag.timer);
    drag.timer = 0;
  }

  /** 把拖动后的 DOM 顺序写回 state.attachments（提交时按这个顺序上传） */
  function commitOrder() {
    const byKey = new Map(state.attachments.map((a) => [a.key, a]));
    const ordered = [...attachStrip.querySelectorAll('.attach-tile')]
      .map((t) => byKey.get(t.dataset.key))
      .filter(Boolean);
    if (ordered.length === state.attachments.length) state.attachments = ordered;
  }

  /**
   * 跟随指针的浮层。
   * 两层结构：外层只负责「平移」（每帧改 transform，不加过渡），
   * 内层负责一次性的「抬起放大」动画 —— 这样放大动画和跟手平移不会互相打架。
   */
  function createGhost(tile) {
    const rect = tile.getBoundingClientRect();
    const ghost = el('div', {
      class: 'attach-ghost',
      style: { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` },
    });
    const inner = el('div', { class: 'attach-ghost-inner' });
    const img = tile.querySelector('img');
    if (img) {
      inner.append(el('img', { src: img.src, alt: '' }));
    } else {
      inner.append(el('div', { class: 'attach-fallback' }, svgIcon('video', 22)));
    }
    ghost.append(inner);
    document.body.append(ghost);
    return ghost;
  }

  function stopGhostLoop() {
    if (drag.raf) cancelAnimationFrame(drag.raf);
    drag.raf = 0;
  }

  /** 每帧把浮层往指针位置"追"过去：比直接赋值更顺，也不会被稀疏的 move 事件抖到 */
  function ghostLoop() {
    if (!drag.active || !drag.ghost) return;
    const k = 0.45;
    drag.x += (drag.targetX - drag.x) * k;
    drag.y += (drag.targetY - drag.y) * k;
    if (Math.abs(drag.targetX - drag.x) < 0.4) drag.x = drag.targetX;
    if (Math.abs(drag.targetY - drag.y) < 0.4) drag.y = drag.targetY;
    // 横向拖得越快，倾斜越明显（松手自然回正），手感更"跟手"
    const vx = drag.targetX - drag.x;
    const targetTilt = Math.max(-7, Math.min(7, vx * 0.35));
    drag.tilt += (targetTilt - drag.tilt) * 0.2;
    drag.ghost.style.transform = `translate3d(${drag.x.toFixed(1)}px, ${drag.y.toFixed(1)}px, 0) rotate(${drag.tilt.toFixed(2)}deg)`;
    drag.raf = requestAnimationFrame(ghostLoop);
  }

  /** 丢掉浮层（面板被关掉 / 提交时兜底调用，避免它留在 body 里） */
  function discardGhost() {
    stopGhostLoop();
    if (drag.ghost) {
      drag.ghost.remove();
      drag.ghost = null;
    }
    drag.active = false;
    drag.key = null;
    drag.placeholder = null;
  }

  function endDrag() {
    cancelHold();
    endActiveDrag = null;
    if (!drag.active) {
      drag.key = null;
      return;
    }
    stopGhostLoop();
    drag.active = false;
    attachStrip.classList.remove('reordering');
    if (drag.pointerId !== null) {
      try {
        attachStrip.releasePointerCapture(drag.pointerId);
      } catch {
        /* 没捕获成功也无所谓 */
      }
    }
    drag.pointerId = null;
    if (drag.placeholder) drag.placeholder.classList.remove('dragging');

    const key = drag.key;
    const ghost = drag.ghost;
    const fromX = drag.baseX + drag.x;
    const fromY = drag.baseY + drag.y;
    drag.key = null;
    drag.ghost = null;
    drag.placeholder = null;

    commitOrder();
    renderAttachments(); // 重建一遍，让顺序和删除/上传用的下标一致

    // 收尾：浮层滑回它真正落下的格子，再淡出
    const landing = key ? attachStrip.querySelector(`.attach-tile[data-key="${key}"]`) : null;
    if (!ghost) return;
    if (!landing) {
      ghost.remove();
      return;
    }
    const rect = landing.getBoundingClientRect();
    ghost.style.transition = 'transform .19s cubic-bezier(0.22, 1, 0.36, 1), opacity .19s ease';
    ghost.style.transform = `translate3d(${(rect.x - fromX).toFixed(1)}px, ${(rect.y - fromY).toFixed(1)}px, 0) rotate(0deg)`;
    ghost.style.opacity = '0.2';
    setTimeout(() => ghost.remove(), 240);
  }

  function moveDragged(x) {
    const dragged = drag.placeholder;
    if (!dragged) return;
    const others = [...attachStrip.querySelectorAll('.attach-tile')].filter((t) => t !== dragged);
    // 先清掉上一帧的 FLIP 位移，按真实布局位置测量（否则会量到动画中间态，插错位置）
    for (const t of others) {
      t.style.transition = 'none';
      t.style.transform = '';
    }
    const from = new Map(others.map((t) => [t, t.getBoundingClientRect()]));
    // 指针落在某个格子的左半边之前 → 插到它前面；都不满足则放到最后
    const target = others.find((t) => {
      const r = from.get(t);
      return x < r.x + r.width / 2;
    });
    const desired = others.slice();
    desired.splice(target ? desired.indexOf(target) : desired.length, 0, dragged);
    const current = [...attachStrip.querySelectorAll('.attach-tile')];
    if (desired.every((t, i) => t === current[i])) {
      autoScroll(x);
      return;
    }
    for (const t of desired) attachStrip.append(t);
    // FLIP：其余格子从旧位置滑到新位置，让位的过程才是连续的
    for (const t of others) {
      const to = t.getBoundingClientRect();
      const dx = from.get(t).x - to.x;
      if (!dx) continue;
      t.style.transition = 'none';
      t.style.transform = `translateX(${dx.toFixed(1)}px)`;
      requestAnimationFrame(() => {
        t.style.transition = '';
        t.style.transform = '';
      });
    }
    autoScroll(x);
  }

  /** 拖到两端时自动滚动，否则排在屏幕外的附件拖不到 */
  function autoScroll(x) {
    const box = attachStrip.getBoundingClientRect();
    if (box.width >= attachStrip.scrollWidth) return;
    if (x > box.right - 48) attachStrip.scrollLeft += 16;
    else if (x < box.left + 48) attachStrip.scrollLeft -= 16;
  }

  function beginDrag(tile, event) {
    drag.active = true;
    drag.placeholder = tile;
    drag.pointerId = event?.pointerId ?? null;
    drag.baseX = tile.getBoundingClientRect().x;
    drag.baseY = tile.getBoundingClientRect().y;
    drag.x = 0;
    drag.y = 0;
    drag.tilt = 0;
    drag.targetX = (event?.clientX ?? drag.startX) - drag.startX;
    drag.targetY = (event?.clientY ?? drag.startY) - drag.startY;
    endActiveDrag = endDrag;
    // 指针捕获在附件条上（它不会随排序被移动），手指划出面板也能收到事件
    if (drag.pointerId !== null) {
      try {
        attachStrip.setPointerCapture(drag.pointerId);
      } catch {
        /* 部分浏览器/场景不支持，忽略 */
      }
    }
    attachStrip.classList.add('reordering');
    // 原格子留在原位当占位，不放大 —— 放大就会顶到附件条的上下边界被裁掉
    tile.classList.add('dragging');
    drag.ghost = createGhost(tile);
    stopGhostLoop();
    drag.raf = requestAnimationFrame(ghostLoop);
    if (navigator.vibrate) {
      try {
        navigator.vibrate(12); // 轻微震动，让"已进入排序"有反馈
      } catch {
        /* 忽略：部分浏览器不允许 */
      }
    }
  }

  attachStrip.addEventListener('pointerdown', (e) => {
    const target = e.target;
    const tile = target instanceof Element ? target.closest('.attach-tile') : null;
    if (!tile || tile.querySelector('.attach-mask')) return; // 正在处理中的附件先不响应
    if (target instanceof Element && target.closest('.attach-remove')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 记下可能的「轻点」：松手时仍然是短按 + 几乎没移动，就打开预览 / 编辑面板
    tap.key = tile.dataset.key || null;
    tap.at = Date.now();
    tap.x = e.clientX;
    tap.y = e.clientY;
    tap.moved = false;
    if (state.attachments.length < 2) return; // 只有一个附件，没什么可排序的
    drag.key = tile.dataset.key || null;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    cancelHold();
    drag.timer = setTimeout(() => {
      drag.timer = 0;
      if (drag.key && drag.key === tile.dataset.key) beginDrag(tile, e);
    }, REORDER_HOLD_MS);
  });

  attachStrip.addEventListener('pointermove', (e) => {
    // 手指动了就不再算「轻点」——移动超过容差说明用户在横向滚动或拖动排序
    if (
      tap.key &&
      !tap.moved &&
      (Math.abs(e.clientX - tap.x) > TAP_MOVE_TOLERANCE || Math.abs(e.clientY - tap.y) > TAP_MOVE_TOLERANCE)
    ) {
      tap.moved = true;
    }
    if (!drag.key) return;
    if (!drag.active) {
      // 长按还没触发就移动了：说明用户想横向滚动，取消这次长按
      if (
        Math.abs(e.clientX - drag.startX) > REORDER_TOLERANCE ||
        Math.abs(e.clientY - drag.startY) > REORDER_TOLERANCE
      ) {
        cancelHold();
        drag.key = null;
      }
      return;
    }
    e.preventDefault();
    drag.targetX = e.clientX - drag.startX;
    drag.targetY = e.clientY - drag.startY;
    moveDragged(e.clientX);
  });

  // 拖动中禁止页面跟着滚（touchmove 默认 passive，必须显式声明才能 preventDefault）
  attachStrip.addEventListener(
    'touchmove',
    (e) => {
      if (drag.active) e.preventDefault();
    },
    { passive: false }
  );

  attachStrip.addEventListener('pointerup', endDrag);
  attachStrip.addEventListener('pointercancel', endDrag);
  attachStrip.addEventListener('pointerup', endTap);
  attachStrip.addEventListener('pointercancel', () => {
    tap.key = null;
  });
  attachStrip.addEventListener('contextmenu', (e) => {
    if (drag.key || drag.active) e.preventDefault(); // 长按别弹出系统菜单
  });

  /** 松手时判断这次是不是「轻点」：是就打开附件预览 / 编辑面板 */
  function endTap() {
    const key = tap.key;
    const held = Date.now() - tap.at;
    tap.key = null;
    if (!key || tap.moved) return;
    if (drag.active) return; // 长按已经进入拖动排序
    // 按够长就算拖动（排序只在 >=2 个附件时才有意义，单个附件仍然允许长按打开）
    if (state.attachments.length >= 2 && held >= REORDER_HOLD_MS) return;
    const item = state.attachments.find((a) => a.key === key);
    if (!item || item.uploading) return;
    openAttachmentEditorFor(item);
  }

  /**
   * 打开附件编辑器；保存后就地替换这个附件。
   *  - 新加的附件：直接换 file / 预览地址（旧的 blob 地址记得回收）；
   *  - 已有附件：把它变成「新附件」——保留 key（位置不变），旧 mediaId 记进
   *    state.removed，于是服务端会删掉旧文件、存下新文件，提交逻辑不用改。
   */
  function openAttachmentEditorFor(item) {
    cancelHold();
    discardGhost();
    openAttachmentEditor(item, {
      onChange: (patch) => {
        if (item.existing) {
          if (item.mediaId) state.removed.push(item.mediaId);
          delete item.mediaId;
          delete item.existing;
          delete item.videoUrl; // 旧的视频地址作废，新的用 file / previewUrl
        } else {
          if (item.previewUrl && item.previewUrl !== patch.previewUrl) URL.revokeObjectURL(item.previewUrl);
          if (item.posterUrl && item.posterUrl !== patch.posterUrl) URL.revokeObjectURL(item.posterUrl);
        }
        Object.assign(item, patch);
        item.uploading = false;
        renderAttachments();
        updateSendState();
      },
    });
  }

  async function addFiles(files) {
    if (!files.length) return;
    const room = MAX_FILES - state.attachments.length;
    if (room <= 0) {
      toast(`最多添加 ${MAX_FILES} 个附件`);
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > room) toast(`只添加了前 ${room} 个附件`);

    const placeholders = accepted.map((file) => {
      const item = {
        // key 用于拖动排序后把顺序对回 state.attachments
        key: `a${(attachSeq += 1)}`,
        // 手机传的文件常常没有 mime，用扩展名兜底判断类型（否则视频会被当成图片）
        kind: kindOf(file) === 'video' ? 'video' : 'image',
        name: file.name,
        size: file.size,
        file,
        uploading: true,
        previewUrl: null,
        posterUrl: null,
      };
      state.attachments.push(item);
      return item;
    });
    renderAttachments();

    for (let i = 0; i < accepted.length; i += 1) {
      const item = placeholders[i];
      try {
        const prepared = await prepareFile(accepted[i], { maxEdge: IMAGE_MAX_EDGE });
        Object.assign(item, {
          kind: prepared.kind,
          file: prepared.file,
          poster: prepared.poster,
          previewUrl: prepared.previewUrl,
          posterUrl: prepared.posterUrl,
          width: prepared.width,
          height: prepared.height,
          duration: prepared.duration,
          size: prepared.file.size,
        });
        // 视频读不出信息（HEVC 之类）时会带一句提示；照片正常时没有
        if (prepared.warning) toast(prepared.warning);
        // 大视频：问一下要不要压缩（手机原视频码率很高，直接用会又慢又卡）
        if (prepared.kind === 'video' && prepared.file.size > BIG_VIDEO_BYTES) {
          const mb = Math.round(prepared.file.size / 1024 / 1024);
          const seconds = Math.max(1, Math.round(prepared.duration || 0));
          const yes = await openConfirm({
            title: `视频较大（${mb}MB），压缩后上传？`,
            message: seconds
              ? `压缩到 720p 后播放会流畅很多。压缩要按原速过一遍，大约 ${seconds} 秒。`
              : '压缩到 720p 后播放会流畅很多（要按原速过一遍）。',
            confirmText: '压缩',
          });
          if (yes) {
            item.uploading = true;
            renderAttachments();
            try {
              const { compressFile, fmtMb } = await import('./attachment-editor.js');
              const smaller = await compressFile(accepted[i], {
                onProgress: (r) => {
                  item.progress = r;
                  renderAttachments();
                },
              });
              if (smaller.size < prepared.file.size * 0.95) {
                const again = await prepareFile(smaller, { maxEdge: IMAGE_MAX_EDGE });
                Object.assign(item, {
                  kind: again.kind,
                  file: again.file,
                  poster: again.poster,
                  previewUrl: again.previewUrl,
                  posterUrl: again.posterUrl,
                  width: again.width,
                  height: again.height,
                  duration: again.duration,
                  size: again.file.size,
                });
                toast(`已压缩：${fmtMb(prepared.file.size)} → ${fmtMb(again.file.size)}`);
              } else {
                toast('这个视频已经很省了，用原文件');
              }
            } catch (err) {
              toast(err?.message || '压缩失败，用原文件上传');
            } finally {
              item.uploading = false;
              item.progress = 0;
            }
          }
        }
      } catch (err) {
        const idx = state.attachments.indexOf(item);
        if (idx >= 0) state.attachments.splice(idx, 1);
        toast(err.message || '处理失败');
      } finally {
        item.uploading = false;
        renderAttachments();
        updateSendState();
      }
    }
  }

  function toolbar() {
    const bar = el('div', { class: 'composer-tools' });
    const mk = (icon, label, onClick) =>
      el(
        'button',
        { type: 'button', class: 'tool-btn', onclick: onClick },
        svgIcon(icon, 20),
        el('span', {}, label)
      );
    bar.append(
      mk('camera', '拍照', async () =>
        addFiles(await pickFiles({ accept: 'image/*', capture: 'environment' }))
      ),
      mk('image', '相册', async () => addFiles(await pickFiles({ accept: 'image/*' }))),
      mk('video', '视频', async () => addFiles(await pickFiles({ accept: 'video/*' })))
    );
    return bar;
  }

  function updateSendState() {
    const hasContent = textarea.value.trim().length > 0 || state.attachments.length > 0;
    sendBtn.disabled = state.busy || !hasContent;
  }

  function setProgress(ratio, text) {
    progressWrap.hidden = ratio === null;
    if (ratio === null) return;
    progressBar.firstElementChild.style.width = `${Math.round(ratio * 100)}%`;
    progressWrap.querySelector('.progress-text').textContent = text || `${Math.round(ratio * 100)}%`;
  }

  async function submit() {
    if (state.busy) return;
    if (state.attachments.some((a) => a.uploading)) {
      toast('还有附件正在处理中…');
      return;
    }
    const body = textarea.value.trim();
    if (!body && !state.attachments.length) return;
    discardGhost(); // 兜底：拖到一半就点了发布，别把浮层留在页面上
    state.busy = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('loading');
    try {
      // 附件顺序：已有的用 id，新加的用 new:序号（对应 multipart 里 media 字段的顺序）
      const fresh = state.attachments.filter((a) => !a.existing);
      const mediaOrder = state.attachments.map((a, i) => (a.existing ? a.mediaId : `new:${fresh.indexOf(a)}`));
      const json = {
        body,
        location: state.location,
        mood: state.mood,
        tags: state.tags,
        visibility: state.visibility,
        occurredAt: state.occurredAt,
        timezone: timezone(),
        // 编辑时：告诉服务端删了哪些附件、剩下的怎么排序
        ...(editing ? { removeMediaIds: state.removed, mediaOrder } : {}),
      };

      // 有新附件就用 multipart 上传（**编辑时也一样**，否则新加的图片/视频会被丢掉）；
      // 只有"已有附件的增删 / 排序"时走纯 JSON 就够了。
      if (fresh.length) {
        const fd = new FormData();
        const mediaMeta = [];
        fresh.forEach((item, index) => {
          fd.append('media', item.file, item.file.name || `file-${index}`);
          mediaMeta.push({
            width: item.width || null,
            height: item.height || null,
            duration: item.duration || null,
          });
          if (item.kind === 'video' && item.poster) {
            fd.append('poster', item.poster, item.poster.name || `poster-${index}.jpg`);
          }
        });
        fd.append('post', JSON.stringify({ ...json, mediaMeta }));
        if (fresh.length > 1) setProgress(0, '上传中…');
        await onSubmit({ formData: fd, id: post?.id, onProgress: setProgress });
      } else {
        await onSubmit({ json, id: post?.id });
      }
      for (const item of state.attachments) {
        if (item.existing) continue;
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.posterUrl) URL.revokeObjectURL(item.posterUrl);
      }
      state.busy = false;
      closeSheet();
    } catch (err) {
      toast(err.message || '保存失败');
      setProgress(null);
      state.busy = false;
      updateSendState();
    } finally {
      sendBtn.classList.remove('loading');
    }
  }

  sendBtn.addEventListener('click', submit);
  textarea.addEventListener('input', updateSendState);
  textarea.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  closeBtn.addEventListener('click', () => {
    cancelHold();
    discardGhost(); // 关面板时别把拖动浮层留在 body 里
    const hasDraft = textarea.value.trim() || state.attachments.length;
    if (!hasDraft || editing) {
      closeSheet();
      return;
    }
    openConfirm({
      title: '放弃这次编辑？',
      message: '已填写的内容不会保存。',
      confirmText: '放弃',
      danger: true,
    }).then((ok) => {
        if (!ok) return;
        for (const item of state.attachments) {
          if (item.existing) continue; // 服务端地址不能 revoke
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          if (item.posterUrl) URL.revokeObjectURL(item.posterUrl);
        }
        closeSheet();
      });
  });

  renderMeta();
  renderAttachments();
  // 内容和工具栏放进 .sheet-body：拿到统一的左右内边距 / 段间距，
  // 内容超过 92dvh 时也能滚动（以前直接挂在 .sheet 上，是贴边的）
  const body = el(
    'div',
    { class: 'sheet-body' },
    textarea,
    attachStrip,
    reorderHint,
    progressWrap,
    metaRow,
    // 编辑时提示"发布时间"（它不会被改）
    editing
      ? el(
          'p',
          { class: 'field-hint' },
          `发布时间 ${new Date(state.createdAt).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}（改上面的时间只改"事情发生的时间"）`
        )
      : null,
    toolbar()
  );
  sheet.append(header, body);
  backdrop.append(sheet);
  openSheet({ node: backdrop, onBackdrop: () => closeBtn.click() });
  updateSendState();
  setTimeout(() => textarea.focus({ preventScroll: true }), 150);

  return { close: () => closeSheet() };
}
