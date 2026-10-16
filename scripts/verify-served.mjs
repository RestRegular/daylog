/**
 * 核验「服务器实际返回的前端文件」是否包含各项修复。
 * 直接抓 HTTP 响应比对，而不是看磁盘文件——避免"改了但没生效"的假象。
 * 运行：node scripts/verify-served.mjs [baseUrl]
 */
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:81';

import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 从脚本位置推出项目根目录：pm2 相关的核验要直接读磁盘上的源码/配置
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

const get = async (p) => (await fetch(BASE + p)).text();
/** 取出某个选择器的规则块（行首锚定，避免匹配到 @media 里缩进的同名规则） */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${escaped} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return m ? m[1] : '';
}

const css = await get('/css/style.css');
const app = await get('/js/app.js');
const ui = await get('/js/ui.js');
const dbg = await get('/js/debug.js');
const friendsJs = await get('/js/friends.js');

// ---------------- 底部面板 ----------------
console.log('\n▸ 底部面板（一个遮罩层只能有一个 .sheet）');
{
  const customStart = ui.indexOf('if (custom) {');
  const buildStart = ui.indexOf('const backdrop = el(');
  const customBranch = customStart !== -1 && buildStart > customStart ? ui.slice(customStart, buildStart) : '';
  check('找到「自备遮罩层」分支', customBranch.length > 100, `长度 ${customBranch.length}`);
  check('自备分支直接复用调用方的 .sheet', customBranch.includes("backdrop.querySelector('.sheet')"));
  check('自备分支不再 append 空 .sheet', !customBranch.includes('backdrop.append('));
  check('复用保护：检测遮罩层已被占用', customBranch.includes('const reused = sheetStack.some'));
  check('复用保护：复用时不再重复挂载', customBranch.includes('if (!reused && !backdrop.isConnected)'));
  check('遮罩点击有 sheet.contains 保护', customBranch.includes('sheet.contains(e.target)'));
  check('自建分支仍会 append 新面板', /backdrop\.append\(sheet\)/.test(ui.slice(buildStart)));
  check('提供结构自检接口 sheetDebugInfo', ui.includes('export function sheetDebugInfo'));
}

// ---------------- 面板样式 ----------------
console.log('\n▸ 面板样式（宽度/居中/隐藏元素）');
{
  const backdrop = blockOf(css, '.sheet-backdrop');
  const sheet = blockOf(css, '.sheet');
  check('遮罩层是固定定位并铺满视口', backdrop.includes('position: fixed') && backdrop.includes('inset: 0'));
  check('遮罩层显式 left/right（宽屏不收缩成内容宽）', backdrop.includes('left: 0') && backdrop.includes('right: 0'));
  check('遮罩层显式 width: 100%', backdrop.includes('width: 100%'));
  check('遮罩层不再用 flex 对齐（避免平移出屏）', !backdrop.includes('align-items: flex-end') && !backdrop.includes('justify-content: center'));
  check('面板用 margin 居中贴底', sheet.includes('margin: auto auto 0'));
  check('面板显式 transform: none', sheet.includes('transform: none'));
  check('[hidden] 有显式 display:none', /\[hidden\] \{[^}]*display: none/.test(css));
}

// ---------------- 日期导航 ----------------
console.log('\n▸ 日期导航（第一排：今天+日期+左右切换；第二排：控件靠左）');
{
  const nav = blockOf(css, '.day-nav');
  check('找到 .day-nav 规则', nav.length > 30);
  check('.day-nav 是纵向两排', nav.includes('flex-direction: column'));
  check('第一排两端对齐', /\.day-nav-row\.main-row \{[\s\S]*?justify-content: space-between/.test(css));
  check('第二排控件靠左', /\.day-nav-row\.ctrl-row \{[\s\S]*?justify-content: flex-start/.test(css));
  const label = blockOf(css, '.day-nav-label');
  check('日期标签居中且不换行', label.includes('justify-content: center') && label.includes('white-space: nowrap'));
  check('日期文字过长时省略号', /\.day-nav-label span \{[\s\S]*?text-overflow: ellipsis/.test(css));
  check('已移除透明覆盖层', !css.includes('.date-overlay') && !app.includes('date-overlay'));
  check('窄屏不再隐藏日期选择与今天按钮', !/\.day-nav \.date-picker,[\s\S]{0,80}display: none/.test(css));
  check('日期导航抽成 datenav.js 并被 app 使用', app.includes("from './datenav.js'") && app.includes('buildDateNav('));
  {
    const datenav = await get('/js/datenav.js');
    check('datenav 生成两排结构', datenav.includes("'day-nav-row main-row'") && datenav.includes("'day-nav-row ctrl-row'"));
    check('datenav 第一排含 左按钮+标签+右按钮', /main-row' \}, prev, label, next\)/.test(datenav));
    check('datenav 第二排含 日期选择+看全部+今天', /ctrl-row' \}, datePicker, allToggle, todayBtn\)/.test(datenav));
    check('分享页也复用 datenav', (await get('/js/share.js')).includes('buildDateNav'));
  }
}

// ---------------- 日历 ----------------
console.log('\n▸ 日历（正方形格子 + 横向铺满 + 桌面限宽）');
{
  const grid = blockOf(css, '.cal-grid');
  const cell = blockOf(css, '.cal-cell');
  check('找到 .cal-grid 规则', grid.length > 30);
  check('列宽 clamp 固定（保证格子是正方形）', /grid-template-columns:\s*repeat\(7,\s*clamp\(/.test(grid));
  check('剩余宽度由 space-between 变间隔（铺满）', /justify-content:\s*space-between/.test(grid));
  check('不再用 repeat(7, 1fr)（会把格子拉成长方形）', !/repeat\(7,\s*1fr\)/.test(grid));
  check('手机端网格没有 max-width', !/max-width/.test(grid));
  check('找到 .cal-cell 规则', cell.length > 30);
  check('格子是正方形（aspect-ratio: 1/1）', /aspect-ratio:\s*1\s*\/\s*1/.test(cell));
  check('格子没有 max-height（否则被压扁成矩形）', !cell.includes('max-height'));
  check('桌面才给日历限宽（避免间隔被拉到上百像素）', /@media \(min-width: 760px\)[\s\S]*?\.cal-wrap \{[\s\S]*?max-width:\s*420px/.test(css));
  check('app.js 用 .cal-wrap 包裹网格', app.includes("class: 'cal-wrap'"));
}

// ---------------- 其他前端资源 ----------------
console.log('\n▸ 其他');
{
  check('app.js 已接入 debug 工具', app.includes("from './debug.js'"));
  check('设置页显示 build 号', app.includes('build ${BUILD}'));
  check('debug.js 暴露 window.daylogDebugLayout', dbg.includes('window.daylogDebugLayout = debugLayout'));
  check('debug.js 输出祖先 transform 信息', dbg.includes('ancestors'));
  check('debug.js 检查「一遮罩一面板」不变量', dbg.includes('sheets:'));
  check('Service Worker 走网络优先（避免看到旧代码）', (await get('/sw.js')).includes('network-first') || (await get('/sw.js')).includes("cache: 'no-store'"));
}

// ---------------- 好友共享 ----------------
console.log('\n▸ 好友共享（添加好友 + 时间线合并 + 区分显示）');
{
  const html = await get('/index.html');
  check('存在好友页模块 /js/friends.js', friendsJs.length > 500);
  check('好友页有「添加好友」入口', friendsJs.includes('添加好友'));
  check('好友页能查找用户', friendsJs.includes('api.lookupUser'));
  check('好友页能同意/拒绝请求', friendsJs.includes('api.acceptFriend') && friendsJs.includes('拒绝'));
  check('好友页能设置备注', friendsJs.includes('setFriendAlias'));
  // 备注名的 UPDATE 必须按「这一行的两个方向」定位：只写 requester=? AND addressee=?
  // 时，接收方（对方来加的我）设置会命中 0 行 —— 接口回 200 但什么都没存进去
  {
    const storeSrc = readFileSync(new URL('../src/db/store.js', import.meta.url), 'utf8');
    const aliasSql = /setAliasByRequester: p\(`([\s\S]*?)`\)/.exec(storeSrc)?.[1] || '';
    check(
      '备注定名的 SQL 覆盖两个方向（接收方也能设备注）',
      /requester_id = \? AND addressee_id = \?\)\s*OR\s*\(requester_id = \? AND addressee_id = \?/.test(aliasSql),
      aliasSql.replace(/\s+/g, ' ').slice(0, 140)
    );
    check('好友时间线页的名片用访问者的备注名', /function ownerProfile\(ctx, owner, viewerId = null\)/.test(readFileSync(new URL('../src/http/routes/share.js', import.meta.url), 'utf8')));
  }
  check('好友页能解除好友', friendsJs.includes('removeFriend'));
  check('底部导航有「好友」入口', html.includes('data-view="friends"'));
  check('好友入口带待处理红点', html.includes('id="friends-badge"'));

  check('app.js 注册了 #/friends 路由', app.includes('friends: viewFriends'));
  check('app.js 有时间线范围切换（我/好友/全部）', app.includes("['mine', '我'") && app.includes("['friends', '好友'") && app.includes("['all', '全部'"));
  check('请求带 scope 参数', app.includes('scope,'));
  check('卡片区分好友动态（传 meId）', app.includes('meId: state.user?.id'));

  // 防回归：视图函数里 loadFriends().then(...) 中调用 render() 会造成
  // render → viewFriends → loadFriends → render 的无限循环（真机上表现为整页卡死）
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const viewFn = /function viewFriends\([\s\S]*?\n\}/.exec(app);
  const viewBody = stripComments(viewFn ? viewFn[0] : '');
  check('好友视图不调用 render()', viewBody.length > 50 && !/\brender\(\)/.test(viewBody), viewBody.slice(0, 80));
  check(
    '好友视图的异步回调里也没有 render()',
    !/loadFriends\([^)]*\)\.then\([\s\S]{0,200}?render\(\)/.test(stripComments(app))
  );
  check(
    'bootstrap 里 loadFriends 的回调不整体重绘',
    !/loadFriends\(\{ silent: true \}\)\.then\(\(\) => \{[\s\S]{0,200}?render\(\)/.test(stripComments(app))
  );
  check('hashchange 有「参数变化或数据过期」判断 + loading 防抖', app.includes('changed || state.home.stale') && app.includes('!state.home.loading'));
  // 防回归：编辑动态新增的图片/视频曾经被丢掉（编辑模式只发了 JSON，没有上传附件）
  const composer = await get('/js/composer.js');
  check(
    '新加的附件会走 multipart 上传（编辑时也一样）',
    composer.includes('const fresh = state.attachments.filter((a) => !a.existing)') &&
      composer.includes('if (fresh.length) {') &&
      composer.includes('onSubmit({ formData: fd')
  );
  check(
    '已有附件不重新上传（编辑时只发 removeMediaIds + mediaOrder，走 JSON）',
    composer.includes('...(editing ? { removeMediaIds: state.removed, mediaOrder } : {})') &&
      /a\.existing \? a\.mediaId : `new:\$\{fresh\.indexOf\(a\)\}`/.test(composer) &&
      composer.includes('await onSubmit({ json, id: post?.id })')
  );
  check('composer 不再因编辑模式而跳过附件', !/if \(editing \|\| !state\.attachments\.length\)/.test(composer));

  // 发布面板：间距（内容必须包在 .sheet-body 里）+ 长按拖动排序
  {
    check(
      '面板内容包在 .sheet-body 里（否则左右贴边、段间没间距、超高不能滚）',
      /el\(\s*'div',\s*\{ class: 'sheet-body' \}/.test(composer) && composer.includes('sheet.append(header, body)')
    );
    check('不再把 textarea/工具栏直接挂在 .sheet 上', !composer.includes('sheet.append(header, textarea'));
    check('面板有独立的内边距与段间距', (() => {
      const body = blockOf(css, '.composer .sheet-body');
      return body.includes('padding: 14px 16px 16px') && body.includes('gap: 12px');
    })());
    check('面板标题栏与内容左右对齐', blockOf(css, '.composer .sheet-head').includes('padding: 14px 16px 10px'));
    check('.sheet-body 允许在 flex 列里收缩（内容超高时滚动而不是被压扁）', /\.sheet-body \{[\s\S]{0,200}?min-height: 0/.test(css));

    check('支持长按进入拖动排序', composer.includes('REORDER_HOLD_MS') && composer.includes('function beginDrag(tile, event)'));
    check('长按前移动手指视为滚动（不误触发排序）', composer.includes('REORDER_TOLERANCE') && composer.includes('cancelHold()'));
    check('拖动顺序写回 state.attachments（上传顺序跟着变）', composer.includes('function commitOrder') && composer.includes('state.attachments = ordered'));
    check('拖动中阻止页面横向滚动（touchmove 非 passive）', composer.includes("'touchmove'") && composer.includes('passive: false'));
    check('拖动中禁止系统长按菜单', composer.includes("'contextmenu'") && css.includes('.attach-strip.reordering'));
    check('附件图片不吃指针事件（不被图片原生拖拽/长按抢走）', /\.attach-tile img \{[\s\S]{0,240}?pointer-events: none/.test(css));
    check('有「长按可拖动排序」提示', composer.includes('attach-hint') && css.includes('.attach-hint'));
    check('删除附件按 key 而不是渲染时的下标', composer.includes('state.attachments.filter((a) => a !== item)'));
    check('附件带稳定 key（拖动后能映射回 state）', composer.includes('key: `a${(attachSeq += 1)}`'));

    // 跟手浮层：不能被附件条裁切，且要有连续的跟随动画
    check('拖动的是一块跟手浮层', composer.includes('function createGhost(tile)') && composer.includes('function ghostLoop()'));
    check('浮层用 rAF 逐帧跟随（不是一格一格跳）', /requestAnimationFrame\(ghostLoop\)/.test(composer) && composer.includes('drag.x += (drag.targetX - drag.x) * k'));
    check('浮层挂到 body 上并固定定位（附件条是 overflow 容器，会裁掉放大的格子）', composer.includes('document.body.append(ghost)') && composer.includes("'attach-ghost'"));
    check('浮层 CSS：fixed + 高于遮罩 + 抬起动画', (() => {
      const ghost = blockOf(css, '.attach-ghost');
      return (
        ghost.includes('position: fixed') &&
        /z-index: 70/.test(ghost) &&
        css.includes('@keyframes attach-lift') &&
        /\.attach-ghost-inner \{[\s\S]{0,200}?animation: attach-lift/.test(css)
      );
    })());
    check('原格子只做占位（不再放大，避免被上下边界裁掉）', (() => {
      const ph = blockOf(css, '.attach-tile.dragging');
      return ph.includes('opacity') && !/transform:\s*scale/.test(ph);
    })());
    check('松手后浮层滑回目标格并被清理', composer.includes('function discardGhost()') && /setTimeout\(\(\) => ghost\.remove\(\)/.test(composer));
    check('关面板 / 提交时会兜底清掉浮层', (composer.match(/discardGhost\(\)/g) || []).length >= 3);
  }
  check('api 提供 multipart 的 PATCH 更新', app.length > 0 && (await get('/js/api.js')).includes('updatePostMultipart'));
  check('updatePostMultipart 用 PATCH 方法', (await get('/js/api.js')).includes("method = 'POST'"));
  check('后端 PATCH 支持 multipart', (await get('/api/health')).length >= 0);
  check('app.js 编辑走 updatePostMultipart', app.includes('api.updatePostMultipart(id, formData'));
  // 防回归：发布后"切到别的界面再回来"看不到新记录 —— 必须有 stale 机制强制重载
  check('有 stale 标记机制（数据过期则重载）', app.includes('state.home.stale'));
  check('回到首页会标记 stale 并重载', /target === 'home'[\s\S]{0,400}?stale: true[\s\S]{0,200}?loadHome\(/.test(app));
  check('切换时间范围/日期后置 stale', app.includes("stale: false") && app.includes("stale: true"));
  // 防回归：在途请求回来后不得覆盖更新的数据（否则会出现"记录又不见了"）
  check('每一页都有请求 token 丢弃过期响应', app.includes('pane.loadToken !== token'));
  check('编辑/删除后会标记三页缓存过期', /markHomeStale\(\)/.test(app) && /editPost\([\s\S]{0,900}?markHomeStale\(\)/.test(app));
  // 所有 loadHome 调用都必须显式传 scope，否则会被默认值悄悄重置范围
  const loadHomeCalls = [...app.matchAll(/loadHome\(\{([^}]*)\}/g)].map((m) => m[1]);
  check(
    'loadHome 调用都显式带 scope',
    loadHomeCalls.length > 3 && loadHomeCalls.every((args) => args.includes('scope')),
    `共 ${loadHomeCalls.length} 处，缺 scope：${loadHomeCalls.filter((a) => !a.includes('scope')).length}`
  );
  // 防回归：跳转时若先改 state 再改 hash，hashchange 会认为"参数没变"而不再加载，
  // 表现为点「我/好友/全部」或切换日期时列表不更新
  check(
    'goto 不会在改 hash 前先写 state（否则 hashchange 判重失效）',
    /const goto = \([\s\S]{0,700}?if \(location\.hash === hash\) \{/.test(app) &&
      /const goto = \([\s\S]*?location\.hash = hash;/.test(app)
  );

  const timeline = await get('/js/timeline.js');
  check('好友卡片带 from-friend 样式类', timeline.includes('from-friend'));
  check('好友卡片显示作者', timeline.includes('post-author'));
  check('好友卡片带「好友」徽标', timeline.includes('friend-badge'));
  check('好友卡片不显示编辑/删除按钮', timeline.includes('canEdit && isMine'));

  // 好友卡片现在只靠主题色区分（不再有左侧色条），框架和自己的完全一致
  check('CSS 有好友卡片样式（主题色调色）', css.includes('.post.tinted') && css.includes('--card-accent'));
  check('CSS 有范围切换样式', css.includes('.scope-tabs'));
  check('CSS 有好友列表样式', css.includes('.friend-row'));
  check('CSS 有红点样式', css.includes('.nav-badge'));
  check('Service Worker 预缓存了 friends.js', (await get('/sw.js')).includes("'/js/friends.js'"));
}

// ---------------- 会话状态与四个细节修复 ----------------
console.log('\n▸ 会话状态（换账号不串数据 + 进入即全量加载）');
{
  check('登录后会清空用户缓存', /resetSessionCaches\(\)/.test(app));
  check('有 refreshEverything 一次性拉全数据', app.includes('async function refreshEverything'));
  check('进入应用即全量拉取（不用手动刷新）', /if \(state\.view === 'home'\) \{[\s\S]{0,200}?refreshEverything\(\)/.test(app));
  check('登录成功后调用 refreshEverything', /resetSessionCaches\(\)[\s\S]{0,400}?refreshEverything\(\)/.test(app));
  check('退出登录清空缓存', /state\.user = null;[\s\S]{0,200}?resetSessionCaches\(\)/.test(app));
  check('清缓存会使在途请求作废（loadToken 自增）', /loadToken: \(state\.home\.loadToken \|\| 0\) \+ 1/.test(app));
  check('好友缓存有 reset 函数并从 app 调用', friendsJs.includes('export function resetFriendsCache') && app.includes('resetFriendsCache'));
  check('好友页标题不是「设置」', /state\.view === 'friends'[\s\S]{0,200}?title\.textContent = '好友'/.test(app));
  check('添加好友提示已缩短', friendsJs.includes('用户名不区分大小写') && !friendsJs.includes('让对方在「设置」页把用户名告诉你'));
}

console.log('\n▸ 弹窗内日期条的粘性位置');
{
  check('弹窗打开时把 --top-h 归零（否则日期条压住记录）', /body\.no-scroll \{[\s\S]*?--top-h: 0px/.test(css));
  check('弹窗内日期条用面板底色', /\.sheet \.day-header \{/.test(css));
}

console.log('\n▸ 统计区域（刚登录进来不能是空的）');
{
  const timeline = await get('/js/timeline.js');
  check('statsBar 无数据时也返回占位元素', /export function statsBar\(stats, \{ placeholder = false \}/.test(timeline));
  check('statsBar 不再返回 null', !/if \(!stats\) return null/.test(timeline));
  check('占位显示为 –', timeline.includes('–'));
  check('提供就地更新函数 updateStatsBar', timeline.includes('export function updateStatsBar'));
  check('统计条带 data-stats-bar 便于就地更新', timeline.includes('data-stats-bar'));
  check('设置页用占位渲染统计', app.includes('statsBar(u.stats, { placeholder: !u.stats })'));
  check('设置页缺统计时会补拉', /if \(!u\.stats\) loadMyStats\(\)/.test(app));
  check('有 loadMyStats 并在全量刷新中调用', app.includes('async function loadMyStats') && /loadMyStats\(\),/.test(app));  check('分享页关闭统计时不显示统计条', (await get('/js/share.js')).includes('if (profile.stats) card.append(statsBar'));
  check('CSS 有占位样式', css.includes('.stats.placeholder'));
}

console.log('\n▸ 生日 / 纪念日倒计时');
{
  const celebration = await get('/js/celebration.js');
  check('倒计时计算抽成独立模块', celebration.includes('export function nextCelebration'));
  check('用本地时间构造日期（避免差一天）', celebration.includes('new Date(now.getFullYear(), now.getMonth(), now.getDate())') || celebration.includes('new Date(year, month - 1'));
  check('处理 2 月 29 日（钳制到当月最后一天）', celebration.includes('Math.min(day, lastDay)'));
  // 倒计时渲染在「每一页自己的」顶部容器里，ids 只挂在当前页（左右滑动切换的基础）
  {
    check('三页各自带一个 .home-top 容器', /el\('div', \{ class: 'home-top' \}\)/.test(app));
    check('id 只挂在当前页（#home-top / #home-list）', /setAttribute\('id', 'home-top'\)/.test(app) && /setAttribute\('id', 'home-list'\)/.test(app));
    check('有独立的 paintHomeTop', app.includes('function paintHomeTop()'));
    check('paintHome 同时画倒计时与列表', /function paintHome\(\) \{[\s\S]{0,220}?paintHomeTop\(\);[\s\S]{0,140}?paintHomeInner\(\)/.test(app));
    const top = app.slice(app.indexOf('function paintPaneTop('), app.indexOf('function paintHomeTop()'));
    check('倒计时只在 scope=mine 时渲染', /scope !== 'mine'/.test(top));
    check('倒计时与「有没有记录」「是否加载中」解耦', !top.includes('posts.length') && !top.includes('loading'));
    check('CSS 有 #home-top 样式', css.includes('.home-top'));
  }
  check('倒计时卡片有可点编辑入口', (await get('/js/anniversaries.js')).includes("class: 'cd-edit'") || (await get('/js/anniversaries.js')).includes('cd-edit'));
  check('倒计时用独立 CSS 类', css.includes('.countdown .cd-main') && css.includes('.countdown.today'));
  check('app.js 从模块导入纪念日能力', app.includes("from './anniversaries.js'"));
  check('Service Worker 预缓存 celebration.js', (await get('/sw.js')).includes("'/js/celebration.js'"));
}

console.log('\n▸ 日期输入框（手机尺寸）');
{
  check('日期输入框宽度受约束', /\.field input\[type='date'\][\s\S]*?width: 100%/.test(css));
  check('日期输入框有统一高度', /\.field input\[type='date'\][\s\S]*?min-height: 46px/.test(css));
  check('日期输入框去掉了原生外观差异', /\.field input\[type='date'\][\s\S]*?-webkit-appearance: none/.test(css));
  check('输入内容左对齐', css.includes('::-webkit-date-and-time-value'));
  check('页面有 field-hint 提示样式', css.includes('.field-hint'));
}

console.log('\n▸ 纪念日（多条目 / 特别关注 / 日历标注）');
{
  const an = await get('/js/anniversaries.js');
  check('存在纪念日模块', an.length > 800);
  check('支持添加（编辑器）', an.includes('添加纪念日'));
  check('支持修改与移除', an.includes('api.updateAnniversary') && an.includes('api.deleteAnniversary'));
  check('支持特别关注切换', an.includes('special: !item.special'));
  check('图标可选', an.includes('ICON_CHOICES') && an.includes('icon-choice'));
  check('预设只剩 11 个（最后一格留给自定义输入框）', (() => {
    const list = (an.match(/const ICON_CHOICES = \[([^\]]*)\]/) || [])[1] || '';
    return (list.match(/[^,\s]+/g) || []).length === 11;
  })(), (an.match(/const ICON_CHOICES = \[([^\]]*)\]/) || [])[1]);
  check('自定义输入框就在图标网格里（和预设同样尺寸）', /iconGrid\.append\(iconInput\)/.test(an) && css.includes('.icon-input') && /\.icon-input \{[\s\S]{0,260}?box-sizing: border-box/.test(css));
  check('自定义图标：placeholder 是铅笔', an.includes("placeholder: '✏️'"));
  check('自定义图标只收一个表情（文字不认）', an.includes('Extended_Pictographic') && an.includes('grapheme'));
  check('编辑器说明文案已精简', an.includes("placeholder: '说明'") && an.includes('最多 ${NOTE_MAX} 个字，超出会截断') && !an.includes('显示时单独占一行'));
  check('日期标签写明「年份用于计算周年数」', an.includes('日期（年份用于计算周年数）'));
  // 倒计时卡片：倒计时一行 + 说明一行；没有说明就只有一行
  check('卡片分成「倒计时行」+「说明行」两段', /const top = el\('div', \{ class: 'cd-top' \}\)/.test(an) && an.includes("el('div', { class: 'cd-meta' })"));
  check('有说明时日期挪到第二行（避免第一行被挤成省略号）', an.includes('let metaDate = null') && an.includes('if (note) metaDate = dateEl'));
  check('没有说明时日期留在第一行（卡片只有一行）', an.includes('else top.append(dateEl)'));
  check('说明行可换行、不截断用户说明', /\.countdown \.cd-meta \{[\s\S]{0,240}?flex-wrap: wrap/.test(css));
  check('第一行不换行（箭头不会被挤下去）', /\.countdown \.cd-top \{[\s\S]{0,240}?flex-wrap: nowrap/.test(css));
  check('可空项都先判断（不会插出字面量 "null"）', an.includes('if (ageEl) {') && an.includes('if (avatar) top.append(avatar)'));
  check('自定义图标输入框有"输入框的样子"（虚线 + 灰底）', /\.icon-input \{[\s\S]{0,420}?border-style: dashed/.test(css) && /\.icon-input \{[\s\S]{0,420}?background: var\(--bg-soft\)/.test(css));
  check('聚焦时变实线', /\.icon-input:focus \{[\s\S]{0,200}?border-style: solid/.test(css));
  check('首页用「生日 + 特别关注」两个倒计时', an.includes('export function homeCelebrations') && an.includes('specialAnniversary'));
  check('倒计时卡片支持名称/图标/说明', an.includes('cd-note') || an.includes('item.note'));
  check('设置页接入纪念日管理区', app.includes('anniversariesSection(') && app.includes("from './anniversaries.js'"));
  check('首页上下文会拉纪念日（倒计时数据源）', /ensureHomeContext[\s\S]{0,400}?loadAnniversaries\(\)/.test(app));
  check('退出登录清空纪念日缓存', app.includes('resetAnniversariesCache'));
  check('日历渲染纪念日标记', app.includes('marks[key]') && app.includes('cal-marks'));
  check('日历下方列出本月纪念日', app.includes('本月纪念日'));
  check('日历下方列出全部倒计时', app.includes('全部倒计时') && app.includes('sortedAnniversaries()'));
  check('CSS 有纪念日标注样式', css.includes('.cal-cell.has-anniversary') && css.includes('.cal-anniversaries'));
  check('CSS 有纪念日管理样式', css.includes('.anniversary-row') && css.includes('.icon-grid'));
  check('Service Worker 预缓存 anniversaries.js', (await get('/sw.js')).includes("'/js/anniversaries.js'"));

  // ---- 说明（第三排 / 20 字截断）/ 特别关注样式 / 自定义图标 / 倒计时年份 ----
  check('说明有 20 字上限常量', an.includes('NOTE_MAX = 20'));
  check('编辑器限制说明输入长度', /maxlength: NOTE_MAX/.test(an));
  check('说明按码点截断（emoji 不会被切坏）', an.includes('export function truncateNote') && an.includes('clipChars'));
  check('自定义图标取字素（组合 emoji 不被切坏）', an.includes('export function normalizeIcon') && an.includes('Intl.Segmenter'));
  check('编辑器有自定义图标输入框', an.includes('icon-input') && an.includes('自定义图标'));
  check('设置页说明单独成第三排', an.includes("class: 'an-note'") && an.includes("class: 'an-meta muted'"));
  check('第二排不再拼接说明', !an.includes('${item.note}'));
  check('倒计时副文案带年份', /\$\{next\.year\} 年 \$\{next\.month\} 月 \$\{next\.day\} 日/.test(an));
  check('倒计时卡片允许换行（说明不挤主文案）', /\.countdown \{[\s\S]*?flex-wrap: wrap/.test(css));
  check('主文案有最小宽度（不被说明挤成省略号）', /\.countdown \.cd-main \{[\s\S]*?min-width: 8\.5em/.test(css));
  check('说明最多显示两行', /\.an-text \.an-note \{[\s\S]*?-webkit-line-clamp: 2/.test(css));
  {
    const row = blockOf(css, '.anniversary-row');
    const specialRow = blockOf(css, '.anniversary-row.special');
    check('纪念日行左右内边距对称（内容位置不变，底色铺满）', row.includes('padding: 10px 8px') && row.includes('margin: 0 -8px'));
    check('特别关注不再单侧内缩（不会看起来变窄）', !specialRow.includes('padding-right') && !specialRow.includes('padding-left'));
  }
  check('添加纪念日后就地重绘列表（不用手动刷新）', an.includes('onSaved: () => { paint(); onChanged?.(); }'));
  check('在日历页发帖后自动刷新日历', /state\.view === 'calendar'\) await loadCalendar/.test(app));

  // 防回归：不能再出现「调用已删除函数」导致整页空白
  check('paintHome 有渲染守卫', app.includes("safePaint('paintHome'"));
  check('paintCalendar 有渲染守卫', app.includes("safePaint('paintCalendar'"));
  {
    const codeOnly = app.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    check('代码里不再引用已删除的 nextAnniversary', !/\bnextAnniversary\s*\(/.test(codeOnly));
  }
}

console.log('\n▸ 首页好友筛选条 + 分享范围 + 分享页筛选');
{
  // 计数节点必须常驻，否则刷新后好友数会消失（真实回归）
  check('「好友」计数节点始终创建', /key === 'friends'[\s\S]{0,200}?data-friend-count/.test(app));
  check('计数缺失时会补建节点', /let node = document\.querySelector\('\[data-friend-count\]'\)[\s\S]{0,300}?tab\.append\(node\)/.test(app));

  // 好友筛选条（挂在「好友」那一页里，跟着页面一起滑动）
  check('有好友筛选条实现', app.includes('function buildFriendStrip'));
  check('头像条只建在「好友」那一页', /function paintFriendStrip\(\)[\s\S]{0,400}?buildFriendStrip\(/.test(app) && app.includes("pager?.panes?.friends"));
  check(
    '「全部」/「我」两页没有头像条（只有 paintFriendStrip 会建）',
    (app.match(/[=?]\s*buildFriendStrip\(/g) || []).length === 1 && /function paintFriendStrip\(\)[\s\S]{0,500}?buildFriendStrip\(/.test(app)
  );
  check('标签顺序为 全部 / 好友 / 我', /tabDefs = \[\s*\['all', '全部'[\s\S]{0,120}?\['friends', '好友'[\s\S]{0,120}?\['mine', '我'/.test(app));
  check('筛选条用头像 + @用户名', app.includes('chip-avatar') && app.includes('@${u.username}'));
  check('头像环表示这天有无记录', app.includes("chip-avatar${count ? ' has-post' : ''}"));
  check('第一项为「全部好友」', app.includes("'全部好友'") && !app.includes('全部人'));
  check('「全部好友」用自己头像的高斯模糊版', app.includes("class: 'blur'") && css.includes('filter: blur(5px)'));
  check('头像条下方说明文本已移除', !app.includes('friend-strip-hint') && !css.includes('friend-strip-hint'));
  check('点击头像筛选（好友页内就地切换）', app.includes('function pickFriend(id)') && /onPick: \(id\) => pickFriend\(id\)/.test(app));
  check('只有「好友」页带筛选参数', app.includes("const useFriend = apiScope === 'friends' ? friendFilter : null") && app.includes('friendId: useFriend || undefined'));
  check('CSS 有横向滚动筛选条', css.includes('.friend-strip') && /\.friend-strip \{[\s\S]*?overflow-x: auto/.test(css));

  // 回归：首页渲染依赖的数据（好友头像条 / 纪念日倒计时）必须"先到位再画"
  // 曾经 loadAnniversaries 与 loadHome 并行，loadHome 内部先 paintHome，
  // 结果倒计时画不出来、之后又没人重绘 —— 刷新后倒计时消失，切标签才出现。
  {
    const body = (startMarker, endMarker) => {
      const s = app.indexOf(startMarker);
      if (s === -1) return '';
      const e = app.indexOf(endMarker, s);
      return e === -1 ? app.slice(s) : app.slice(s, e);
    };
    const ensure = body('async function ensureHomeContext', '// ---------------------------------------------------------------- 启动');
    check('存在 ensureHomeContext 统一前置依赖', ensure.includes('loadFriends(') && ensure.includes('loadAnniversaries()'));
    check('前置依赖只在未加载时才请求', ensure.includes('!getFriendState().loaded') && ensure.includes('!getAnniversaryState().loaded'));

    const refresh = body('async function refreshEverything', 'async function ensureHomeContext');
    const iEnsure = refresh.indexOf('await ensureHomeContext()');
    // 注意：必须匹配带参数的调用，否则会命中 ensureHomeContext 定义里的 'loadHome(' 子串
    const iHome = refresh.indexOf('loadHome({ date:');
    const iPaint = refresh.indexOf('if (state.view === \'home\') paintHome();');
    check('全量刷新里能找到关键步骤', iEnsure !== -1 && iHome !== -1 && iPaint !== -1, `ensure@${iEnsure} home@${iHome} paint@${iPaint}`);
    check('先 await 上下文（好友+纪念日），再拉时间线', iEnsure !== -1 && iHome !== -1 && iEnsure < iHome);
    check('纪念日不再与 loadHome 并行（否则画完才到）', !/loadHome\(\{ date:[\s\S]{0,240}?loadAnniversaries\(\)/.test(refresh));
    check('上下文到位后才重绘首页', iEnsure !== -1 && iPaint !== -1 && iEnsure < iPaint);

    // 会话中途进入首页（例如直接刷新到 #/home?scope=mine）
    check(
      'viewHome 缺上下文时会补拉并重绘',
      /if \(!getFriendState\(\)\.loaded \|\| !getAnniversaryState\(\)\.loaded\) \{[\s\S]{0,400}?paintHome\(\)/.test(app)
    );
    check('不是首页时也先等好友再重绘', /loadFriends\(\{ silent: true \}\)\.then\(\(\) => \{[\s\S]{0,400}?paintCalendar\(\)/.test(app));
  }

  // 分享面板：现场生成一条限时链接（范围 + 有效期都绑在链接上，URL 里不再有 range/date）
  {
    const sheet = app.slice(app.indexOf('function openShareSheet'), app.indexOf('function toggleSwitch('));
    check('找到分享面板实现', sheet.length > 500, `长度 ${sheet.length}`);
    check(
      '三个范围：选中的日期 / 今日时间线 / 全部时间线',
      sheet.includes("['date', ['选中的日期', date]]") &&
        sheet.includes("['today', ['今日时间线', today]]") &&
        sheet.includes("['all', ['全部时间线', '可自由筛选']]"),
      '三个范围按钮定义缺失'
    );
    check('面板里还要选有效期（1 小时 / 1 天 / 7 天 / 30 天）', sheet.includes('SHARE_TTL_OPTIONS') && sheet.includes('ttl-tabs'));
    check('点「生成分享链接」才现场创建链接', sheet.includes('generateShareLink(') && sheet.includes('生成分享链接'));
    check(
      '范围 + 有效期一起提交给 /api/share/links',
      /generateShareLink\(\{[\s\S]{0,260}?scope: kind === 'all' \? 'all' : 'day'[\s\S]{0,160}?hours,/.test(sheet)
    );
    check(
      '结果块给链接 + 二维码 + 复制/系统分享',
      sheet.includes('shareResultBox(') && app.includes('api/qr?data=') && app.includes('系统分享') && app.includes('预览访客视角')
    );
    check('改了范围或时效会清掉上一条结果（免得发错链接）', /function sync\(\)[\s\S]{0,500}?resultBox\.textContent = ''/.test(sheet));
  }
  check(
    '分享链接不再带 range/date 参数',
    !app.includes("new URLSearchParams({ range: 'all' })") && !app.includes("range: 'date', date") && !app.includes('shareRangeQuery')
  );

  // 分享页（/s/<限时令牌>）：范围由链接决定，页面上不再给筛选入口
  const share = await get('/js/share.js');
  check('分享页支持 /s/<token> 入口', share.includes('/^\\/s\\/([A-Za-z0-9]+)/'));
  check('老 /share/<token> 仍返回页面（由页面提示链接无效）', share.includes('/^\\/share\\/([A-Za-z0-9]+)/'));
  check('分享链接页不发筛选 UI，只说明这条链接能看到什么', /if \(isLocked\) \{[\s\S]{0,240}?linkNotice\(state\.page\)/.test(share));
  check('筛选 UI 只留给应用内的好友时间线', /else \{[\s\S]{0,240}?filterBox = buildFilterBar\(\)/.test(share));
  check('分享链接的请求不带 range/date', /request = api\.sharePosts\(token, \{ limit: 20, \.\.\.extra \}\)/.test(share));
  check('好友时间线才按 今天/选日期/全部/按月 传参', share.includes('api.friendTimelinePosts(friendName'));
  check('好友时间线仍复用日期导航', share.includes('buildDateNav'));
  check('分享页已移除重复的范围摘要（今天 · 今天 / 全部时间线 / 2026 年 10 月 · 整月）', !share.includes('share-summary') && !share.includes('rangeSummary'));
  check('分享页不再显示「全部时间线：按天分组…」提示', !share.includes('按天分组'));
  check('分享页空状态用简洁标题', share.includes('function emptyTitle') && /dayLabel\(day\)/.test(share));
  check('分享页有刷新守卫（按钮不会一直转）', /classList\.contains\('spin'\)[\s\S]{0,200}?finally[\s\S]{0,80}?classList\.remove\('spin'\)/.test(share));
  check('CSS 有范围切换样式', css.includes('.range-tabs') && css.includes('.range-tab.active'));

  // 后端能力
  const health = await get('/api/health');
  check('服务在运行（分享/筛选接口可用）', JSON.parse(health).ok === true);
}

console.log('\n▸ 限时分享链接（范围绑定 / 失效语义 / 管理入口）');
{
  const share = await get('/js/share.js');
  check('顶部说明这条链接的范围与有效期', share.includes('function linkNotice(link)') && share.includes('这是一个限时分享：') && share.includes('分钟后过期'));
  check(
    '过期 / 被撤销 / 无效 三种文案分开',
    share.includes("'这个分享链接已过期'") && share.includes("'对方已撤销这个链接'") && share.includes("'这个分享链接无效'")
  );
  check('失效码分别处理（share_expired / share_revoked / not_found）', /'share_expired', 'share_revoked', 'not_found'/.test(share));
  check('好友视图门禁文案（需登录 + 是好友）', share.includes("'login_required'") && share.includes("'not_friend'") && share.includes('只有好友才能看 TA 的时间线'));
  check(
    '支持 /u/<用户名>/timeline 入口',
    /location\.pathname\.match\(\/\^\\\/u\\\//.test(share) || share.includes('/^\\/u\\/([A-Za-z0-9_.-]+)\\/timeline/')
  );

  // API 客户端：新模型走 /api/s/ 与 /api/share/links
  const api = await get('/js/api.js');
  check('api.js 用 /api/s/ 读分享链接', api.includes('`/api/s/${encodeURIComponent(token)}`') && api.includes('`/api/s/${encodeURIComponent(token)}/posts?'));
  check(
    'api.js 用 /api/share/links 生成 / 列出 / 撤销链接',
    api.includes("request('/api/share/links', { method: 'POST', body: payload })") &&
      api.includes("shareLinks: () => request('/api/share/links')") &&
      api.includes('`/api/share/links/${encodeURIComponent(token)}`, { method: \'DELETE\' }')
  );
  check('api.js 的好友时间线走 /api/u/<name>/timeline', api.includes('`/api/u/${encodeURIComponent(name)}/timeline`'));
  check('api.js 不再有旧的分享令牌接口', !api.includes('/api/me/share/rotate') && !api.includes("'/api/share/'"));

  // 分享面板：三个两行按钮 + 直接用首页选中的日期
  {
    const sheet = app.slice(app.indexOf('function openShareSheet'), app.indexOf('function toggleSwitch('));
    check('分享面板默认选中「选中的日期」', /let kind = 'date'/.test(sheet));
    check('分享日期直接取首页选中日期', /let date = state\.home\.date \|\| today/.test(sheet));
    check('弹窗里按「选中的日期 / 今日时间线 / 全部时间线」生成 day / day / all 三种链接', sheet.includes("scope: kind === 'all' ? 'all' : 'day'"));
    check('「今天」已改为「今日时间线」', sheet.includes("'今日时间线'"));
    check('每个范围按钮两行（标题 + 具体日期）', sheet.includes('rt-title') && sheet.includes('rt-sub'));
    check('二维码下方的说明文本已移除', !sheet.includes('const desc ='));
  }

  // 设置页：范围 + 有效期 + 已生成链接列表（可复制/撤销）
  check(
    '设置页有分享范围选择器（全部 / 某一天 / 某个月）',
    app.includes("el('option', { value: 'all' }, '全部时间线')") &&
      app.includes("el('option', { value: 'day' }, '某一天')") &&
      app.includes("el('option', { value: 'month' }, '某个月')")
  );
  check('设置页有有效期选择器', /const ttlSel = el\(\s*'select'[\s\S]{0,240}?SHARE_TTL_OPTIONS/.test(app));
  check(
    '设置页列出已生成的链接并可撤销',
    app.includes('api.shareLinks()') && app.includes('api.revokeShareLink(link.token)') && app.includes('已生成的链接')
  );
  check('设置页已移除「允许通过链接访问」开关', !app.includes('shareEnabled') && !app.includes('toggleShare'));
  check('CSS 有设置页分享区块样式', css.includes('.share-links') && css.includes('.share-scope-row') && css.includes('.ttl-tabs'));

  // 好友页跳「好友的时间线」
  check('点好友头像能跳 /u/<用户名>/timeline', friendsJs.includes('/u/${encodeURIComponent(user.username)}/timeline'));

  // 后端
  check('后端服务在运行（分享接口可用）', (await get('/api/health')).includes('ok'));
  check('CSS 有分享范围样式（两行按钮 + 分享页说明条）', css.includes('.range-tab .rt-sub') && css.includes('.notice'));
}

console.log('\n▸ 纪念日关联好友');
{
  const an = await get('/js/anniversaries.js');
  check('编辑器里有「关联好友」选择器', an.includes("'关联好友（可选）'") && an.includes('friendSelect'));
  check('没有好友时不显示该字段', an.includes('friends.length'));
  check('保存时会带上 friendId', an.includes('friendId: draft.friendId || null'));
  check('生日也能改关联', /draft\.kind === 'birthday'[\s\S]{0,220}?friendId/.test(an));
  check('列表行显示关联好友标签', an.includes("class: 'tag-pill link'"));
  check('倒计时卡片带好友头像', an.includes('function friendAvatar') && an.includes("class: 'cd-friend'"));
  check('有关联时卡片加 linked 类', an.includes("item.friend ? ' linked' : ''"));
  check('有 friendAnniversaries / friendCelebrations', an.includes('export function friendAnniversaries') && an.includes('export function friendCelebrations'));
  check('有 loadFriendAnniversaries', an.includes('export async function loadFriendAnniversaries'));

  check('首页按好友筛选时显示关联倒计时', /friendCelebrations\(friendFilter\)/.test(app) && /const friendFilter = scope === 'friends' \? state\.home\.friendFilter : null/.test(app));
  check('数据到达后补画倒计时', app.includes('async function ensureFriendCelebrations') && /paintPaneTop\('friends'\)/.test(app));
  check('CSS 有好友头像与 linked 样式', css.includes('.cd-friend') && css.includes('.countdown.linked'));
  check('API 客户端有按好友查询方法', (await get('/js/api.js')).includes('anniversariesOfFriend'));
}

console.log('\n▸ 首页三页滑动切换（不重建视图 / 不闪）');
{
  check('常驻容器 + 轨道', app.includes("class: 'scope-pager'") && app.includes("class: 'scope-track'") && app.includes("class: 'scope-pane'"));
  check('每个格子都有独立缓存（不是共用 state.home）', app.includes('function emptyPaneState()') && app.includes('prev: emptyPaneState()'));
  check('每格各自的请求 token / key（缓存能不能用要看参数）', app.includes('pane.loadToken') && app.includes('function paneKeyOf(scope, date, all, friendFilter)'));
  check('预热其余格子（滑过去不用等）', app.includes('function warmPanes(') && app.includes('pane.loaded && !pane.stale && pane.key ==='));
  check('切标签 = 平移 + 就地重绘（不再 hash → render 重建）', app.includes('function slideToScope(') && /onclick: \(\) => slideToScope\(key\)/.test(app));
  check('改地址用 replaceState（不触发 hashchange 重建）', app.includes('function replaceHomeHash()') && app.includes('history.replaceState'));
  check('ids 只挂在当前格（#home-list 仍可用）', app.includes("top.removeAttribute('id')") && app.includes("list.removeAttribute('id')"));
  check('idle 格不接收点击 + 读屏隐藏', /pane\.el\.classList\.toggle\('idle', idle\)/.test(app) && app.includes("setAttribute('aria-hidden', 'true')"));
  check('容器高度跟着当前格（矮格不留大片空白）', app.includes('function syncPagerHeight()') && app.includes('pager.root.style.height'));
  check('高度变化也做过渡（不"咔"一下）', blockOf(css, '.scope-pager').includes('transition: height'));
  check('横向手势：阈值 + 速度 + 橡皮筋', app.includes('function bindPagerGesture()') && app.includes('Math.abs(vx) > 0.4') && app.includes('mx * 0.35'));
  check('竖向手势让给页面滚动', app.includes('if (Math.abs(my) >= Math.abs(mx))') && blockOf(css, '.scope-pager').includes('touch-action: pan-y'));
  check('拖动时标签高亮先跟手', app.includes('function highlightTab(') && /if \(apiScope !== state\.home\.scope\) highlightTab\(apiScope\)/.test(app));
  check('滑动时不给页面留骨架屏（只有该格首次加载才画）', /if \(data\.loading && host\.querySelector\('\.skeleton'\)\) return/.test(app) && /data\.loaded && data\.key === paneKeyOf/.test(app));

  // ---- 按天连滑（用户 2026-10-10 要的）----
  check(
    '轨道 5 个槽位：[前一天·全部] 全部 好友 我 [后一天·全部]',
    app.includes("const SLOT_ORDER = ['prev', 'all', 'friends', 'mine', 'next']") && app.includes('const DAY_SLOT_DELTA = { prev: -1, next: 1 }')
  );
  check('每格按自己的日期/标签渲染（不共用 state.home.date）', app.includes('function slotPlan(slot)') && /const plan = pane\.plan \|\| slotPlan\(scope\)/.test(app));
  check('轨道平移量按 SLOT_ORDER 算（中间「全部」是下标 1）', app.includes('function currentSlotIndex()') && !/SCOPE_ORDER\.indexOf\(scope\) \* pagerStep/.test(app));
  check(
    '落地两头的按天格 = 换日期 + 回到「全部」标签',
    app.includes('async function slideToDay(delta') && app.includes("scope: 'all'") && app.includes('const nextDate = shiftDayKey(state.home.date, delta)')
  );
  check('预览到的数据搬到中间格（落地不白屏）', app.includes('state.panes.all = { ...peek }') && app.includes("alignTrack('all', { animate: false })"));
  check(
    '松手后有收尾动画：先滑满到那一格，再换天（不是一松手就刹住）',
    app.includes('const SETTLE_MS = 300') &&
      /alignTrack\(fromSlot, \{ animate, ms: SETTLE_MS \}\)/.test(app) &&
      /if \(animate\) await new Promise\(\(r\) => setTimeout\(r, SETTLE_MS \+ 20\)\)/.test(app)
  );
  check(
    '轨道对位统一走 alignTrack，并记住「视觉上停在哪一格」',
    app.includes('function alignTrack(slot,') &&
      app.includes('pager.visualSlot') &&
      app.includes('if (pager && Number.isInteger(pager.visualSlot)) return pager.visualSlot')
  );
  check('落到两头的按天格走 slideToDay，中间格走 slideToScope', app.includes('if (delta) slideToDay(delta);'));
  check('「全部时间线」模式下两头不启用（保持橡皮筋）', app.includes('function slotEnabled(slot)') && app.includes('return !DAY_SLOT_DELTA[slot] || !state.home.all'));
  check('相邻两天的数据就地预热', /const opts = DAY_SLOT_DELTA\[slot\] \? \{ silent: true \}/.test(app));
  check('按天切换后日期条跟着更新', app.includes('homeDateNav.update(nextDate, false)'));
  check('两头按天格的响应不覆盖"今天多少条"的计数', app.includes('const isCurrentDay = !plan.day') && app.includes('if (isCurrentDay) {'));

  check('CSS：轨道层 + 非当前页槽位', css.includes('.scope-track') && css.includes('.scope-pane.idle') && css.includes('will-change: transform'));
  // 卡片阴影左右不能被 clip 掉，但相邻页也不能从这段留白里露出来
  check('滑动容器左右/底部留出阴影空间（负 margin 抵掉）', (() => {
    const pager = blockOf(css, '.scope-pager');
    return /padding: 0 8px 10px/.test(pager) && /margin: 0 -8px -10px/.test(pager);
  })());
  check('页与页之间留 16px 空隙（相邻页不会滑进阴影区）', /\.scope-track \{[\s\S]{0,260}?gap: 16px/.test(css));
  check('翻页步长 = 页宽 + 空隙', app.includes('function pagerStep()') && app.includes('const gap = pager ? parseFloat(getComputedStyle(pager.track).columnGap)'));
}

console.log('\n▸ 好友备注名 / 分享页归属');
{
  const share = await get('/js/share.js');
  check('分享页用「TA 的昵称（我的备注名）」', share.includes('function myAliasFor(') && share.includes('（${alias}）'));
  check('备注名拿不到时静默降级（分享页不要求登录）', /catch \{\s*\n\s*return '';/.test(share));
  check('时间线作者显示名走「备注名优先」', (await get('/js/timeline.js')).includes('post.author.displayName') || (await get('/js/timeline.js')).includes('author.displayName'));
}

console.log('\n▸ 时间线摘要 / 空状态');
{
  // 首页只看 day-header（「今天 N 条」），不再重复一行范围摘要
  check('首页不再渲染范围摘要', !/paintPaneList[\s\S]{0,2600}?class: 'summary'/.test(app));
  check('搜索页仍保留摘要，且放在 renderFeed 之后（renderFeed 会清空容器）', /renderFeed\(host, posts, \{[\s\S]{0,400}?\}\);\s*\n\s*\/\/[\s\S]{0,120}?host\.prepend\(/.test(app));
  check('空状态用 emptyState', app.includes('emptyState(') && (await get('/js/timeline.js')).includes('export function emptyState'));
}

console.log('\n▸ 定位与裁剪（sticky 日期条 / 头像角标）');
{
  // 角标必须有自己的定位祖先，否则会挂到 .scope-track 的右下角（页面角上冒蓝点）
  check('头像角标有自己的定位容器 .chip-avatar-wrap', app.includes("class: 'chip-avatar-wrap'") && css.includes('.chip-avatar-wrap'));
  check('角标是定位容器里的绝对定位元素', /\.chip-avatar-wrap \{[\s\S]{0,200}?position: relative/.test(css) && /\.chip-count \{[\s\S]{0,120}?position: absolute/.test(css));
  // overflow: hidden 会制造滚动容器 → sticky 日期条以它为参照，凭空多顶 52px
  const pagerBlock = blockOf(css, '.scope-pager');
  check('滑动容器用 overflow: clip 而不是 hidden', pagerBlock.includes('overflow: clip') && !pagerBlock.includes('overflow: hidden'));
  check('滑动容器两个方向都裁（非当前页更高时不会把整页撑出滚动）', pagerBlock.includes('overflow: clip') && !pagerBlock.includes('overflow-y: visible'));
  check('面板本身不加 overflow（否则 sticky 又会以它为参照）', (() => {
    const pane = blockOf(css, '.scope-pane').replace(/\/\*[\s\S]*?\*\//g, '');
    return pane.length > 20 && !/overflow\s*:/.test(pane);
  })());
  check('老浏览器有 @supports 兜底', /@supports not \(overflow: clip\)/.test(css));
  check(
    '日期条仍是 sticky 且偏移用 --top-h',
    /\.day-header \{[\s\S]{0,300}?position: sticky/.test(css) &&
      css.includes('top: calc(var(--top-h) + var(--safe-top) + 8px)')
  );
  check(
    '--top-h 是顶栏实测高度 66px（写小了日期条会钻到顶栏底下）',
    /--top-h:\s*66px/.test(css) && !/--top-h:\s*58px/.test(css),
    (css.match(/--top-h:[^;]*/) || [])[0]
  );
  check('面板 / 非当前页里 --top-h 置 0（那里没有顶栏）', /body\.no-scroll \{[\s\S]{0,120}?--top-h:\s*0px/.test(css));
}

console.log('\n▸ 记录卡片主题色（自己和好友共用一套框架）');
{
  const theme = await get('/js/theme.js');
  check('主题模块存在', theme.includes('CARD_THEME_PRESETS') && theme.includes('export function themeFromAvatar'));
  check('头像取色＝缩小后取平均（相当于先模糊）', theme.includes('const size = 12') && theme.includes('drawImage(img, 0, 0, size, size)'));
  check('取色后做规范化（保证底色看得出来）', theme.includes('normalizeTheme') && theme.includes('Math.min(0.62, Math.max(0.44'));

  const timeline = await get('/js/timeline.js');
  check('卡片按作者主题上色', timeline.includes('resolveCardTheme(') && timeline.includes("style.setProperty('--card-accent'"));
  check('自己默认不上色（保持白底）', theme.includes('if (isMine) return { accent: null, avatarUrl: null }'));
  check('好友没设置时用头像取色', theme.includes('return { accent: null, avatarUrl: avatarUrl || null }'));
  check('同伴卡片不再有左侧色条', !/\.post\.from-friend \{[\s\S]{0,240}?border-left/.test(css));
  check('底色用 --card-accent 混出来，深色模式另算', /\.post\.tinted \{[\s\S]{0,220}?color-mix\(in srgb, var\(--card-accent\)/.test(css) && css.includes('@media (prefers-color-scheme: dark)'));
  check('设置页有主题选择（默认白 / 跟随头像 / 预设 / 自定义）', app.includes('function cardThemeSection') && app.includes('CARD_THEME_PRESETS') && css.includes('.theme-row'));
  check('设置项通过 /api/me/settings 保存', app.includes("api.updateSettings({ cardTheme: value })"));
  check('分享页也用主人的主题色', (await get('/js/share.js')).includes('myCardTheme: state.profile?.cardTheme'));
  check('API 客户端带 cardTheme', (await get('/js/api.js')).includes('updateSettings'));
  check('Service Worker 预缓存 theme.js', (await get('/sw.js')).includes("'/js/theme.js'"));
}

console.log('\n▸ pm2 常驻运行');
{
  const src = fs.readFileSync(path.join(rootDir, 'src', 'server.js'), 'utf8');
  check('「是否直接运行」认了 pm2 注入的变量', src.includes('process.env.pm_id !== undefined') && src.includes('process.env.pm_exec_path'));
  check('仍然保留 argv 判断（node src/server.js 照常）', src.includes('path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))'));
  const eco = fs.readFileSync(path.join(rootDir, 'ecosystem.config.cjs'), 'utf8');
  check('带了 pm2 配置文件', eco.includes('module.exports') && eco.includes("script: 'src/server.js'"));
  check('pm2 配置固定单进程（node:sqlite 不能多写）', eco.includes("exec_mode: 'fork'") && eco.includes('instances: 1'));
  check('pm2 配置里写死了端口等环境变量（pm2 不读 .env）', /env: \{[\s\S]{0,240}?PORT: 81/.test(eco));
  check('pm2 加载方式有回归测试', fs.readFileSync(path.join(rootDir, 'scripts', 'pm2-mode-test.mjs'), 'utf8').includes('pm_exec_path'));
}

console.log('\n▸ 发布时间 / 事情发生时间');
{
  const timeline = await get('/js/timeline.js');
  check('卡片左上角用「事情发生时间」', timeline.includes('clockOf(post.occurredAt || post.createdAt)'));
  check('旁边的「xx 分钟前」用发布时间', /class: 'rel' \}, relativeTime\(post\.createdAt\)/.test(timeline));
  check('按天分组用 occurredAt 兜底', timeline.includes('dayKeyOf(post.occurredAt || post.createdAt)'));
  const composer = await get('/js/composer.js');
  check('面板的时间框改的是 occurredAt', composer.includes('state.occurredAt = fromLocalInput(timeInput.value)'));
  check('提交时带 occurredAt（不再改 createdAt）', /occurredAt: state\.occurredAt/.test(composer) && !/createdAt: state\.createdAt,/.test(composer));
  check('编辑时提示「发布时间」（不可改）', composer.includes('发布时间') && composer.includes('事情发生的时间'));
  const posts = fs.readFileSync(path.join(rootDir, 'src', 'http', 'routes', 'posts.js'), 'utf8');
  check(
    '接口接受 occurredAt 并按它算 postDay',
    posts.includes('normalizeCreatedAt(body.occurredAt ?? body.createdAt)') && posts.includes('dayKey(occurredAt, tz)')
  );
  check('编辑只改 occurredAt（createdAt 固定）', posts.includes('patch.occurredAt = normalizeCreatedAt(next, existing.occurred_at || existing.created_at)'));
  const store = fs.readFileSync(path.join(rootDir, 'src', 'db', 'store.js'), 'utf8');
  check(
    '数据库有 occurred_at + 老数据回填',
    store.includes("addColumn('posts', 'occurred_at'") && store.includes('UPDATE posts SET occurred_at = created_at WHERE occurred_at IS NULL')
  );
  check('查询按 occurred_at 排序', store.includes("ORDER BY COALESCE(post_day, '') DESC, COALESCE(occurred_at, created_at) DESC LIMIT ?"));
}

console.log('\n▸ 分享面板复用已有链接');
{
  const app = await get('/js/app.js');
  check('面板里列出「已创建的链接」', app.includes("el('h4', { hidden: true }, '已创建的链接')"));
  check('点一条就切到那条链接（不重新生成）', /class: 'share-link-row pick'/.test(app) && app.includes('onclick: () => showLink(link)'));
  check('选中态跟着切换', app.includes("row.classList.toggle('active', row.dataset.token === link.token)"));
  check('列表限高可滚（复用 CSS 里 .share-links）', /\.share-links \{[\s\S]{0,240}?max-height: 40dvh[\s\S]{0,120}?overflow-y: auto/.test(css));
  check('最多显示 5 行、超过才滚（按实际行高算）', app.includes('const SHARE_LINKS_VISIBLE = 5') && app.includes('function capLinkList(box)') && app.includes("box.style.maxHeight = ''"));
  check('可点的行有按钮样式与选中态', /\.share-link-row\.pick \{[\s\S]{0,200}?width: 100%/.test(css) && /\.share-link-row\.pick\.active \{[\s\S]{0,120}?border-color: var\(--brand\)/.test(css));
}

console.log('\n▸ 手机通知（服务器出站推送）');
{
  const pushSrc = fs.readFileSync(path.join(rootDir, 'src', 'push.js'), 'utf8');
  check('有独立的通知模块 src/push.js', pushSrc.includes('export function pushConfig(') && pushSrc.includes('export async function sendPush('));
  check('支持企业微信机器人（国内最稳）', pushSrc.includes('cgi-bin/webhook/send') && pushSrc.includes('msgtype: \'markdown\''));
  check('也能接 ntfy / Bark / 通用 webhook', pushSrc.includes("kind === 'bark'") && pushSrc.includes("kind === 'ntfy'") && pushSrc.includes('通用 webhook'));
  check(
    '摘要字数可配（0 = 只推「有新记录」）',
    pushSrc.includes('export { excerptOf }') && pushSrc.includes('normExcerpt(') && /export function excerptOf\(/.test(fs.readFileSync(path.join(rootDir, 'src', 'notify.js'), 'utf8'))
  );
  check('只推给好友、不推给作者自己', pushSrc.includes('store.listFriends(author.id)') && pushSrc.includes('f.user.id !== author.id'));
  // 2026-10-11 用户要求：去掉"服务器级通道"（界面上看不见却能收到推送，会让人怀疑）
  check(
    '没有服务器级通道：env 里的 key/url 不再参与（只留总开关 / 端点 / 公开地址）',
    !pushSrc.includes('env.DAYLOG_PUSH_WECOM_KEY') &&
      !pushSrc.includes('env.DAYLOG_PUSH_URL') &&
      !pushSrc.includes('env.DAYLOG_PUSH_OWNER') &&
      !pushSrc.includes('envChannelOwnerId')
  );
  check(
    '测试通知只认用户自己的通道（没配就报 not_configured）',
    /export async function sendTestNotification/.test(pushSrc) &&
      pushSrc.includes('channelFromSettings(store.pushSettings(user.id)') &&
      /if \(!channel\) return \{ ok: false, error: 'not_configured' \}/.test(pushSrc)
  );
  check(
    '路由没有 env 兜底（免推送 > 单独 key > 我的默认 key > 没有）',
    /export function channelForRecipient\(store, recipientId, authorId/.test(pushSrc) && !pushSrc.includes("reason: 'env'")
  );
  check('发送失败只记日志、绝不抛出去', /catch \(err\) \{[\s\S]{0,200}return \{ ok: false/.test(pushSrc) && pushSrc.includes('timeoutMs = 5000'));
  const postsSrc = fs.readFileSync(path.join(rootDir, 'src', 'http', 'routes', 'posts.js'), 'utf8');
  check('发帖成功后才触发通知（在 ctx.send(201) 之后）', /ctx\.send\(201, \{ post: postJson\(fresh, user\) \}\);[\s\S]{0,400}notifyNewPost\(/.test(postsSrc));
  const friendsSrc = fs.readFileSync(path.join(rootDir, 'src', 'http', 'routes', 'friends.js'), 'utf8');
  check('收到好友请求也会推一条', friendsSrc.includes('notifyFriendRequest(') && friendsSrc.includes("result.status !== 'accepted'"));
  const eco = fs.readFileSync(path.join(rootDir, 'ecosystem.config.cjs'), 'utf8');
  check('密钥走 .env.secrets（root-only），不写进 ecosystem 文件', eco.includes('loadSecrets(path.join(__dirname, \'.env.secrets\'))') && eco.includes('function loadSecrets('));
  check('通知里的链接有固定站点地址', eco.includes('DAYLOG_PUBLIC_URL'));
}

console.log('\n▸ 通知层（收件箱：让 agent 也能"收到"人的动态）');
{
  const notifySrc = fs.readFileSync(path.join(rootDir, 'src', 'notify.js'), 'utf8');
  check(
    '有独立的通知层 src/notify.js',
    notifySrc.includes('export function recordNotifications(') && notifySrc.includes('export function notificationsPayload(')
  );
  check(
    '三类事件都记：新记录 / 好友申请 / 成为好友',
    notifySrc.includes('export function recordPostNotifications(') &&
      notifySrc.includes('export function recordFriendRequestNotification(') &&
      notifySrc.includes('export function recordFriendAcceptedNotifications(')
  );
  check('不给自己写通知', /if \(!userId \|\| userId === actor\.id\) continue;/.test(notifySrc));
  check('收件箱有长度上限（不无限增长）', notifySrc.includes('store.pruneNotifications('));
  const serverSrc = fs.readFileSync(path.join(rootDir, 'src', 'server.js'), 'utf8');
  check('响应出口捎带未读摘要（用户提的那层）', /notificationsPayload\(store, user\.id/.test(serverSrc));
  check('捎带失败不影响正常响应（fail-open）', /通知层坏了也不能影响正常返回/.test(serverSrc));
  const usersSrc = fs.readFileSync(path.join(rootDir, 'src', 'http', 'routes', 'users.js'), 'utf8');
  check('有 GET /api/me/notifications', usersSrc.includes("r.get('/api/me/notifications'"));
  check(
    '有 POST /api/me/notifications/read（all / ids / upTo）',
    usersSrc.includes("r.post('/api/me/notifications/read'") && usersSrc.includes('markNotificationsRead(user.id')
  );
  const storeSrc = fs.readFileSync(path.join(rootDir, 'src', 'db', 'store.js'), 'utf8');
  check('store 里有 notifications 表与索引', storeSrc.includes('CREATE TABLE IF NOT EXISTS notifications') && storeSrc.includes('idx_notifications_unread'));
  check('手机推送与收件箱解耦（关掉推送也照样记）', /const recorded = recordPostNotifications\(/.test(fs.readFileSync(path.join(rootDir, 'src', 'push.js'), 'utf8')));
}

console.log(`\n${'─'.repeat(48)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `前端修复核验全部通过 ✅（${pass} 项）`);
process.exitCode = fail ? 1 : 0;
