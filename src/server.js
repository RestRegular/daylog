import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDirs, localAddresses } from './config.js';
import { closeStore, getStore } from './db/store.js';
import { cleanupStaleTemp } from './media/files.js';
import { notificationsPayload } from './notify.js';
import {
  HttpError,
  MIME,
  extOf,
  jsonBody,
  sendFile,
  sendHtml,
  sendJson,
  sendText,
} from './http/http.js';
import { getUserFromRequest } from './http/authRoutes.js';
import { publicUser } from './http/shared.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerUserRoutes } from './http/routes/users.js';
import { registerFriendRoutes } from './http/routes/friends.js';
import { registerAnniversaryRoutes } from './http/routes/anniversaries.js';
import { registerPostRoutes } from './http/routes/posts.js';
import { registerMediaRoutes } from './http/routes/media.js';
import { registerShareRoutes } from './http/routes/share.js';
import { makeQrSvg } from './lib/qr.js';
import { normalizeTimezone } from './lib/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function registerRoute(routes, method, pattern, handler) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
}

function createRouter() {
  const routes = [];
  const r = {
    get: (p, h) => registerRoute(routes, 'GET', p, h),
    post: (p, h) => registerRoute(routes, 'POST', p, h),
    patch: (p, h) => registerRoute(routes, 'PATCH', p, h),
    put: (p, h) => registerRoute(routes, 'PUT', p, h),
    delete: (p, h) => registerRoute(routes, 'DELETE', p, h),
    routes,
  };
  registerAuthRoutes(r);
  registerUserRoutes(r);
  registerFriendRoutes(r);
  registerAnniversaryRoutes(r);
  registerPostRoutes(r);
  registerMediaRoutes(r);
  registerShareRoutes(r);

  r.get('/api/health', async (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      version: config.version,
      time: Date.now(),
      uptimeSec: Math.round(process.uptime()),
    });
  });

  r.get('/api/qr', async (ctx) => {
    const data = ctx.query.get('data') || '';
    if (!data || data.length > 1024) throw new HttpError(400, 'data 参数无效');
    const scale = Math.min(Math.max(Number(ctx.query.get('scale')) || 8, 2), 24);
    const svg = makeQrSvg(data, { scale });
    ctx.res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    ctx.res.end(svg);
  });

  // 限时分享链接页（每次分享生成一条，范围与有效期都绑在链接上）
  r.get('/s/:token', async (ctx) => {
    sendHtml(ctx.res, 200, renderStatic('share.html'));
  });

  // 老版永久链接（/share/<token>）已停用，但仍然返回分享页，由页面提示"链接已失效"
  r.get('/share/:token', async (ctx) => {
    sendHtml(ctx.res, 200, renderStatic('share.html'));
  });

  // 用用户名访问好友的时间线（应用内"点好友头像 → 打开他的时间线"，需登录 + 好友关系）
  r.get('/u/:name/timeline', async (ctx) => {
    sendHtml(ctx.res, 200, renderStatic('share.html'));
  });

  return r;
}

function renderStatic(file) {
  try {
    return fs.readFileSync(path.join(config.publicDir, file), 'utf8');
  } catch {
    return `<!doctype html><meta charset="utf-8"><title>Not found</title><h1>缺少 ${file}</h1>`;
  }
}

async function serveStatic(ctx) {
  const { req, res, pathname } = ctx;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(config.publicDir);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (stat.isDirectory()) return false;
  const ext = extOf(target);
  // 代码类资源（html/js/css/sw）不缓存：改完刷新立即生效，避免"改了却看不到"的假象。
  // 体积很小，局域网上直取更快；图标等静态图片仍然长缓存。
  const isCode = ['.html', '.js', '.mjs', '.css', '.webmanifest'].includes(ext) || path.basename(target) === 'sw.js';
  const immutable = /\/icons\//.test(rel) || /\.(png|svg|woff2|ico)$/.test(ext);
  sendFile(req, res, target, {
    contentType: MIME[ext] || 'application/octet-stream',
    cache: isCode ? 'no-store, must-revalidate' : immutable ? 'public, max-age=604800' : 'public, max-age=3600',
  });
  return true;
}

function createContext(req, res, store) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ctx = {
    req,
    res,
    url,
    store,
    pathname: decodeURIComponent(url.pathname),
    params: {},
    query: url.searchParams,
    ip: req.socket?.remoteAddress || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    user: null,
    sessionToken: null,
    publicUser,
    json: () => jsonBody(req),
    /**
     * 响应出口。这里**捎带通知层**：只要调用方是登录用户、且他有未读，
     * 就把未读摘要塞进 JSON 响应（`notifications` 字段）。
     *
     * 为什么这么做：agent 不是常驻进程，收不到"推送"；它唯一的动作就是调 API。
     * 于是"人做了事 → agent 下次一调用就必然看到" —— 即使不是实时的。
     * 只在有未读时才塞，且失败绝不影响正常响应（fail-open）。
     */
    send: (status, payload) => {
      let body = payload;
      if (user && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.notifications === undefined) {
        const skip = /^\/api\/me\/notifications/.test(ctx.pathname);
        if (!skip) {
          try {
            const extra = notificationsPayload(store, user.id, { limit: 5 });
            if (extra) body = { ...payload, notifications: extra };
          } catch {
            /* 通知层坏了也不能影响正常返回 */
          }
        }
      }
      sendJson(res, status, body);
    },
    timezone: normalizeTimezone(req.headers['x-daylog-tz'] || url.searchParams.get('tz') || config.timezone),
  };
  const { user, sessionToken } = getUserFromRequest(ctx);
  ctx.user = user;
  ctx.sessionToken = sessionToken;
  if (user) ctx.timezone = user.timezone || ctx.timezone;
  return ctx;
}

function handleError(err, ctx, res) {
  const status = err instanceof HttpError ? err.status : 500;
  const payload = {
    error: status === 500 ? '服务器内部错误' : err.message,
    code: err.code || 'error',
  };
  if (err.details) payload.details = err.details;
  if (status === 500) console.error('[server error]', err);
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  sendJson(res, status, payload);
}

export function createServer({ store = getStore() } = {}) {
  ensureDirs();
  const router = createRouter();
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let ctx;
    try {
      ctx = createContext(req, res, store);
    } catch {
      sendJson(res, 400, { error: '无效请求' });
      return;
    }
    res.on('error', (err) => {
      if (process.env.DAYLOG_LOG !== '0') console.error('[response error]', err.message);
    });
    req.on('error', () => {
      /* 客户端中断，交给各处理器善后 */
    });
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET,POST,PATCH,DELETE,HEAD,OPTIONS' });
        res.end();
        return;
      }
      const route = router.routes.find(
        (r) =>
          r.regex.test(ctx.pathname) &&
          (r.method === req.method || (req.method === 'HEAD' && r.method === 'GET'))
      );
      if (route) {
        const m = route.regex.exec(ctx.pathname);
        route.keys.forEach((key, i) => {
          ctx.params[key] = decodeURIComponent(m[i + 1]);
        });
        await route.handler(ctx);
        return;
      }
      if (ctx.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: '接口不存在', code: 'not_found', path: ctx.pathname });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(ctx);
        if (served) return;
        sendHtml(res, 200, renderStatic('index.html'));
        return;
      }
      sendJson(res, 405, { error: '方法不被允许' });
    } catch (err) {
      handleError(err, ctx, res);
    } finally {
      if (process.env.DAYLOG_LOG !== '0' && !ctx?.pathname?.startsWith('/api/health')) {
        const ms = Date.now() - started;
        if (ms > 300 || res.statusCode >= 400) {
          console.log(`[${req.method}] ${ctx?.pathname} -> ${res.statusCode} (${ms}ms)`);
        }
      }
    }
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}

export async function startServer() {
  ensureDirs();
  const store = getStore();
  store.purgeSessions();
  const migrated = store.migrateBirthdaysToAnniversaries();
  if (migrated) console.log(`已把 ${migrated} 个老「生日」字段迁移成纪念日条目`);
  const cleaned = cleanupStaleTemp();
  if (cleaned) console.log(`已清理 ${cleaned} 个残留临时文件`);
  const server = createServer({ store });

  const timer = setInterval(() => {
    try {
      store.purgeSessions();
      cleanupStaleTemp();
    } catch (err) {
      console.error('定期维护失败', err);
    }
  }, 6 * 3600 * 1000);
  timer.unref?.();

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const lines = ['', '  DayLog 已启动 🎉', `  本机访问    http://localhost:${addr.port}`];
  for (const nic of localAddresses()) {
    lines.push(`  局域网访问  http://${nic.address}:${addr.port}   (${nic.name})`);
  }
  lines.push(`  数据目录    ${config.dataDir}`);
  lines.push(`  注册开关    ${config.allowSignup ? '开放' : '关闭'}`);
  if (config.signupCode) lines.push('  注册邀请码  已设置');
  lines.push('');
  console.log(lines.join('\n'));
  return server;
}

export async function shutdown(server) {
  await new Promise((resolve) => server.close(resolve));
  closeStore();
}

// 直接运行：node src/server.js
//
// 注意 pm2：它是用自己的 lib/ProcessContainerFork.js 去 import() 应用的，
// 所以进程里的 process.argv[1] 是 pm2 的包装脚本、而不是本文件 ——
// 只比较 argv 的话，pm2 下的进程会显示 online 却永远不监听端口
// （日志里连一行都没有，表现为"pm2 起了但访问不了"）。
// pm2 会注入 pm_id / pm_exec_path，认这两个就够了（fork 和 cluster 都会注入）。
const isDirectRun = (() => {
  if (process.env.pm_id !== undefined || process.env.pm_exec_path) return true;
  try {
    return (
      process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const server = await startServer();
  const bye = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    await shutdown(server);
    process.exit(0);
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
}
