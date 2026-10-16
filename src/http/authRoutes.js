import { HttpError, clientIp, isSecureRequest, parseCookies, sendJson, serializeCookie } from './http.js';
import { config } from '../config.js';
import { hashPassword, timingSafeEqualStr, verifyPassword } from '../lib/crypto.js';
import { normalizeTimezone } from '../lib/time.js';

export const SESSION_COOKIE = 'daylog_session';

export function getUserFromRequest(ctx) {
  const cookies = parseCookies(ctx.req.headers.cookie);
  const bearer = /^Bearer\s+(.+)$/i.exec(ctx.req.headers.authorization || '');
  const token = cookies[SESSION_COOKIE] || (bearer ? bearer[1] : '');
  if (!token) return { user: null, sessionToken: null };
  const session = ctx.store.session(token);
  if (!session) return { user: null, sessionToken: null };
  const user = ctx.store.stmt.userById.get(session.user_id);
  if (!user) return { user: null, sessionToken: null };
  return { user, sessionToken: token };
}

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, '请先登录', 'unauthorized');
  return ctx.user;
}

export function setSessionCookie(ctx, token) {
  const cookie = serializeCookie(SESSION_COOKIE, token, {
    maxAge: config.sessionDays * 86400,
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(ctx.req),
  });
  ctx.res.setHeader('set-cookie', cookie);
}

export function clearSessionCookie(ctx) {
  ctx.res.setHeader(
    'set-cookie',
    serializeCookie(SESSION_COOKIE, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax' })
  );
}

function validateUsername(raw) {
  const username = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(username)) {
    throw new HttpError(400, '用户名需为 3-24 位小写字母、数字、_ . -，且以字母或数字开头', 'bad_username');
  }
  return username;
}

export function validatePassword(raw) {
  const password = String(raw || '');
  if (password.length < 6) throw new HttpError(400, '密码至少 6 位', 'bad_password');
  if (password.length > 200) throw new HttpError(400, '密码过长', 'bad_password');
  return password;
}

export async function handleSignup(ctx) {
  if (!config.allowSignup) throw new HttpError(403, '本站已关闭注册', 'signup_disabled');
  const body = await ctx.json();
  const username = validateUsername(body.username);
  const password = validatePassword(body.password);
  if (config.signupCode && !timingSafeEqualStr(body.signupCode || '', config.signupCode)) {
    throw new HttpError(403, '邀请码不正确', 'bad_invite');
  }
  if (ctx.store.stmt.userByName.get(username)) {
    throw new HttpError(409, '该用户名已被使用', 'username_taken');
  }
  const isFirstUser = ctx.store.userCount() === 0;
  const user = ctx.store.createUser({
    username,
    passwordHash: await hashPassword(password),
    displayName: String(body.displayName || username).slice(0, 40),
    timezone: normalizeTimezone(body.timezone || ctx.timezone),
    isAdmin: isFirstUser,
  });
  const token = ctx.store.createSession(user.id, { ua: ctx.userAgent, ip: ctx.ip });
  setSessionCookie(ctx, token);
  sendJson(ctx.res, 201, { user: ctx.publicUser(user), token, isFirstUser });
}

export async function handleLogin(ctx) {
  const body = await ctx.json();
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = ctx.store.stmt.userByName.get(username);
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) throw new HttpError(401, '用户名或密码不正确', 'bad_credentials');
  const token = ctx.store.createSession(user.id, { ua: ctx.userAgent, ip: ctx.ip });
  setSessionCookie(ctx, token);
  sendJson(ctx.res, 200, { user: ctx.publicUser(user), token });
}

export async function handleLogout(ctx) {
  if (ctx.sessionToken) ctx.store.destroySession(ctx.sessionToken);
  clearSessionCookie(ctx);
  sendJson(ctx.res, 200, { ok: true });
}

export async function handleChangePassword(ctx) {
  const user = requireUser(ctx);
  const body = await ctx.json();
  const current = String(body.currentPassword || '');
  const next = validatePassword(body.newPassword);
  const ok = await verifyPassword(current, user.password_hash);
  if (!ok) throw new HttpError(403, '当前密码不正确', 'bad_credentials');
  ctx.store.stmt.updateUserPassword.run(await hashPassword(next), Date.now(), user.id);
  ctx.store.stmt.deleteUserSessions.run(user.id);
  const token = ctx.store.createSession(user.id, { ua: ctx.userAgent, ip: ctx.ip });
  setSessionCookie(ctx, token);
  sendJson(ctx.res, 200, { ok: true, token });
}

export const authHelpers = { clientIp, isSecureRequest };
