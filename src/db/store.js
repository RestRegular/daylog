import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { makeId, makeShareToken } from '../lib/crypto.js';
import { dayKey } from '../lib/time.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  birthday      TEXT,
  celebration_date TEXT,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  share_token   TEXT NOT NULL UNIQUE,
  share_enabled INTEGER NOT NULL DEFAULT 1,
  show_stats    INTEGER NOT NULL DEFAULT 1,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_by    TEXT,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS posts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  post_day   TEXT,
  location   TEXT NOT NULL DEFAULT '',
  mood       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_posts_user_time ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_day ON posts(user_id, post_day);

CREATE TABLE IF NOT EXISTS media (
  id            TEXT PRIMARY KEY,
  post_id       TEXT,
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  ext           TEXT NOT NULL,
  bytes         INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  duration      REAL,
  poster_ext    TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);

/**
 * 限时分享链接：每次分享都生成一条，绑死「看哪些内容」+ 什么时候过期。
 * scope: day（某一天）/ month（某个月）/ all（全部）
 * 过期链接不再能访问；revoked_at 是用户主动撤销。
 */
CREATE TABLE IF NOT EXISTS share_links (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  scope      TEXT NOT NULL,
  day        TEXT NOT NULL DEFAULT '',
  month      TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id, created_at DESC);

-- 好友关系（双向，一行一对；status = pending | accepted）
-- requester 是发起方，addressee 是接收方；alias_* 是各自给对方起的备注名
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  alias_by_requester TEXT NOT NULL DEFAULT '',
  alias_by_addressee TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);

-- 纪念日：生日也是一种纪念日（kind='birthday'，每个用户最多一条且自动特别关注）
CREATE TABLE IF NOT EXISTS anniversaries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '🎂',
  date       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  special    INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'custom',
  friend_id  TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anniversaries_user ON anniversaries(user_id, special DESC, sort_order ASC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const nowMs = () => Date.now();

/** 转义 LIKE 的通配符，避免用户输入的 % _ \ 改变查询语义 */
function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class Store {
  constructor(file = config.dbFile) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#migrate();
    this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '2');
    this.stmt = {};
    this.#prepare();
  }

  /**
   * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
   * 所以新增字段要在这里显式 ALTER（已存在则忽略错误），保证老库能平滑升级。
   */
  #migrate() {
    const addColumn = (table, column, definition) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch (err) {
        if (!/duplicate column/i.test(err.message)) throw err;
      }
    };
    addColumn('users', 'celebration_date', "TEXT");
    // 记录卡片的主题色（'' 未设置 / 'white' / 'avatar' / 预设 id / #rrggbb）
    addColumn('users', 'card_theme', "TEXT");
    // 纪念日可关联好友（不强制）
    addColumn('anniversaries', 'friend_id', "TEXT");
    // 附件顺序：编辑时可以拖动排序，也要能删掉某个附件
    addColumn('media', 'sort_order', "INTEGER");
    this.#backfillMediaOrder();

    /**
     * 记录有两个时间：
     *   created_at   发布时间（创建时间）—— 发布后固定不变
     *   occurred_at  「记录的事儿真正发生的时间」—— 编辑时可以改，排序 / 分组都按它
     * 老数据没有这一列，直接按 created_at 回填（以前 created_at 就兼着这个角色）。
     */
    addColumn('posts', 'occurred_at', "INTEGER");
    this.db.prepare('UPDATE posts SET occurred_at = created_at WHERE occurred_at IS NULL').run();

    /**
     * 手机通知（2026-10-11）：**收件人视角**的配置。
     *   push_settings  我自己的默认通道：好友发记录就推到它
     *   friend_push    我对某个好友的例外：免推送 / 单独通道（优先于默认）
     * 密钥存这里（自己的服务器、自己的 SQLite），接口只回掩码，不回完整值。
     */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_settings (
        user_id    TEXT PRIMARY KEY,
        kind       TEXT NOT NULL DEFAULT 'wecom',
        secret     TEXT NOT NULL DEFAULT '',
        url        TEXT NOT NULL DEFAULT '',
        token      TEXT NOT NULL DEFAULT '',
        excerpt    INTEGER NOT NULL DEFAULT 60,
        enabled    INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friend_push (
        owner_id   TEXT NOT NULL,
        friend_id  TEXT NOT NULL,
        muted      INTEGER NOT NULL DEFAULT 0,
        kind       TEXT NOT NULL DEFAULT '',
        secret     TEXT NOT NULL DEFAULT '',
        url        TEXT NOT NULL DEFAULT '',
        token      TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, friend_id)
      );

      /**
       * 收件箱（2026-10-11 用户提的"通知层"）：
       * 好友发了新记录 / 收到好友申请 / 好友申请被同意 —— 往收件人这里写一条。
       * 为什么需要它：agent 不是常驻进程、收不到"推送"，所以把未读摘要**捎带在每个 API 响应里**，
       * 这样"人做了事 → agent 下次一调用就能看到并处理"。
       */
      CREATE TABLE IF NOT EXISTS notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        actor_id   TEXT NOT NULL,
        post_id    TEXT,
        summary    TEXT NOT NULL DEFAULT '',
        day_key    TEXT,
        created_at INTEGER NOT NULL,
        read_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at, created_at DESC);
    `);
  }

  /**
   * 老库里的附件没有 sort_order：按「创建时间 + id」的旧顺序补 0..n-1。
   * 只跑一次（补完就没有 NULL 了），量很小（个人应用）。
   */
  #backfillMediaOrder() {
    const posts = this.db
      .prepare("SELECT DISTINCT post_id FROM media WHERE post_id IS NOT NULL AND sort_order IS NULL")
      .all();
    if (!posts.length) return;
    const list = this.db.prepare('SELECT id FROM media WHERE post_id = ? ORDER BY created_at ASC, id ASC');
    const set = this.db.prepare('UPDATE media SET sort_order = ? WHERE id = ?');
    for (const { post_id: postId } of posts) {
      list.all(postId).forEach((row, index) => set.run(index, row.id));
    }
  }

  #prepare() {
    const p = (sql) => this.db.prepare(sql);
    this.stmt = {
      userById: p('SELECT * FROM users WHERE id = ?'),
      userByName: p('SELECT * FROM users WHERE username = ?'),
      userByShare: p('SELECT * FROM users WHERE share_token = ?'),
      insertUser: p(`INSERT INTO users
        (id, username, display_name, password_hash, bio, avatar, birthday, timezone,
         share_token, share_enabled, show_stats, is_admin, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      updateUserProfile: p(`UPDATE users SET display_name=?, bio=?, birthday=?, celebration_date=?, avatar=?,
        timezone=?, updated_at=? WHERE id=?`),
      updateUserShare: p('UPDATE users SET share_enabled=?, show_stats=?, card_theme=?, updated_at=? WHERE id=?'),
      updateUserPassword: p('UPDATE users SET password_hash=?, updated_at=? WHERE id=?'),
      rotateShareToken: p('UPDATE users SET share_token=?, updated_at=? WHERE id=?'),
      allUsers: p('SELECT * FROM users ORDER BY created_at ASC'),
      countUsers: p('SELECT COUNT(*) AS c FROM users'),

      // ---- 好友关系 ----
      friendRow: p(`SELECT * FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`),
      insertFriend: p(`INSERT INTO friendships
        (requester_id, addressee_id, status, alias_by_requester, alias_by_addressee, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`),
      setFriendStatus: p(`UPDATE friendships SET status = ?, updated_at = ?
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`),
      deleteFriend: p(`DELETE FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`),
      // 备注名按「这一行是谁发起的」存两列。定位这一行必须用**行的两个方向**去匹配：
      // 以前只写 `requester_id = ? AND addressee_id = ?`，当「我」是接收方（对方加的我）时
      // 这条 UPDATE 命中 0 行，前端却收到 200 —— 表现就是「改了备注名没生效」。
      setAliasByRequester: p(`UPDATE friendships SET alias_by_requester = ?, updated_at = ?
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`),
      setAliasByAddressee: p(`UPDATE friendships SET alias_by_addressee = ?, updated_at = ?
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`),

      // ---- 手机通知 ----
      pushSettingsOf: p('SELECT * FROM push_settings WHERE user_id = ?'),
      upsertPushSettings: p(`INSERT INTO push_settings (user_id, kind, secret, url, token, excerpt, enabled, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET
          kind = excluded.kind, secret = excluded.secret, url = excluded.url, token = excluded.token,
          excerpt = excluded.excerpt, enabled = excluded.enabled, updated_at = excluded.updated_at`),
      friendPushOf: p('SELECT * FROM friend_push WHERE owner_id = ? AND friend_id = ?'),
      upsertFriendPush: p(`INSERT INTO friend_push (owner_id, friend_id, muted, kind, secret, url, token, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id, friend_id) DO UPDATE SET
          muted = excluded.muted, kind = excluded.kind, secret = excluded.secret,
          url = excluded.url, token = excluded.token, updated_at = excluded.updated_at`),
      deleteFriendPush: p('DELETE FROM friend_push WHERE owner_id = ? AND friend_id = ?'),
      deletePushForUser: p('DELETE FROM push_settings WHERE user_id = ?'),

      // ---- 收件箱（通知层）----
      insertNotification: p(`INSERT INTO notifications (user_id, kind, actor_id, post_id, summary, day_key, created_at)
        VALUES (?,?,?,?,?,?,?)`),
      notificationsOf: p(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
      unreadNotificationsOf: p(`SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT ?`),
      unreadCounts: p(`SELECT kind, COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL GROUP BY kind`),
      unreadTotal: p('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
      markNotificationRead: p('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL'),
      markAllNotificationsRead: p('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
      markNotificationsUpTo: p('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND created_at <= ?'),
      pruneNotifications: p(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
        SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
      )`),

      // ---- 纪念日 ----
      anniversariesOf: p(`SELECT * FROM anniversaries WHERE user_id = ?
        ORDER BY special DESC, sort_order ASC, date ASC, created_at ASC`),
      anniversariesOfFriend: p(`SELECT * FROM anniversaries WHERE user_id = ? AND friend_id = ?
        ORDER BY special DESC, sort_order ASC, date ASC, created_at ASC`),
      anniversaryById: p('SELECT * FROM anniversaries WHERE id = ?'),
      insertAnniversary: p(`INSERT INTO anniversaries
        (id, user_id, name, icon, date, note, special, kind, friend_id, sort_order, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      updateAnniversary: p(`UPDATE anniversaries SET name=?, icon=?, date=?, note=?, special=?, friend_id=?, updated_at=?
        WHERE id=? AND user_id=?`),
      deleteAnniversary: p('DELETE FROM anniversaries WHERE id=? AND user_id=?'),
      // 注意排除 kind='birthday'：生日永远是特别关注，不能被自定义纪念日顶掉
      clearSpecial: p("UPDATE anniversaries SET special = 0, updated_at = ? WHERE user_id = ? AND kind <> 'birthday'"),
      birthdayAnniversaryOf: p("SELECT * FROM anniversaries WHERE user_id = ? AND kind = 'birthday'"),
      countAnniversaries: p('SELECT COUNT(*) AS c FROM anniversaries WHERE user_id = ?'),
      usersWithBirthdayNoAnniversary: p(`SELECT id, birthday FROM users
        WHERE birthday IS NOT NULL AND birthday <> ''
          AND id NOT IN (SELECT user_id FROM anniversaries WHERE kind = 'birthday')`),
      deleteAnniversariesForUser: p('DELETE FROM anniversaries WHERE user_id = ?'),
      clearAnniversaryFriend: p('UPDATE anniversaries SET friend_id = NULL, updated_at = ? WHERE friend_id = ?'),
      acceptedFriendsOf: p(`SELECT * FROM friendships
        WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`),
      incomingRequests: p(`SELECT * FROM friendships
        WHERE status = 'pending' AND addressee_id = ? ORDER BY created_at DESC`),
      outgoingRequests: p(`SELECT * FROM friendships
        WHERE status = 'pending' AND requester_id = ? ORDER BY created_at DESC`),
      deleteFriendshipsForUser: p('DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?'),

      insertSession: p('INSERT INTO sessions (token, user_id, created_at, expires_at, ua, ip) VALUES (?,?,?,?,?,?)'),
      sessionByToken: p('SELECT * FROM sessions WHERE token = ?'),
      deleteSession: p('DELETE FROM sessions WHERE token = ?'),
      deleteUserSessions: p('DELETE FROM sessions WHERE user_id = ?'),
      purgeSessions: p('DELETE FROM sessions WHERE expires_at < ?'),

      insertPost: p(`INSERT INTO posts
        (id, user_id, body, created_at, occurred_at, updated_at, post_day, location, mood, tags, visibility)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
      updatePost: p(`UPDATE posts SET body=?, occurred_at=?, updated_at=?, post_day=?, location=?,
        mood=?, tags=?, visibility=? WHERE id=? AND user_id=?`),
      softDeletePost: p('UPDATE posts SET deleted_at=?, updated_at=? WHERE id=? AND user_id=?'),
      postById: p('SELECT * FROM posts WHERE id = ?'),
      postByIdForUser: p('SELECT * FROM posts WHERE id = ? AND user_id = ?'),

      insertMedia: p(`INSERT INTO media
        (id, post_id, user_id, kind, mime, ext, bytes, width, height, duration, poster_ext, original_name, created_at, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      mediaByPost: p('SELECT * FROM media WHERE post_id = ? ORDER BY COALESCE(sort_order, 0) ASC, created_at ASC, id ASC'),
      mediaById: p('SELECT * FROM media WHERE id = ?'),
      nextMediaOrder: p('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM media WHERE post_id = ?'),
      setMediaOrder: p('UPDATE media SET sort_order = ? WHERE id = ? AND post_id = ?'),

      insertShareLink: p(`INSERT INTO share_links
        (token, user_id, scope, day, month, expires_at, created_at, revoked_at)
        VALUES (?,?,?,?,?,?,?,?)`),
      shareLinkByToken: p('SELECT * FROM share_links WHERE token = ?'),
      shareLinksOfUser: p(`SELECT * FROM share_links
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT ?`),
      revokeShareLink: p('UPDATE share_links SET revoked_at = ? WHERE token = ? AND user_id = ?'),
      purgeShareLinks: p('DELETE FROM share_links WHERE expires_at < ?'),
      setPoster: p('UPDATE media SET poster_ext = ? WHERE id = ?'),
      deleteMediaById: p('DELETE FROM media WHERE id = ?'),
      deleteMediaByPost: p('DELETE FROM media WHERE post_id = ?'),

      statsForUser: p(`SELECT COUNT(*) AS posts, MIN(COALESCE(occurred_at, created_at)) AS first_at, MAX(COALESCE(occurred_at, created_at)) AS last_at
        FROM posts WHERE user_id = ? AND deleted_at IS NULL`),
      daysForUser: p(`SELECT DISTINCT COALESCE(post_day, '') AS d FROM posts
        WHERE user_id = ? AND deleted_at IS NULL`),
      mediaCountForUser: p('SELECT COUNT(*) AS c FROM media WHERE user_id = ?'),
      deleteUser: p('DELETE FROM users WHERE id = ?'),
      deletePostsForUser: p('DELETE FROM posts WHERE user_id = ?'),
      deleteMediaForUser: p('DELETE FROM media WHERE user_id = ?'),
    };
  }

  today(timezone) {
    return dayKey(nowMs(), timezone || config.timezone);
  }

  // ---------------- users ----------------

  createUser({
    username,
    passwordHash,
    displayName = '',
    timezone = config.timezone,
    isAdmin = false,
    bio = '',
  }) {
    const id = makeId('u');
    const ts = nowMs();
    let shareToken = makeShareToken(12);
    while (this.stmt.userByShare.get(shareToken)) shareToken = makeShareToken(12);
    this.stmt.insertUser.run(
      id,
      username,
      displayName || username,
      passwordHash,
      bio,
      null,
      null,
      timezone,
      shareToken,
      1,
      1,
      isAdmin ? 1 : 0,
      ts,
      ts
    );
    return this.stmt.userById.get(id);
  }

  userCount() {
    return this.stmt.countUsers.get()?.c || 0;
  }

  allUsers() {
    return this.stmt.allUsers.all();
  }

  // ---------------- 好友 ----------------

  /** 两人之间的关系行（无论谁发起） */
  friendRow(a, b) {
    return this.stmt.friendRow.get(a, b, b, a) || null;
  }

  /**
   * 关系状态：'none' | 'pending_out'（我发起的待确认）| 'pending_in'（待我确认）| 'accepted'
   */
  friendshipStatus(a, b) {
    const row = this.friendRow(a, b);
    if (!row) return 'none';
    if (row.status === 'accepted') return 'accepted';
    return row.requester_id === a ? 'pending_out' : 'pending_in';
  }

  /**
   * 发起好友请求。返回 { ok, status, reason }
   * - 已是好友 -> reason: 'already_friends'
   * - 已发过请求 -> reason: 'already_requested'
   * - 对方先发给我 -> 直接成为好友（双向同意）
   */
  requestFriend(requesterId, addresseeId) {
    if (requesterId === addresseeId) return { ok: false, reason: 'self' };
    const existing = this.friendRow(requesterId, addresseeId);
    const ts = nowMs();
    if (existing) {
      if (existing.status === 'accepted') return { ok: false, reason: 'already_friends' };
      if (existing.requester_id === requesterId) return { ok: false, reason: 'already_requested' };
      // 对方已经请求过我 -> 视为互相确认
      this.stmt.setFriendStatus.run('accepted', ts, requesterId, addresseeId, addresseeId, requesterId);
      return { ok: true, status: 'accepted' };
    }
    this.stmt.insertFriend.run(requesterId, addresseeId, 'pending', '', '', ts, ts);
    return { ok: true, status: 'pending' };
  }

  /** 同意好友请求（仅接收方可以） */
  acceptFriend(userId, otherId) {
    const row = this.friendRow(userId, otherId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'accepted') return { ok: true, status: 'accepted' };
    if (row.addressee_id !== userId) return { ok: false, reason: 'not_addressee' };
    this.stmt.setFriendStatus.run('accepted', nowMs(), userId, otherId, otherId, userId);
    return { ok: true, status: 'accepted' };
  }

  /** 拒绝请求 / 解除好友 / 撤回请求：统一删除关系行 */
  removeFriend(userId, otherId) {
    const row = this.friendRow(userId, otherId);
    if (!row) return { ok: false, reason: 'not_found' };
    this.stmt.deleteFriend.run(userId, otherId, otherId, userId);
    // 解除好友关系后，双方纪念日上对彼此的关联也要清掉，避免留下悬空引用
    const ts = nowMs();
    this.stmt.clearAnniversaryFriend.run(ts, otherId);
    return { ok: true, removed: row.status };
  }

  /** 我给某个好友起的备注名（不是好友 / 自己 就返回空串） */
  aliasFor(userId, otherId) {
    if (!userId || !otherId || userId === otherId) return '';
    const row = this.friendRow(userId, otherId);
    if (!row) return '';
    const alias = row.requester_id === userId ? row.alias_by_requester : row.alias_by_addressee;
    return alias || '';
  }

  /** 设置我给对方的备注名 */
  setFriendAlias(userId, otherId, alias) {
    const row = this.friendRow(userId, otherId);
    if (!row) return { ok: false, reason: 'not_found' };
    const value = String(alias || '').slice(0, 24);
    // 定位用「行的两个方向」，写哪一列看这一行是谁发起的
    const args = [value, nowMs(), userId, otherId, otherId, userId];
    if (row.requester_id === userId) this.stmt.setAliasByRequester.run(...args);
    else this.stmt.setAliasByAddressee.run(...args);
    return { ok: true, alias: value };
  }

  // ------------------------------------------------------------ 手机通知配置

  /** 我的默认推送通道（没配过返回 null） */
  pushSettings(userId) {
    if (!userId) return null;
    return this.stmt.pushSettingsOf.get(userId) || null;
  }

  /**
   * 写我的默认通道。patch 里没给的字段保持原样；
   * clearSecret/clearUrl 用来主动清空（否则空串会被当成"没改"）。
   */
  setPushSettings(userId, patch = {}) {
    const cur = this.pushSettings(userId) || {
      user_id: userId,
      kind: 'wecom',
      secret: '',
      url: '',
      token: '',
      excerpt: 60,
      enabled: 0,
    };
    const kind = patch.kind === undefined ? cur.kind : String(patch.kind || 'wecom').slice(0, 16);
    const secret = patch.clearSecret ? '' : patch.secret === undefined ? cur.secret : String(patch.secret || '').slice(0, 400);
    const url = patch.clearUrl ? '' : patch.url === undefined ? cur.url : String(patch.url || '').slice(0, 400);
    const token = patch.clearToken ? '' : patch.token === undefined ? cur.token : String(patch.token || '').slice(0, 400);
    const rawExcerpt = patch.excerpt === undefined ? cur.excerpt : Number(patch.excerpt);
    const excerpt = Number.isFinite(rawExcerpt) ? Math.max(0, Math.min(200, Math.round(rawExcerpt))) : cur.excerpt;
    const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0;
    this.stmt.upsertPushSettings.run(userId, kind, secret, url, token, excerpt, enabled, nowMs());
    return this.pushSettings(userId);
  }

  /** 我对某个好友的例外设置（免推送 / 单独通道）；没设过返回 null */
  friendPushPref(ownerId, friendId) {
    if (!ownerId || !friendId) return null;
    return this.stmt.friendPushOf.get(ownerId, friendId) || null;
  }

  setFriendPushPref(ownerId, friendId, patch = {}) {
    const cur = this.friendPushPref(ownerId, friendId) || {
      owner_id: ownerId,
      friend_id: friendId,
      muted: 0,
      kind: '',
      secret: '',
      url: '',
      token: '',
    };
    const muted = patch.muted === undefined ? cur.muted : patch.muted ? 1 : 0;
    const kind = patch.kind === undefined ? cur.kind : String(patch.kind || '').slice(0, 16);
    const secret = patch.clearSecret ? '' : patch.secret === undefined ? cur.secret : String(patch.secret || '').slice(0, 400);
    const url = patch.clearUrl ? '' : patch.url === undefined ? cur.url : String(patch.url || '').slice(0, 400);
    const token = patch.clearToken ? '' : patch.token === undefined ? cur.token : String(patch.token || '').slice(0, 400);
    this.stmt.upsertFriendPush.run(ownerId, friendId, muted, kind, secret, url, token, nowMs());
    return this.friendPushPref(ownerId, friendId);
  }

  /** 我把某个好友的例外设置清掉（回到"用默认通道"） */
  clearFriendPushPref(ownerId, friendId) {
    this.stmt.deleteFriendPush.run(ownerId, friendId);
    return { ok: true };
  }

  // ------------------------------------------------------------ 收件箱（通知层）

  /**
   * 往收件人的收件箱写一条。
   * @returns {object|null} 写入的行
   */
  addNotification({ userId, kind, actorId, postId = null, summary = '', dayKey = null, createdAt = null } = {}) {
    if (!userId || !kind || !actorId) return null;
    const at = createdAt ?? nowMs();
    const info = this.stmt.insertNotification.run(userId, kind, actorId, postId, String(summary || '').slice(0, 200), dayKey, at);
    return this.stmt.notificationsOf.get(userId, 1) && { id: Number(info.lastInsertRowid), userId, kind, actorId, postId, summary, dayKey, createdAt: at };
  }

  /** 收件箱列表（默认全部，unreadOnly 只取未读）；带触发者的展示信息 */
  listNotifications(userId, { limit = 30, unreadOnly = false } = {}) {
    if (!userId) return [];
    const rows = unreadOnly
      ? this.stmt.unreadNotificationsOf.all(userId, Math.max(1, Math.min(200, limit)))
      : this.stmt.notificationsOf.all(userId, Math.max(1, Math.min(200, limit)));
    return rows.map((row) => {
      const actor = row.actor_id ? this.stmt.userById.get(row.actor_id) : null;
      return {
        id: row.id,
        kind: row.kind,
        actorId: row.actor_id,
        actorName: actor ? actor.display_name || actor.username : '',
        actorUsername: actor ? actor.username : '',
        postId: row.post_id || null,
        summary: row.summary || '',
        dayKey: row.day_key || null,
        createdAt: row.created_at,
        read: Boolean(row.read_at),
      };
    });
  }

  /** 未读概览：总数 + 分类计数（捎带在响应里的就是它） */
  notificationSummary(userId) {
    if (!userId) return { total: 0, byKind: {} };
    const byKind = {};
    for (const row of this.stmt.unreadCounts.all(userId)) byKind[row.kind] = row.n;
    const total = Number(this.stmt.unreadTotal.get(userId)?.n || 0);
    return { total, byKind };
  }

  /** 标记已读：ids 指定 / all 全部 / upTo 某时间之前 */
  markNotificationsRead(userId, { ids = null, all = false, upTo = null } = {}) {
    if (!userId) return 0;
    const at = nowMs();
    if (all) return this.stmt.markAllNotificationsRead.run(at, userId).changes;
    if (upTo) return this.stmt.markNotificationsUpTo.run(at, userId, Number(upTo) || 0).changes;
    let n = 0;
    for (const id of ids || []) n += this.stmt.markNotificationRead.run(at, Number(id) || 0, userId).changes;
    return n;
  }

  /** 只保留最近 keep 条，防止收件箱无限长 */
  pruneNotifications(userId, keep = 500) {
    if (!userId) return 0;
    return this.stmt.pruneNotifications.run(userId, userId, Math.max(10, keep)).changes;
  }

  /** 把关系行转成「对方」视角的好友对象 */
  #friendEntry(row, meId) {
    const otherId = row.requester_id === meId ? row.addressee_id : row.requester_id;
    const other = this.stmt.userById.get(otherId);
    if (!other) return null;
    const alias = row.requester_id === meId ? row.alias_by_requester : row.alias_by_addressee;
    const myAlias = alias || '';
    return {
      user: other,
      alias: myAlias,
      displayName: myAlias || other.display_name || other.username,
      since: row.updated_at,
      direction: row.requester_id === meId ? 'out' : 'in',
    };
  }

  listFriends(userId) {
    return this.stmt.acceptedFriendsOf
      .all(userId, userId)
      .map((row) => this.#friendEntry(row, userId))
      .filter(Boolean)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
  }

  listIncomingRequests(userId) {
    return this.stmt.incomingRequests
      .all(userId)
      .map((row) => this.#friendEntry(row, userId))
      .filter(Boolean);
  }

  listOutgoingRequests(userId) {
    return this.stmt.outgoingRequests
      .all(userId)
      .map((row) => this.#friendEntry(row, userId))
      .filter(Boolean);
  }

  friendIds(userId) {
    return this.listFriends(userId).map((f) => f.user.id);
  }

  // ---------------- 纪念日 ----------------

  listAnniversaries(userId) {
    return this.stmt.anniversariesOf.all(userId);
  }

  /** 某个好友关联到我这边的纪念日（首页按好友筛选时展示） */
  listAnniversariesOfFriend(userId, friendId) {
    return this.stmt.anniversariesOfFriend.all(userId, friendId);
  }

  getAnniversary(id, userId) {
    const row = this.stmt.anniversaryById.get(id);
    return row && row.user_id === userId ? row : null;
  }

  /**
   * 新建纪念日。special=true 时会先清掉其他条目的 special（全局只允许一个）。
   * kind='birthday' 时同样只允许一条。
   */
  createAnniversary(userId, data) {
    const ts = nowMs();
    const row = {
      id: makeId('an', 8),
      user_id: userId,
      name: String(data.name || '纪念日').slice(0, 24),
      icon: String(data.icon || '🎂').slice(0, 8),
      date: data.date,
      note: String(data.note || '').slice(0, 60),
      special: data.special ? 1 : 0,
      kind: data.kind === 'birthday' ? 'birthday' : 'custom',
      friend_id: data.friendId || null,
      sort_order: Number.isFinite(Number(data.sortOrder)) ? Number(data.sortOrder) : 0,
      created_at: ts,
      updated_at: ts,
    };
    if (row.kind === 'birthday' && this.stmt.birthdayAnniversaryOf.get(userId)) {
      return { ok: false, reason: 'birthday_exists' };
    }
    if (row.special) this.stmt.clearSpecial.run(ts, userId);
    this.stmt.insertAnniversary.run(
      row.id,
      row.user_id,
      row.name,
      row.icon,
      row.date,
      row.note,
      row.special,
      row.kind,
      row.friend_id,
      row.sort_order,
      row.created_at,
      row.updated_at
    );
    return { ok: true, row: this.stmt.anniversaryById.get(row.id) };
  }

  updateAnniversary(id, userId, patch) {
    const existing = this.getAnniversary(id, userId);
    if (!existing) return { ok: false, reason: 'not_found' };
    const next = {
      name: patch.name !== undefined ? String(patch.name).slice(0, 24) : existing.name,
      icon: patch.icon !== undefined ? String(patch.icon).slice(0, 8) : existing.icon,
      date: patch.date !== undefined ? patch.date : existing.date,
      note: patch.note !== undefined ? String(patch.note).slice(0, 60) : existing.note,
      special: patch.special !== undefined ? (patch.special ? 1 : 0) : existing.special,
      friend_id: patch.friendId !== undefined ? patch.friendId || null : existing.friend_id,
    };
    const ts = nowMs();
    if (next.special) this.stmt.clearSpecial.run(ts, userId);
    this.stmt.updateAnniversary.run(
      next.name,
      next.icon,
      next.date,
      next.note,
      next.special,
      next.friend_id,
      ts,
      id,
      userId
    );
    return { ok: true, row: this.stmt.anniversaryById.get(id) };
  }

  deleteAnniversary(id, userId) {
    const res = this.stmt.deleteAnniversary.run(id, userId);
    return res.changes > 0;
  }

  /** 把老的 users.birthday 一次性迁移成「生日」纪念日（返回迁移条数） */
  migrateBirthdaysToAnniversaries() {
    const rows = this.stmt.usersWithBirthdayNoAnniversary.all();
    for (const row of rows) {
      this.createAnniversary(row.id, {
        name: '生日',
        icon: '🎂',
        date: row.birthday,
        note: '',
        special: true,
        kind: 'birthday',
      });
    }
    return rows.length;
  }

  // ---------------- sessions ----------------

  createSession(userId, { ua = '', ip = '', days = config.sessionDays } = {}) {
    const token = makeId('s', 32);
    const ts = nowMs();
    this.stmt.insertSession.run(token, userId, ts, ts + days * 86400000, ua, ip);
    return token;
  }

  session(token) {
    if (!token) return null;
    const row = this.stmt.sessionByToken.get(token);
    if (!row) return null;
    if (row.expires_at < nowMs()) {
      this.stmt.deleteSession.run(token);
      return null;
    }
    return row;
  }

  destroySession(token) {
    if (token) this.stmt.deleteSession.run(token);
  }

  purgeSessions() {
    this.stmt.purgeSessions.run(nowMs());
  }

  // ---------------- posts ----------------

  createPost(row) {
    const id = row.id || makeId('p');
    // created_at 是"发布时间"；occurred_at 是"事情发生的时间"（没传就当作刚发生）
    const ts = row.createdAt ?? nowMs();
    const occurredAt = row.occurredAt ?? ts;
    this.stmt.insertPost.run(
      id,
      row.userId,
      row.body || '',
      ts,
      occurredAt,
      nowMs(),
      row.postDay ?? null,
      row.location || '',
      row.mood || '',
      row.tags || '',
      row.visibility || 'public'
    );
    return this.stmt.postById.get(id);
  }

  updatePost(id, userId, patch) {
    const existing = this.stmt.postByIdForUser.get(id, userId);
    if (!existing) return null;
    // 注意：编辑只改 occurred_at（事情发生的时间），created_at（发布时间）不动
    this.stmt.updatePost.run(
      patch.body ?? existing.body,
      patch.occurredAt ?? existing.occurred_at ?? existing.created_at,
      nowMs(),
      patch.postDay !== undefined ? patch.postDay : existing.post_day,
      patch.location ?? existing.location,
      patch.mood ?? existing.mood,
      patch.tags ?? existing.tags,
      patch.visibility ?? existing.visibility,
      id,
      userId
    );
    return this.stmt.postById.get(id);
  }

  deletePost(id, userId) {
    const res = this.stmt.softDeletePost.run(nowMs(), nowMs(), id, userId);
    return res.changes > 0;
  }

  /**
   * 帖子列表：支持多作者（我 + 好友）、日期区间、搜索、分页。
   * @param {object} opts
   * @param {string} [opts.userId]          单作者（兼容旧调用）
   * @param {string[]} [opts.authorIds]     多作者；传入时优先于 userId
   * @param {boolean} [opts.includePrivate] 是否包含 private（仅作者本人视角为 true）
   * @param {boolean} [opts.withAuthor]     是否附带作者信息（合并时间线需要）
   */
  queryPosts({
    userId = null,
    authorIds = null,
    viewerId = null,
    from = null,
    to = null,
    q = '',
    tag = '',
    limit = 20,
    cursor = null,
    includePrivate = false,
    withAuthor = false,
  }) {
    const ids = Array.isArray(authorIds) ? authorIds.filter(Boolean) : userId ? [userId] : [];
    if (!ids.length) return [];

    const where = [`user_id IN (${ids.map(() => '?').join(',')})`, 'deleted_at IS NULL'];
    const args = [...ids];
    if (!includePrivate) {
      where.push("visibility <> 'private'");
    }
    // 日期区间基于「帖子所属日」：优先 post_day，否则按创建时间
    if (from) {
      where.push("COALESCE(post_day, '') >= ?");
      args.push(from);
    }
    if (to) {
      where.push("COALESCE(post_day, '') <= ?");
      args.push(to);
    }
    if (q) {
      // 说明：SQLite 的 LIKE 对 ASCII 不区分大小写，对 CJK 是精确子串匹配，符合预期。
      // 注意 LIKE 的通配符需转义，避免用户输入 % 或 _ 时行为异常。
      const like = `%${escapeLike(q)}%`;
      where.push("(body LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    if (tag) {
      where.push("tags LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(tag)}%`);
    }
    if (cursor) {
      const cursorRow = this.stmt.postById.get(cursor);
      if (cursorRow && ids.includes(cursorRow.user_id)) {
        where.push(
          "(COALESCE(post_day, '') < ? OR (COALESCE(post_day, '') = ? AND COALESCE(occurred_at, created_at) < ?))"
        );
        const cd = cursorRow.post_day || dayKey(cursorRow.occurred_at || cursorRow.created_at, config.timezone);
        args.push(cd, cd, cursorRow.occurred_at || cursorRow.created_at);
      }
    }
    const sql = `SELECT * FROM posts WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(post_day, '') DESC, COALESCE(occurred_at, created_at) DESC LIMIT ?`;
    args.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
    const rows = this.db.prepare(sql).all(...args);
    if (withAuthor) this.attachAuthors(rows, viewerId);
    return rows;
  }

  /**
   * 给帖子行补上作者信息（合并时间线用来区分是谁发的）。
   * 传了 viewerId 就用「我给这个作者起的备注名」当显示名（真实昵称放在 realDisplayName）。
   */
  attachAuthors(rows, viewerId = null) {
    for (const row of rows) {
      if (row.author) continue;
      const user = this.stmt.userById.get(row.user_id);
      if (!user) {
        row.author = null;
        continue;
      }
      const realName = user.display_name || user.username;
      const alias = this.aliasFor(viewerId, user.id);
      row.author = {
        id: user.id,
        username: user.username,
        displayName: alias || realName,
        realDisplayName: realName,
        alias,
        avatar: user.avatar || null,
        // 头像地址要带版本号（updated_at），避免浏览器缓存住旧头像
        updatedAt: user.updated_at,
        // 记录卡片主题色（空 = 没设置）
        cardTheme: user.card_theme || '',
      };
    }
    return rows;
  }

  postsWithMedia(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const media = this.db
      .prepare(`SELECT * FROM media WHERE post_id IN (${placeholders}) ORDER BY COALESCE(sort_order, 0) ASC, created_at ASC, id ASC`)
      .all(...ids);
    const byPost = new Map();
    for (const m of media) {
      if (!byPost.has(m.post_id)) byPost.set(m.post_id, []);
      byPost.get(m.post_id).push(m);
    }
    return rows.map((r) => ({ ...r, media: byPost.get(r.id) || [] }));
  }

  // ---------------- media ----------------

  createMedia(row) {
    const sortOrder =
      row.sortOrder === undefined || row.sortOrder === null
        ? row.postId
          ? this.stmt.nextMediaOrder.get(row.postId).n
          : 0
        : row.sortOrder;
    this.stmt.insertMedia.run(
      row.id,
      row.postId || null,
      row.userId,
      row.kind,
      row.mime,
      row.ext,
      row.bytes || 0,
      row.width ?? null,
      row.height ?? null,
      row.duration ?? null,
      row.posterExt ?? null,
      row.originalName || '',
      row.createdAt || nowMs(),
      sortOrder
    );
    return this.stmt.mediaById.get(row.id);
  }

  attachMedia(postId, mediaIds, userId) {
    const upd = this.db.prepare('UPDATE media SET post_id = ?, sort_order = ? WHERE id = ? AND user_id = ? AND post_id IS NULL');
    let n = 0;
    let next = this.stmt.nextMediaOrder.get(postId).n;
    for (const id of mediaIds) {
      const changes = upd.run(postId, next, id, userId).changes;
      if (changes) next += 1;
      n += changes;
    }
    return n;
  }

  /** 按给定顺序重排某条记录的附件（只认属于这条记录的 id） */
  setMediaOrder(postId, mediaIds) {
    let index = 0;
    for (const id of mediaIds) {
      if (!id) continue;
      this.stmt.setMediaOrder.run(index, id, postId);
      index += 1;
    }
    return index;
  }

  detachMedia(mediaId, userId) {
    this.db.prepare('UPDATE media SET post_id = NULL WHERE id = ? AND user_id = ?').run(mediaId, userId);
  }

  deleteMedia(mediaId) {
    const row = this.stmt.mediaById.get(mediaId);
    if (row) this.stmt.deleteMediaById.run(mediaId);
    return row;
  }

  mediaOfPost(postId) {
    return this.stmt.mediaByPost.all(postId);
  }

  // ---------------- 限时分享链接 ----------------

  /** 生成一条限时分享链接（ttlMs 之后失效） */
  createShareLink({ userId, scope, day = '', month = '', ttlMs }) {
    const token = makeShareToken(14);
    const now = nowMs();
    this.stmt.insertShareLink.run(token, userId, scope, day, month, now + ttlMs, now, null);
    return this.stmt.shareLinkByToken.get(token);
  }

  /** 按 token 取分享链接（不看是否过期，交给调用方给出友好提示） */
  shareLink(token) {
    if (!token) return null;
    return this.stmt.shareLinkByToken.get(String(token)) || null;
  }

  /** 我生成的分享链接（未撤销、未过期，最近的在前） */
  myShareLinks(userId, limit = 20) {
    return this.stmt.shareLinksOfUser.all(userId, nowMs(), limit);
  }

  revokeShareLink(userId, token) {
    return this.stmt.revokeShareLink.run(nowMs(), token, userId).changes > 0;
  }

  /** 清掉早就过期的链接（定期维护时顺手调用） */
  purgeShareLinks(before = nowMs() - 7 * 24 * 3600 * 1000) {
    return this.stmt.purgeShareLinks.run(before).changes;
  }

  /**
   * 我自己最近用过的地点 / 标签 / 心情，去重后拿来做输入候选
   * （新记录优先，越近的越靠前；每类最多 distinct 个）
   */
  recentMeta(userId, { limit = 200, distinct = 12 } = {}) {
    const rows = this.db
      .prepare(`SELECT location, tags, mood FROM posts
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY COALESCE(post_day, '') DESC, COALESCE(occurred_at, created_at) DESC LIMIT ?`)
      .all(userId, limit);
    const out = { locations: [], tags: [], moods: [] };
    const add = (list, raw, itemMax) => {
      const value = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, itemMax);
      if (!value || list.includes(value) || list.length >= distinct) return;
      list.push(value);
    };
    for (const row of rows) {
      add(out.locations, row.location, 40);
      add(out.moods, row.mood, 32);
      for (const tag of String(row.tags || '').split(',')) add(out.tags, tag.replace(/^#/, ''), 24);
      if (out.locations.length >= distinct && out.tags.length >= distinct && out.moods.length >= distinct) break;
    }
    return out;
  }

  setPoster(mediaId, posterExt) {
    this.stmt.setPoster.run(posterExt, mediaId);
    return this.stmt.mediaById.get(mediaId);
  }

  stats(userId) {
    const s = this.stmt.statsForUser.get(userId) || {};
    const days = this.stmt.daysForUser
      .all(userId)
      .map((r) => r.d)
      .filter(Boolean);
    const distinctDays = new Set(days);
    return {
      posts: s.posts || 0,
      firstAt: s.first_at || null,
      lastAt: s.last_at || null,
      days: distinctDays.size,
      media: this.stmt.mediaCountForUser.get(userId)?.c || 0,
    };
  }

  rotateShareToken(userId) {
    let token = makeShareToken(12);
    while (this.stmt.userByShare.get(token)) token = makeShareToken(12);
    this.stmt.rotateShareToken.run(token, nowMs(), userId);
    return token;
  }

  // ---------------- maintenance ----------------

  exportUser(userId) {
    const user = this.stmt.userById.get(userId);
    if (!user) return null;
    const posts = this.db
      .prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId);
    const media = this.db.prepare('SELECT * FROM media WHERE user_id = ? ORDER BY created_at ASC').all(userId);
    const { password_hash, share_token, ...safeUser } = user;
    return { user: safeUser, posts, media, exportedAt: nowMs(), version: config.version };
  }

  deleteUserCascade(userId) {
    this.db.exec('BEGIN');
    try {
      this.stmt.deleteMediaForUser.run(userId);
      this.stmt.deletePostsForUser.run(userId);
      this.stmt.deleteFriendshipsForUser.run(userId, userId);
      this.stmt.deleteAnniversariesForUser.run(userId);
      this.stmt.deleteUserSessions.run(userId);
      this.stmt.deleteUser.run(userId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  vacuumIfNeeded() {
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      /* 忽略 */
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 忽略 */
    }
  }
}

let singleton = null;
export function getStore() {
  if (!singleton) singleton = new Store();
  return singleton;
}

export function closeStore() {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

export function dbFileExists() {
  return fs.existsSync(config.dbFile);
}
