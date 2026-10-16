/** DayLog 前端主控：路由、视图、交互 */
import { ApiError, api, TZ, upload } from './api.js';
import {
  $$,
  addMonths,
  copyText,
  dayKeyOf,
  dayLabel,
  daysInMonth,
  el,
  firstWeekdayOfMonth,
  monthLabel,
  pad2,
  pickFiles,
  svgIcon,
  todayKey,
  toggleSwitch,
} from './util.js';
import { emptyState, renderFeed, skeleton, statsBar, updateStatsBar } from './timeline.js';
import { closeSheet, openConfirm, openLightbox, openSheet, toast } from './ui.js';
import { openComposer } from './composer.js';
import { BUILD, debugHome, debugLayout } from './debug.js';
import { CARD_THEME_PRESETS, HEX_COLOR_RE, themeFromAvatar } from './theme.js';
import { buildDateNav } from './datenav.js';
import {
  anniversariesSection,
  celebrationCard,
  friendCelebrations,
  getAnniversaryState,
  homeCelebrations,
  loadAnniversaries,
  loadFriendAnniversaries,
  resetAnniversariesCache,
  sortedAnniversaries,
} from './anniversaries.js';import {
  friendsBadgeCount,
  getFriendState,
  loadFriends,
  openFriendTimeline,
  renderFriendsView,
  resetFriendsCache,
} from './friends.js';

/** 首页三个标签（顺序 = 面板 / 滑动的顺序，必须和 tabDefs 一致） */
const SCOPE_ORDER = ['all', 'friends', 'mine'];

/**
 * 滑动轨道上的「槽位」：
 *   [前一天·全部] [全部] [好友] [我] [后一天·全部]
 * 中间三格是选中那天的三个标签；两头各挂相邻一天的「全部」。于是：
 *   · 在「全部」右滑 → 上一天的「全部」
 *   · 在「我」左滑   → 下一天的「全部」
 * 「全部时间线」模式（all=1）下没有"上一天/下一天"，这时两头不启用，保持原来的橡皮筋手感。
 * 注意：轨道平移量必须按 SLOT_ORDER 的下标算（中间「全部」在下标 1，不是 0）。
 */
const SLOT_ORDER = ['prev', 'all', 'friends', 'mine', 'next'];
const DAY_SLOT_DELTA = { prev: -1, next: 1 };

/** 一个标签页自己的数据状态（切标签不重建视图，所以每页都得有独立缓存） */
function emptyPaneState() {
  return {
    posts: [],
    loading: false,
    loaded: false,
    hasMore: false,
    cursor: null,
    stale: false,
    loadToken: 0,
    loadedAt: 0,
    // 上次拉取用的参数（日期/范围/筛选），用来判断"缓存还能不能用"
    key: '',
  };
}

/**
 * 首页 = 一个可左右滑动的三页容器（全部 / 好友 / 我）。
 *
 * 为什么要有 panes：以前切标签走的是 `location.hash` → hashchange → `render()`，
 * 会把整个 #main 清空重建，于是「切一下标签要闪一下、骨架屏还会闪出来」。
 * 现在三页 DOM 一直存在，切标签只是横向平移 + 用各自缓存即时重绘；
 * state.home 依然是"当前这一页"的镜像，老代码（编辑/删除/调试入口）都还能直接用。
 */
const state = {
  user: null,
  allowSignup: true,
  // stale: 数据可能过期（切回首页/切回前台/增删改后置为 true，加载完成清零）
  // loadToken: 请求序号，用于丢弃过期响应
  home: {
    date: todayKey(),
    posts: [],
    loading: false,
    hasMore: false,
    cursor: null,
    all: false,
    scope: 'all',
    friendFilter: null,
    counts: {},
    stale: false,
    loadToken: 0,
    loadedAt: 0,
    friendCount: 0,
  },
  panes: {
    prev: emptyPaneState(),
    all: emptyPaneState(),
    friends: emptyPaneState(),
    mine: emptyPaneState(),
    next: emptyPaneState(),
  },
  calendar: { month: todayKey().slice(0, 7), days: [], marks: {}, anniversaries: [], loading: false },
  search: { q: '', tag: '', posts: [], loading: false, ran: false },
  view: 'home',
};

/** 首页滑动容器的 DOM 引用（每次进入首页视图时重建） */
let pager = null;
/** 首页那根日期条（按天滑动切换时要把它同步过去，但不重建视图） */
let homeDateNav = null;
/** 滑动动画序号：动画结束后才把"离开的那一格"收起来 */
let slideToken = 0;

// ---------------------------------------------------------------- 路由

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const segs = path.split('/').filter(Boolean);
  return { segs, params: new URLSearchParams(query || '') };
}

function render() {
  const { segs, params } = parseRoute();
  const root = segs[0] || (state.user ? 'home' : 'login');
  state.view = root;
  const main = document.querySelector('#main');
  main.textContent = '';
  document.querySelector('#bottom-nav').classList.toggle('hidden', !state.user || root === 'login');
  document.querySelector('#compose-btn').classList.toggle('hidden', !state.user);
  document.querySelector('#share-btn').classList.toggle('hidden', !state.user);
  document.querySelector('#refresh-btn').classList.toggle('hidden', !state.user);

  const views = {
    login: viewLogin,
    home: viewHome,
    calendar: viewCalendar,
    friends: viewFriends,
    search: viewSearch,
    settings: viewSettings,
    me: viewSettings,
  };
  (views[root] || viewHome)(main, params);
  $$('#bottom-nav .nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === root));
  updateHeader();
}

/** 好友页 */
function viewFriends(main) {
  if (!state.user) {
    location.replace('#/login');
    return;
  }
  // 注意：这里**不能**在 loadFriends() 之后再调用 render()——
  // render() 会重新进入 viewFriends()，从而再次 loadFriends()，形成无限循环，
  // 表现为主线程被刷爆：底部导航点不动、输入框无法输入。
  // 好友页的刷新由 friends.js 内部的局部重绘负责。
  renderFriendsView(main, {
    onChanged: () => {
      updateFriendsBadge();
      // 好友变化会影响「好友 / 全部」两页的时间线：标记过期，下次进入或滑动到时重新拉
      state.panes.friends.stale = true;
      state.panes.all.stale = true;
      state.home = { ...state.home, friendCount: getFriendState().counts.friends || 0 };
      updateFriendCountText();
    },
    onOpen: (entry) => openFriendTimeline(entry, { onOpenMedia: openLightbox }),
  });
  loadFriends({ silent: true }).then(updateFriendsBadge);
}

/**
 * 好友筛选条：横向滚动的头像 + @用户名（只在「好友」标签下出现）。
 * 第一项是「全部好友」，用**自己头像的高斯模糊版**当图标（表示"所有人"）。
 * 点某个人 -> 只看他的记录；再点一次取消筛选。
 */
function buildFriendStrip({ scope, date, all, activeId, onPick }) {
  if (!state.user) return null;
  const friends = getFriendState().friends || [];
  if (!friends.length) return null;
  const counts = state.home.counts || {};

  const strip = el('div', { class: 'friend-strip' });

  // 「全部好友」：自己头像的高斯模糊版
  const meName = state.user.displayName || state.user.username || '?';
  const meAvatar = state.user.avatarUrl
    ? el('img', { class: 'blur', src: state.user.avatarUrl, alt: '', loading: 'lazy' })
    : el('span', { class: 'ini blur' }, meName.slice(0, 1));
  strip.append(
    el(
      'button',
      {
        class: `friend-chip me${!activeId ? ' active' : ''}`,
        type: 'button',
        'aria-label': '全部好友',
        onclick: () => onPick(null),
      },
      el('span', { class: 'chip-avatar all-avatar' }, meAvatar),
      el('span', { class: 'chip-name' }, '全部好友')
    )
  );

  for (const entry of friends) {
    const u = entry.user;
    const count = counts[u.id] || 0;
    const chip = el(
      'button',
      {
        class: `friend-chip${activeId === u.id ? ' active' : ''}`,
        type: 'button',
        title: `${entry.displayName}（${count ? `${count} 条` : '这天没有记录'}）`,
        onclick: () => onPick(u.id),
      },
      // 头像 + 右下角的条数角标：角标必须放在一个**自己的**定位容器里。
      // 以前它是 .friend-chip 的直接子元素，而 .friend-chip 没有 position，
      // 于是角标会挂到最近的定位祖先上（滑动容器 .scope-track 因为 will-change: transform
      // 也是定位祖先）—— 表现就是页面右下角/卡片角上冒出一个蓝色小圆点。
      el(
        'span',
        { class: 'chip-avatar-wrap' },
        el(
          'span',
          { class: `chip-avatar${count ? ' has-post' : ''}` },
          u.avatarUrl
            ? el('img', { src: u.avatarUrl, alt: '', loading: 'lazy' })
            : el('span', { class: 'ini' }, (u.displayName || u.username || '?').slice(0, 1))
        ),
        count ? el('span', { class: 'chip-count' }, String(count)) : null
      ),
      el('span', { class: 'chip-name' }, `@${u.username}`)
    );
    strip.append(chip);
  }

  const wrap = el('div', { class: 'friend-strip-wrap' }, strip);
  wrap.dataset.scope = scope;
  wrap.dataset.date = date;
  wrap.dataset.all = all ? '1' : '0';
  return wrap;
}

/** 底部导航上的待处理好友请求红点 */
function updateFriendsBadge() {
  const badge = document.querySelector('#friends-badge');
  if (!badge) return;
  const count = friendsBadgeCount();
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.classList.toggle('hidden', count === 0);
}

/**
 * 只更新「好友」tab 上的数量文字（避免为了这个数字整体重绘）。
 * 注意：节点必须"始终存在"（首次渲染时好友数还没到，值为 0 也要建出来），
 * 否则这里找不到节点就什么都不做 —— 表现为"刷新后好友数消失、点一下才出现"。
 */
function updateFriendCountText() {
  const count = state.home.friendCount || 0;
  let node = document.querySelector('[data-friend-count]');
  if (!node) {
    // 兜底：节点缺失时补建（例如渲染时好友数还是 0）
    const tab = [...document.querySelectorAll('.scope-tab')].find((b) => /好友/.test(b.textContent));
    if (!tab) return;
    node = el('span', { class: 'count', 'data-friend-count': 'friends' });
    tab.append(node);
  }
  node.textContent = count ? String(count) : '';
  node.classList.toggle('hidden', !count);
}

function updateHeader() {
  const title = document.querySelector('#top-title');
  const sub = document.querySelector('#top-sub');
  if (!state.user) {
    title.textContent = 'DayLog';
    sub.textContent = '记录并分享你的每一天';
    return;
  }
  if (state.view === 'home') {
    title.textContent = '我的时间线';
    sub.textContent = `${state.user.displayName || state.user.username} · 共 ${state.user.stats?.posts ?? 0} 条`;
  } else if (state.view === 'calendar') {
    title.textContent = '记录日历';
    sub.textContent = monthLabel(state.calendar.month);
  } else if (state.view === 'friends') {
    title.textContent = '好友';
    const counts = getFriendState().counts || {};
    sub.textContent = counts.incoming
      ? `${counts.friends || 0} 位好友 · ${counts.incoming} 个待确认`
      : `${counts.friends || 0} 位好友`;
  } else if (state.view === 'search') {
    title.textContent = '搜索';
    sub.textContent = '按文字 / 地点 / 标签查找';
  } else {
    title.textContent = '设置';
    sub.textContent = `@${state.user.username}`;
  }
}

async function refreshCurrent() {
  if (!state.user) return;
  if (state.view === 'search') return runSearch();
  if (state.view === 'calendar') return loadCalendar(state.calendar.month);
  return loadHome({ date: state.home.date, all: state.home.all, scope: state.home.scope });
}

/**
 * 清空所有「属于某个用户」的内存缓存。
 * 登录/退出/切换账号时必须调用，否则会把上一个用户的数据渲染给新用户。
 */
function resetSessionCaches({ keepDate = false } = {}) {
  state.home = {
    date: keepDate ? state.home.date : todayKey(),
    posts: [],
    loading: false,
    hasMore: false,
    cursor: null,
    all: false,
    scope: 'all',
    friendFilter: null,
    counts: {},
    stale: false,
    loadToken: (state.home.loadToken || 0) + 1, // 让在途请求全部作废
    loadedAt: 0,
    friendCount: 0,
  };
  state.panes = {
    prev: emptyPaneState(),
    all: emptyPaneState(),
    friends: emptyPaneState(),
    mine: emptyPaneState(),
    next: emptyPaneState(),
  };
  pager = null;
  state.search = { q: '', tag: '', posts: [], loading: false, ran: false };
  state.calendar = { month: todayKey().slice(0, 7), days: [], marks: {}, anniversaries: [], loading: false };
  resetFriendsCache();
  resetAnniversariesCache();
}

/** 拉取自己的统计（记录数/天数/媒体数），供设置页与首页副标题使用 */
async function loadMyStats({ silent = true } = {}) {
  if (!state.user) return null;
  try {
    const res = await api.stats();
    state.user = { ...state.user, stats: res.stats };
    updateStatsBar(document, res.stats);
    updateHeader();
    return res.stats;
  } catch (err) {
    if (!silent) toast(err.message || '统计加载失败');
    return null;
  }
}

/** 登录成功 / 已有会话进入首页后：一次性把所有数据拉全，避免"还要手动刷新一次" */
async function refreshEverything() {
  if (!state.user) return;

  // 关键顺序：首页渲染依赖的数据（好友 / 纪念日）必须先到位，
  // 否则 loadHome() 内部那次 paintHome() 会画出没有头像条、没有倒计时的首页。
  await ensureHomeContext();

  await Promise.allSettled([
    loadHome({ date: state.home.date, all: state.home.all, scope: state.home.scope }),
    loadCalendar(state.calendar.month),
    loadMyStats(),
  ]);
  updateFriendsBadge();
  state.home = { ...state.home, friendCount: getFriendState().counts.friends || 0 };
  if (state.view === 'home') paintHome();
  updateFriendCountText();
  updateHeader();
}

/**
 * 首页渲染所依赖的「上下文数据」。
 *
 * paintHome() 会用到好友列表（头像条）和纪念日（倒计时卡片），
 * 但这两个是模块级内存状态、刷新后为空。如果它们在 loadHome() 之后才到，
 * 首页就已经画完了、之后又没人重绘 —— 表现就是"刷新后头像条/倒计时不见了，
 * 切一下标签才出来"。
 *
 * 所以：**任何会触发首页渲染的入口，都必须先 await 这个函数。**
 */
async function ensureHomeContext() {
  if (!state.user) return;
  const jobs = [];
  if (!getFriendState().loaded && !getFriendState().loading) jobs.push(loadFriends({ silent: true }));
  if (!getAnniversaryState().loaded && !getAnniversaryState().loading) jobs.push(loadAnniversaries());
  if (jobs.length) await Promise.allSettled(jobs);
}

// ---------------------------------------------------------------- 启动

async function bootstrap() {
  bindChrome();
  try {
    const res = await api.me();
    state.user = res.user;
    state.allowSignup = res.allowSignup;
  } catch {
    state.user = null;
  }
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    history.replaceState(null, '', state.user ? '#/home' : '#/login');
  }
  render();
  if (state.user) {
    if (state.view === 'home') {
      // refreshEverything 内部会先等好友到位再重绘首页（头像条依赖好友列表），
      // 所以这里不用再重复 render。
      refreshEverything();
    } else {
      // 不是首页：先把好友拉好，再按当前视图重绘一次（日历/好友页都用得到）
      loadFriends({ silent: true }).then(() => {
        updateFriendsBadge();
        state.home = { ...state.home, friendCount: getFriendState().counts.friends || 0 };
        updateFriendCountText();
        updateHeader();
        if (state.view === 'calendar') paintCalendar();
      });
      loadCalendar(state.calendar.month);
    }
  }
  registerServiceWorker();
}

function bindChrome() {
  window.addEventListener('hashchange', () => {
    const { segs, params } = parseRoute();
    if (!segs.length || segs[0] === 'home') {
      const date = params.get('date') || todayKey();
      const all = params.get('all') === '1';
      const scope = ['mine', 'friends', 'all'].includes(params.get('scope')) ? params.get('scope') : 'all';
      const friendFilter = params.get('friend') || null;
      const changed =
        date !== state.home.date ||
        all !== state.home.all ||
        scope !== state.home.scope ||
        friendFilter !== (state.home.friendFilter || null);
      // 参数变了要重载；参数没变但数据可能过期（stale）也要重载。
      // 注意排除"正在加载"的情况，避免形成 渲染→加载→渲染 的循环。
      if (state.user && (changed || state.home.stale) && !state.home.loading) {
        state.home = {
          ...state.home,
          date,
          all,
          scope,
          friendFilter,
          posts: [],
          cursor: null,
          hasMore: false,
          stale: false,
        };
        // 换了日期 / 范围：所有格子缓存都得重来
        for (const s of SLOT_ORDER) state.panes[s].stale = true;
        loadHome({ date, all, scope, friendFilter });
      }
    }
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  });

  document.querySelector('#compose-btn').addEventListener('click', () => createPost());
  document.querySelector('#share-btn').addEventListener('click', () => openShareSheet());
  document.querySelector('#refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('spin')) return; // 防止连点叠加
    btn.classList.add('spin');
    try {
      // 刷新 = 全量重来一遍（时间线 / 好友 / 日历 / 统计），失败也要恢复按钮
      await refreshEverything();
    } catch (err) {
      toast(err?.message || '刷新失败');
    } finally {
      btn.classList.remove('spin');
    }
  });
  $$('#bottom-nav .nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      const target = item.dataset.view;
      if (!state.user && target !== 'login') {
        e.preventDefault();
        toast('请先登录');
        location.hash = '#/login';
        return;
      }
      if (target === 'home') {
        e.preventDefault();
        // 回到首页：切到今天、保留当前范围，并标记数据过期强制重载，
        // 这样"发布后去别的页面再回来"也能立刻看到新记录。
        state.home = {
          ...state.home,
          date: todayKey(),
          all: false,
          posts: [],
          cursor: null,
          hasMore: false,
          stale: true,
        };
        markHomeStale();
        if (location.hash === '#/home' || location.hash === '') {
          loadHome({ date: state.home.date, all: false, scope: state.home.scope });
        } else {
          location.hash = '#/home';
        }
        render();
        window.scrollTo({ top: 0 });
      }
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) {
      // 切回前台：数据可能已过期，标记后按需重载
      markHomeStale();
      if (state.view === 'home') refreshCurrent();
    }
  });
  window.addEventListener('online', () => {
    toast('已恢复网络连接');
    markHomeStale();
    if (state.view === 'home') refreshCurrent();
  });
  window.addEventListener('offline', () => toast('网络已断开，仍可浏览已加载内容'));
}

/** 所有格子的缓存都标记为过期（切回前台 / 联网恢复 / 数据被别处改动时用） */
function markHomeStale() {
  state.home = { ...state.home, stale: true };
  for (const slot of SLOT_ORDER) {
    const pane = state.panes[slot];
    if (pane) pane.stale = true;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const https = location.protocol === 'https:';
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!https && !local) return; // 局域网 http 下浏览器不允许注册 SW
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------------------------------------------------------------- 登录 / 注册

function viewLogin(main, params) {
  let signup = params.get('mode') === 'signup' || !state.allowSignup ? params.get('mode') === 'signup' : false;
  if (params.get('mode') === 'signup') signup = true;
  const errorBox = el('div', { class: 'form-error' });
  errorBox.hidden = true;
  const username = el('input', {
    class: 'input',
    placeholder: '用户名（3-24 位小写字母/数字）',
    autocomplete: 'username',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
  });
  const password = el('input', {
    class: 'input',
    type: 'password',
    placeholder: '密码（至少 6 位）',
    autocomplete: 'current-password',
  });
  const displayName = el('input', {
    class: 'input',
    placeholder: '昵称（可选，会显示在分享页）',
    autocomplete: 'nickname',
  });
  const submit = el('button', { class: 'btn primary wide', type: 'submit' }, '登录');
  const form = el('form', { class: 'auth-form' }, username, password, displayName, errorBox, submit);
  const switchBtn = el('button', { class: 'link-btn', type: 'button' }, '');

  function syncMode() {
    displayName.hidden = !signup;
    submit.textContent = signup ? '创建账号' : '登录';
    password.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    errorBox.hidden = true;
    switchBtn.textContent = signup ? '已有账号？去登录' : '还没有账号？注册一个';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    submit.classList.add('loading');
    try {
      const payload = { username: username.value.trim(), password: password.value, timezone: TZ() };
      if (signup) payload.displayName = displayName.value.trim();
      const res = signup ? await api.signup(payload) : await api.login(payload);
      state.user = res.user;
      // 换了账号：先清空上一个用户的内存缓存，再全量刷新
      resetSessionCaches();
      toast(signup ? '欢迎加入 DayLog 🎉' : `欢迎回来，${res.user.displayName}`);
      if (location.hash === '#/home') {
        render();
        await refreshEverything();
      } else {
        location.hash = '#/home';
      }
    } catch (err) {
      errorBox.textContent = err.message || '操作失败';
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.classList.remove('loading');
    }
  });

  switchBtn.addEventListener('click', () => {
    signup = !signup;
    syncMode();
  });

  main.append(
    el(
      'div',
      { class: 'auth' },
      el(
        'div',
        { class: 'auth-hero' },
        el('div', { class: 'logo' }, svgIcon('clock', 34)),
        el('h1', {}, 'DayLog'),
        el('p', {}, '把「今天在做什么」记下来，用一条链接分享给家人和朋友。')
      ),
      form,
      switchBtn,
      el('p', { class: 'auth-tip' }, '支持文字、图片、视频；手机上可以直接拍照上传。')
    )
  );
  syncMode();
}

// ---------------------------------------------------------------- 首页

/** 某一页当前的缓存是否还能用（日期 / 单日-全部 / 好友筛选都得对上） */
function paneKeyOf(scope, date, all, friendFilter) {
  return `${scope}|${date}|${all ? 'all' : 'day'}|${scope === 'friends' ? friendFilter || '' : ''}`;
}

/** 日期加减一天（day key 是本地时区的 YYYY-MM-DD） */
function shiftDayKey(key, delta) {
  const [y, m, d] = String(key || todayKey()).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + delta);
  return dayKeyOf(dt.getTime());
}

/** 这个槽位现在能不能滑到（「全部时间线」模式下两头的按天槽位不启用） */
function slotEnabled(slot) {
  return !DAY_SLOT_DELTA[slot] || !state.home.all;
}

/** 槽位此刻应该显示什么：中间三格是当天的标签，两头是相邻一天的「全部」 */
function slotPlan(slot) {
  const delta = DAY_SLOT_DELTA[slot];
  if (delta) return { slot, apiScope: 'all', date: shiftDayKey(state.home.date, delta), all: false, day: true };
  return { slot, apiScope: slot, date: state.home.date, all: state.home.all, day: false };
}

function activeSlot() {
  return state.home.scope;
}

/** 槽位对应的缓存键（按槽位自己的日期/范围算，不能借用 state.home） */
function paneKeyFor(slot) {
  const plan = pager?.panes?.[slot]?.plan || slotPlan(slot);
  const friendFilter = plan.apiScope === 'friends' ? state.home.friendFilter || null : null;
  return paneKeyOf(plan.apiScope, plan.date, plan.all, friendFilter);
}

/** 把每个槽位的"这一格显示哪一天/哪个标签"重新对到当前状态上 */
function syncPanePlans() {
  for (const slot of SLOT_ORDER) {
    const pane = pager?.panes?.[slot];
    if (pane) pane.plan = slotPlan(slot);
  }
}

/** 某一格各自拉数据；只重画自己那一格，不碰其它格 */
async function loadPane(
  slot,
  { date, all, friendFilter = state.home.friendFilter || null, silent = false } = {}
) {
  if (!state.user) return;
  const pane = state.panes[slot];
  const view = pager?.panes?.[slot];
  if (!pane || !view) return;
  const plan = view.plan || slotPlan(slot);
  const apiScope = plan.apiScope;
  // 两头的按天槽位永远用"自己那一天"，不吃外面传进来的 date/all（那是中间三格的）
  const useDate = plan.day ? plan.date : date ?? plan.date;
  const useAll = plan.day ? false : all ?? plan.all;
  const useFriend = apiScope === 'friends' ? friendFilter : null;
  const isActive = activeSlot() === slot;
  // 「当天这一格」才允许更新头部计数：两头按天格子的响应不能覆盖"今天有多少条"
  const isCurrentDay = !plan.day && useDate === state.home.date && useAll === state.home.all;
  const token = (pane.loadToken += 1);
  const firstLoad = !pane.loaded;

  pane.loading = true;
  if (isActive) state.home = { ...state.home, loading: true };
  // 骨架屏只在「这一格正被看着、而且还没数据」时出现，
  // 否则后台预热 / 切标签时会闪一下（这正是要避免的"闪烁"）
  if (isActive && firstLoad) paintHome();

  try {
    const res = await api.listPosts({
      limit: 50,
      scope: apiScope,
      friendId: useFriend || undefined,
      ...(useAll ? {} : { from: useDate, to: useDate }),
    });
    // 丢弃过期响应：避免"在途请求"回来后覆盖更新的数据
    if (pane.loadToken !== token) return;
    pane.posts = res.posts || [];
    pane.hasMore = !!res.hasMore;
    pane.cursor = res.nextCursor ?? null;
    pane.loaded = true;
    pane.stale = false;
    pane.loading = false;
    pane.loadedAt = Date.now();
    pane.key = paneKeyOf(apiScope, useDate, useAll, useFriend);
    if (isCurrentDay) {
      state.home = { ...state.home, counts: res.counts || {}, friendCount: res.friendCount ?? state.home.friendCount };
    }
    if (isActive) {
      state.home = {
        ...state.home,
        posts: pane.posts,
        hasMore: pane.hasMore,
        cursor: pane.cursor,
        loading: false,
        loadedAt: pane.loadedAt,
      };
    }
    paintPane(slot);
    paintFriendStrip();
    if (isActive) {
      updateFriendCountText();
      updateHeader();
    }
  } catch (err) {
    if (pane.loadToken !== token) return;
    pane.loading = false;
    if (isActive) state.home = { ...state.home, loading: false };
    if (err instanceof ApiError && err.status === 401) {
      state.user = null;
      location.hash = '#/login';
      render();
      return;
    }
    if (!silent) toast(err.message || '加载失败');
    paintPane(slot);
  }
}

/**
 * 预热其它格子：滑过去的时候内容已经在了，不会看到骨架屏。
 * 两头的按天格子只传 silent（它们自己按 plan 里的日期拉），中间三格才吃传进来的 date/all。
 */
function warmPanes({ date = state.home.date, all = state.home.all } = {}, except = null) {
  if (!state.user) return;
  const friendFilter = state.home.friendFilter || null;
  (async () => {
    for (const slot of SLOT_ORDER) {
      if (slot === except) continue;
      if (!slotEnabled(slot)) continue;
      const pane = state.panes[slot];
      if (!pane || pane.loading) continue;
      if (pane.loaded && !pane.stale && pane.key === paneKeyFor(slot)) continue;
      const opts = DAY_SLOT_DELTA[slot] ? { silent: true } : { date, all, friendFilter, silent: true };
      await loadPane(slot, opts);
    }
  })().catch(() => {});
}

/** 这一格的数据是否可用；不可用就（后台）拉一次 */
function ensurePaneData(slot, { force = false } = {}) {
  const pane = state.panes[slot];
  if (!pane) return Promise.resolve();
  if (!force && pane.loaded && !pane.stale && pane.key === paneKeyFor(slot)) return Promise.resolve();
  return loadPane(slot, { silent: true });
}

async function loadHome({
  date = state.home.date,
  all = state.home.all,
  scope = state.home.scope,
  friendFilter = state.home.friendFilter || null,
  warm = true,
} = {}) {
  if (!state.user) return;
  state.home = { ...state.home, date, all, scope, friendFilter, stale: false };
  syncPanePlans();
  // 换了日期 / 范围：所有格子的缓存都失效（含两头的按天格子，它们的日期也跟着变）
  if (state.home.panesDate !== `${date}|${all}`) {
    state.home = { ...state.home, panesDate: `${date}|${all}` };
    for (const s of SLOT_ORDER) state.panes[s].stale = true;
  }
  applyScopeChrome();
  await loadPane(scope, { date, all, friendFilter });
  if (warm) warmPanes({ date, all }, scope);
}

/**
 * 渲染守卫：单个渲染函数出错时不要让整页空白。
 * （曾经因为残留调用已删除的 nextAnniversary() 抛 ReferenceError，
 *   导致 renderFeed 永远执行不到、首页一条记录都不显示。）
 */
function safePaint(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[daylog] ${name} 渲染失败：`, err);
    const host = document.querySelector('#home-list') || document.querySelector('#calendar-body');
    if (host && !host.childElementCount) {
      host.append(
        emptyState({
          title: '页面渲染出错了',
          hint: String(err?.message || err),
          action: el('button', { class: 'btn ghost', type: 'button', onclick: () => location.reload() }, '重新加载'),
        })
      );
    }
    // 必须提示出来：只写 console 的话，用户看到的就是"莫名其妙空白"（踩过这个坑）
    toast(`渲染出错：${String(err?.message || err).slice(0, 40)}`);
  }
}

/**
 * 倒计时独立渲染到 #home-top。
 * 它和「有没有记录」「加载中」都无关：只要有生日/特别关注纪念日就该显示。
 */
/**
 * 某一页顶部的倒计时区。
 * 它和「有没有记录」「加载中」都无关：只要有生日/特别关注纪念日就该显示。
 */
function paintPaneTop(scope) {
  const pane = pager?.panes?.[scope];
  if (!pane) return;
  const top = pane.top;
  top.textContent = '';
  const friendFilter = scope === 'friends' ? state.home.friendFilter : null;
  // 「好友」标签下筛了某个人：显示我这边关联了 TA 的纪念日
  if (scope === 'friends' && friendFilter) {
    const items = friendCelebrations(friendFilter);
    top.classList.toggle('empty', items.length === 0);
    for (const item of items) {
      top.append(celebrationCard(item, { onClick: () => (location.hash = '#/settings') }));
    }
    return;
  }
  if (scope !== 'mine') {
    top.classList.add('empty'); // 其余情况只在「我」标签下显示
    return;
  }
  const items = homeCelebrations();
  top.classList.toggle('empty', items.length === 0);
  for (const item of items) {
    top.append(celebrationCard(item, { onClick: () => (location.hash = '#/settings') }));
  }
}

/** 当前这一页的倒计时区（保留老函数名：老代码与回归测试都按它来） */
function paintHomeTop() {
  paintPaneTop(state.home.scope);
}

/** 好友筛选条挂在「好友」那一页里，跟着页面一起滑动 */
function paintFriendStrip() {
  const pane = pager?.panes?.friends;
  if (!pane) return;
  const next =
    state.view === 'home'
      ? buildFriendStrip({
          scope: 'friends',
          date: state.home.date,
          all: state.home.all,
          activeId: state.home.friendFilter || null,
          onPick: (id) => pickFriend(id),
        })
      : null;
  if (pane.strip) {
    if (next) pane.strip.replaceWith(next);
    else pane.strip.remove();
  } else if (next) {
    pane.el.prepend(next);
  }
  pane.strip = next || null;
}

/**
 * 加载「我」这边关联了某个好友的纪念日，并在数据到达后补画倒计时。
 * 首页「好友」标签筛选某人时用。
 */
async function ensureFriendCelebrations(friendId) {
  if (!friendId) return;
  await loadFriendAnniversaries(friendId);
  if (state.view === 'home' && state.home.scope === 'friends' && state.home.friendFilter === friendId) {
    paintPaneTop('friends');
  }
}

function paintHome() {
  safePaint('paintHome', () => {
    paintHomeTop();
    paintHomeInner();
    paintFriendStrip();
    syncPagerHeight();
  });
}

/** 重画某一页（顶部 + 列表） */
function paintPane(scope) {
  paintPaneTop(scope);
  paintPaneList(scope);
  if (scope === state.home.scope) syncPagerHeight();
}

/** 切换某一页的数据列表（不动其它页面，也不重建视图） */
function paintPaneList(scope) {
  const pane = pager?.panes?.[scope];
  if (!pane) return;
  const host = pane.list;
  const data = state.panes[scope];
  // 每一格按自己的计划渲染：中间三格是当天，两头是相邻一天的「全部」
  const plan = pane.plan || slotPlan(scope);
  const apiScope = plan.apiScope;
  const date = plan.date;
  const all = plan.all;
  const filter = apiScope === 'friends' ? state.home.friendFilter || null : null;
  // 数据必须"是这一组参数拉回来的"才能用：否则换个日期就会画出上一天的记录
  const fresh = data.loaded && data.key === paneKeyOf(apiScope, date, all, filter);

  // 没数据 / 数据过期 / 正在首次加载：只画骨架屏，绝不用过期数据去画。
  // （曾经因为 loadHome 的 await 期间 state.home.scope 还是旧值，
  //   此时被 ensureHomeContext 触发重绘，倒计时就被判掉了 —— 时有时无的根源。）
  if (!fresh) {
    if (data.loading && host.querySelector('.skeleton')) return; // 已经是骨架屏，不用重画
    host.textContent = '';
    host.append(skeleton(3));
    return;
  }

  host.textContent = '';
  const posts = data.posts || [];

  if (!posts.length) {
    host.append(
      emptyState({
        title:
          apiScope === 'friends'
            ? state.home.friendFilter
              ? 'TA 最近还没有动态'
              : '好友最近还没有动态'
            : all
              ? '还没有任何记录'
              : `${dayLabel(date)}还没有记录`,
        hint:
          apiScope === 'mine'
            ? '点右下角的 + 记录此刻在做什么，可以带上图片和视频。'
            : '在「好友」页添加好友后，这里就会显示对方的动态。',
        action:
          apiScope === 'friends'
            ? el('button', { class: 'btn primary', type: 'button', onclick: () => (location.hash = '#/friends') }, '去添加好友')
            : el('button', { class: 'btn primary', type: 'button', onclick: () => createPost() }, '写一条'),
      })
    );
    return;
  }
  const opts = {
    onOpenMedia: openLightbox,
    canEdit: true,
    meId: state.user?.id,
    myCardTheme: state.user?.cardTheme || '',
    onEdit: (post) => editPost(post),
    onDelete: (post) =>
      deletePost(post, () => {
        // 删除同样会影响所有格子（当前格 + 其余格的缓存）
        markHomeStale();
        loadHome({ date: state.home.date, all: state.home.all, scope: state.home.scope });
      }),
  };
  renderFeed(host, posts, opts);
  // 首页不再显示那行范围摘要（「今天 · N 条 / 其中好友 N 条 / 含 N 个图片视频」）：
  // 下面的日期分组头（day-header）里已经有「今天 N 条」，再写一遍是重复信息。
  // 这一格正被看着时，把激活页的镜像同步过去（编辑 / 删除 / 调试入口在用它）。
  // 注意必须按**槽位**比，不能按 apiScope：两头按天格子的 apiScope 也是 'all'。
  if (activeSlot() === scope) {
    state.home = { ...state.home, posts, hasMore: data.hasMore, cursor: data.cursor };
  }
}

/** 当前这一页的列表（保留老函数名） */
function paintHomeInner() {
  paintPaneList(state.home.scope);
}

/** 把「当前格」的 ids / tab 高亮 / 标题栏同步好 */
function applyScopeChrome() {
  if (!pager) return;
  for (const slot of SLOT_ORDER) {
    const pane = pager.panes[slot];
    if (!pane) continue;
    const on = slot === activeSlot();
    // id 始终挂在当前格上：老代码和调试入口都在用 document.querySelector('#home-list')
    if (on) {
      pane.top.setAttribute('id', 'home-top');
      pane.list.setAttribute('id', 'home-list');
    } else {
      pane.top.removeAttribute('id');
      pane.list.removeAttribute('id');
    }
  }
  highlightTab(state.home.scope);
}

function highlightTab(scope) {
  $$('#main .scope-tab').forEach((btn) => {
    const on = btn.dataset.scope === scope;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/** 让某一格参与布局 / 退出布局（.idle 用 height:0 收起，但保留横向槽位） */
function setPaneIdle(slot, idle) {
  const pane = pager?.panes?.[slot];
  if (!pane) return;
  pane.el.classList.toggle('idle', idle);
  // 收起的那一格不该被读屏念出来
  if (idle) pane.el.setAttribute('aria-hidden', 'true');
  else pane.el.removeAttribute('aria-hidden');
}

/** 除当前页外，其余页都收起来（不接收点击；高度由 pager 统一控制） */
function collapseIdlePanes(active) {
  for (const slot of SLOT_ORDER) setPaneIdle(slot, slot !== active);
}

/**
 * 让容器高度跟着当前格走。
 * 各格内容高度不一样（「全部」通常最高），如果让轨道自己撑高，矮的那格下面会空一大段；
 * 所以由 pager 定高 + overflow 裁剪，并在切换时把高度也做成过渡。
 */
function syncPagerHeight() {
  if (!pager) return;
  const pane = pager.panes[activeSlot()];
  const h = pane ? pane.el.offsetHeight : 0;
  if (h && Math.abs((parseFloat(pager.root.style.height) || 0) - h) > 1) {
    pager.root.style.height = `${h}px`;
  }
}

/** 当前格在轨道上的下标（按 SLOT_ORDER 算：中间「全部」是 1） */
function currentSlotIndex() {
  // 动画途中以「视觉上停在哪一格」为准：否则收尾动画没走完就再滑一下会跳一格
  if (pager && Number.isInteger(pager.visualSlot)) return pager.visualSlot;
  const i = SLOT_ORDER.indexOf(activeSlot());
  return i < 0 ? SLOT_ORDER.indexOf('all') : i;
}

/** 一格的宽度（= 卡片宽度，不含留给阴影的内边距）与翻页步长（格宽 + 格间空隙） */
function pagerMetrics() {
  const pane = pager?.panes?.all || pager?.panes?.[SLOT_ORDER[0]];
  // 用「一格的实际宽度」而不是 pager.clientWidth：后者含左右 padding（那是留给卡片阴影的）
  const width = pane?.el?.offsetWidth || pager?.root?.clientWidth || 1;
  const gap = pager ? parseFloat(getComputedStyle(pager.track).columnGap) || 0 : 0;
  return { width, step: width + gap };
}

function pagerWidth() {
  return pagerMetrics().width;
}

function pagerStep() {
  return pagerMetrics().step;
}

function setTrack(px, { animate = false, ms = 300 } = {}) {
  if (!pager) return;
  pager.track.style.transition = animate ? `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)` : 'none';
  pager.track.style.transform = `translate3d(${Math.round(px * 100) / 100}px, 0, 0)`;
}

/** 收尾动画时长：切标签与按天滑动共用，两边手感必须一致 */
const SETTLE_MS = 300;

/**
 * 把轨道对齐到某一格，同时记住「视觉上停在哪一格」。
 * 记这个是为了动画期间用户又滑一下时不跳：新的手势要从眼前这一格算起，而不是从 state 里的标签算起。
 */
function alignTrack(slot, { animate = false, ms = SETTLE_MS } = {}) {
  if (!pager) return;
  const index = SLOT_ORDER.indexOf(slot);
  pager.visualSlot = index < 0 ? SLOT_ORDER.indexOf('all') : index;
  setTrack(-pager.visualSlot * pagerStep(), { animate, ms });
}

/**
 * 切到某一页：先让目标页参与布局，再平移过去。
 * 数据用缓存立即重绘，所以滑动过程中看到的是真实内容，不会有骨架屏闪出来。
 */
function slideToScope(scope, { animate = true, updateUrl = true } = {}) {
  if (!SCOPE_ORDER.includes(scope) || !pager) return;
  const prev = state.home.scope;
  if (prev === scope) {
    alignTrack(scope, { animate: false });
    collapseIdlePanes(scope);
    return;
  }
  setPaneIdle(scope, false);
  state.home = { ...state.home, scope };
  applyScopeChrome();
  const pane = state.panes[scope];
  state.home = { ...state.home, posts: pane.posts, hasMore: pane.hasMore, cursor: pane.cursor, loading: pane.loading };
  paintPane(scope);
  alignTrack(scope, { animate });
  const token = (slideToken += 1);
  if (animate) {
    setTimeout(() => {
      if (token === slideToken) collapseIdlePanes(scope);
    }, 330);
  } else {
    collapseIdlePanes(scope);
  }
  if (updateUrl) replaceHomeHash();
  updateHeader();
  // 数据可能没到 / 已过期 → 后台补一次（视图不重建，只会局部更新那一格）
  ensurePaneData(scope);
  warmPanes({}, scope);
}

/**
 * 滑到「上一天 / 下一天」那一格落地。
 * 分两步，就是为了跟中间三格一样**有收尾动画**（以前直接换数据 + 无动画对位，手指一松就"刹住"，很生硬）：
 *   ① 先把轨道平滑地滑满到那一格（300ms 缓动，和切标签同款）
 *   ② 动画结束再把日期换掉、把这一格的数据搬到中间「全部」格，然后**无动画**对回中间
 *      —— 此时中间格显示的内容和刚才那一格一模一样，所以看不出换过，画面是连续的
 */
async function slideToDay(delta, { animate = true } = {}) {
  const fromSlot = delta < 0 ? 'prev' : 'next';
  if (!pager || !slotEnabled(fromSlot)) return;
  const nextDate = shiftDayKey(state.home.date, delta);

  // ① 平滑滑满到相邻天那一格（手指松开后继续滑过去的收尾动画）
  setPaneIdle('all', false);
  setPaneIdle(fromSlot, false);
  alignTrack(fromSlot, { animate, ms: SETTLE_MS });
  const token = (slideToken += 1);
  if (animate) await new Promise((r) => setTimeout(r, SETTLE_MS + 20));
  if (token !== slideToken) return; // 动画期间又滑了：交给新的手势，别在这里换天

  // ② 预览到的那一格数据直接搬到中间「全部」格（键一致：都是 all|新日期|day|）
  const peek = state.panes[fromSlot];
  state.panes.all = { ...peek };
  state.panes[fromSlot] = emptyPaneState();
  // ③ 换日期 + 回到「全部」标签
  state.home = {
    ...state.home,
    date: nextDate,
    all: false,
    scope: 'all',
    friendFilter: null,
    panesDate: `${nextDate}|false`,
    posts: peek.posts || [],
    hasMore: !!peek.hasMore,
    cursor: peek.cursor ?? null,
    loading: false,
    stale: false,
  };
  for (const s of ['friends', 'mine']) state.panes[s].stale = true;
  syncPanePlans();
  applyScopeChrome();
  // ④ 先把中间格画出来（数据已经在），再无动画对位 —— 画面连续，不闪不跳
  paintPane('all');
  alignTrack('all', { animate: false });
  collapseIdlePanes('all');
  // ⑤ 顶部日期条、地址栏、标题
  if (homeDateNav) homeDateNav.update(nextDate, false);
  replaceHomeHash();
  updateHeader();
  syncPagerHeight();
  // ⑥ 后台补：当前格的确认 + 其余格与新相邻天的预热
  ensurePaneData('all');
  warmPanes({}, 'all');
}


/** 只改地址栏、不触发 hashchange（否则会走 render() 重建整个视图，那就闪了） */
function replaceHomeHash() {
  const p = new URLSearchParams();
  if (state.home.date !== todayKey()) p.set('date', state.home.date);
  if (state.home.all) p.set('all', '1');
  if (state.home.scope !== 'all') p.set('scope', state.home.scope);
  if (state.home.scope === 'friends' && state.home.friendFilter) p.set('friend', state.home.friendFilter);
  const hash = `#/home${p.toString() ? `?${p}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

/** 点好友头像筛选（只在「好友」页内生效，不重建视图） */
function pickFriend(id) {
  const next = id && id !== state.home.friendFilter ? id : null;
  state.home = { ...state.home, friendFilter: next, stale: false };
  state.panes.friends.stale = true;
  paintFriendStrip();
  replaceHomeHash();
  if (next) ensureFriendCelebrations(next);
  paintPane('friends');
  loadPane('friends', { silent: true });
}

/** 三个标签按钮（全部 / 好友 / 我） */
function buildScopeTabs() {
  const tabs = el('div', { class: 'scope-tabs', role: 'tablist' });
  const friendCount = state.home.friendCount ?? 0;
  const tabDefs = [
    ['all', '全部', null],
    ['friends', '好友', friendCount ? String(friendCount) : null],
    ['mine', '我', null],
  ];
  for (const [key, text, count] of tabDefs) {
    tabs.append(
      el(
        'button',
        {
          class: `scope-tab${state.home.scope === key ? ' active' : ''}`,
          type: 'button',
          role: 'tab',
          dataset: { scope: key },
          'aria-selected': state.home.scope === key ? 'true' : 'false',
          onclick: () => slideToScope(key),
        },
        text,
        // 计数节点始终创建（好友数稍后才有，靠 updateFriendCountText 填充），
        // 否则刷新后这个数字会一直缺失。
        key === 'friends'
          ? el('span', { class: `count${count ? '' : ' hidden'}`, 'data-friend-count': key }, count || '')
          : null
      )
    );
  }
  return tabs;
}

/**
 * 三页容器。
 *  - 三页 DOM 常驻，滑动只是 translateX，内容不重建 → 不闪
 *  - 非当前页用 .idle（height:0 + visibility:hidden）收起：既保留横向槽位
 *    （每页宽度 == 容器宽度，translateX 才能按页对齐），又不会撑出大片空白
 */
function buildPager() {
  const root = el('div', { class: 'scope-pager' });
  const track = el('div', { class: 'scope-track' });
  const panes = {};
  for (const slot of SLOT_ORDER) {
    const plan = slotPlan(slot);
    const pane = el('div', { class: 'scope-pane', dataset: { scope: slot, day: plan.day ? String(DAY_SLOT_DELTA[slot]) : '' } });
    const top = el('div', { class: 'home-top' });
    const list = el('div', { class: 'feed' });
    pane.append(top, list);
    panes[slot] = { el: pane, top, list, strip: null, plan };
    track.append(pane);
  }
  root.append(track);
  pager = { root, track, panes, visualSlot: SLOT_ORDER.indexOf(state.home.scope) };
  bindPagerGesture();
  // 内容高度会变（图片加载完、数据到齐）：跟着当前格重新定高
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (state.view === 'home' && pager?.root === root) syncPagerHeight();
    });
    for (const slot of SLOT_ORDER) ro.observe(panes[slot].el);
  }
  return root;
}

/**
 * 左右滑动切换：pointer 事件统一处理触摸与鼠标。
 * 竖向滑动一律让给页面滚动（CSS 上 touch-action: pan-y），只有横向意图才接管。
 */
function bindPagerGesture() {
  const root = pager.root;
  const drag = {
    id: null,
    active: false,
    axis: null,
    index: 0,
    startX: 0,
    startY: 0,
    dx: 0,
    lastX: 0,
    lastT: 0,
    vx: 0,
  };

  const reset = () => {
    drag.id = null;
    drag.active = false;
    drag.axis = null;
    drag.dx = 0;
    root.classList.remove('dragging');
  };

  /** 松手 / 取消后回到某一格（带动画） */
  const settle = (slot, animate = true) => {
    const plan = pager.panes[slot]?.plan || slotPlan(slot);
    highlightTab(plan.apiScope);
    alignTrack(slot, { animate, ms: 260 });
    collapseIdlePanes(slot);
  };

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    reset();
    drag.id = e.pointerId;
    drag.index = currentSlotIndex();
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.lastX = e.clientX;
    drag.lastT = performance.now();
    drag.vx = 0;
  });

  root.addEventListener('pointermove', (e) => {
    if (drag.id === null || e.pointerId !== drag.id) return;
    const mx = e.clientX - drag.startX;
    const my = e.clientY - drag.startY;
    if (!drag.axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // 主方向是竖向 → 本次手势交给页面滚动，不再接管
      if (Math.abs(my) >= Math.abs(mx)) {
        drag.id = null;
        return;
      }
      drag.axis = 'x';
      drag.active = true;
      root.classList.add('dragging');
      // 滑动方向上相邻的那一格先参与布局，才能被"拉"进视野
      const next = drag.index + (mx < 0 ? 1 : -1);
      setPaneIdle(SLOT_ORDER[drag.index], false);
      if (next >= 0 && next < SLOT_ORDER.length && slotEnabled(SLOT_ORDER[next])) setPaneIdle(SLOT_ORDER[next], false);
      // 相邻那一格还没数据就顺手拉一把（多数时候预热已经拿回来了）
      if (next >= 0 && next < SLOT_ORDER.length) ensurePaneData(SLOT_ORDER[next]);
    }
    drag.dx = mx;
    const now = performance.now();
    if (now - drag.lastT > 10) {
      drag.vx = (e.clientX - drag.lastX) / (now - drag.lastT);
      drag.lastX = e.clientX;
      drag.lastT = now;
    }
    // 已经到头（或该方向那一格不可用）：橡皮筋，最多拖出 1/3 屏
    const want = drag.index + (mx < 0 ? 1 : -1);
    const atEdge = want < 0 || want >= SLOT_ORDER.length || !slotEnabled(SLOT_ORDER[want]);
    const offset = Math.max(-pagerWidth(), Math.min(pagerWidth(), atEdge ? mx * 0.35 : mx));
    setTrack(-drag.index * pagerStep() + offset, { animate: false });
    // 越过 1/3 屏就先把标签高亮切过去，视觉上更跟手（按目标格的 apiScope 高亮）
    const towards = mx < -pagerWidth() * 0.33 ? drag.index + 1 : mx > pagerWidth() * 0.33 ? drag.index - 1 : drag.index;
    const clamped = Math.max(0, Math.min(SLOT_ORDER.length - 1, towards));
    const slot = SLOT_ORDER[clamped];
    if (slotEnabled(slot)) {
      const apiScope = (pager.panes[slot]?.plan || slotPlan(slot)).apiScope;
      if (apiScope !== state.home.scope) highlightTab(apiScope);
    }
  });

  const finish = ({ cancelled = false } = {}) => {
    if (drag.id === null) return;
    const wasActive = drag.active;
    const index = drag.index;
    const dx = drag.dx;
    const vx = drag.vx;
    const from = SLOT_ORDER[index];
    reset();
    if (!wasActive) return;
    if (cancelled) {
      settle(from);
      return;
    }
    const w = pagerStep();
    const want = index + (dx < 0 ? 1 : -1);
    const blocked = want < 0 || want >= SLOT_ORDER.length || !slotEnabled(SLOT_ORDER[want]);
    let target = index;
    // 滑过 22% 屏，或者甩得够快（>0.4px/ms）就翻一格
    if (!blocked && (Math.abs(dx) > w * 0.22 || Math.abs(vx) > 0.4)) target = want;
    const slot = SLOT_ORDER[target];
    if (slot === from) {
      settle(from);
      return;
    }
    // 落到两头的按天格 → 换一整天；落到中间格 → 换标签
    const delta = DAY_SLOT_DELTA[slot];
    if (delta) slideToDay(delta);
    else slideToScope((pager.panes[slot]?.plan || slotPlan(slot)).apiScope);
  };

  root.addEventListener('pointerup', () => finish());
  root.addEventListener('pointercancel', () => finish({ cancelled: true }));

  // 横竖屏切换 / 键盘弹出后重新对齐，避免停在两格中间
  window.addEventListener('resize', () => {
    if (state.view === 'home' && pager && !drag.active) {
      setTrack(-currentSlotIndex() * pagerStep(), { animate: false });
      syncPagerHeight();
    }
  });
}

function viewHome(main, params) {
  if (!state.user) {
    location.replace('#/login');
    return;
  }
  const date = params.get('date') || state.home.date || todayKey();
  const all = params.get('all') === '1';
  const scope = ['mine', 'friends', 'all'].includes(params.get('scope'))
    ? params.get('scope')
    : state.home.scope || 'all';
  const friendFilter = state.home.friendFilter || null;

  const goto = (nextDate, nextAll, nextScope = scope, nextFriend = friendFilter) => {
    const p = new URLSearchParams();
    if (nextDate !== todayKey()) p.set('date', nextDate);
    if (nextAll) p.set('all', '1');
    if (nextScope !== 'all') p.set('scope', nextScope);
    if (nextFriend) p.set('friend', nextFriend);
    const hash = `#/home${p.toString() ? `?${p}` : ''}`;

    if (location.hash === hash) {
      // hash 没变（例如点的是当前日期 / 当前范围）：直接加载，不依赖 hashchange
      loadHome({ date: nextDate, all: nextAll, scope: nextScope, friendFilter: nextFriend });
    } else {
      // hash 变了：**不要**提前改 state，交给 hashchange 统一处理，
      // 否则 hashchange 会认为"参数没变"而不再加载。
      location.hash = hash;
    }
    updateHeader();
  };

  const dateNav = buildDateNav({
    date,
    all,
    onDate: (d) => goto(d, false),
    onToggleAll: () => goto(date, !all),
  });
  homeDateNav = dateNav; // 按天滑动切换日期时要同步这根条（不重建视图）
  main.append(dateNav.node);

  // 范围切换：全部 / 好友 / 我。
  // 点标签 = slideToScope（横向平移 + 缓存重绘），不再 location.hash → render() 重建视图
  state.home = { ...state.home, date, all, scope, friendFilter };
  main.append(buildScopeTabs());

  main.append(buildPager());
  syncPanePlans();

  applyScopeChrome();
  collapseIdlePanes(scope);
  alignTrack(scope, { animate: false });

  // 所有格子都先按缓存画一遍（先画再拉，避免先空一下再出现 —— 那也是一种"闪"）
  for (const slot of SLOT_ORDER) paintPane(slot);
  paintFriendStrip();

  // 「好友」标签下筛了某人：拉他关联的纪念日，到了再补画倒计时
  if (scope === 'friends' && friendFilter) ensureFriendCelebrations(friendFilter);

  // 首页渲染依赖好友（头像条）与纪念日（倒计时），先确保它们到位。
  // 用 ensureHomeContext 统一处理，避免再次出现"刷新后某块不见了"的时序问题。
  if (!getFriendState().loaded || !getAnniversaryState().loaded) {
    ensureHomeContext().then(() => {
      updateFriendsBadge();
      state.home = { ...state.home, friendCount: getFriendState().counts.friends || 0 };
      updateFriendCountText();
      if (state.view === 'home') paintHome();
    });
  }

  const pane = state.panes[scope];
  const paneUsable = pane.loaded && !pane.stale && pane.key === paneKeyFor(scope);
  if (paneUsable) {
    paintHome();
    if (pane.stale) ensurePaneData(scope, { force: true });
  } else {
    paintHome();
    loadHome({ date, all, scope, friendFilter });
  }
  warmPanes({ date, all }, scope);
}

// ---------------------------------------------------------------- 日历

async function loadCalendar(month = state.calendar.month) {
  state.calendar = { ...state.calendar, month, loading: true };
  try {
    const res = await api.calendar(month);
    state.calendar = {
      ...state.calendar,
      days: res.days,
      marks: res.marks || {},
      anniversaries: res.anniversaries || [],
      loading: false,
    };
  } catch (err) {
    state.calendar = { ...state.calendar, loading: false };
    toast(err.message || '加载日历失败');
  }
  if (state.view === 'calendar') paintCalendar();
  updateHeader();
}

function paintCalendar() {
  safePaint('paintCalendar', paintCalendarInner);
}

function paintCalendarInner() {
  const host = document.querySelector('#calendar-body');
  if (!host) return;
  host.textContent = '';
  const { month, days, marks = {}, anniversaries = [] } = state.calendar;
  const counts = new Map(days.map((d) => [d.day_key, d.c]));
  const grid = el('div', { class: 'cal-grid' });
  for (const w of ['日', '一', '二', '三', '四', '五', '六']) {
    grid.append(el('div', { class: 'cal-weekday' }, w));
  }
  const first = firstWeekdayOfMonth(month);
  for (let i = 0; i < first; i += 1) grid.append(el('div', { class: 'cal-cell empty' }));
  const total = daysInMonth(month);
  const today = todayKey();
  for (let d = 1; d <= total; d += 1) {
    const key = `${month}-${pad2(d)}`;
    const count = counts.get(key) || 0;
    const dayMarks = marks[key] || [];
    const cell = el(
      'button',
      {
        type: 'button',
        class: `cal-cell${count ? ' has' : ''}${key === today ? ' today' : ''}${dayMarks.length ? ' has-anniversary' : ''}`,
        title: dayMarks.length ? dayMarks.map((m) => `${m.icon} ${m.name}`).join('\n') : null,
        onclick: () => {
          state.home = { ...state.home, date: key, all: false, posts: [], cursor: null, hasMore: false };
          const p = new URLSearchParams();
          if (key !== today) p.set('date', key);
          location.hash = `#/home${p.toString() ? `?${p}` : ''}`;
        },
      },
      el('span', { class: 'cal-day' }, String(d)),
      count ? el('span', { class: 'cal-count' }, String(count)) : null,
      dayMarks.length ? el('span', { class: 'cal-marks' }, dayMarks.map((m) => m.icon).join('')) : null
    );
    grid.append(cell);
  }
  host.append(el('div', { class: 'cal-wrap' }, grid));
  const monthTotal = days.reduce((sum, d) => sum + d.c, 0);
  host.append(el('div', { class: 'cal-summary' }, `本月 ${monthTotal} 条记录，覆盖 ${days.length} 天`));

  // 本月纪念日（日历上已用小图标标出）
  if (anniversaries.length) {
    const box = el('div', { class: 'cal-anniversaries' });
    box.append(el('h4', {}, '本月纪念日'));
    for (const a of anniversaries) {
      box.append(
        el(
          'div',
          { class: `cal-an-row${a.special || a.isBirthday ? ' special' : ''}` },
          el('span', { class: 'an-icon' }, a.icon),
          el('span', { class: 'an-name' }, a.name),
          el('span', { class: 'muted' }, `${Number(a.date.slice(5, 7))} 月 ${Number(a.date.slice(8, 10))} 日`),
          el('span', { class: 'an-days' }, a.days === 0 ? '就是今天 🎉' : `${a.days} 天后`)
        )
      );
    }
    host.append(box);
  }

  // 全部纪念日倒计时（按剩余天数排序）
  const all = sortedAnniversaries();
  if (all.length) {
    const box = el('div', { class: 'cal-countdowns' });
    box.append(el('h4', {}, '全部倒计时'));
    for (const item of all) {
      if (!item.next) continue;
      box.append(
        celebrationCard(
          { ...item, label: item.name, unit: item.isBirthday ? '岁' : '周年' },
          { onClick: () => (location.hash = '#/settings') }
        )
      );
    }
    host.append(box);
  }

  if (!monthTotal) {
    host.append(emptyState({ title: '这个月还没有记录', hint: '点日历上的日期可以回看，也可以直接写一条。' }));
  }
}

function viewCalendar(main) {
  if (!state.user) {
    location.replace('#/login');
    return;
  }
  const label = el('strong', {}, monthLabel(state.calendar.month));
  const prev = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '上个月' }, svgIcon('back', 18));
  const next = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '下个月' }, svgIcon('chevron', 18));
  prev.addEventListener('click', () => {
    const m = addMonths(state.calendar.month, -1);
    label.textContent = monthLabel(m);
    loadCalendar(m);
  });
  next.addEventListener('click', () => {
    const m = addMonths(state.calendar.month, 1);
    label.textContent = monthLabel(m);
    loadCalendar(m);
  });
  main.append(el('div', { class: 'month-nav' }, prev, label, next));
  main.append(el('div', { id: 'calendar-body', class: 'calendar-view' }));
  paintCalendar();
  loadCalendar(state.calendar.month);
}

// ---------------------------------------------------------------- 搜索

async function runSearch() {
  const { q, tag } = state.search;
  if (!q && !tag) {
    state.search = { ...state.search, posts: [], ran: false };
    if (state.view === 'search') paintSearch();
    return;
  }
  state.search = { ...state.search, loading: true };
  const list = document.querySelector('#search-list');
  if (list) {
    list.textContent = '';
    list.append(skeleton(2));
  }
  try {
    const res = await api.listPosts({ q, tag, limit: 50 });
    state.search = { ...state.search, posts: res.posts, loading: false, ran: true };
  } catch (err) {
    state.search = { ...state.search, loading: false, ran: true };
    toast(err.message || '搜索失败');
  }
  if (state.view === 'search') paintSearch();
}

function paintSearch() {
  const host = document.querySelector('#search-list');
  if (!host) return;
  host.textContent = '';
  const { posts, ran, q, tag } = state.search;
  if (!ran) {
    host.append(emptyState({ title: '查找过去的记录', hint: '输入关键词、地点，或点击动态里的 #标签。' }));
    return;
  }
  if (!posts.length) {
    host.append(emptyState({ title: '没有找到相关记录', hint: q ? `当前关键词：${q}` : '换个词试试' }));
    return;
  }
  renderFeed(host, posts, {
    onOpenMedia: openLightbox,
    canEdit: true,
    meId: state.user?.id,
    myCardTheme: state.user?.cardTheme || '',
    onEdit: (post) => editPost(post),
    onDelete: (post) => deletePost(post, () => runSearch()),
  });
  // 同上：摘要要在 renderFeed（会清空容器）之后再放进去
  host.prepend(el('div', { class: 'summary' }, `找到 ${posts.length} 条${tag ? ` #${tag}` : ''}`));
}

function viewSearch(main, params) {
  if (!state.user) {
    location.replace('#/login');
    return;
  }
  const tagParam = params.get('tag') || '';
  const qParam = params.get('q') || '';
  if (tagParam !== state.search.tag || qParam !== state.search.q) {
    state.search = { ...state.search, q: qParam, tag: tagParam, ran: false };
  }
  const input = el('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索内容 / 地点 / #标签',
    value: state.search.q || '',
    enterkeyhint: 'search',
  });
  const tagInput = el('input', { class: 'input', placeholder: '标签（可选，不含 #）', value: state.search.tag || '' });
  const form = el(
    'form',
    { class: 'search-bar' },
    input,
    el('button', { class: 'btn primary', type: 'submit' }, svgIcon('search', 18), '搜索')
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    state.search = {
      ...state.search,
      q: input.value.trim(),
      tag: tagInput.value.trim().replace(/^#/, ''),
    };
    const p = new URLSearchParams();
    if (state.search.q) p.set('q', state.search.q);
    if (state.search.tag) p.set('tag', state.search.tag);
    history.replaceState(null, '', `#/search${p.toString() ? `?${p}` : ''}`);
    runSearch();
  });
  main.append(form, el('details', { class: 'search-advanced' }, el('summary', {}, '按标签筛选'), tagInput));
  main.append(el('div', { id: 'search-list', class: 'feed' }));
  if (state.search.q || state.search.tag) runSearch();
  else paintSearch();
}

// ---------------------------------------------------------------- 动态操作

function createPost() {
  if (!state.user) {
    toast('请先登录');
    return;
  }
  openComposer({
    onSubmit: async ({ formData, json, onProgress }) => {
      const res = formData ? await api.createPostMultipart(formData, { onProgress }) : await api.createPost(json);
      toast('已记录 ✓');
      if (state.user.stats) state.user.stats.posts = (state.user.stats.posts || 0) + 1;
      const day = res.post.postDay || dayKeyOf(res.post.occurredAt || res.post.createdAt);
      // 新记录会同时出现在「我 / 好友(不含) / 全部」里 → 三页缓存都作废，
      // 这样滑到别的页也是最新的（当前页马上重载，其余页由 warmPanes 补）
      markHomeStale();

      if (state.home.all) {
        // 看全部时直接按当前范围重载即可，新记录一定在里面
        await loadHome({ all: true, scope: state.home.scope });
      } else if (day === state.home.date) {
        await loadHome({ date: day, all: false, scope: state.home.scope });
      } else {
        // 补记了别的日期：跳到那一天。若该记录属于"未来"（可能因时区），
        // 不跳转、避免出现空白列表，只提示一下。
        const todayKeyNow = todayKey();
        if (day > todayKeyNow) {
          toast(`这条记录记在了 ${day}（今天之后）`);
        } else {
          state.home = {
            ...state.home,
            date: day,
            all: false,
            posts: [],
            cursor: null,
            hasMore: false,
            stale: false,
          };
          const p = new URLSearchParams();
          if (day !== todayKeyNow) p.set('date', day);
          const hash = `#/home${p.toString() ? `?${p}` : ''}`;
          if (location.hash === hash) {
            render();
            await loadHome({ date: day, all: false, scope: state.home.scope });
          } else {
            location.hash = hash;
          }
        }
      }
      // 在「日历」页发帖时，日历上的条数/标记也要立刻跟着变
      // （以前只重载了时间线，日历要手动刷新才更新）
      if (state.view === 'calendar') await loadCalendar(state.calendar.month);
      updateHeader();
    },
  });
}

function editPost(post) {
  openComposer({
    post,
    onSubmit: async ({ json, formData, id, onProgress }) => {
      // 有新增附件时用 multipart（会追加到这条动态），否则走 JSON 只改文字
      const res = formData
        ? await api.updatePostMultipart(id, formData, { onProgress })
        : await api.updatePost(id, json);
      toast('已保存');
      const activePane = state.panes[state.home.scope];
      const lists = [state.home.posts, state.search.posts];
      if (activePane) lists.push(activePane.posts);
      for (const list of lists) {
        const idx = list.findIndex((p) => p.id === id);
        if (idx >= 0) list[idx] = res.post;
      }
      // 就地更新 + 就地重画（不再 render() 重建整个首页，否则会闪一下）
      markHomeStale();
      if (state.view === 'home') paintHome();
      if (state.view === 'search') paintSearch();
    },
  });
}

async function deletePost(post, onDone) {
  const ok = await openConfirm({
    title: '删除这条记录？',
    message: '删除后无法恢复，附件也会一并删除。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deletePost(post.id);
    if (state.user?.stats?.posts) state.user.stats.posts = Math.max(0, state.user.stats.posts - 1);
    toast('已删除');
    onDone?.();
  } catch (err) {
    toast(err.message || '删除失败');
  }
}

// ---------------------------------------------------------------- 分享

/**
 * 「已生成的链接」列表：最多显示 5 行，超过就自己滚动。
 * 行高会随字体/换行变，所以按实际行高算，而不是写死一个 px。
 */
const SHARE_LINKS_VISIBLE = 5;
function capLinkList(box) {
  const rows = [...box.children];
  if (rows.length <= SHARE_LINKS_VISIBLE) {
    box.style.maxHeight = '';
    return;
  }
  const h = rows[0].getBoundingClientRect().height;
  const gap = parseFloat(getComputedStyle(box).rowGap) || 0;
  if (h > 0) box.style.maxHeight = `${Math.round(h * SHARE_LINKS_VISIBLE + gap * (SHARE_LINKS_VISIBLE - 1))}px`;
}

/** 生成分享链接时可选的时效 */
const SHARE_TTL_OPTIONS = [
  [1, '1 小时'],
  [24, '1 天'],
  [168, '7 天'],
  [720, '30 天'],
];
const SHARE_DEFAULT_TTL = 168;

/** 链接范围的人话描述 */
function shareScopeText(link) {
  if (link.scope === 'day') return `${link.day} 这一天`;
  if (link.scope === 'month') return `${link.month} 整月`;
  return '全部时间线';
}

function shareExpiryText(expiresAt) {
  const left = expiresAt - Date.now();
  if (left <= 0) return '已过期';
  const hours = Math.floor(left / 3600000);
  if (hours < 1) return `${Math.max(1, Math.round(left / 60000))} 分钟后过期`;
  if (hours < 48) return `${hours} 小时后过期`;
  return `${Math.round(hours / 24)} 天后过期`;
}

async function generateShareLink({ scope, day, month, hours }) {
  const res = await api.createShareLink({ scope, day, month, hours });
  return { ...res.link, url: `${location.origin}${res.link.url}` };
}

/** 链接 + 二维码 + 复制/系统分享/预览 的一整块 */
function shareResultBox(link) {
  const qrImg = el('img', { alt: '分享二维码', width: 216, height: 216, src: `/api/qr?data=${encodeURIComponent(link.url)}&scale=6` });
  return el(
    'div',
    { class: 'share-result' },
    el('p', { class: 'share-note' }, `可查看：${shareScopeText(link)} · ${shareExpiryText(link.expiresAt)}`),
    el('div', { class: 'qr-box' }, qrImg),
    el(
      'div',
      { class: 'link-row' },
      el('input', { class: 'input', readonly: true, value: link.url, onfocus: (e) => e.target.select() }),
      el(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: async () => {
            const ok = await copyText(link.url);
            toast(ok ? '链接已复制' : '复制失败，请长按选中复制');
          },
        },
        '复制'
      )
    ),
    el(
      'div',
      { class: 'share-actions' },
      el(
        'button',
        {
          class: 'btn ghost',
          type: 'button',
          onclick: async () => {
            if (navigator.share) {
              try {
                await navigator.share({ title: `${state.user?.displayName || ''} 的 DayLog`, url: link.url });
                return;
              } catch {
                /* 用户取消 */
              }
            }
            await copyText(link.url);
            toast('链接已复制');
          },
        },
        svgIcon('share', 18),
        '系统分享'
      ),
      el('a', { class: 'btn ghost', href: link.url, target: '_blank', rel: 'noopener' }, svgIcon('eye', 18), '预览访客视角')
    )
  );
}

/**
 * 「分享给朋友」面板：选范围 + 选时效 → **现场生成一条限时链接**。
 * 每次分享都是一条独立链接（范围绑在链接上），所以链接里不再带 range/date 参数。
 */
function openShareSheet() {
  if (!state.user) return;
  const today = todayKey();
  let date = state.home.date || today;
  let kind = 'date';
  let hours = SHARE_DEFAULT_TTL;

  const body = el('div', { class: 'share-body' });
  const rangeTabs = el('div', { class: 'range-tabs' });
  const defs = [
    ['date', ['选中的日期', date]],
    ['today', ['今日时间线', today]],
    ['all', ['全部时间线', '可自由筛选']],
  ];
  for (const key of ['date', 'today', 'all']) {
    const [title, sub] = defs.find((d) => d[0] === key)[1];
    rangeTabs.append(
      el(
        'button',
        {
          class: `range-tab${kind === key ? ' active' : ''}`,
          type: 'button',
          dataset: { kind: key },
          onclick: () => {
            kind = key;
            sync();
          },
        },
        el('span', { class: 'rt-title' }, title),
        el('span', { class: 'rt-sub' }, sub)
      )
    );
  }

  const ttlRow = el('div', { class: 'range-tabs ttl-tabs' });
  for (const [value, label] of SHARE_TTL_OPTIONS) {
    ttlRow.append(
      el(
        'button',
        {
          class: `range-tab small${hours === value ? ' active' : ''}`,
          type: 'button',
          dataset: { hours: String(value) },
          onclick: () => {
            hours = value;
            sync();
          },
        },
        el('span', { class: 'rt-title' }, label)
      )
    );
  }

  const resultBox = el('div', { class: 'share-result-slot' });
  const genBtn = el('button', { class: 'btn primary', type: 'button' }, svgIcon('link', 18), '生成分享链接');

  /** 显示某条链接的二维码 / 地址 / 复制按钮（新生成的和已经存在的都走这里） */
  function showLink(link) {
    const full = { ...link, url: link.url.startsWith('http') ? link.url : `${location.origin}${link.url}` };
    resultBox.textContent = '';
    resultBox.append(shareResultBox(full));
    for (const row of linksBox.children) row.classList.toggle('active', row.dataset.token === link.token);
    if (typeof resultBox.scrollIntoView === 'function') resultBox.scrollIntoView({ block: 'nearest' });
  }

  // 已经创建过的链接：点一条直接看它的二维码 / 地址，不用每次重新生成
  const linksTitle = el('h4', { hidden: true }, '已创建的链接');
  const linksBox = el('div', { class: 'share-links' });
  async function refreshLinks() {
    let links = [];
    try {
      links = (await api.shareLinks()).links || [];
    } catch {
      links = [];
    }
    linksBox.textContent = '';
    linksTitle.hidden = !links.length;
    for (const link of links) {
      linksBox.append(
        el(
          'button',
          {
            type: 'button',
            class: 'share-link-row pick',
            dataset: { token: link.token },
            onclick: () => showLink(link),
          },
          el(
            'div',
            { class: 'share-link-text' },
            el('strong', {}, shareScopeText(link)),
            el('span', { class: 'muted' }, shareExpiryText(link.expiresAt))
          ),
          el('span', { class: 'share-link-go' }, svgIcon('chevron', 15))
        )
      );
    }
    capLinkList(linksBox);
  }

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    genBtn.classList.add('loading');
    try {
      const link = await generateShareLink({
        scope: kind === 'all' ? 'all' : 'day',
        day: kind === 'all' ? '' : kind === 'today' ? today : date,
        hours,
      });
      await refreshLinks();
      showLink(link);
    } catch (err) {
      toast(err.message || '生成失败');
    } finally {
      genBtn.disabled = false;
      genBtn.classList.remove('loading');
    }
  });

  function sync() {
    for (const btn of rangeTabs.children) btn.classList.toggle('active', btn.dataset.kind === kind);
    for (const btn of ttlRow.children) btn.classList.toggle('active', Number(btn.dataset.hours) === hours);
    // 改了范围/时效，之前显示的那条链接就不对了，清掉免得发错
    resultBox.textContent = '';
    for (const row of linksBox.children) row.classList.remove('active');
  }

  body.append(
    el('p', { class: 'share-note' }, '每次分享都会生成一条独立链接，到期自动失效。'),
    el('div', { class: 'share-range' }, rangeTabs),
    el('div', { class: 'field' }, el('label', {}, '有效期'), ttlRow),
    el('div', { class: 'field-actions' }, genBtn),
    linksTitle,
    linksBox,
    resultBox
  );
  openSheet({ title: '分享给朋友', content: body });
  sync();
  refreshLinks();
}

// ---------------------------------------------------------------- 设置


/** 设置页：我的记录卡片主题色（好友的卡片用他们自己的设置，没设置就用他们头像取色） */
function cardThemeSection(user) {
  const card = el('section', { class: 'card settings-card' });
  card.append(el('h3', {}, '记录卡片底色'));
  const current = String(user.cardTheme || '').toLowerCase();
  const isCustom = HEX_COLOR_RE.test(current);

  const pick = async (value) => {
    try {
      const res = await api.updateSettings({ cardTheme: value });
      state.user = { ...state.user, ...res.user, stats: state.user.stats };
      markHomeStale();
      toast('已更新');
      render();
    } catch (err) {
      toast(err.message || '设置失败');
    }
  };

  const item = (value, label, { color = null, extra = '', active = current === value } = {}) =>
    el(
      'button',
      {
        type: 'button',
        class: `theme-item${active ? ' active' : ''}`,
        onclick: () => pick(value),
      },
      el('span', { class: `theme-dot${extra ? ` ${extra}` : ''}`, style: color ? { background: color } : null }),
      el('span', {}, label)
    );

  const row = el('div', { class: 'theme-row' });
  row.append(item('', '默认白'));
  const avatarItem = item('avatar', '跟随头像', { extra: 'user-avatar' });
  row.append(avatarItem);
  if (user.avatarUrl) {
    // 直接把取到的头像主题色涂在圆点上：选之前就能看到效果
    const dot = avatarItem.firstElementChild;
    themeFromAvatar(user.avatarUrl).then((color) => {
      if (color) dot.style.background = color;
    });
  }
  for (const preset of CARD_THEME_PRESETS) row.append(item(preset.id, preset.name, { color: preset.color }));

  const colorInput = el('input', {
    type: 'color',
    value: isCustom ? current : '#2f6df6',
    'aria-label': '自定义主题色',
  });
  colorInput.addEventListener('change', () => pick(colorInput.value.toLowerCase()));
  row.append(
    el(
      'label',
      { class: `theme-item${isCustom ? ' active' : ''}` },
      el('span', { class: 'theme-dot custom' }, colorInput),
      el('span', {}, '自定义')
    )
  );

  card.append(row);
  return card;
}

/**
 * 手机通知（收件人视角）：我自己的**默认通道**。
 * 好友发记录 → 推到这里；某个好友想单独用别的 key 或免推送 → 去好友页设（优先于这里）。
 */
function buildPushCard() {
  const card = el('section', { class: 'card settings-card' });
  card.append(el('h3', {}, '手机通知'));
  const body = el('div', { class: 'push-card-body' });
  card.append(body);

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
    placeholder: '整条 Webhook 地址，或只贴 key= 后面那串',
  });
  const urlInput = el('input', { class: 'input', type: 'text', autocomplete: 'off' });
  const excerptInput = el('input', { class: 'input', type: 'number', min: '0', max: '200', value: '60' });
  const status = el('p', { class: 'muted push-status' }, '读取中…');
  const secretRow = el('div', { class: 'field' }, el('label', {}, '机器人 key'), secretInput);
  const urlRow = el('div', { class: 'field' }, el('label', {}, '推送地址'), urlInput);
  const switchHost = el('div', {});

  let current = { enabled: false, configured: false, hasSecret: false, secretHint: '', url: '', kind: 'wecom', excerpt: 60 };

  function syncRows() {
    const kind = kindSel.value;
    secretRow.classList.toggle('hidden', kind !== 'wecom');
    urlRow.classList.toggle('hidden', kind === 'wecom');
    urlInput.placeholder =
      kind === 'ntfy'
        ? 'https://ntfy.sh/你的topic'
        : kind === 'bark'
          ? 'https://api.day.app/你的key'
          : 'https://…（会收到 {title,body,link} 的 JSON）';
    secretInput.placeholder = current.hasSecret ? `已保存 ${current.secretHint}（留空=不改）` : '整条 Webhook 地址，或只贴 key= 后面那串';
  }

  function mountSwitch() {
    switchHost.textContent = '';
    switchHost.append(
      toggleSwitch(Boolean(current.enabled), async (v) => {
        await save({ enabled: v }, v ? '已开启推送' : '已关闭推送');
      })
    );
  }

  function paint() {
    kindSel.value = current.kind || 'wecom';
    excerptInput.value = String(current.excerpt ?? 60);
    secretInput.value = '';
    urlInput.value = current.url || '';
    syncRows();
    if (current.configured && current.enabled) {
      status.textContent = '已开启 · 好友发记录会推到这里';
    } else if (current.configured) {
      status.textContent = '已保存，但推送是关闭的';
    } else {
      status.textContent = '还没配 · 配好会推给我手机';
    }
  }

  const save = async (patch, okText) => {
    try {
      const res = await api.savePushSettings(patch);
      current = res.push || current;
      paint();
      mountSwitch();
      if (okText) toast(okText);
    } catch (err) {
      toast(err.message || '保存失败');
    }
  };

  const testBtn = el('button', { class: 'btn ghost', type: 'button' }, '发送测试通知');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.classList.add('loading');
    try {
      await api.testPush();
      toast('测试通知已发出，看手机');
    } catch (err) {
      toast(err.message || '发送失败');
    } finally {
      testBtn.disabled = false;
      testBtn.classList.remove('loading');
    }
  });

  const saveBtn = el('button', { class: 'btn primary', type: 'button' }, '保存');
  saveBtn.addEventListener('click', async () => {
    const kind = kindSel.value;
    const patch = { kind, excerpt: Number(excerptInput.value) || 0 };
    if (kind === 'wecom') {
      const v = secretInput.value.trim();
      if (v) patch.secret = v;
    } else {
      const v = urlInput.value.trim();
      if (v) patch.url = v;
    }
    await save(patch, '已保存');
  });

  kindSel.addEventListener('change', syncRows);

  body.append(
    status,
    el('div', { class: 'field' }, el('label', {}, '通道'), kindSel),
    secretRow,
    urlRow,
    el('div', { class: 'field push-inline' }, el('label', {}, '摘要字数'), excerptInput, el('span', { class: 'muted' }, '0 = 只推标题')),
    el(
      'div',
      { class: 'switch-row' },
      el('div', {}, el('strong', {}, '开启推送'), el('span', { class: 'muted' }, '好友发记录 / 有人加你时响')),
      switchHost
    ),
    el('div', { class: 'field-actions' }, testBtn, saveBtn),
    el('p', { class: 'muted push-hint' }, '想给某个好友单独用别的 key、或不想收他的推送？去「好友」页点他那行的推送按钮。')
  );

  mountSwitch();
  paint();
  api
    .pushSettings()
    .then((res) => {
      current = res.push || current;
      paint();
      mountSwitch();
    })
    .catch(() => {
      status.textContent = '读取失败，稍后重试';
    });
  return card;
}

function viewSettings(main) {
  if (!state.user) {
    location.replace('#/login');
    return;
  }
  const u = state.user;
  const avatar = u.avatarUrl
    ? el('img', { class: 'avatar', src: u.avatarUrl, alt: '' })
    : el('div', { class: 'avatar placeholder' }, (u.displayName || u.username).slice(0, 1));
  const uploadAvatar = el('button', { class: 'btn ghost small', type: 'button' }, svgIcon('camera', 16), '更换头像');
  uploadAvatar.addEventListener('click', async () => {
    const files = await pickFiles({ accept: 'image/*', multiple: false });
    if (!files.length) return;
    uploadAvatar.disabled = true;
    uploadAvatar.classList.add('loading');
    try {
      const { prepareFile } = await import('./media.js');
      const prepared = await prepareFile(files[0], { maxEdge: 480, quality: 0.85 });
      const fd = new FormData();
      fd.append('avatar', prepared.file, prepared.file.name || 'avatar.jpg');
      const res = await upload('/api/uploads/avatar', fd);
      state.user = { ...state.user, avatarUrl: res.avatarUrl };
      toast('头像已更新');
      render();
    } catch (err) {
      toast(err.message || '头像上传失败');
    } finally {
      uploadAvatar.disabled = false;
      uploadAvatar.classList.remove('loading');
    }
  });

  const profileCard = el('section', { class: 'card settings-card' });
  profileCard.append(
    el(
      'div',
      { class: 'profile-head' },
      avatar,
      el(
        'div',
        { class: 'profile-id' },
        el('strong', {}, u.displayName || u.username),
        el('span', { class: 'muted' }, `@${u.username}`)
      ),
      uploadAvatar
    ),
    // 即使统计还没加载出来也要先占位（显示 – ），避免这块看起来是空的
    statsBar(u.stats, { placeholder: !u.stats })
  );
  // 没有统计数据就补拉一次（就地更新，不整体重绘）
  if (!u.stats) loadMyStats();

  const nameInput = el('input', { class: 'input', value: u.displayName || '', placeholder: '昵称', maxlength: 40 });
  const bioInput = el('textarea', {
    class: 'input',
    rows: 2,
    placeholder: '一句话介绍（显示在分享页顶部）',
    maxlength: 200,
  });
  bioInput.value = u.bio || '';
  const saveProfile = el('button', { class: 'btn primary', type: 'button' }, '保存资料');
  saveProfile.addEventListener('click', async () => {
    saveProfile.disabled = true;
    try {
      const res = await api.updateProfile({
        displayName: nameInput.value.trim(),
        bio: bioInput.value.trim(),
        timezone: TZ(),
      });
      state.user = { ...state.user, ...res.user, stats: state.user.stats };
      toast('已保存');
      render();
    } catch (err) {
      toast(err.message || '保存失败');
    } finally {
      saveProfile.disabled = false;
    }
  });
  profileCard.append(
    el('div', { class: 'field' }, el('label', {}, '昵称'), nameInput),
    el('div', { class: 'field' }, el('label', {}, '自我介绍'), bioInput),
    el('div', { class: 'field-actions' }, saveProfile)
  );
  main.append(profileCard);

  // 记录卡片主题色：自己的卡片用哪个底色（好友的卡片用他们自己的 / 头像取色）
  main.append(cardThemeSection(u));

  // 纪念日管理（生日 + 多个自定义纪念日，其中一个可设为特别关注）
  main.append(
    anniversariesSection({
      onChanged: () => {
        // 纪念日会影响「我」这一页的倒计时（以及「好友」页的关联倒计时）
        markHomeStale();
        if (state.view === 'home') paintHome();
      },
    }).node
  );

  // ---- 手机通知（收件人视角）：默认通道 + 每个好友的例外在好友页设 ----
  main.append(buildPushCard());

  const shareCard = el('section', { class: 'card settings-card' });
  shareCard.append(el('h3', {}, '分享'));
  shareCard.append(
    el(
      'div',
      { class: 'switch-row' },
      el('div', {}, el('strong', {}, '在分享页显示统计'), el('span', { class: 'muted' }, '记录条数、天数等')),
      toggleSwitch(!!u.showStats, async (v) => {
        try {
          const res = await api.updateSettings({ showStats: v });
          state.user = { ...state.user, ...res.user, stats: state.user.stats };
          toast(v ? '已显示统计' : '已隐藏统计');
        } catch (err) {
          toast(err.message || '操作失败');
        }
      })
    )
  );

  // 每次分享生成一条独立链接（范围 + 时效都绑在链接上），这里也能看/撤销已生成的
  const scopeSel = el(
    'select',
    { class: 'input' },
    el('option', { value: 'all' }, '全部时间线'),
    el('option', { value: 'day' }, '某一天'),
    el('option', { value: 'month' }, '某个月')
  );
  const dayInput = el('input', { class: 'input', type: 'date', value: todayKey(), hidden: true });
  const monthInput = el('input', { class: 'input', type: 'month', value: todayKey().slice(0, 7), hidden: true });
  scopeSel.addEventListener('change', () => {
    dayInput.hidden = scopeSel.value !== 'day';
    monthInput.hidden = scopeSel.value !== 'month';
  });
  const ttlSel = el(
    'select',
    { class: 'input' },
    ...SHARE_TTL_OPTIONS.map(([value, label]) =>
      el('option', { value: String(value), selected: value === SHARE_DEFAULT_TTL }, label)
    )
  );
  const genBtn = el('button', { class: 'btn primary', type: 'button' }, svgIcon('link', 16), '生成分享链接');
  const linksBox = el('div', { class: 'share-links' });

  async function refreshLinks() {
    linksBox.textContent = '';
    try {
      const res = await api.shareLinks();
      const links = res.links || [];
      if (!links.length) {
        linksBox.append(el('p', { class: 'muted' }, '还没有生成过分享链接'));
        return;
      }
      for (const link of links) {
        const full = `${location.origin}${link.url}`;
        linksBox.append(
          el(
            'div',
            { class: 'share-link-row' },
            el(
              'div',
              { class: 'share-link-text' },
              el('strong', {}, shareScopeText(link)),
              el('span', { class: 'muted' }, shareExpiryText(link.expiresAt))
            ),
            el(
              'button',
              {
                class: 'btn ghost small',
                type: 'button',
                onclick: async () => {
                  const ok = await copyText(full);
                  toast(ok ? '链接已复制' : '复制失败');
                },
              },
              '复制'
            ),
            el(
              'button',
              {
                class: 'btn ghost small danger',
                type: 'button',
                onclick: async () => {
                  const yes = await openConfirm({
                    title: '撤销这条分享链接？',
                    message: '已经拿到链接的人会立刻打不开。',
                    confirmText: '撤销',
                    danger: true,
                  });
                  if (!yes) return;
                  try {
                    await api.revokeShareLink(link.token);
                    toast('已撤销');
                    refreshLinks();
                  } catch (err) {
                    toast(err.message || '撤销失败');
                  }
                },
              },
              '撤销'
            )
          )
        );
      }
    } catch (err) {
      linksBox.append(el('p', { class: 'muted' }, err.message || '读取失败'));
    }
    capLinkList(linksBox);
  }

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    try {
      const scope = scopeSel.value;
      const link = await generateShareLink({
        scope,
        day: scope === 'day' ? dayInput.value : '',
        month: scope === 'month' ? monthInput.value : '',
        hours: Number(ttlSel.value),
      });
      toast('链接已生成');
      const box = el('div', { class: 'share-result-slot' });
      box.append(shareResultBox(link));
      linksBox.before(box);
      if (shareCard.querySelectorAll('.share-result-slot').length > 1) {
        shareCard.querySelector('.share-result-slot').remove();
      }
      refreshLinks();
    } catch (err) {
      toast(err.message || '生成失败');
    } finally {
      genBtn.disabled = false;
    }
  });

  shareCard.append(
    el(
      'div',
      { class: 'field' },
      el('label', {}, '分享范围'),
      el('div', { class: 'share-scope-row' }, scopeSel, dayInput, monthInput)
    ),
    el('div', { class: 'field' }, el('label', {}, '有效期'), ttlSel),
    el('div', { class: 'field-actions' }, genBtn),
    el('h4', {}, '已生成的链接'),
    linksBox
  );
  refreshLinks();
  main.append(shareCard);

  const accountCard = el('section', { class: 'card settings-card' });
  accountCard.append(el('h3', {}, '账号与数据'));
  const cur = el('input', { class: 'input', type: 'password', placeholder: '当前密码', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', placeholder: '新密码（至少 6 位）', autocomplete: 'new-password' });
  const changeBtn = el('button', { class: 'btn ghost', type: 'button' }, '修改密码');
  changeBtn.addEventListener('click', async () => {
    changeBtn.disabled = true;
    try {
      await api.changePassword({ currentPassword: cur.value, newPassword: next.value });
      cur.value = '';
      next.value = '';
      toast('密码已修改，其他设备已退出登录');
    } catch (err) {
      toast(err.message || '修改失败');
    } finally {
      changeBtn.disabled = false;
    }
  });
  accountCard.append(
    el('div', { class: 'field' }, el('label', {}, '修改密码'), cur, next),
    el('div', { class: 'field-actions' }, changeBtn),
    el(
      'div',
      { class: 'field-actions' },
      el('a', { class: 'btn ghost', href: '/api/me/export', download: '' }, svgIcon('download', 16), '导出我的数据'),
      el(
        'button',
        {
          class: 'btn ghost danger',
          type: 'button',
          onclick: async () => {
            const ok = await openConfirm({
              title: '退出登录？',
              message: '下次需要重新输入密码。',
              confirmText: '退出',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.logout();
            } catch {
              /* 忽略 */
            }
            // 退出登录：清空所有用户相关缓存，避免下一个登录的人看到上一个用户的数据
            state.user = null;
            resetSessionCaches();
            updateFriendsBadge();
            location.hash = '#/login';
            render();
          },
        },
        '退出登录'
      )
    )
  );
  main.append(accountCard);
  main.append(
    el(
      'footer',
      { class: 'app-footer' },
      el('span', {}, 'DayLog · 记录并分享你的每一天'),
      el('span', { class: 'muted' }, `时区 ${TZ()} · build ${BUILD}`)
    )
  );
}

bootstrap();

// 控制台可用的调试入口（布局 / 首页数据排查用）
window.daylogDebug = {
  layout: debugLayout,
  home: debugHome,
  state,
  build: BUILD,
  // 暴露各模块的内存状态，便于定位"数据没到"还是"渲染出错"
  anniversaries: getAnniversaryState,
  friends: getFriendState,
  homeCelebrations,
  friendCelebrations,
  celebrationCard,
  loadAnniversaries,
  loadFriendAnniversaries,
  paintHome,
};
window.__daylogState = state;
