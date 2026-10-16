/**
 * 纪念日展示回归测试（纯 DOM 桩，不引入 jsdom）。
 *
 * 锁死这几条真实需求：
 *   1. 设置页纪念日列表是「三排」：名称+标签 / 日期+剩余天数 / 说明
 *   2. 说明最多 20 个字，超出自动截断（按码点截，不切坏 emoji）
 *   3. 支持自定义图标（任意 emoji，组合 emoji 不被切坏）
 *   4. 首页/日历倒计时写明**年份**，且说明过长时不会把主文案挤成省略号
 *
 * 运行：node scripts/anniversary-note-test.mjs
 */

// ---------------------------------------------------------------- 最小 DOM 桩

class StubNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._classes = new Set();
    this._listeners = {};
    this._text = '';
    this.classList = {
      add: (...names) => names.forEach((n) => n && this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      contains: (n) => this._classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !this._classes.has(n) : Boolean(force);
        if (on) this._classes.add(n);
        else this._classes.delete(n);
        return on;
      },
    };
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined || node === false) continue;
      const target = typeof node === 'string' ? new StubNode('#text') : node;
      target.parentElement = this;
      this.children.push(target);
    }
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this._listeners[type] || []) fn({ target: this, preventDefault() {}, ...event });
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }

  /** 测试里比 innerText 更省事的别名 */
  get innerText() {
    return this.textContent;
  }

  _matches(selector) {
    if (selector.startsWith('.')) return this._classes.has(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName !== '#TEXT' && child._matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

globalThis.Node = StubNode;
globalThis.document = {
  createElement: (tag) => new StubNode(tag),
  createElementNS: (_ns, tag) => new StubNode(tag),
  createTextNode: (text) => {
    const node = new StubNode('#text');
    node.textContent = text;
    return node;
  },
};
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };

const { anniversariesSection, celebrationCard, getAnniversaryState, normalizeIcon, truncateNote } =
  await import('../public/js/anniversaries.js');

// ---------------------------------------------------------------- 断言工具

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

const LONG_NOTE = '一二三四五六七八九十一二三四五六七八九十超出部分不该显示';
const SHORT_NOTE = '短说明';

console.log('\n▸ 说明截断（最多 20 个字）');
{
  check('20 个字原样保留', truncateNote('一二三四五六七八九十一二三四五六七八九十') === '一二三四五六七八九十一二三四五六七八九十');
  const cut = truncateNote(LONG_NOTE);
  check('超长截断到 20 个字并补省略号', [...cut].length === 21 && cut.endsWith('…'), cut);
  check('截断后不再包含超出部分', !cut.includes('超出部分'), cut);
  check('空说明返回空串', truncateNote('') === '' && truncateNote(null) === '');
  check('emoji 不被切成半个', truncateNote('🎂'.repeat(30)) === `${'🎂'.repeat(20)}…`, truncateNote('🎂'.repeat(30)));
}

console.log('\n▸ 自定义图标（只收一个表情，不给文字）');
{
  check('普通 emoji 保留', normalizeIcon('🦄') === '🦄');
  check('组合 emoji（ZWJ）不被切坏', normalizeIcon('👨‍👩‍👧') === '👨‍👩‍👧', normalizeIcon('👨‍👩‍👧'));
  check('国旗（区域指示符）保留', normalizeIcon('🇨🇳') === '🇨🇳', normalizeIcon('🇨🇳'));
  check('只取一个表情（多打的一律丢掉）', normalizeIcon('🎂💍🎉') === '🎂', normalizeIcon('🎂💍🎉'));
  check('纯英文被拒绝', normalizeIcon('abc') === '', normalizeIcon('abc'));
  check('中文被拒绝', normalizeIcon('生日') === '', normalizeIcon('生日'));
  check('数字被拒绝', normalizeIcon('3') === '', normalizeIcon('3'));
  check('表情混文字只留表情', normalizeIcon('🎂生日') === '🎂', normalizeIcon('🎂生日'));
  check('空白会被去掉', normalizeIcon('  🐳  ') === '🐳');
  check('空输入返回空串（调用方回退到默认图标）', normalizeIcon('') === '');
}

console.log('\n▸ 倒计时卡片（年份 + 说明）');
{
  const item = {
    id: 'a1',
    name: '结婚纪念日',
    icon: '🦄',
    date: '2023-05-20',
    note: LONG_NOTE,
    special: true,
    next: { days: 223, month: 5, day: 20, year: 2027, isToday: false, age: 4 },
  };
  const card = celebrationCard(item, {});
  const text = card.textContent;
  check('副文案写明目标年份', text.includes('2027 年 5 月 20 日'), text);
  check('主文案完整（不被说明挤掉）', text.includes('距离结婚纪念日还有 223 天'), text);
  check('说明按 20 字截断', text.includes(truncateNote(LONG_NOTE)) && !text.includes('超出部分'), text);
  check('自定义图标渲染出来', text.includes('🦄'), text);
  check('特别关注卡片带 special 类', card.className.includes('special'), card.className);
  check('说明是独立的一个节点（可换行）', Boolean(card.querySelector('.cd-note')), card.className);
  // 布局：第一行放倒计时，第二行放日期 + 说明；没有说明时只有一行
  const topRow = card.children.find((c) => String(c.className).includes('cd-top'));
  const metaRow = card.children.find((c) => String(c.className).includes('cd-meta'));
  check('卡片分成「倒计时行 / 说明行」两段', Boolean(topRow) && Boolean(metaRow), card.children.map((c) => c.className).join(','));
  check('倒计时（主文案）在第一行', Boolean(topRow?.querySelector('.cd-main')), String(topRow?.className));
  check('有说明时日期挪到第二行、和说明作伴', Boolean(metaRow?.querySelector('.cd-sub')) && Boolean(metaRow?.querySelector('.cd-note')), String(metaRow?.className));
  check(
    '第一行不会被挤断（日期不在第一行）',
    !topRow?.querySelector('.cd-sub'),
    String(topRow?.textContent)
  );
  const plain = celebrationCard({ ...item, note: '' }, {});
  check('没有说明时卡片只有一行（没有 cd-meta）', !plain.children.some((c) => String(c.className).includes('cd-meta')), plain.children.map((c) => c.className).join(','));
  check('没有说明时日期留在第一行', Boolean(plain.children.find((c) => String(c.className).includes('cd-top'))?.querySelector('.cd-sub')), plain.textContent);
  check('卡片里不会出现字面量 null', !/null/.test(card.textContent + plain.textContent), card.textContent);

  const todayNoAge = celebrationCard(
    { ...item, note: '就是今天', next: { days: 0, month: 5, day: 20, year: 2026, isToday: true, age: 0 } },
    {}
  );
  check('今天 + 没有周年数时不会插出 "null"', !/null/.test(todayNoAge.textContent) && todayNoAge.textContent.includes('就是今天'), todayNoAge.textContent);

  const today = celebrationCard(
    { ...item, note: '', next: { days: 0, month: 5, day: 20, year: 2026, isToday: true, age: 3 } },
    {}
  );
  check('当天显示「今天是…！」+ 周年数', today.textContent.includes('今天是结婚纪念日！') && today.textContent.includes('3 周年'), today.textContent);

  const warn = console.warn;
  console.warn = () => {}; // 这一条本来就该打警告，测试时静音，避免污染输出
  const broken = celebrationCard({ id: 'bad', name: '坏数据' }, {});
  console.warn = warn;
  check('缺少 next 时返回空卡片而不是抛错', broken.className.includes('broken') && broken.textContent === '');
}

console.log('\n▸ 设置页列表三排结构');
{
  const state = getAnniversaryState();
  state.loaded = true;
  state.loading = false;
  state.list = [
    {
      id: 'a1',
      name: '结婚纪念日',
      icon: '🦄',
      date: '2023-05-20',
      note: LONG_NOTE,
      special: true,
      isBirthday: false,
      friend: null,
      next: { days: 223, month: 5, day: 20, year: 2027, isToday: false, age: 4 },
    },
    {
      id: 'a2',
      name: '搬家纪念日',
      icon: '🏠',
      date: '2024-08-08',
      note: '',
      special: false,
      isBirthday: false,
      friend: null,
      next: { days: 303, month: 8, day: 8, year: 2027, isToday: false, age: 3 },
    },
  ];
  const { node } = anniversariesSection({});
  const rows = node.querySelectorAll('.anniversary-row');
  check('渲染出全部条目', rows.length === 2, `count=${rows.length}`);

  const special = rows.find((r) => r.className.includes('special'));
  const normal = rows.find((r) => !r.className.includes('special'));
  check('特别关注条目带 special 类', Boolean(special));

  const title = special?.querySelector('.an-title');
  const meta = special?.querySelector('.an-meta');
  const note = special?.querySelector('.an-note');
  check('第一排：名称 + 特别关注标签', title?.textContent.includes('结婚纪念日') && title?.textContent.includes('特别关注'), title?.textContent);
  check('第二排：日期 + 剩余天数', meta?.textContent === '2023-05-20 · 还有 223 天', meta?.textContent);
  check('第三排：说明单独成行', note?.textContent === truncateNote(LONG_NOTE), note?.textContent);
  check('第二排不再混着说明', !String(meta?.textContent).includes('一二三'), meta?.textContent);
  check('自定义图标显示在列表里', special?.querySelector('.an-icon')?.textContent === '🦄');
  check('没有说明的条目不会渲染空的第三排', normal?.querySelector('.an-note') === null);
  check('普通条目也没有说明混进第二排', normal?.querySelector('.an-meta')?.textContent === '2024-08-08 · 还有 303 天', normal?.querySelector('.an-meta')?.textContent);
}

console.log(`\n${'─'.repeat(44)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `纪念日展示测试全部通过 ✅（${pass} 项）`);
process.exitCode = fail ? 1 : 0;
