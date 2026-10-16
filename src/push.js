/**
 * 出站通知：把「好友发了新记录 / 收到好友请求」推到手机上。
 *
 * 为什么是"服务器出站推"而不是浏览器的 Web Push：
 *   线上是纯 HTTP（http://站点:81），浏览器不允许注册 Service Worker，
 *   Push API 也就用不了。改成服务器主动 POST 到推送服务的接口，
 *   由手机上的那个 App 弹原生通知 —— 不需要 HTTPS、不需要域名。
 *
 * 支持的通道（零依赖，用 Node 内置 fetch）：
 *   wecom    企业微信群机器人（国内最稳，推荐）
 *   webhook  通用：自己接 ntfy / Bark / Server酱 都行
 *   bark     Bark（iPhone）：GET https://api.day.app/<key>/<标题>/<正文>
 *   ntfy     ntfy：POST <server>/<topic>，正文即内容
 *
 * **通道只来自用户自己的设置**（设置页 / 好友页，存在数据库里）：
 *   以前还支持一套"服务器级通道"（DAYLOG_PUSH_WECOM_KEY + DAYLOG_PUSH_OWNER），
 *   2026-10-11 用户明确要求去掉 —— 它在界面上看不见，会出现
 *   「我明明没配 key，却还能收到推送」这种让人怀疑的怪事。现在没配就是没配。
 *
 * 仍然保留的服务器环境变量（跟"通道"无关）：
 *   DAYLOG_PUSH            1/0  管理员总开关：0 = 整站都不推
 *   DAYLOG_PUSH_ENDPOINT   覆盖企业微信服务地址（测试 / 自建代理用）
 *   DAYLOG_PUBLIC_URL      通知里链接用的站点地址（默认按请求的 Host 推）
 */

const DEFAULT_ENDPOINT = 'https://qyapi.weixin.qq.com';
const DEFAULT_EXCERPT = 60;

/**
 * 服务器侧配置。注意：**这里不再有通道**（key / url / kind 都没有），
 * 通道一律来自用户自己的设置。
 */
export function pushConfig(env = process.env) {
  const off = String(env.DAYLOG_PUSH ?? '').trim();
  return {
    enabled: !(off === '0' || off.toLowerCase() === 'false'),
    endpoint: String(env.DAYLOG_PUSH_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    publicUrl: String(env.DAYLOG_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  };
}

/**
 * 截断成一句话摘要（按字符数，换行压成空格）。
 * 实现放在 notify.js（收件箱那一层也要用），这里 import 进来自己用，并重新导出给老代码/测试。
 */
import { excerptOf, recordFriendRequestNotification, recordPostNotifications } from './notify.js';

export { excerptOf };

/**
 * 拼「好友发了新记录」这条通知。纯函数，方便测。
 * @returns {{title: string, body: string, link: string}}
 */
export function formatPostMessage({ authorName, body, mood, tags, dayLabel = '', url = '', excerpt = DEFAULT_EXCERPT } = {}) {
  const who = authorName || '好友';
  const title = `${who} 发了新记录`;
  const parts = [];
  const text = excerptOf(body, excerpt);
  if (text) parts.push(text);
  const meta = [mood, dayLabel, Array.isArray(tags) && tags.length ? tags.map((t) => `#${t}`).join(' ') : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) parts.push(meta);
  if (url) parts.push(url);
  return { title, body: parts.join('\n'), link: url };
}

/** 拼「收到好友请求」这条通知 */
export function formatFriendRequestMessage({ fromName, url = '' } = {}) {
  const who = fromName || '有人';
  return { title: `${who} 想加你为好友`, body: [url ? `去应用里确认：${url}` : '去应用里确认'].join(''), link: url };
}

/** 各通道的请求体；抽出来是为了能单测 */
export function buildRequest(config, { title, body, link = '' }) {
  const text = [title, body].filter(Boolean).join('\n');
  if (config.kind === 'wecom') {
    // markdown 里用一行链接，点开就是那条时间线
    const content = [`**${title}**`, body].filter(Boolean).join('\n');
    return {
      url: `${config.endpoint}/cgi-bin/webhook/send?key=${encodeURIComponent(config.wecomKey)}`,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }) },
    };
  }
  if (config.kind === 'bark') {
    const base = config.url.replace(/\/+$/, '');
    const path = [encodeURIComponent(title), encodeURIComponent(body)].filter(Boolean).join('/');
    return { url: `${base}/${path}`, init: { method: 'GET' } };
  }
  if (config.kind === 'ntfy') {
    return {
      url: config.url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}), Title: encodeURIComponent(title) },
        body: text,
      },
    };
  }
  // 通用 webhook：POST JSON
  return {
    url: config.url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify({ title, body, link, text }),
    },
  };
}

/**
 * 真的发出去。**绝不抛异常、绝不拖慢请求路径**：失败只记一条日志。
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function sendPush(config, message, { fetchImpl = globalThis.fetch, log = console, timeoutMs = 5000 } = {}) {
  if (!config || !message) return { ok: false, error: 'not_configured' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' };
  const { url, init } = buildRequest(config, message);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, ctl ? { ...init, signal: ctl.signal } : init);
    const okHttp = res && res.ok !== false && (res.status === undefined || (res.status >= 200 && res.status < 300));
    if (!okHttp) {
      log?.warn?.(`[daylog] 通知发送失败：HTTP ${res?.status}`);
      return { ok: false, status: res?.status };
    }
    // 企业微信**失败也回 HTTP 200**，必须看 errcode，否则 key 写错/被重置会被当成"发送成功"
    if (config.kind === 'wecom') {
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* 有些自建代理不回 JSON */
      }
      if (json && json.errcode !== 0) {
        log?.warn?.(`[daylog] 通知被企业微信拒绝：errcode=${json.errcode} ${json.errmsg || ''}`);
        return { ok: false, status: res.status, errcode: json.errcode, error: json.errmsg || `errcode ${json.errcode}` };
      }
    }
    return { ok: true, status: res?.status };
  } catch (err) {
    log?.warn?.(`[daylog] 通知发送失败：${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 通知里用的站点地址：优先 DAYLOG_PUBLIC_URL，否则按请求的 Host 推 */
export function baseUrlFor(ctx, config = pushConfig()) {
  if (config?.publicUrl) return config.publicUrl;
  const host = ctx?.req?.headers?.host;
  if (!host) return '';
  const proto = ctx?.req?.headers?.['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

/** 摘要字数归一（0 表示只推标题不推正文） */
function normExcerpt(value, fallback = DEFAULT_EXCERPT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(200, Math.round(n));
}

/**
 * 企业微信的口令字段：**整条 Webhook 地址、`key=xxx` 片段、裸 key 都接受**，
 * 统一归一成裸 key。理由很实际：让人只复制"key 那一段"很容易复制错/多带空格，
 * 大多数人会直接把整条地址粘进来。
 */
export function normalizeWecomKey(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const fromUrl = new URL(s).searchParams.get('key');
      if (fromUrl) return fromUrl.trim();
    } catch {
      /* 不是合法 URL，退回正则 */
    }
    const m = /[?&]key=([^&\s]+)/i.exec(s);
    if (m) return decodeURIComponent(m[1]).trim();
    return s; // 认不出来就原样存，发送时会失败并**如实报错**（不假装成功）
  }
  const prefixed = /^key\s*=\s*(.+)$/i.exec(s);
  if (prefixed) return prefixed[1].trim();
  return s;
}

/**
 * 把一条「推送设置」（用户表里的 push_settings / friend_push 行）归一成可用通道。
 * 返回的字段和 pushConfig() 完全一致，这样 buildRequest/sendPush 不用管来源。
 * 没配好（缺 key / 缺 url / 停用）→ null。
 */
export function channelFromSettings(row, { enabledDefault = true, endpoint = '' } = {}) {
  if (!row) return null;
  if (enabledDefault && row.enabled !== undefined && !row.enabled) return null;
  const kind = String(row.kind || '').trim().toLowerCase();
  const secret = kind === 'wecom' ? normalizeWecomKey(row.secret) : String(row.secret || '').trim();
  const url = String(row.url || '').trim();
  const token = String(row.token || '').trim();
  const excerpt = normExcerpt(row.excerpt);
  const base = { wecomKey: '', url: '', token, excerpt, endpoint: endpoint || DEFAULT_ENDPOINT, publicUrl: '' };
  if (kind === 'wecom') return secret ? { ...base, kind: 'wecom', wecomKey: secret } : null;
  if (kind === 'bark' || kind === 'ntfy' || kind === 'webhook') return url ? { ...base, kind, url } : null;
  // 没写 kind（好友例外里常见）：有 key 当企业微信，有 url 按域名猜
  if (secret) return { ...base, kind: 'wecom', wecomKey: secret };
  if (url) {
    const guess = url.includes('api.day.app') ? 'bark' : url.includes('ntfy') ? 'ntfy' : 'webhook';
    return { ...base, kind: guess, url };
  }
  return null;
}

/** 同一条通道（同一个 key / 同一个地址）只该收到一条 —— 用这个指纹去重 */
export function channelFingerprint(channel) {
  if (!channel) return '';
  return `${channel.kind}|${channel.wecomKey || ''}|${channel.url || ''}`;
}

/**
 * 算出「收件人 R 该用哪条通道收作者 A 的记录」：
 *   ① R 把 A 设成免推送 → 没有
 *   ② R 给 A 单独配了 key → 用单独的
 *   ③ 否则用 R 自己的默认 key
 *   ④ 都没配 → 没有（**不再有任何隐藏的服务器级兜底**，没配就是没配）
 */
export function channelForRecipient(store, recipientId, authorId, { endpoint = '' } = {}) {
  const pref = store.friendPushPref(recipientId, authorId);
  if (pref?.muted) return { channel: null, reason: 'muted' };
  const override = pref ? channelFromSettings({ ...pref, enabled: 1 }, { endpoint }) : null;
  if (override) return { channel: override, reason: 'override' };
  const ownRow = store.pushSettings(recipientId);
  if (!ownRow) return { channel: null, reason: 'not_configured' };
  const own = channelFromSettings(ownRow, { endpoint });
  return own ? { channel: own, reason: 'default' } : { channel: null, reason: 'disabled' };
}

/** 服务地址：DAYLOG_PUSH_ENDPOINT 优先（测试 / 自建代理用），否则用默认的企业微信 */
function serviceEndpoint(env = process.env) {
  return String(env.DAYLOG_PUSH_ENDPOINT || '').trim().replace(/\/+$/, '') || DEFAULT_ENDPOINT;
}

/**
 * 好友发了新记录 → **按收件人**推给他的每个好友（不推给作者自己）。
 * 每个收件人用自己的通道（免推送 / 单独 key / 默认 key），同一个 key 只发一条。
 */
export async function notifyNewPost(
  { store, author, post, dayKey = '', baseUrl = '', env = process.env, fetchImpl = globalThis.fetch, log = console } = {}
) {
  if (!store || !author || !post) return { sent: 0, skipped: 'bad_args' };
  // 先记收件箱（跟推送无关，关掉推送也照样记 —— 这一层是给 agent 看的）
  const recorded = recordPostNotifications({ store, author, post, dayKey });
  const cfg = pushConfig(env);
  if (!cfg.enabled) return { sent: 0, skipped: 'disabled', recorded };
  const friends = store.listFriends(author.id).filter((f) => f?.user?.id && f.user.id !== author.id);
  if (!friends.length) return { sent: 0, skipped: 'no_friends', recorded };

  const authorName = author.display_name || author.username;
  const url = baseUrl ? `${baseUrl}/#/home${dayKey ? `?date=${dayKey}` : ''}` : '';
  const seen = new Set();
  const jobs = [];
  let skipped = 0;
  for (const f of friends) {
    const { channel } = channelForRecipient(store, f.user.id, author.id, { endpoint: serviceEndpoint(env) });
    if (!channel) {
      skipped += 1;
      continue;
    }
    const fp = channelFingerprint(channel);
    if (seen.has(fp)) continue; // 同一个 key 的多个收件人 → 只发一条
    seen.add(fp);
    const message = formatPostMessage({
      authorName,
      body: post.body,
      mood: post.mood,
      tags: post.tags,
      dayLabel: dayKey,
      url,
      excerpt: channel.excerpt,
    });
    jobs.push(sendPush(channel, message, { fetchImpl, log }));
  }
  if (!jobs.length) return { sent: 0, skipped: skipped ? 'no_channel' : 'nothing', recipients: friends.length, recorded };
  const results = await Promise.all(jobs);
  return { sent: results.filter((r) => r.ok).length, tried: jobs.length, recipients: friends.length, results, recorded };
}

/** 收到好友请求 → 写收件箱 + 推给**收请求的那个人**（免推送 / 单独 key / 默认 key） */
export async function notifyFriendRequest(
  { store, from, to, baseUrl = '', env = process.env, fetchImpl = globalThis.fetch, log = console } = {}
) {
  if (!store || !from || !to) return { sent: 0, skipped: 'bad_args' };
  const recorded = recordFriendRequestNotification({ store, from, to });
  const cfg = pushConfig(env);
  if (!cfg.enabled) return { sent: 0, skipped: 'disabled', recorded };
  const { channel, reason } = channelForRecipient(store, to.id, from.id, { endpoint: serviceEndpoint(env) });
  if (!channel) return { sent: 0, skipped: reason, recorded };
  const message = formatFriendRequestMessage({
    fromName: from.display_name || from.username,
    url: baseUrl ? `${baseUrl}/#/friends` : '',
  });
  const sent = await sendPush(channel, message, { fetchImpl, log });
  return { sent: sent.ok ? 1 : 0, result: sent, via: reason, recorded };
}

/**
 * 给自己发一条测试通知（设置页那个「发送测试通知」按钮用）。
 * **只认你自己配的通道**：没配就明确报 not_configured，不会偷偷用别的东西发出去。
 */
export async function sendTestNotification(
  { store, user, env = process.env, fetchImpl = globalThis.fetch, log = console } = {}
) {
  if (!store || !user) return { ok: false, error: 'bad_args' };
  const cfg = pushConfig(env);
  if (!cfg.enabled) return { ok: false, error: 'disabled' };
  const channel = channelFromSettings(store.pushSettings(user.id), { endpoint: serviceEndpoint(env) });
  if (!channel) return { ok: false, error: 'not_configured' };
  const message = {
    title: 'DayLog 通知自检',
    body: ['收到这条就说明你的手机推送配好了 ✅', channel.kind === 'wecom' ? '' : `通道：${channel.kind}`].filter(Boolean).join('\n'),
    link: cfg.publicUrl || '',
  };
  return sendPush(channel, message, { fetchImpl, log });
}

