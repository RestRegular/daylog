/** 分享页：/s/<限时链接>（范围与有效期由链接决定）或 /u/<用户名>/timeline（应用内好友视图） */
import { ApiError, api } from './api.js';
import { el, dayLabel, monthLabel, addMonths, svgIcon, todayKey } from './util.js';
import { emptyState, renderFeed, skeleton, statsBar } from './timeline.js';
import { openLightbox, toast } from './ui.js';
import { buildDateNav } from './datenav.js';

const token = (() => {
  // /s/<限时分享令牌>（新版）或老链接 /share/<token>（已停用，会提示失效）
  const byLink = location.pathname.match(/^\/s\/([A-Za-z0-9]+)/);
  if (byLink) return byLink[1];
  const legacy = location.pathname.match(/^\/share\/([A-Za-z0-9]+)/);
  if (legacy) return legacy[1];
  return new URLSearchParams(location.search).get('token') || '';
})();

/** 应用内「好友的时间线」用用户名访问：需要登录 + 好友关系 */
const friendName = (() => {
  const m = location.pathname.match(/^\/u\/([A-Za-z0-9_.-]+)\/timeline/);
  return m ? m[1] : '';
})();

const urlParams = new URLSearchParams(location.search);
const viaFriend = Boolean(friendName);

const state = {
  // 分享链接页：范围由链接决定，页面上不再给筛选入口
  // 好友视图：还是可以自己筛 今天 / 选日期 / 全部 / 按月
  range: 'all',
  date: urlParams.get('date') || todayKey(),
  month: (urlParams.get('date') || todayKey()).slice(0, 7),
  page: null, // 分享链接的信息（范围 + 有效期）
  posts: [],
  cursor: null,
  hasMore: false,
  profile: null,
  loading: false,
  loadToken: 0,
};

const isLocked = !viaFriend;

const main = document.querySelector('#share-main');
let filterBox = null;

async function fetchPosts({ append = false } = {}) {
  const myToken = (state.loadToken += 1);
  state.loading = true;
  const extra = append && state.cursor ? { cursor: state.cursor } : {};
  let request;
  if (viaFriend) {
    if (state.range === 'today') request = api.friendTimelinePosts(friendName, { limit: 20, ...extra, date: todayKey() });
    else if (state.range === 'date') request = api.friendTimelinePosts(friendName, { limit: 20, ...extra, date: state.date });
    else if (state.range === 'month') request = api.friendTimelinePosts(friendName, { limit: 100, ...extra, from: `${state.month}-01`, to: `${state.month}-31` });
    else request = api.friendTimelinePosts(friendName, { limit: 20, ...extra });
  } else {
    // 分享链接：范围完全由服务端按链接决定，客户端不传 date/range
    request = api.sharePosts(token, { limit: 20, ...extra });
  }
  try {
    const res = await request;
    if (state.loadToken !== myToken) return; // 过期响应丢弃
    state.profile = res.profile || state.profile;
    state.page = res.link || null;
    state.posts = append ? [...state.posts, ...res.posts] : res.posts;
    state.cursor = res.nextCursor;
    state.hasMore = res.hasMore;
  } finally {
    if (state.loadToken === myToken) state.loading = false;
  }
}

/**
 * 我给这个用户起的备注名（只有「已登录、且是好友」时才拿得到；
 * 拿不到就返回空串 —— 分享页本身不要求登录）
 */
async function myAliasFor(userId) {
  if (!userId) return '';
  try {
    const res = await api.friends();
    const entry = (res.friends || []).find((f) => f.user?.id === userId);
    return entry?.alias || '';
  } catch {
    return '';
  }
}

function renderProfileCard(profile, { alias = '' } = {}) {
  const card = el('section', { class: 'card profile-card' });
  const avatar = profile.avatarUrl
    ? el('img', { class: 'avatar', src: profile.avatarUrl, alt: '' })
    : el('div', { class: 'avatar placeholder' }, (profile.displayName || '?').slice(0, 1));
  card.append(
    el(
      'div',
      { class: 'profile-head' },
      avatar,
      el(
        'div',
        { class: 'profile-id' },
        el('strong', {}, profile.displayName || profile.username),
        // 我给 TA 起的备注名：用括号标注（分享页以 TA 自己的昵称为主）
        alias ? el('span', { class: 'muted' }, `（${alias}）`) : null,
        el('span', { class: 'muted' }, `@${profile.username}`)
      )
    )
  );
  if (profile.bio) card.append(el('p', { class: 'profile-bio' }, profile.bio));
  if (profile.stats) card.append(statsBar(profile.stats));
  return card;
}

/** 顶部筛选区：今日 / 选日期 / 全部 / 按月 */
function buildFilterBar() {
  const wrap = el('div', { class: 'share-filter' });

  const tabs = el('div', { class: 'range-tabs' });
  const defs = [
    ['today', '今天'],
    ['date', '选日期'],
    ['all', '全部'],
    ['month', '按月'],
  ];
  for (const [key, text] of defs) {
    tabs.append(
      el(
        'button',
        {
          class: `range-tab${state.range === key ? ' active' : ''}`,
          type: 'button',
          onclick: () => {
            state.range = key;
            if (key === 'date' && !state.date) state.date = todayKey();
            if (key === 'month') state.month = state.date.slice(0, 7);
            apply();
          },
        },
        text
      )
    );
  }
  wrap.append(tabs);

  // 单日模式：可翻日期
  if (state.range === 'date') {
    const datePicker = el('input', {
      type: 'date',
      class: 'date-picker',
      value: state.date,
      'aria-label': '选择日期',
    });
    datePicker.addEventListener('change', () => {
      state.date = datePicker.value || todayKey();
      state.month = state.date.slice(0, 7);
      apply();
    });
    const nav = buildDateNav({
      date: state.date,
      onDate: (d) => {
        state.date = d;
        state.month = d.slice(0, 7);
        apply();
      },
    });
    wrap.append(nav.node);
  }

  // 按月模式：整月 + 翻月
  if (state.range === 'month') {
    const prev = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '上个月' }, svgIcon('back', 18));
    const next = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '下个月' }, svgIcon('chevron', 18));
    prev.addEventListener('click', () => {
      state.month = addMonths(state.month, -1);
      apply();
    });
    next.addEventListener('click', () => {
      state.month = addMonths(state.month, 1);
      apply();
    });
    wrap.append(
      el(
        'div',
        { class: 'day-nav' },
        el('div', { class: 'day-nav-row main-row' }, prev, el('div', { class: 'day-nav-label' }, el('strong', {}, monthLabel(state.month))), next)
      )
    );
  }

  return wrap;
}

/**
 * 空状态的标题。
 * 注意：以前这里（以及页面上的「范围摘要」）会拼出「今天 · 今天」「今天 · 2026-10-09」
 * 「全部时间线」「2026 年 10 月 · 整月」这类重复文案，已经全部去掉，只保留一句人话。
 */
function emptyTitle() {
  if (!isLocked && state.range === 'all') return '还没有公开的记录';
  if (!isLocked && state.range === 'month') return `${monthLabel(state.month)}还没有记录`;
  const day = !isLocked && state.range === 'today' ? todayKey() : state.date;
  return `${dayLabel(day)}还没有记录`;
}

/** 锁定模式下的说明条：告诉访客这个链接只分享了哪一天 */
function lockedNotice() {
  const text =
    state.mode === 'locked-today'
      ? '这个链接只分享了【今天】的记录'
      : `这个链接只分享了【${state.date}】的记录`;
  return el(
    'div',
    { class: 'share-locked' },
    svgIcon('lock', 15),
    el('span', {}, text)
  );
}

async function apply() {
  const feed = document.querySelector('#share-feed');
  if (feed) {
    feed.textContent = '';
    feed.append(skeleton(2));
  }
  state.posts = [];
  state.cursor = null;
  // 只有完整分享页才重建筛选 UI；锁定分享不做切换
  if (!isLocked && filterBox) filterBox.replaceWith((filterBox = buildFilterBar()));
  try {
    await fetchPosts();
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'error';
    state.posts = [];
    // 链接失效 / 被撤销 / 过期 / 未登录看好友页：都直接给一句话说明
    if (['share_expired', 'share_revoked', 'not_found', 'login_required', 'not_friend'].includes(code)) {
      renderFatal(code);
      return;
    }
    toast(err.message || '加载失败');
  }
  paintFeed();
}

function paintFeed() {
  const feed = document.querySelector('#share-feed');
  if (!feed) return;
  feed.textContent = '';
  if (!state.posts.length) {
    feed.append(
      emptyState({
        title: emptyTitle(),
        hint: state.range === 'all' ? '稍后再来看看吧。' : '试试切换「全部」看看其他时间。',
      })
    );
    return;
  }
  renderFeed(feed, state.posts, {
    onOpenMedia: openLightbox,
    // 访客看到的所有记录都是同一个人的：用 TA 设的主题色
    meId: state.profile?.id || null,
    myCardTheme: state.profile?.cardTheme || '',
  });
  if (state.hasMore) {
    const more = el('button', { class: 'btn ghost wide', type: 'button' }, '加载更多');
    more.addEventListener('click', async () => {
      more.disabled = true;
      more.textContent = '加载中…';
      try {
        await fetchPosts({ append: true });
      } catch {
        toast('加载失败');
      }
      paintFeed();
    });
    feed.append(more);
  }
}

function renderFatal(code) {
  const expired = code === 'share_expired';
  const revoked = code === 'share_revoked';
  const notFriend = code === 'login_required' || code === 'not_friend';
  main.textContent = '';
  main.append(
    emptyState({
      title: notFriend
        ? code === 'not_friend'
          ? '只有好友才能看 TA 的时间线'
          : '请先登录再查看'
        : expired
          ? '这个分享链接已过期'
          : revoked
            ? '对方已撤销这个链接'
            : '这个分享链接无效',
      hint: notFriend ? '先登录 DayLog，并和 TA 成为好友。' : '让 TA 重新生成一条分享链接吧。',
      action: el('a', { class: 'btn primary', href: '/' }, notFriend ? '去登录' : '去 DayLog 首页'),
    })
  );
}

/** 分享链接页顶部那句「能看到什么 / 什么时候过期」 */
function linkNotice(link) {
  const scope =
    link.scope === 'day' ? `${link.day} 这一天` : link.scope === 'month' ? `${link.month} 整月` : '全部时间线';
  const left = link.expiresAt - Date.now();
  const hours = Math.floor(left / 3600000);
  const expiry = left <= 0 ? '已经过期' : hours < 1 ? `${Math.max(1, Math.round(left / 60000))} 分钟后过期` : hours < 48 ? `${hours} 小时后过期` : `${Math.round(hours / 24)} 天后过期`;
  return el(
    'div',
    { class: 'notice' },
    el('span', {}, `这是一个限时分享：${scope}`),
    el('span', { class: 'muted' }, expiry)
  );
}

async function boot() {
  if (!token && !friendName) {
    main.textContent = '';
    main.append(emptyState({ title: '链接不完整', hint: '请向朋友索要完整的分享链接。' }));
    return;
  }
  try {
    await fetchPosts();
  } catch (err) {
    renderFatal(err instanceof ApiError ? err.code : 'error');
    return;
  }

  const profile = state.profile || {};
  // 好友的时间线：服务端已经把显示名换成「我给他起的备注名」了（profile.alias 有值），
  // 直接用它，不要再加括号；分享链接页是给外人看的，仍以 TA 自己的昵称为主，
  // 只在括号里标一句我的备注名。
  const alias = profile.alias || (await myAliasFor(profile.id));
  const ownerName = profile.displayName || profile.username;
  const named = alias && alias !== ownerName ? `${ownerName}（${alias}）` : ownerName;
  document.querySelector('#top-title').textContent = `${named} 的时间线`;
  document.querySelector('#top-sub').textContent = profile.bio || '记录每一天都在做什么';
  document.title = `${named} 的 DayLog`;

  main.textContent = '';
  main.append(renderProfileCard(profile, { alias: profile.alias ? '' : alias }));

  if (isLocked) {
    // 分享链接：范围写在链接里，页面上不给筛选入口，只说明这条链接能看到什么
    if (state.page) main.append(linkNotice(state.page));
  } else {
    // 好友视图：可以自己按 今天 / 选日期 / 全部 / 按月 筛选
    filterBox = buildFilterBar();
    main.append(filterBox);
  }
  main.append(el('div', { id: 'share-feed', class: 'feed' }));
  paintFeed();
}

document.querySelector('#refresh-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.classList.contains('spin')) return;
  btn.classList.add('spin');
  try {
    await apply();
  } finally {
    btn.classList.remove('spin');
  }
});

boot();
