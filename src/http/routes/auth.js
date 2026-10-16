import { handleChangePassword, handleLogin, handleLogout, handleSignup } from '../authRoutes.js';
import { config } from '../../config.js';

export function registerAuthRoutes(r) {
  r.post('/api/auth/signup', handleSignup);
  r.post('/api/auth/login', handleLogin);
  r.post('/api/auth/logout', handleLogout);
  r.post('/api/auth/password', handleChangePassword);

  r.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) {
      ctx.send(200, { user: null, allowSignup: config.allowSignup, needsSetup: ctx.store.userCount() === 0 });
      return;
    }
    const u = ctx.publicUser(ctx.user);
    // 注：这里不再下发永久分享令牌 —— 分享改成「每次生成一条限时链接」（/api/share/links）
    u.stats = ctx.store.stats(ctx.user.id);
    ctx.send(200, { user: u, allowSignup: config.allowSignup, needsSetup: false });
  });
}
