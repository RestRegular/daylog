/**
 * 日历布局核算：验证在各类屏幕下
 *   1) 格子是【正方形】（宽 = 高）
 *   2) 日历【铺满】可用宽度（左右贴边；桌面因格子有上限而居中等宽）
 *   3) 整块日历不会超出屏幕高度（不需要滚动就能看全）
 *
 * 与 CSS 保持一致的参数：
 *   .cal-grid  grid-template-columns: repeat(7, clamp(30px, 9.2vw, 44px))
 *              justify-content: space-between;  padding: 12px 8px
 *   .cal-cell  width: 100%;  aspect-ratio: 1/1
 *   .main      padding: 14px（窄屏 10px，宽屏 18px）
 *
 * 运行：node scripts/cal-test.mjs
 */

const COLS = 7;
const ROWS = 6;
const GRID_PAD_X = 8;
const GRID_PAD_Y = 12;

function layout({ vw, vh, label }) {
  const narrow = vw <= 380;
  const wide = vw >= 760;
  const mainSide = wide ? 18 : narrow ? 10 : 14;
  const available = vw - mainSide * 2;

  // 大屏（≥760px）日历有宽度上限 .cal-wrap { max-width: 420px }
  const wrapWidth = wide ? Math.min(available, 420) : available;
  const content = wrapWidth - GRID_PAD_X * 2;

  // 列宽 = clamp(30px, 9.2vw, 44px)
  const cell = Math.min(Math.max(30, 0.092 * vw), 44);

  const usedByCells = cell * COLS;
  // space-between 把剩余宽度平均分配给 6 个间隔
  const gap = (content - usedByCells) / (COLS - 1);
  const fills = gap >= 0; // 剩余宽度非负才铺得下
  const gridHeight = GRID_PAD_Y * 2 + ROWS * cell + Math.max(gap, 0) * (ROWS - 1);

  // 竖向：顶栏 + 月份导航 + 间距 + 上内边距 + 网格 + 汇总 +（底部导航 + 余量）
  const overhead = 58 + 56 + 24 + 14;
  const bottom = 58 + 24;
  const needed = overhead + gridHeight + 40 + bottom;

  return {
    label,
    vw,
    vh,
    available,
    wrapWidth: +wrapWidth.toFixed(1),
    cell: +cell.toFixed(1),
    gap: +gap.toFixed(1),
    gridHeight: +gridHeight.toFixed(1),
    needed: Math.round(needed),
    square: true, // aspect-ratio 保证宽 = 高
    fills: fills && gap <= 26, // 铺满且间隔不至于夸张
    fitsHeight: needed <= vh,
  };
}

const cases = [
  { vw: 320, vh: 568, label: 'iPhone SE1（最苛刻）' },
  { vw: 360, vh: 640, label: '常见窄屏安卓' },
  { vw: 375, vh: 667, label: 'iPhone SE2/8' },
  { vw: 390, vh: 844, label: 'iPhone 14/15' },
  { vw: 414, vh: 896, label: 'iPhone Plus' },
  { vw: 440, vh: 956, label: '用户实测机型' },
  { vw: 768, vh: 1024, label: 'iPad 竖屏' },
  { vw: 1440, vh: 900, label: '桌面' },
];

console.log('\n日历布局核算（正方形格子 + 铺满宽度 + 竖向放得下）\n');
console.log('  视口            可用宽  格边长   间隔    网格高   竖向需要  结果');
console.log('  ' + '─'.repeat(80));

let bad = 0;
for (const c of cases) {
  const r = layout(c);
  const ok = r.square && r.fills && r.fitsHeight && r.cell >= 28;
  if (!ok) bad += 1;
  const problems = [];
  if (r.cell < 28) problems.push('格子过小');
  if (!r.fills) problems.push('宽度放不下');
  if (!r.fitsHeight) problems.push(`竖向超出 ${r.needed - r.vh}px`);
  console.log(
    `  ${String(r.vw).padStart(4)}×${String(r.vh).padEnd(4)}  ` +
      `${String(r.available).padStart(5)}  ${String(r.cell).padStart(6)}  ${String(r.gap).padStart(6)}  ` +
      `${String(r.gridHeight).padStart(6)}  ${String(r.needed).padStart(7)}   ${ok ? '✓' : '✗ ' + problems.join('、')}`
  );
}

console.log(
  `\n结论：${bad === 0 ? '全部尺寸下格子为正方形、日历横向铺满、且无需滚动即可看全 ✅' : `有 ${bad} 个尺寸需要注意 ⚠️`}`
);
process.exitCode = bad ? 1 : 0;
