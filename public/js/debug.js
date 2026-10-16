/**
 * 布局自检：找出「比视口还宽」的元素（横向溢出会让固定定位的底部面板看起来被裁切）。
 * 用法：浏览器控制台执行
 *   window.daylogDebugLayout()
 */
import { $$ } from './util.js';
import { sheetDebugInfo } from './ui.js';
import { getAnniversaryState, homeCelebrations } from './anniversaries.js';
import { getFriendState } from './friends.js';

export const BUILD = '2026-10-10-port81-29';

/**
 * 首页自检：倒计时 / 头像条为什么没出现，一眼就能看出是"数据没到"还是"渲染出错"。
 * 用法：浏览器控制台执行 window.daylogDebugHome()
 */
export function debugHome({ verbose = true } = {}) {
  const annState = getAnniversaryState();
  const friendState = getFriendState();
  let celebrations = [];
  let renderError = null;
  try {
    celebrations = homeCelebrations().map((c) => ({
      name: c.label || c.name,
      icon: c.icon,
      special: !!c.special,
      isBirthday: !!c.isBirthday,
      days: c.next?.days ?? null,
    }));
  } catch (err) {
    renderError = String(err?.message || err);
  }

  const list = document.querySelector('#home-list');
  const report = {
    build: BUILD,
    user: window.__daylogState?.user ? window.__daylogState.user.username : '(未暴露)',
    home: window.__daylogState
      ? {
          date: window.__daylogState.home.date,
          scope: window.__daylogState.home.scope,
          all: window.__daylogState.home.all,
          friendFilter: window.__daylogState.home.friendFilter,
          posts: window.__daylogState.home.posts?.length ?? 0,
          counts: window.__daylogState.home.counts,
        }
      : null,
    // 三页各自的缓存：判断"滑过去为什么是空的 / 为什么要等"用
    panes: window.__daylogState?.panes
      ? Object.fromEntries(
          Object.entries(window.__daylogState.panes).map(([scope, p]) => [
            scope,
            { loaded: p.loaded, loading: p.loading, stale: p.stale, posts: p.posts.length, key: p.key },
          ])
        )
      : null,
    anniversaries: {
      loaded: annState.loaded,
      loading: annState.loading,
      count: annState.list.length,
      items: annState.list.map((a) => ({ name: a.name, icon: a.icon, special: a.special, isBirthday: a.isBirthday, days: a.next?.days })),
    },
    friends: {
      loaded: friendState.loaded,
      count: friendState.friends.length,
    },
    wouldRenderCelebrations: celebrations,
    celebrationError: renderError,
    dom: {
      homeListExists: !!list,
      countdownNodes: document.querySelectorAll('#home-list .countdown').length,
      friendChips: document.querySelectorAll('.friend-chip').length,
      firstChildClass: list?.firstElementChild?.className ?? null,
    },
    tabs: [...document.querySelectorAll('.scope-tab')].map((b) => ({
      text: b.textContent.trim(),
      active: b.classList.contains('active'),
    })),
  };

  if (verbose) {
    /* eslint-disable no-console */
    console.log(`%c[DayLog] 首页自检  build=${BUILD}`, 'font-weight:bold');
    console.log('当前视图:', report.home);
    console.log(
      '纪念日数据:',
      report.anniversaries.loaded ? `已加载 ${report.anniversaries.count} 条` : `未加载 (loading=${report.anniversaries.loading})`,
      report.anniversaries.items
    );
    console.log('好友数据:', report.friends);
    console.log('应该渲染的倒计时:', report.wouldRenderCelebrations);
    if (report.celebrationError) console.error('计算倒计时时出错:', report.celebrationError);
    console.log('DOM 实际结果:', report.dom);
    console.log('标签页:', report.tabs);
    if (!report.anniversaries.count) {
      console.warn('⚠️ 你的账号还没有纪念日 —— 去「设置 → 纪念日」添加一个（例如生日）才会显示倒计时。');
    } else if (report.home && report.home.scope !== 'mine') {
      console.warn('⚠️ 倒计时只在「我」标签下显示，当前是「' + report.home.scope + '」。');
    } else if (report.celebrationError) {
      console.warn('⚠️ 渲染倒计时时报错了，请把上面的报错截图发我。');
    } else if (!report.dom.countdownNodes && report.wouldRenderCelebrations.length) {
      console.warn('⚠️ 数据齐全但没有渲染出来，请截图发我。');
    }
  }
  return report;
}

export function debugLayout({ verbose = true } = {}) {
  const vw = window.innerWidth;
  const docW = document.documentElement.scrollWidth;
  const bodyW = document.body.scrollWidth;
  const report = {
    build: BUILD,
    viewport: { width: vw, height: window.innerHeight, dpr: window.devicePixelRatio },
    document: { scrollWidth: docW, bodyScrollWidth: bodyW },
    horizontalOverflow: Math.max(docW, bodyW) > vw + 1,
    overflowing: [],
    sheet: null,
    sheets: null,
  };

  // 结构不变量：一个遮罩层里只能有一个 .sheet（两个会让每个被压成一半宽并整体偏移）
  const backdrops = [...document.querySelectorAll('.sheet-backdrop')];
  report.sheets = {
    count: sheetDebugInfo().length,
    backdrops: backdrops.map((b) => ({
      sheets: b.querySelectorAll('.sheet').length,
      classes: b.className,
    })),
    ok: backdrops.every((b) => b.querySelectorAll('.sheet').length <= 1),
  };

  for (const node of $$('body *')) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(node);
    if (style.position === 'fixed' && style.visibility === 'hidden') continue;
    if (rect.right > vw + 1 || rect.left < -1) {
      report.overflowing.push({
        tag: node.tagName.toLowerCase(),
        class: node.className && typeof node.className === 'string' ? node.className : '',
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        position: style.position,
        overflowX: style.overflowX,
      });
    }
  }
  report.overflowing = report.overflowing.slice(0, 25);

  const sheet = document.querySelector('.sheet');
  if (sheet) {
    const rect = sheet.getBoundingClientRect();
    const cs = getComputedStyle(sheet);
    const backdrop = document.querySelector('.sheet-backdrop');
    const bRect = backdrop?.getBoundingClientRect();
    const bcs = backdrop ? getComputedStyle(backdrop) : null;
    report.sheet = {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      viewportWidth: vw,
      fillsWidth: Math.abs(rect.width - vw) <= 2,
      centered: Math.abs(rect.left + rect.width / 2 - vw / 2) <= 2,
      offsetWidth: sheet.offsetWidth,
      clientWidth: sheet.clientWidth,
      scrollWidth: sheet.scrollWidth,
      computed: {
        position: cs.position,
        width: cs.width,
        maxWidth: cs.maxWidth,
        minWidth: cs.minWidth,
        margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
        left: cs.left,
        right: cs.right,
        transform: cs.transform,
        zoom: cs.zoom,
        translate: cs.translate,
      },
      backdrop: bRect
        ? {
            left: Math.round(bRect.left),
            right: Math.round(bRect.right),
            width: Math.round(bRect.width),
            height: Math.round(bRect.height),
            display: bcs.display,
            position: bcs.position,
            alignItems: bcs.alignItems,
            justifyContent: bcs.justifyContent,
            inset: `${bcs.top} ${bcs.right} ${bcs.bottom} ${bcs.left}`,
            transform: bcs.transform,
          }
        : null,
      ancestors: (() => {
        const out = [];
        let node = sheet.parentElement;
        while (node && node !== document.documentElement) {
          const s = getComputedStyle(node);
          out.push({
            tag: node.tagName.toLowerCase(),
            class: typeof node.className === 'string' ? node.className : '',
            position: s.position,
            transform: s.transform,
            filter: s.filter,
            perspective: s.perspective,
            contain: s.contain,
            willChange: s.willChange,
            width: Math.round(node.getBoundingClientRect().width),
            left: Math.round(node.getBoundingClientRect().left),
          });
          node = node.parentElement;
        }
        return out;
      })(),
    };
  }

  if (verbose) {
    /* eslint-disable no-console */
    console.log(`%c[DayLog] 布局自检  build=${BUILD}`, 'font-weight:bold');
    console.table(report.viewport);
    console.log('横向溢出:', report.horizontalOverflow ? '是 ⚠️' : '否 ✅', report.document);
    console.log(
      '面板结构 (一个遮罩层只能有一个 .sheet):',
      report.sheets.ok ? '正常 ✅' : '异常 ⚠️',
      report.sheets
    );
    if (report.overflowing.length) {
      console.warn('以下元素超出视口（可能造成横向滚动）:');
      console.table(report.overflowing);
    } else {
      console.log('没有元素超出视口 ✅');
    }
    if (report.sheet) {
      const s = report.sheet;
      console.log('底部面板:', s);
      console.log(`  面板 left=${s.left} width=${s.width} 视口宽=${s.viewportWidth} 居中=${s.centered ? '是' : '否 ⚠️'}`);
      console.log('  面板计算样式:', s.computed);
      console.log('  遮罩层:', s.backdrop);
      console.table(s.ancestors);
      if (!s.centered) {
        console.warn(
          '⚠️ 面板没有水平居中。请把「底部面板」和 ancestors 表格的截图发给开发者。'
        );
      }
    }
    console.log('提示：把本行输出截图即可定位问题 —— window.daylogDebugLayout()');
  }
  return report;
}

/** 供控制台手动调用 */
if (typeof window !== 'undefined') {
  window.daylogDebugLayout = debugLayout;
  window.daylogDebugHome = debugHome;
}