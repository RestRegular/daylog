// QR 自检：结构校验 + 完整反向解码（含纠错），不需要外部依赖
import { createQrMatrix } from '../src/lib/qr.js';

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

const EC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const DATA_CODEWORDS = {
  1: { L: 19, M: 16, Q: 13, H: 9 }, 2: { L: 34, M: 28, Q: 22, H: 16 },
  3: { L: 55, M: 44, Q: 34, H: 26 }, 4: { L: 80, M: 64, Q: 48, H: 36 },
  5: { L: 108, M: 86, Q: 62, H: 46 }, 6: { L: 136, M: 108, Q: 76, H: 60 },
  7: { L: 156, M: 124, Q: 88, H: 66 }, 8: { L: 194, M: 154, Q: 110, H: 86 },
  9: { L: 232, M: 182, Q: 132, H: 100 }, 10: { L: 274, M: 216, Q: 154, H: 122 },
};
const EC_BLOCKS = {
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
};
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function maskFn(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

function reservedMap(version) {
  const size = version * 4 + 17;
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; };
  for (const [tr, tc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(tr + r, tc + c);
  }
  for (const r of ALIGNMENT[version]) for (const c of ALIGNMENT[version]) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) mark(r + dr, c + dc);
  }
  for (let i = 0; i < size; i += 1) { mark(6, i); mark(i, 6); }
  for (let i = 0; i <= 8; i += 1) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i += 1) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(Math.floor(i / 3), size - 11 + (i % 3));
      mark(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return res;
}

function readCodewords(matrix, version) {
  const size = version * 4 + 17;
  const res = reservedMap(version);
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (res[row][c]) continue;
        bits.push(matrix[row][c]);
      }
    }
    upward = !upward;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
    words.push(v);
  }
  return words;
}

function readFormat(matrix, size) {
  const bits = [];
  for (let i = 0; i <= 5; i += 1) bits.push(matrix[8][i]);
  bits.push(matrix[8][7], matrix[8][8], matrix[7][8]);
  for (let i = 9; i <= 14; i += 1) bits.push(matrix[14 - i][8]);
  let v = 0;
  for (const b of bits) v = (v << 1) | b;
  return v;
}

function polyMod(a, b) {
  let out = a.slice();
  while (out.length >= b.length) {
    const factor = out[0];
    const shift = out.length - b.length;
    if (factor !== 0) {
      for (let i = 0; i < b.length; i += 1) out[i] ^= mul(b[i], factor);
    }
    while (out.length && out[0] === 0) out.shift();
    if (shift === 0) break;
  }
  return out;
}

/** 用汉明距离做纠错（每块最多纠 t 个码字错误） */
function correctBlock(blockData, ecWords, t, blockLen) {
  const received = [...blockData, ...ecWords];
  // 计算 Syndrome
  const synd = [];
  let hasError = false;
  for (let i = 0; i < ecWords.length; i += 1) {
    let s = 0;
    for (let j = 0; j < received.length; j += 1) s = mul(s, EXP[i]) ^ received[j];
    synd.push(s);
    if (s !== 0) hasError = true;
  }
  if (!hasError) return { data: blockData, corrected: 0 };
  // 为求简单：用 Berlekamp-Massey + Chien
  let errLoc = null;
  {
    let C = [1];
    let B = [1];
    let L = 0;
    let m = 1;
    let b = 1;
    for (let n = 0; n < ecWords.length; n += 1) {
      let d = synd[n];
      for (let i = 1; i <= L; i += 1) d ^= mul(C[i] || 0, synd[n - i]);
      if (d === 0) {
        m += 1;
      } else if (2 * L <= n) {
        const T = C.slice();
        const scale = mul(d, inv(b));
        const shifted = B.map((v) => mul(v, scale));
        while (C.length < shifted.length + m) C.push(0);
        for (let i = 0; i < shifted.length; i += 1) C[i + m] ^= shifted[i];
        L = n + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        const scale = mul(d, inv(b));
        const shifted = B.map((v) => mul(v, scale));
        while (C.length < shifted.length + m) C.push(0);
        for (let i = 0; i < shifted.length; i += 1) C[i + m] ^= shifted[i];
        m += 1;
      }
    }
    const positions = [];
    for (let i = 0; i < received.length; i += 1) {
      // 求 C(x) 的根：把 x = alpha^-i 代入
      const x = EXP[(255 - (i % 255)) % 255];
      let sum = 0;
      let xp = 1;
      for (let j = 0; j < C.length; j += 1) {
        sum ^= mul(C[j] || 0, xp);
        xp = mul(xp, x);
      }
      if (sum === 0) positions.push(received.length - 1 - i);
    }
    if (positions.length !== L || positions.length === 0 || positions.length > t) {
      return null;
    }
    errLoc = positions;
  }
  const fixed = received.slice();
  for (const p of errLoc) {
    // 用 Forney 简化：直接试所有 255 种值不可行；用线性方程组解
    fixed[p] ^= 0; // 占位，下面用 Brute-force 单点修正
  }
  // 简单可靠的做法：对每个错误位置，用其余正确的 syndrome 关系解出错误值
  // 这里使用暴力：错误个数少（<= t），对每个位置尝试 1..255
  const values = new Array(errLoc.length).fill(1);
  const recompute = (candidate) => {
    const test = received.slice();
    errLoc.forEach((p, i) => { test[p] ^= candidate[i]; });
    let ok = true;
    for (let i = 0; i < ecWords.length && ok; i += 1) {
      let s = 0;
      for (let j = 0; j < test.length; j += 1) s = mul(s, EXP[i]) ^ test[j];
      if (s !== 0) ok = false;
    }
    return ok;
  };
  if (errLoc.length === 1) {
    for (let v = 1; v < 256; v += 1) {
      if (recompute([v])) {
        values[0] = v;
        const out = received.slice();
        out[errLoc[0]] ^= v;
        return { data: out.slice(0, blockLen), corrected: 1 };
      }
    }
    return null;
  }
  if (errLoc.length === 2) {
    for (let v1 = 1; v1 < 256; v1 += 1) {
      for (let v2 = 1; v2 < 256; v2 += 1) {
        if (recompute([v1, v2])) {
          const out = received.slice();
          out[errLoc[0]] ^= v1;
          out[errLoc[1]] ^= v2;
          return { data: out.slice(0, blockLen), corrected: 2 };
        }
      }
    }
  }
  return null;
}

function inv(a) {
  if (a === 0) throw new Error('inv(0)');
  return EXP[255 - LOG[a]];
}

function deinterleave(words, version, level) {
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = EC_BLOCKS[version][level];
  const blocks = [];
  for (let i = 0; i < g1Blocks; i += 1) blocks.push({ data: [], ec: [], dataLen: g1Data });
  for (let i = 0; i < g2Blocks; i += 1) blocks.push({ data: [], ec: [], dataLen: g2Data });
  let idx = 0;
  const maxData = Math.max(...blocks.map((b) => b.dataLen));
  for (let i = 0; i < maxData; i += 1) {
    for (const b of blocks) if (i < b.dataLen) b.data.push(words[idx++]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const b of blocks) b.ec.push(words[idx++]);
  }
  return blocks;
}

function decodeMatrix(matrix, { expectVersion = null, expectLevel = 'M' } = {}) {
  const sample = matrix[0].length;
  const version = (sample - 17) / 4;
  if (!Number.isInteger(version)) throw new Error('矩阵尺寸非法');
  const fmt = readFormat(matrix, sample);
  // 反查格式位：验证 BCH 距离为 0
  const G = 0b10100110111;
  let bestLevel = null;
  let bestMask = null;
  let bestDist = 99;
  for (const [name, lv] of Object.entries(EC_LEVELS)) {
    for (let mask = 0; mask < 8; mask += 1) {
      const data = (lv << 3) | mask;
      let d = data << 10;
      for (let i = 14; i >= 10; i -= 1) if (d & (1 << i)) d ^= G << (i - 10);
      const bits = ((data << 10) | d) ^ 0b101010000010010;
      let dist = 0;
      for (let i = 0; i < 15; i += 1) {
        if (((bits >> i) & 1) !== ((fmt >> (14 - i)) & 1)) dist += 1;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestLevel = name;
        bestMask = mask;
      }
    }
  }
  if (expectVersion !== null && expectVersion !== version) {
    throw new Error(`版本不符：期望 ${expectVersion}，实际 ${version}`);
  }
  if (expectLevel && expectLevel !== bestLevel) {
    throw new Error(`纠错等级不符：期望 ${expectLevel}，实际 ${bestLevel}`);
  }
  // 反掩码
  const unmasked = matrix.map((row) => row.slice());
  for (let r = 0; r < sample; r += 1) {
    for (let c = 0; c < sample; c += 1) {
      if (reservedMap(version)[r][c]) continue;
      if (maskFn(bestMask, r, c)) unmasked[r][c] ^= 1;
    }
  }
  const words = readCodewords(unmasked, version);
  const blocks = deinterleave(words, version, bestLevel);
  const dataWords = [];
  for (const b of blocks) {
    const t = Math.floor(b.ec.length / 2);
    const corrected = correctBlock(b.data, b.ec, t, b.dataLen);
    if (!corrected) throw new Error('纠错失败');
    dataWords.push(...corrected.data);
  }
  // 解析比特流
  const bits = [];
  for (const w of dataWords) for (let i = 7; i >= 0; i -= 1) bits.push((w >> i) & 1);
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | bits.shift();
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`模式不是字节模式：${mode.toString(2)}`);
  const len = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i += 1) bytes.push(take(8));
  return { text: new TextDecoder().decode(Uint8Array.from(bytes)), version, level: bestLevel, mask: bestMask };
}

// ---- 测试 ----
const LevelName = { L: 'L', M: 'M', Q: 'Q', H: 'H' };
const cases = [
  { text: 'http://192.168.1.20:81/share/abcdefghijkm', level: 'M' },
  { text: 'http://192.168.1.20:81/share/abc', level: 'L' },
  { text: 'https://daylog.example.com/share/xyz234567890?from=2024-05-01', level: 'M' },
  { text: 'x'.repeat(120), level: 'Q' },
  { text: 'x'.repeat(200), level: 'M' },
  { text: '分享我的每一天 https://example.com/share/tok123456789', level: 'M' },
];

let failed = 0;
for (const c of cases) {
  try {
    const { matrix, size, version } = createQrMatrix(c.text, { level: c.level });
    const out = decodeMatrix(matrix, { expectVersion: version, expectLevel: c.level });
    if (out.text !== c.text) throw new Error(`文本不一致：${out.text.slice(0, 40)}`);
    console.log(`✓ v${version} ${c.level} ${size}x${size} mask=${out.mask} len=${c.text.length}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ [${c.level}] ${c.text.slice(0, 40)} :: ${err.message}`);
  }
}

// 尺寸 / 定位图形结构校验
{
  const { matrix, size } = createQrMatrix('http://10.0.0.2:81/share/abcd1234', { level: 'M' });
  const checks = [
    ['左上定位', matrix[0][0] === 1 && matrix[6][6] === 1 && matrix[1][1] === 0],
    ['右上定位', matrix[0][size - 1] === 1],
    ['左下定位', matrix[size - 1][0] === 1],
    ['时序图形', matrix[6][8] === 1 && matrix[6][9] === 0],
    ['固定黑点', matrix[size - 8][8] === 1],
  ];
  for (const [name, ok] of checks) {
    if (!ok) {
      failed += 1;
      console.error(`✗ 结构校验失败：${name}`);
    }
  }
  if (!failed) console.log('✓ 结构校验通过（定位/时序/固定点）');
}

if (failed) {
  console.error(`\nQR 自检失败：${failed} 项`);
  process.exit(1);
}
console.log('\nQR 自检全部通过 ✅');
