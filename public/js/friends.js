/** 好友页：添加好友、处理请求、查看好友列表 */
import { ApiError, api } from './api.js';
import { el, svgIcon, toggleSwitch } from './util.js';
import { emptyState, skeleton } from './timeline.js';
import { openConfirm, openSheet, toast } from './ui.js';

const state = {
  friends: [],
  incoming: [],
  outgoing: [],
  counts: { friends: 0, incoming: 0, outgoing: 0 },
  loading: false,
  loaded: false,
  lookup: null, // { username, user, friendship } | null
  lookupQuery: '',
};

export function friendsBadgeCount() {
  return state.counts.incoming || 0;
}

export async function loadFriends({ silent = false } = {}) {
  state.loading = true;
  try {
    const res = await api.friends();
    state.friends = res.friends || [];
    state.incoming = res.incoming || [];
    state.outgoing = res.outgoing || [];
    state.counts = res.counts || { friends: state.friends.length, incoming: 0, outgoing: 0 };
  } catch (err) {
    if (!silent) toast(err.message || '加载好友失败');
  }
  state.loading = false;
  state.loaded = true;
  return state;
}

export function getFriendState() {
  return state;
}

/** 清空好友缓存（退出登录 / 切换账号时必须调用，避免把上个用户的好友显示给新用户） */
export function resetFriendsCache() {
  state.friends = [];
  state.incoming = [];
  state.outgoing = [];
  state.counts = { friends: 0, incoming: 0, outgoing: 0 };
  state.loading = false;
  state.loaded = false;
  state.lookup = null;
  state.lookupQuery = '';
}

function userAvatar(user, size = 44) {
  if (user.avatarUrl) {
    return el('img', { class: 'avatar', src: user.avatarUrl, alt: '', loading: 'lazy', style: { width: `${size}px`, height: `${size}px` } });
  }
  return el(
    'div',
    { class: 'avatar placeholder', style: { width: `${size}px`, height: `${size}px` } },
    (user.displayName || user.username || '?').slice(0, 1)
  );
}

/**
 * 某个好友的推送设置（收件人视角）：
 *   · 免推送：不收 TA 的记录（连好友请求也不响）
 *   · 单独 key：优先于「设置 → 手机通知」里的默认通道；不填就用默认
 */
function openFriendPushSheet(entry, { onChanged } = {}) {
  const { user, displayName } = entry;
  const push = entry.push || { muted: false, override: false, kind: '', secretHint: '', url: '' };
  const body = el('div', { class: 'push-sheet-body' });

  const kindSel = el(
    'select',
    { class: 'input' },
    el('option', { value: 'wecom' }, '企业微信机器人'),
    el('option', { value: 'ntfy' }, 'ntfy'),
    el('option', { value: 'bark' }, 'Bark（iPhone）'),
    el('option', { value: 'webhook' }, '自定义 Webhook')
  );
  const secretInput = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    placeholder: push.secretHint ? `已保存 ${push.secretHint}（留空=不改）` : '整条 Webhook 地址，或只贴 key= 后面那串',
  });
  const urlInput = el('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: 'https://…' });
  const secretRow = el('div', { class: 'field' }, el('label', {}, '这个好友单独的 key'), secretInput);
  const urlRow = el('div', { class: 'field' }, el('label', {}, '这个好友单独的推送地址'), urlInput);

  const syncRows = () => {
    const kind = kindSel.value;
    secretRow.classList.toggle('hidden', kind !== 'wecom');
    urlRow.classList.toggle('hidden', kind === 'wecom');
    urlInput.placeholder =
      kind === 'ntfy' ? 'https://ntfy.sh/你的topic' : kind === 'bark' ? 'https://api.day.app/你的key' : 'https://…';
  };
  kindSel.value = push.kind || 'wecom';
  urlInput.value = push.url || '';
  syncRows();
  kindSel.addEventListener('change', syncRows);

  let muted = Boolean(push.muted);
  const muteSwitch = toggleSwitch(muted, (v) => {
    muted = v;
    body.classList.toggle('push-muted', muted);
  });

  const saveBtn = el('button', { class: 'btn primary wide', type: 'button' }, '保存');
  const clearBtn = el('button', { class: 'btn ghost wide', type: 'button' }, '恢复默认（跟「设置」里一样）');

  const sheet = openSheet({ title: `「${displayName}」的推送`, content: body });

  const useOverride = push.override || !push.muted;
  const modeSel = el(
    'select',
    { class: 'input' },
    el('option', { value: 'default' }, '跟默认一样（用设置里那条通道）'),
    el('option', { value: 'custom' }, '给 TA 单独配一条通道')
  );
  modeSel.value = push.override ? 'custom' : 'default';
  const customBox = el(
    'div',
    { class: 'push-custom' },
    el('div', { class: 'field' }, el('label', {}, '通道'), kindSel),
    secretRow,
    urlRow
  );
  const syncMode = () => customBox.classList.toggle('hidden', modeSel.value !== 'custom');
  modeSel.addEventListener('change', syncMode);
  syncMode();

  body.append(
    el(
      'div',
      { class: 'switch-row' },
      el('div', {}, el('strong', {}, '免推送'), el('span', { class: 'muted' }, '不收 TA 的记录，也不响 TA 的好友请求')),
      muteSwitch
    ),
    el('div', { class: 'field' }, el('label', {}, '这个好友的推送通道'), modeSel),
    customBox,
    el('div', { class: 'field-actions' }, clearBtn, saveBtn),
    el('p', { class: 'muted push-hint' }, push.muted ? '当前：免推送（保存后生效）' : push.override ? '当前：单独通道' : '当前：用默认通道')
  );

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const patch = { muted };
    if (modeSel.value === 'custom') {
      patch.kind = kindSel.value;
      if (kindSel.value === 'wecom') {
        const v = secretInput.value.trim();
        if (v) patch.secret = v;
      } else {
        const v = urlInput.value.trim();
        if (v) patch.url = v;
      }
    } else {
      patch.clearSecret = true;
      patch.clearUrl = true;
      patch.kind = '';
    }
    try {
      await api.setFriendPush(user.id, patch);
      toast('已保存');
      sheet.close();
      onChanged?.();
    } catch (err) {
      toast(err.message || '保存失败');
    } finally {
      saveBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', async () => {
    try {
      await api.setFriendPush(user.id, { clear: true });
      toast('已恢复默认');
      sheet.close();
      onChanged?.();
    } catch (err) {
      toast(err.message || '操作失败');
    }
  });

  return sheet;
}

function friendRow(entry, { onChanged, onOpen }) {
  const { user, alias, displayName } = entry;
  const push = entry.push || { muted: false, override: false, usable: false, secretHint: '', url: '' };
  const row = el('div', { class: 'friend-row' });
  const pushNote = push.muted ? ' · 免推送' : push.usable ? ' · 单独推送' : '';
  const main = el(
    'button',
    { class: 'friend-main', type: 'button', onclick: () => onOpen?.(entry) },
    userAvatar(user),
    el(
      'div',
      { class: 'friend-text' },
      el('strong', {}, displayName),
      el('span', { class: 'muted' }, `${alias ? `@${user.username} · 备注：${alias}` : `@${user.username}`}${pushNote}`)
    )
  );
  row.append(main);

  const actions = el('div', { class: 'friend-actions' });
  actions.append(
    el(
      'button',
      {
        class: 'icon-btn small',
        type: 'button',
        'aria-label': '看他的时间线',
        title: '看他的时间线',
        onclick: () => onOpen?.(entry),
      },
      svgIcon('eye', 16)
    ),
    el(
      'button',
      {
        class: `icon-btn small${push.muted ? ' danger' : ''}`,
        type: 'button',
        'aria-label': '推送设置',
        title: push.muted ? '已免推送' : push.usable ? '单独推送' : '推送设置',
        onclick: () => openFriendPushSheet(entry, { onChanged }),
      },
      svgIcon('bell', 16)
    ),
    el(
      'button',
      {
        class: 'icon-btn small',
        type: 'button',
        'aria-label': '设置备注',
        title: '设置备注',
        onclick: () => {
          const value = window.prompt(`给「${displayName}」设置备注名（留空取消）`, alias || '');
          if (value === null) return;
          api
            .setFriendAlias(user.id, value.trim())
            .then(() => {
              toast('已保存备注');
              onChanged?.();
            })
            .catch((err) => toast(err.message || '保存失败'));
        },
      },
      svgIcon('edit', 16)
    ),
    el(
      'button',
      {
        class: 'icon-btn small danger',
        type: 'button',
        'aria-label': '解除好友',
        title: '解除好友',
        onclick: async () => {
          const ok = await openConfirm({
            title: `解除与「${displayName}」的好友关系？`,
            message: '解除后你将看不到对方的动态（可以重新添加）。',
            confirmText: '解除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.removeFriend(user.id);
            toast('已解除好友');
            onChanged?.();
          } catch (err) {
            toast(err.message || '操作失败');
          }
        },
      },
      svgIcon('trash', 16)
    )
  );
  row.append(actions);
  return row;
}

function requestRow(entry, { incoming, onChanged }) {
  const { user, displayName } = entry;
  const row = el('div', { class: 'friend-row' });
  row.append(
    el(
      'div',
      { class: 'friend-main static' },
      userAvatar(user),
      el(
        'div',
        { class: 'friend-text' },
        el('strong', {}, displayName),
        el('span', { class: 'muted' }, incoming ? '想加你为好友' : '等待对方确认')
      )
    )
  );
  const actions = el('div', { class: 'friend-actions' });
  if (incoming) {
    actions.append(
      el(
        'button',
        {
          class: 'btn primary small',
          type: 'button',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.acceptFriend(user.id);
              toast('你们已经是好友了 🎉');
              onChanged?.();
            } catch (err) {
              toast(err.message || '操作失败');
              e.currentTarget.disabled = false;
            }
          },
        },
        '同意'
      ),
      el(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          onclick: async () => {
            try {
              await api.removeFriend(user.id);
              toast('已拒绝');
              onChanged?.();
            } catch (err) {
              toast(err.message || '操作失败');
            }
          },
        },
        '拒绝'
      )
    );
  } else {
    actions.append(
      el(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          onclick: async () => {
            try {
              await api.removeFriend(user.id);
              toast('已撤回申请');
              onChanged?.();
            } catch (err) {
              toast(err.message || '操作失败');
            }
          },
        },
        '撤回'
      )
    );
  }
  row.append(actions);
  return row;
}

function paint(host, { onChanged, onOpen }) {
  host.textContent = '';

  // 添加好友
  const addCard = el('section', { class: 'card settings-card' });
  addCard.append(el('h3', {}, '添加好友'));
  const input = el('input', {
    class: 'input',
    placeholder: '输入对方的用户名（不含 @）',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    value: state.lookupQuery || '',
  });
  const result = el('div', { class: 'lookup-result' });
  const form = el(
    'form',
    { class: 'search-bar' },
    input,
    el('button', { class: 'btn primary', type: 'submit' }, svgIcon('search', 18), '查找')
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = input.value.trim().replace(/^@/, '').toLowerCase();
    state.lookupQuery = username;
    result.textContent = '';
    if (!username) {
      result.append(el('p', { class: 'muted' }, '请输入用户名'));
      return;
    }
    result.append(skeleton(1));
    try {
      const res = await api.lookupUser(username);
      result.textContent = '';
      state.lookup = res;
      if (!res.user) {
        result.append(el('p', { class: 'notice warn' }, `没有找到用户「${username}」`));
        return;
      }
      if (res.user.isSelf) {
        result.append(el('p', { class: 'notice warn' }, '这是你自己 🙂'));
        return;
      }
      const box = el('div', { class: 'friend-row' });
      box.append(
        el(
          'div',
          { class: 'friend-main static' },
          userAvatar(res.user),
          el(
            'div',
            { class: 'friend-text' },
            el('strong', {}, res.user.displayName),
            el('span', { class: 'muted' }, `@${res.user.username}`),
            res.user.bio ? el('span', { class: 'muted' }, res.user.bio) : null
          )
        )
      );
      const actions = el('div', { class: 'friend-actions' });
      const labels = {
        none: '加为好友',
        pending_out: '已发送申请',
        pending_in: '同意对方申请',
        accepted: '已是好友',
      };
      const btn = el(
        'button',
        { class: `btn ${res.friendship === 'accepted' ? 'ghost' : 'primary'} small`, type: 'button' },
        labels[res.friendship] || '加为好友'
      );
      if (res.friendship === 'accepted') {
        btn.disabled = true;
      } else if (res.friendship === 'pending_in') {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.acceptFriend(res.user.id);
            toast('你们已经是好友了 🎉');
            onChanged?.();
          } catch (err) {
            toast(err.message || '操作失败');
            btn.disabled = false;
          }
        });
      } else if (res.friendship === 'pending_out') {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const out = await api.requestFriend({ username: res.user.username });
            toast(out.message || '请求已发送');
            onChanged?.();
          } catch (err) {
            toast(err.message || '操作失败');
            btn.disabled = false;
          }
        });
      }
      actions.append(btn);
      box.append(actions);
      result.append(box);
    } catch (err) {
      result.textContent = '';
      result.append(el('p', { class: 'notice warn' }, err.message || '查找失败'));
    }
  });
  addCard.append(form, result, el('p', { class: 'muted' }, '用户名不区分大小写。'));
  host.append(addCard);

  // 待处理请求
  if (state.incoming.length) {
    const card = el('section', { class: 'card settings-card' });
    card.append(el('h3', {}, `待我确认（${state.incoming.length}）`));
    for (const entry of state.incoming) {
      card.append(requestRow(entry, { incoming: true, onChanged }));
    }
    host.append(card);
  }

  // 好友列表
  const listCard = el('section', { class: 'card settings-card' });
  listCard.append(el('h3', {}, `我的好友（${state.friends.length}）`));
  if (!state.friends.length) {
    listCard.append(
      emptyState({
        title: '还没有好友',
        hint: '在上面的输入框里输入对方的用户名，发出申请；对方同意后你们就能互相看到动态了。',
      })
    );
  } else {
    for (const entry of state.friends) listCard.append(friendRow(entry, { onChanged, onOpen }));
  }
  host.append(listCard);

  // 我发出的申请
  if (state.outgoing.length) {
    const card = el('section', { class: 'card settings-card' });
    card.append(el('h3', {}, `我发出的申请（${state.outgoing.length}）`));
    for (const entry of state.outgoing) card.append(requestRow(entry, { incoming: false, onChanged }));
    host.append(card);
  }
}

/** 渲染好友页 */
export function renderFriendsView(main, { onChanged, onOpen } = {}) {
  const host = el('div', { class: 'friends-view' });
  main.append(host);

  const rerender = () => paint(host, { onChanged: handleChanged, onOpen });

  async function handleChanged() {
    await loadFriends({ silent: true });
    rerender();
    onChanged?.();
  }

  if (!state.loaded && !state.loading) {
    host.append(skeleton(2));
    loadFriends().then(rerender);
  } else {
    rerender();
  }
  return { refresh: handleChanged };
}

/** 点开某个好友：先给一个快速预览，并可跳到「完整的分享页」 */
export async function openFriendTimeline(entry, { onOpenMedia } = {}) {
  const { user, displayName } = entry;
  const body = el('div', { class: 'share-body' });

  // 直达完整分享页（按用户名，完整模式 = 带日期筛选）
  body.append(
    el(
      'a',
      {
        class: 'btn primary wide',
        href: `/u/${encodeURIComponent(user.username)}/timeline`,
        target: '_blank',
        rel: 'noopener',
      },
      svgIcon('globe', 18),
      `打开 ${displayName} 的完整分享页`
    ),
    el('p', { class: 'muted center' }, '完整分享页可以按 今天 / 选日期 / 全部 / 按月 自己筛选'),
    el('div', { class: 'sheet-divider' })
  );

  const list = el('div', { class: 'feed' });
  list.append(el('div', { class: 'loading-box' }, el('span', { class: 'spinner' }), el('span', {}, '加载中…')));
  body.append(el('p', { class: 'muted' }, '今日预览'), list);
  const sheet = openSheet({ title: `${displayName} 的动态`, content: body });

  try {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await api.listPosts({ scope: 'only', author: user.id, from: iso, to: iso, limit: 30 });
    list.textContent = '';
    if (!res.posts.length) {
      list.append(emptyState({ title: '对方今天还没有公开的动态', hint: '点上面的按钮可以看他的全部时间线。' }));
      return sheet;
    }
    const { renderFeed } = await import('./timeline.js');
    renderFeed(list, res.posts, { onOpenMedia });
  } catch (err) {
    list.textContent = '';
    list.append(el('p', { class: 'notice warn' }, err instanceof ApiError ? err.message : '加载失败'));
  }
  return sheet;
}
