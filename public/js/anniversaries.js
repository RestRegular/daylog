/**
 * 纪念日前端：设置页管理（增删改/特别关注）、首页倒计时卡片、日历标注。
 */
import { api } from './api.js';
import { el, svgIcon } from './util.js';
import { openConfirm, openSheet, toast } from './ui.js';
import { nextCelebration } from './celebration.js';
import { emptyState, skeleton } from './timeline.js';
import { getFriendState } from './friends.js';

const state = {
  list: [],
  loaded: false,
  loading: false,
  // 按好友筛选时，该好友关联的纪念日（首页「好友」标签用）
  byFriend: {},
};

// 预设图标 11 个：网格最后一格留给「自定义」（和预设一样大的输入框）
const ICON_CHOICES = ['🎂', '💍', '🎉', '❤️', '💼', '🎓', '🏠', '👶', '🐱', '✈️', '📅'];

/** 说明最多 20 个字（中文、emoji 都按「一个字」算，不会把 emoji 切成两半） */
export const NOTE_MAX = 20;

/** 取前 max 个字符（按码点，不破坏 emoji） */
function clipChars(text, max) {
  return [...String(text ?? '').trim()].slice(0, max).join('');
}

/** 显示用的说明：超长自动截断并补省略号 */
export function truncateNote(text, max = NOTE_MAX) {
  const clean = String(text ?? '').trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${clipChars(clean, max)}…`;
}

/**
 * 自定义图标：**只收一个表情**（文字一律不认）。
 * 返回第一个表情「字素」，没有就返回空串 —— 一个 emoji 可能由多个码点组成
 * （👨‍👩‍👧、🇨🇳、❤️），所以必须按字素切，直接 slice 会切坏。
 */
const EMOJI_RE = /(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

export function normalizeIcon(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let segments;
  try {
    segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw)].map((s) => s.segment);
  } catch {
    segments = [...raw];
  }
  return segments.find((g) => EMOJI_RE.test(g)) || '';
}

export function getAnniversaryState() {
  return state;
}

export function resetAnniversariesCache() {
  state.list = [];
  state.loaded = false;
  state.loading = false;
  state.byFriend = {};
}

/** 拉取某个好友关联到的纪念日（没有关联则返回空数组） */
export async function loadFriendAnniversaries(friendId) {
  if (!friendId) return [];
  try {
    const res = await api.anniversariesOfFriend(friendId);
    state.byFriend = { ...state.byFriend, [friendId]: res.anniversaries || [] };
    return state.byFriend[friendId];
  } catch {
    state.byFriend = { ...state.byFriend, [friendId]: [] };
    return [];
  }
}

/** 同步读取已缓存的好友关联纪念日 */
export function friendAnniversaries(friendId) {
  if (!friendId) return [];
  return state.byFriend[friendId] || [];
}

/**
 * 首页「好友」标签选中某个人时要显示的倒计时：
 * 展示「我」这边关联了该好友的纪念日。
 */
export function friendCelebrations(friendId) {
  if (!friendId) return [];
  const friend = (getFriendState().friends || []).find((f) => f.user.id === friendId);
  const ownerName = friend?.displayName || friend?.user?.username || '好友';
  return friendAnniversaries(friendId)
    .filter((a) => a.next)
    .map((a) => ({ ...a, label: a.name || '纪念日', unit: '周年', linkedFriendName: ownerName }));
}

export async function loadAnniversaries({ silent = true } = {}) {
  state.loading = true;
  try {
    const res = await api.anniversaries();
    state.list = res.anniversaries || [];
  } catch (err) {
    if (!silent) toast(err.message || '加载纪念日失败');
  }
  state.loading = false;
  state.loaded = true;
  return state.list;
}

/** 按「剩余天数」升序（今天的排最前） */
export function sortedAnniversaries(list = state.list) {
  return [...list].sort((a, b) => {
    const da = a.next?.days ?? 9999;
    const db = b.next?.days ?? 9999;
    if (da !== db) return da - db;
    return (a.name || '').localeCompare(b.name || '', 'zh-CN');
  });
}

export function birthdayAnniversary() {
  return state.list.find((a) => a.isBirthday) || null;
}

export function specialAnniversary() {
  return state.list.find((a) => a.special && !a.isBirthday) || null;
}

/** 首页要展示的倒计时：生日 + 特别关注的纪念日 */
export function homeCelebrations() {
  const out = [];
  const push = (item, label, unit) => {
    // 必须带着 next 一起传出去（celebrationCard 依赖它算天数/日期）
    if (!item || !item.next) return;
    out.push({ ...item, next: item.next, label, unit });
  };
  push(birthdayAnniversary(), '生日', '岁');
  const special = specialAnniversary();
  if (special) push(special, special.name || '纪念日', '周年');
  return out;
}

/** 关联好友的小头像（没有头像时用首字兜底） */
function friendAvatar(friend, size = 22) {
  if (!friend) return null;
  const inner = friend.avatarUrl
    ? el('img', { src: friend.avatarUrl, alt: '', loading: 'lazy' })
    : el('span', { class: 'ini' }, (friend.displayName || friend.username || '?').slice(0, 1));
  return el(
    'span',
    {
      class: 'cd-friend',
      title: `关联好友：${friend.displayName || friend.username}`,
      style: { width: `${size}px`, height: `${size}px` },
    },
    inner
  );
}

/**
 * 统一的倒计时卡片。
 * 注意：item.next 缺失时必须返回空节点而不是抛错 ——
 * 否则一张卡的数据异常会把整个首页时间线一起干掉（曾经就是这样）。
 */
export function celebrationCard(item, { onClick } = {}) {
  const next = item?.next;
  if (!next) {
    console.warn('[daylog] 纪念日数据缺少 next，跳过卡片:', item);
    return el('div', { class: 'countdown broken', hidden: true });
  }
  const box = el('div', {
    class: `countdown${next.isToday ? ' today' : ''}${item.special || item.isBirthday ? ' special' : ''}${item.friend ? ' linked' : ''}`,
  });
  // 带上年份：只写「5 月 20 日」看不出是哪一年（跨年顺延后尤其容易误会）
  const dateText = next.year
    ? `${next.year} 年 ${next.month} 月 ${next.day} 日`
    : `${next.month} 月 ${next.day} 日`;

  // 第一行：图标 + 主文案（+ 好友头像 / 箭头）；有说明时"日期"挪到第二行跟说明作伴。
  // 不这么做的话第一行塞不下「主文案 + 日期 + 箭头」共 375px（可用只有 338px），
  // 主文案或日期会被挤成省略号。
  // 注意：DOM.append(null) 会插入字面量 "null"，所以每个可空项都要先判断
  const note = truncateNote(item.note);
  const top = el('div', { class: 'cd-top' });
  top.append(el('span', { class: 'cd-emoji' }, item.icon || '🎉'));
  let metaDate = null; // 要放进第二行的日期 / 周年数
  if (next.isToday) {
    top.append(el('span', { class: 'cd-main' }, `今天是${item.label || item.name}！`));
    // 今天 + 没有周年数（age=0）时就什么都不加，避免插出字面量 "null"
    const ageEl = next.age ? el('span', { class: 'cd-sub' }, `${next.age} ${item.unit || '周年'}`) : null;
    if (ageEl) {
      if (note) metaDate = ageEl;
      else top.append(ageEl);
    }
  } else {
    top.append(el('span', { class: 'cd-main' }, `距离${item.label || item.name}还有 ${next.days} 天`));
    const dateEl = el('span', { class: 'cd-sub' }, dateText);
    if (note) metaDate = dateEl;
    else top.append(dateEl);
  }
  // 关联了好友：把对方头像挂在卡片上
  const avatar = friendAvatar(item.friend);
  if (avatar) top.append(avatar);
  if (onClick) {
    box.classList.add('clickable');
    box.addEventListener('click', onClick);
    top.append(el('span', { class: 'cd-edit' }, svgIcon('chevron', 15)));
  }
  box.append(top);

  // 第二行：日期 + 说明（说明永远从这里开始；两者一起放不下时说明整体换到第三行，不截断）
  if (note) {
    const meta = el('div', { class: 'cd-meta' });
    if (metaDate) meta.append(metaDate);
    meta.append(el('span', { class: 'cd-note' }, note));
    box.append(meta);
  }
  return box;
}

// ---------------------------------------------------------------- 设置页：管理列表

function openEditor(existing, { onSaved }) {
  const isBirthday = existing?.isBirthday;
  const draft = {
    name: existing?.name || '',
    icon: existing?.icon || '🎉',
    date: existing?.date || '',
    note: existing?.note || '',
    special: existing?.special ?? false,
    kind: isBirthday ? 'birthday' : 'custom',
    friendId: existing?.friendId || null,
  };

  const nameInput = el('input', {
    class: 'input',
    placeholder: '例如：结婚纪念日',
    maxlength: 24,
    value: draft.name,
  });
  const dateInput = el('input', { class: 'input', type: 'date', value: draft.date });
  const noteInput = el('input', {
    class: 'input',
    placeholder: '说明',
    maxlength: NOTE_MAX,
    value: clipChars(draft.note, NOTE_MAX),
  });

  // 图标：11 个预设 + 最后一格「自定义」（和预设一样大，只收一个表情）
  const iconGrid = el('div', { class: 'icon-grid' });
  const iconButtons = [];
  const syncIconActive = () => {
    const isPreset = ICON_CHOICES.includes(draft.icon);
    for (const btn of iconButtons) btn.classList.toggle('active', btn.dataset.icon === draft.icon);
    iconInput.classList.toggle('active', !isPreset);
  };
  const iconInput = el('input', {
    class: 'icon-choice icon-input',
    placeholder: '✏️',
    value: ICON_CHOICES.includes(draft.icon) ? '' : draft.icon,
    'aria-label': '自定义图标（只支持一个表情）',
  });
  for (const ic of ICON_CHOICES) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'icon-choice',
        dataset: { icon: ic },
        onclick: () => {
          draft.icon = ic;
          iconInput.value = '';
          syncIconActive();
        },
      },
      ic
    );
    iconButtons.push(btn);
    iconGrid.append(btn);
  }
  iconGrid.append(iconInput);
  iconInput.addEventListener('input', () => {
    const emoji = normalizeIcon(iconInput.value);
    if (!emoji) {
      // 只允许表情：打了文字就丢掉，保留原来的图标
      if (iconInput.value) iconInput.value = '';
      return;
    }
    if (iconInput.value !== emoji) iconInput.value = emoji; // 多余的字符直接删掉
    draft.icon = emoji;
    syncIconActive();
  });
  syncIconActive();

  const specialSwitch = el('button', {
    class: `switch${draft.special || isBirthday ? ' on' : ''}`,
    type: 'button',
    role: 'switch',
    disabled: isBirthday ? true : null,
  }, el('span', { class: 'knob' }));
  specialSwitch.addEventListener('click', () => {
    if (isBirthday) return;
    draft.special = !draft.special;
    specialSwitch.classList.toggle('on', draft.special);
  });

  // 关联好友（可选）：下拉选一个好友，在首页按好友筛选时会显示这条倒计时
  const friends = getFriendState().friends || [];
  const friendSelect = el(
    'select',
    { class: 'input', 'aria-label': '关联好友（可选）' },
    el('option', { value: '' }, '不关联'),
    ...friends.map((f) =>
      el('option', { value: f.user.id, selected: draft.friendId === f.user.id ? true : null }, f.displayName || f.user.username)
    )
  );
  friendSelect.addEventListener('change', () => {
    draft.friendId = friendSelect.value || null;
  });

  const body = el(
    'div',
    { class: 'anniversary-editor' },
    el('div', { class: 'field' }, el('label', {}, '名称'), nameInput),
    el('div', { class: 'field' }, el('label', {}, '日期（年份用于计算周年数）'), dateInput),
    el('div', { class: 'field' }, el('label', {}, '图标'), iconGrid),
    el(
      'div',
      { class: 'field' },
      el('label', {}, '说明'),
      noteInput,
      el('span', { class: 'field-hint' }, `最多 ${NOTE_MAX} 个字，超出会截断`)
    ),
    friends.length
      ? el(
          'div',
          { class: 'field' },
          el('label', {}, '关联好友（可选）'),
          friendSelect,
          el('span', { class: 'field-hint' }, '关联后，在首页「好友」标签筛选对方时会显示这条倒计时')
        )
      : null,
    el(
      'div',
      { class: 'switch-row' },
      el(
        'div',
        {},
        el('strong', {}, '特别关注'),
        el('span', { class: 'muted' }, isBirthday ? '生日默认特别关注' : '首页会显示它的倒计时（只能有一个）')
      ),
      specialSwitch
    )
  );

  const saveBtn = el('button', { class: 'btn primary wide', type: 'button' }, existing ? '保存修改' : '添加纪念日');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const date = dateInput.value;
    if (!name) {
      toast('请填写名称');
      return;
    }
    if (!date) {
      toast('请选择日期');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.classList.add('loading');
    try {
      // friendId: null 表示不关联；'' 也会被后端归一化成 null
      const payload = {
        name,
        icon: normalizeIcon(draft.icon) || '🎉',
        date,
        note: clipChars(noteInput.value, NOTE_MAX),
        friendId: draft.friendId || null,
      };
      if (existing) {
        await api.updateAnniversary(
          existing.id,
          draft.kind === 'birthday'
            ? { name, icon: payload.icon, date, note: payload.note, friendId: payload.friendId }
            : { ...payload, special: draft.special }
        );
        toast('已保存');
      } else {
        await api.createAnniversary({ ...payload, special: draft.special, kind: 'custom' });
        toast('已添加');
      }
      await loadAnniversaries();
      onSaved?.();
      sheet.close();
    } catch (err) {
      toast(err.message || '保存失败');
      saveBtn.disabled = false;
    } finally {
      saveBtn.classList.remove('loading');
    }
  });

  const sheet = openSheet({ title: existing ? '编辑纪念日' : '添加纪念日', content: body });
  body.append(saveBtn);
}

/** 设置页里的纪念日管理区（返回元素） */
export function anniversariesSection({ onChanged } = {}) {
  const card = el('section', { class: 'card settings-card' });
  const head = el(
    'div',
    { class: 'section-head' },
    el('h3', {}, '纪念日'),
    el(
      'button',
      {
        class: 'btn ghost small',
        type: 'button',
        // 新增后必须就地重绘列表：只调 onChanged 的话，列表要手动刷新才出现新条目
        onclick: () => openEditor(null, { onSaved: () => { paint(); onChanged?.(); } }),
      },
      svgIcon('plus', 16),
      '添加'
    )
  );
  card.append(head);

  const listBox = el('div', { class: 'anniversary-list' });
  card.append(listBox);

  const paint = () => {
    listBox.textContent = '';
    if (!state.loaded && state.loading) {
      listBox.append(skeleton(1));
      return;
    }
    if (!state.list.length) {
      listBox.append(
        el('p', { class: 'muted' }, '还没有纪念日。添加一个生日或纪念日，首页会显示倒计时，日历上也会标注出来。')
      );
      return;
    }
    for (const item of sortedAnniversaries()) {
      const row = el(
        'div',
        { class: `anniversary-row${item.special || item.isBirthday ? ' special' : ''}${item.friend ? ' linked' : ''}` }
      );
      const next = item.next;
      // 三排展示：第一排名称+标签 / 第二排日期+剩余天数 / 第三排说明（最多 20 字，超出截断）
      const note = truncateNote(item.note);
      row.append(
        el('span', { class: 'an-icon' }, item.icon || '🎉'),
        el(
          'div',
          { class: 'an-text' },
          el(
            'div',
            { class: 'an-title' },
            el('strong', {}, item.name),
            item.isBirthday ? el('span', { class: 'tag-pill' }, '生日') : null,
            item.special && !item.isBirthday ? el('span', { class: 'tag-pill special' }, '特别关注') : null,
            // 关联好友：小头像 + 名字
            item.friend
              ? el(
                  'span',
                  { class: 'tag-pill link' },
                  friendAvatar(item.friend, 16),
                  item.friend.displayName || item.friend.username
                )
              : null
          ),
          el(
            'span',
            { class: 'an-meta muted' },
            `${item.date}${next ? ` · ${next.isToday ? '就是今天 🎉' : `还有 ${next.days} 天`}` : ''}`
          ),
          note ? el('span', { class: 'an-note' }, note) : null
        )
      );
      const actions = el('div', { class: 'friend-actions' });
      if (!item.isBirthday) {
        actions.append(
          el(
            'button',
            {
              class: `icon-btn small${item.special ? ' active-star' : ''}`,
              type: 'button',
              'aria-label': item.special ? '取消特别关注' : '设为特别关注',
              title: item.special ? '取消特别关注' : '设为特别关注',
              onclick: async () => {
                try {
                  await api.updateAnniversary(item.id, { special: !item.special });
                  await loadAnniversaries();
                  paint();
                  onChanged?.();
                  toast(item.special ? '已取消特别关注' : '已设为特别关注');
                } catch (err) {
                  toast(err.message || '操作失败');
                }
              },
            },
            svgIcon('star', 16)
          )
        );
      }
      actions.append(
        el(
          'button',
          { class: 'icon-btn small', type: 'button', 'aria-label': '编辑', title: '编辑', onclick: () => openEditor(item, { onSaved: () => { paint(); onChanged?.(); } }) },
          svgIcon('edit', 16)
        ),
        el(
          'button',
          {
            class: 'icon-btn small danger',
            type: 'button',
            'aria-label': '移除',
            title: '移除',
            onclick: async () => {
              const ok = await openConfirm({
                title: `移除「${item.name}」？`,
                message: '移除后首页和日历都不再显示它。',
                confirmText: '移除',
                danger: true,
              });
              if (!ok) return;
              try {
                await api.deleteAnniversary(item.id);
                await loadAnniversaries();
                paint();
                onChanged?.();
                toast('已移除');
              } catch (err) {
                toast(err.message || '移除失败');
              }
            },
          },
          svgIcon('trash', 16)
        )
      );
      row.append(actions);
      listBox.append(row);
    }
  };

  if (!state.loaded) {
    loadAnniversaries().then(() => {
      paint();
      onChanged?.();
    });
  }
  paint();
  return { node: card, repaint: paint };
}

/** 点开某个纪念日 -> 编辑 */
export function openAnniversaryEditor(item, opts) {
  return openEditor(item, opts);
}

export { emptyState };
