import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export const config = {
  // 默认端口 81（可用环境变量 PORT 覆盖）
  port: envInt('PORT', 81),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DAYLOG_DATA_DIR || path.join(ROOT, 'data')),
  publicDir: path.join(ROOT, 'public'),
  dbFile: '',
  uploadDir: '',
  /** 单张图片上限 20MB，单个视频上限 300MB */
  maxImageBytes: envInt('DAYLOG_MAX_IMAGE_MB', 20) * 1024 * 1024,
  maxVideoBytes: envInt('DAYLOG_MAX_VIDEO_MB', 300) * 1024 * 1024,
  maxTextFileBytes: envInt('DAYLOG_MAX_FILE_MB', 20) * 1024 * 1024,
  /** 单个动态最多附件数 */
  maxFilesPerPost: envInt('DAYLOG_MAX_FILES_PER_POST', 12),
  /** 单次 multipart 请求整体上限 */
  maxRequestBytes: envInt('DAYLOG_MAX_REQUEST_MB', 400) * 1024 * 1024,
  /** 是否允许自助注册（默认允许，方便给朋友/家人开账号） */
  allowSignup: envBool('DAYLOG_ALLOW_SIGNUP', true),
  /** 可选的注册邀请码：设置后注册必须填写 */
  signupCode: process.env.DAYLOG_SIGNUP_CODE || '',
  /** 反向代理后面（如 cloudflared / nginx）时置 1，用于正确识别 https */
  trustProxy: envBool('DAYLOG_TRUST_PROXY', false),
  sessionDays: envInt('DAYLOG_SESSION_DAYS', 90),
  timezone: process.env.TZ || 'Asia/Shanghai',
  version: '1.0.0',
};

config.dbFile = path.join(config.dataDir, 'daylog.db');
config.uploadDir = path.join(config.dataDir, 'uploads');

export function ensureDirs() {
  for (const dir of [config.dataDir, config.uploadDir, path.join(config.uploadDir, 'tmp')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 局域网 / 本机可访问的地址列表，用于启动时打印分享链接 */
export function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ name, address: addr.address });
      }
    }
  }
  return out;
}
