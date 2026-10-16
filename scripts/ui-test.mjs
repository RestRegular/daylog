/**
 * 回归测试：底部面板的 DOM 结构。
 *
 * 这里曾出过一个真实 bug：调用方自备遮罩层时，openSheet() 又往里面 append 了一个
 * 空的 .sheet，导致一个遮罩层里出现两个并排的 flex 子项，各自被压成一半宽度并
 * 整体左移（表现为面板右侧被裁切）。本测试锁死"一个遮罩层里只能有一个 .sheet"。
 *
 * 用最小 DOM 桩实现，不引入 jsdom。运行：node scripts/ui-test.mjs
 */

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
    this.textContent = '';
    this._className = '';
    this.classList = {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
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
      if (!node) continue;
      const target = typeof node === 'string' ? new StubNode('#text') : node;
      target.parentElement = this;
      this.children.push(target);
    }
  }

  prepend(node) {
    if (!node) return;
    node.parentElement = this;
    this.children.unshift(node);
  }

  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this._listeners[type] || []) fn({ target: this, ...event });
  }

  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    if (!cls) return null;
    const walk = (node) => {
      for (const child of node.children) {
        if (child._classes && child._classes.has(cls)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const out = [];
    if (!cls) return out;
    const walk = (node) => {
      for (const child of node.children) {
        if (child._classes && child._classes.has(cls)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node === globalThis.document.body || node === globalThis.document.documentElement;
  }

  get firstElementChild() {
    return this.children.find((c) => c.tagName !== '#TEXT') || null;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains?.(node));
  }
}

// ---- 装配全局环境 ----
// util.js 里用 `child instanceof Node` 判断节点，所以要提供 Node 基类
class StubNodeBase {}
Object.setPrototypeOf(StubNode.prototype, StubNodeBase.prototype);
globalThis.Node = StubNodeBase;

const documentElement = new StubNode('html');
const body = new StubNode('body');
documentElement.append(body);
const registry = new Map();

globalThis.document = {
  documentElement,
  body,
  createElement: (tag) => new StubNode(tag),
  createElementNS: (_ns, tag) => new StubNode(tag),
  createTextNode: (text) => {
    const node = new StubNode('#text');
    node.textContent = text;
    return node;
  },
  querySelector: (sel) => {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    if (!cls) return null;
    if (body._classes.has(cls)) return body;
    return body.querySelector(`.${cls}`);
  },
  querySelectorAll: (sel) => body.querySelectorAll(sel),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  innerWidth: 440,
  innerHeight: 956,
  devicePixelRatio: 3,
};
globalThis.getComputedStyle = () => ({
  position: 'relative',
  width: '440px',
  maxWidth: '720px',
  minWidth: '0px',
  marginTop: '0px',
  marginRight: '0px',
  marginBottom: '0px',
  marginLeft: '0px',
  left: '0px',
  right: '0px',
  transform: 'none',
  zoom: '1',
  translate: 'none',
  display: 'flex',
  alignItems: 'normal',
  justifyContent: 'normal',
  top: '0px',
  bottom: '0px',
  filter: 'none',
  perspective: 'none',
  contain: 'none',
  willChange: 'auto',
});
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

const { openSheet, closeSheet } = await import('../public/js/ui.js');

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

console.log('\n▸ 自备遮罩层（composer 的用法）');
{
  const backdrop = new StubNode('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = new StubNode('div');
  sheet.className = 'sheet composer';
  const head = new StubNode('div');
  head.className = 'sheet-head';
  sheet.append(head);
  backdrop.append(sheet);

  const entry = openSheet({ node: backdrop, onBackdrop: () => {} });

  const sheets = backdrop.querySelectorAll('.sheet');
  check('遮罩层内只有一个 .sheet', sheets.length === 1, `实际 ${sheets.length} 个：${sheets.map((s) => s.className).join(' | ')}`);
  check('没有凭空多出空的 .sheet', !sheets.some((s) => s.className.trim() === 'sheet'));
  check('保留原有的 .sheet.composer', sheets[0] === sheet);
  check('返回的 entry.sheet 指向真实面板', entry.sheet === sheet);
  check('遮罩层已挂到 body', document.body.children.includes(backdrop));
  check('body 加上了 no-scroll', document.body.classList.contains('no-scroll'));

  closeSheet();
  await new Promise((r) => setTimeout(r, 220));
  check('关闭后遮罩层被移除', !document.body.children.includes(backdrop));
  check('关闭后 body 去掉 no-scroll', !document.body.classList.contains('no-scroll'));
}

console.log('\n▸ 内部自建面板（确认框 / 分享面板的用法）');
{
  const content = new StubNode('div');
  const entry = openSheet({ title: '分享给朋友', content });
  const sheets = document.body.querySelectorAll('.sheet');
  check('创建了 1 个 .sheet', sheets.length === 1, `实际 ${sheets.length}`);
  check('面板里有 .sheet-body', entry.sheet.querySelector('.sheet-body') !== null);
  check('面板里有标题', entry.sheet.querySelector('.sheet-title') !== null);
  closeSheet();
  await new Promise((r) => setTimeout(r, 220));
  check('关闭后清理干净', document.body.querySelectorAll('.sheet').length === 0);
}

console.log('\n▸ 嵌套打开（composer 里再开心情选择器）');
{
  const backdrop = new StubNode('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = new StubNode('div');
  sheet.className = 'sheet composer';
  backdrop.append(sheet);
  openSheet({ node: backdrop, onBackdrop: () => {} });

  const inner = new StubNode('div');
  openSheet({ title: '此刻的心情', content: inner, compact: true });

  const backdrops = document.body.querySelectorAll('.sheet-backdrop');
  check('存在两个遮罩层（嵌套）', backdrops.length === 2, `实际 ${backdrops.length}`);
  check('外层遮罩层内仍只有 1 个 .sheet', backdrop.querySelectorAll('.sheet').length === 1);

  closeSheet();
  await new Promise((r) => setTimeout(r, 220));
  check('关闭的是内层，外层仍在', document.body.children.includes(backdrop));
  closeSheet();
  await new Promise((r) => setTimeout(r, 220));
  check('再关闭清理全部', document.body.querySelectorAll('.sheet-backdrop').length === 0);
}

console.log('\n▸ 同一遮罩层被复用两次（曾经的第二个空 .sheet 来源）');
{
  // 复现真实场景：面板 A 打开后，又用「同一个 backdrop 节点」开面板 B
  const backdrop = new StubNode('div');
  backdrop.className = 'sheet-backdrop';
  const sheetA = new StubNode('div');
  sheetA.className = 'sheet composer';
  backdrop.append(sheetA);
  openSheet({ node: backdrop, onBackdrop: () => {} });

  // 第二次调用传入的仍然是同一个 backdrop（这就是 bug 的入口）
  openSheet({ node: backdrop, onBackdrop: () => {} });

  const sheetsInBackdrop = backdrop.querySelectorAll('.sheet');
  check(
    '同一遮罩层里始终只有一个 .sheet',
    sheetsInBackdrop.length === 1,
    `实际 ${sheetsInBackdrop.length} 个：${sheetsInBackdrop.map((s) => s.className).join(' | ')}`
  );
  check('没有产生空的 .sheet', !sheetsInBackdrop.some((s) => s.className.trim() === 'sheet'));

  // 两个逻辑层应该在 DOM 里也各自独立
  const allBackdrops = document.body.querySelectorAll('.sheet-backdrop');
  const totalSheets = allBackdrops.reduce((sum, b) => sum + b.querySelectorAll('.sheet').length, 0);
  check('每层遮罩各有一个面板', totalSheets <= allBackdrops.length, `遮罩 ${allBackdrops.length} 个，面板 ${totalSheets} 个`);

  closeSheet();
  await new Promise((r) => setTimeout(r, 220));
  closeSheet();
  await new Promise((r) => setTimeout(r, 220));
  const leftovers = document.body.querySelectorAll('.sheet-backdrop');
  const residue = document.body.querySelectorAll('.sheet');
  check(
    '全部关闭后没有残留面板（.sheet）',
    residue.length === 0,
    `残留 ${residue.length} 个：${residue.map((s) => s.className).join(' | ')}；遮罩 ${leftovers.length} 个：${leftovers
      .map((b) => b.className)
      .join(' | ')}`
  );
  check(
    '残留的遮罩层都已不可见（无 .sheet 且已标记 closing）',
    leftovers.every((b) => b.classList.contains('closing')),
    `残留 ${leftovers.length} 个`
  );
}

console.log(`\n${'─'.repeat(42)}`);
console.log(fail ? `失败 ${fail} 项，通过 ${pass} 项` : `面板结构回归测试全部通过 ✅（${pass} 项）`);
process.exit(fail ? 1 : 0);
