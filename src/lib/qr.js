/**
 * 极简 QR 码生成器（字节模式，版本 1-10，纠错等级 L/M/Q/H）。
 * 零依赖：用于把分享链接渲染成 SVG / 直接画到 <canvas>。
 */

const EC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };

// 版本 -> 每个纠错等级的数据码字数 (total codewords - ec codewords)
const DATA_CODEWORDS = {
  1: { L: 19, M: 16, Q: 13, H: 9 },
  2: { L: 34, M: 28, Q: 22, H: 16 },
  3: { L: 55, M: 44, Q: 34, H: 26 },
  4: { L: 80, M: 64, Q: 48, H: 36 },
  5: { L: 108, M: 86, Q: 62, H: 46 },
  6: { L: 136, M: 108, Q: 76, H: 60 },
  7: { L: 156, M: 124, Q: 88, H: 66 },
  8: { L: 194, M: 154, Q: 110, H: 86 },
  9: { L: 232, M: 182, Q: 132, H: 100 },
  10: { L: 274, M: 216, Q: 154, H: 122 },
};

// 版本 -> 纠错等级 -> [每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
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
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// ---- GF(256) ----
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

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      res[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return res.slice(data.length);
}

// ---- 位缓冲 ----
class BitBuffer {
  constructor() {
    this.bits = [];
  }
  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

function chooseVersion(byteLen, level) {
  for (let v = 1; v <= 10; v += 1) {
    const capacity = DATA_CODEWORDS[v][level];
    const lenBits = v <= 9 ? 8 : 16;
    const need = Math.ceil((4 + lenBits + byteLen * 8) / 8);
    if (need <= capacity) return v;
  }
  throw new Error('内容过长，无法生成二维码（请缩短链接）');
}

function buildCodewords(bytes, version, level) {
  const bits = new BitBuffer();
  bits.put(0b0100, 4); // 字节模式
  bits.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bits.put(b, 8);
  const capacityBits = DATA_CODEWORDS[version][level] * 8;
  if (bits.length > capacityBits) throw new Error('内容超出容量');
  // 终止符
  const term = Math.min(4, capacityBits - bits.length);
  bits.put(0, term);
  // 补齐到字节
  while (bits.length % 8 !== 0) bits.put(0, 1);
  const data = bits.toBytes();
  // 填充码字
  const words = Array.from(data);
  const padBytes = [0xec, 0x11];
  let i = 0;
  while (words.length < DATA_CODEWORDS[version][level]) {
    words.push(padBytes[i % 2]);
    i += 1;
  }
  // 分块
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = EC_BLOCKS[version][level];
  const blocks = [];
  let offset = 0;
  for (let b = 0; b < g1Blocks; b += 1) {
    const chunk = Uint8Array.from(words.slice(offset, offset + g1Data));
    offset += g1Data;
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecPerBlock) });
  }
  for (let b = 0; b < g2Blocks; b += 1) {
    const chunk = Uint8Array.from(words.slice(offset, offset + g2Data));
    offset += g2Data;
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecPerBlock) });
  }
  // 交织
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i2 = 0; i2 < maxData; i2 += 1) {
    for (const b of blocks) if (i2 < b.data.length) out.push(b.data[i2]);
  }
  for (let i2 = 0; i2 < ecPerBlock; i2 += 1) {
    for (const b of blocks) out.push(b.ec[i2]);
  }
  return out;
}

// ---- 矩阵 ----
function patternPosition(row, col, version) {
  const size = version * 4 + 17;
  // 定位图形 + 分隔符
  const inFinder = (r, c) => r >= 0 && r <= 6 && c >= 0 && c <= 6;
  if (inFinder(row, col) || inFinder(row - size + 7, col) || inFinder(row, col - size + 7)) return true;
  // 时序图形
  if (row === 6 || col === 6) return true;
  // 校正图形
  const coords = ALIGNMENT[version];
  for (const r of coords) {
    for (const c of coords) {
      if ((r === 6 && c === 6) || (r === 6 && c === coords[coords.length - 1]) || (r === coords[coords.length - 1] && c === 6)) {
        continue;
      }
      if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
    }
  }
  // 格式信息区
  if (row === 8 && (col <= 8 || col >= size - 8)) return true;
  if (col === 8 && (row <= 8 || row >= size - 8)) return true;
  // 版本信息（版本 >= 7）
  if (version >= 7) {
    if (row < 6 && col >= size - 11 && col <= size - 9) return true;
    if (col < 6 && row >= size - 11 && row <= size - 9) return true;
  }
  return false;
}

function bchFormat(data) {
  let d = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if (d & (1 << i)) d ^= g << (i - 10);
  }
  return ((data << 10) | d) ^ 0b101010000010010;
}

function bchVersion(version) {
  let d = version << 12;
  const g = 0b1111100100101;
  for (let i = 17; i >= 12; i -= 1) {
    if (d & (1 << i)) d ^= g << (i - 12);
  }
  return (version << 12) | d;
}

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

function buildMatrix(version, level, codewords) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, v, res = true) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = v;
    if (res) reserved[r][c] = true;
  };

  // 定位图形
  const drawFinder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const isDark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, isDark ? 1 : 0);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 校正图形
  const coords = ALIGNMENT[version];
  for (const r of coords) {
    for (const c of coords) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(r + dr, c + dc, dark ? 1 : 0);
        }
      }
    }
  }

  // 时序图形
  for (let i = 8; i < size - 8; i += 1) {
    if (!reserved[6][i]) set(6, i, i % 2 === 0 ? 1 : 0);
    if (!reserved[i][6]) set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // 格式信息占位（稍后写入真实值）
  const formatPositions = [];
  const reserveFormat = () => {
    for (let i = 0; i <= 8; i += 1) {
      if (i !== 6) {
        if (!reserved[8][i]) { modules[8][i] = 0; reserved[8][i] = true; formatPositions.push([8, i]); }
        if (!reserved[i][8]) { modules[i][8] = 0; reserved[i][8] = true; formatPositions.push([i, 8]); }
      }
    }
    for (let i = 0; i < 8; i += 1) {
      if (!reserved[8][size - 1 - i]) { modules[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; formatPositions.push([8, size - 1 - i]); }
      if (!reserved[size - 1 - i][8]) { modules[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; formatPositions.push([size - 1 - i, 8]); }
    }
    set(size - 8, 8, 1); // 固定黑点
  };
  reserveFormat();

  // 版本信息（版本 >= 7）
  if (version >= 7) {
    const vinfo = bchVersion(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = (vinfo >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      set(size - 11 + c, r, bit);
      set(r, size - 11 + c, bit);
    }
  }
  // 数据位（右下角开始，蛇形）
  const bits = [];
  for (const word of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((word >> i) & 1);
  }
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
        modules[row][c] = bit;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }

  // 选择最优掩码
  const levelBits = EC_LEVELS[level];
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const trial = modules.map((row) => row.slice());
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!reserved[r][c] && maskFn(mask, r, c)) trial[r][c] ^= 1;
      }
    }
    applyFormat(trial, size, levelBits, mask);
    const score = penalty(trial, size);
    if (!best || score < best.score) best = { score, matrix: trial, mask };
  }
  return best.matrix;
}

function applyFormat(matrix, size, levelBits, mask) {
  const data = (levelBits << 3) | mask;
  const bits = bchFormat(data);
  const getBit = (i) => (bits >> i) & 1;
  // 左上
  for (let i = 0; i <= 5; i += 1) matrix[8][i] = getBit(i);
  matrix[8][7] = getBit(6);
  matrix[8][8] = getBit(7);
  matrix[7][8] = getBit(8);
  for (let i = 9; i <= 14; i += 1) matrix[14 - i][8] = getBit(i);
  // 右上 / 左下
  for (let i = 0; i <= 7; i += 1) matrix[8][size - 1 - i] = getBit(i);
  for (let i = 8; i <= 14; i += 1) matrix[size - 15 + i][8] = getBit(i);
  matrix[size - 8][8] = 1;
}

function penalty(matrix, size) {
  let score = 0;
  // 规则 1：连续同色
  for (let r = 0; r < size; r += 1) {
    let run = 1;
    for (let c = 1; c < size; c += 1) {
      if (matrix[r][c] === matrix[r][c - 1]) run += 1;
      else {
        if (run >= 5) score += PENALTY_N1 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += PENALTY_N1 + (run - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let run = 1;
    for (let r = 1; r < size; r += 1) {
      if (matrix[r][c] === matrix[r - 1][c]) run += 1;
      else {
        if (run >= 5) score += PENALTY_N1 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += PENALTY_N1 + (run - 5);
  }
  // 规则 2：2x2 同色
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        score += PENALTY_N2;
      }
    }
  }
  // 规则 3：1:1:3:1:1 模式
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (arr) => {
    for (let i = 0; i + 7 <= arr.length; i += 1) {
      let ok = true;
      for (let j = 0; j < 7; j += 1) {
        if (arr[i + j] !== pattern[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const before = arr.slice(Math.max(0, i - 4), i);
      const after = arr.slice(i + 7, i + 11);
      const lightBefore = before.length === 4 && before.every((v) => v === 0);
      const lightAfter = after.length === 4 && after.every((v) => v === 0);
      if (lightBefore || lightAfter) score += PENALTY_N3;
    }
  };
  for (let r = 0; r < size; r += 1) matches(matrix[r]);
  for (let c = 0; c < size; c += 1) matches(matrix.map((row) => row[c]));
  // 规则 4：暗色比例
  const dark = matrix.flat().filter((v) => v === 1).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * PENALTY_N4;
  return score;
}

export function createQrMatrix(text, { level = 'M' } = {}) {
  const lvl = EC_LEVELS[level] === undefined ? 'M' : level;
  const bytes = utf8Bytes(text);
  const version = chooseVersion(bytes.length, lvl);
  const codewords = buildCodewords(bytes, version, lvl);
  const matrix = buildMatrix(version, lvl, codewords);
  return { matrix, size: matrix.length, version };
}

export function makeQrSvg(text, { scale = 8, level = 'M', margin = 4, dark = '#111827', light = '#ffffff' } = {}) {
  const { matrix, size } = createQrMatrix(text, { level });
  const dim = (size + margin * 2) * scale;
  const parts = [];
  for (let r = 0; r < size; r += 1) {
    let runStart = -1;
    for (let c = 0; c <= size; c += 1) {
      const on = c < size && matrix[r][c] === 1;
      if (on && runStart === -1) runStart = c;
      if (!on && runStart !== -1) {
        const w = c - runStart;
        parts.push(
          `<rect x="${(runStart + margin) * scale}" y="${(r + margin) * scale}" width="${w * scale}" height="${scale}"/>`
        );
        runStart = -1;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${parts.join('')}</g></svg>`;
}
