/** 与后端交互的统一封装 */

export class ApiError extends Error {
  constructor(status, payload) {
    super((payload && payload.error) || `请求失败（${status}）`);
    this.status = status;
    this.code = (payload && payload.code) || 'error';
    this.payload = payload || {};
  }
}

export const TZ = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
};

function baseHeaders(extra = {}) {
  return { 'x-daylog-tz': TZ(), ...extra };
}

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }
  return { error: await res.text() };
}

export async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: baseHeaders(headers) };
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, init);
  const payload = await parse(res);
  if (!res.ok) throw new ApiError(res.status, payload);
  if (raw) return payload;
  return payload;
}

/** 带进度回调的 XHR 上传（fetch 无法获取上传进度） */
export function upload(path, formData, { onProgress, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-daylog-tz', TZ());
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || '{}');
      } catch {
        payload = { error: '服务器返回了无法解析的内容' };
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new ApiError(xhr.status, payload));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: '网络中断，上传失败' }));
    xhr.onabort = () => reject(new ApiError(0, { error: '上传已取消', code: 'aborted' }));
    xhr.send(formData);
  });
}

export const api = {
  me: () => request('/api/auth/me'),
  signup: (payload) => request('/api/auth/signup', { method: 'POST', body: payload }),
  login: (payload) => request('/api/auth/login', { method: 'POST', body: payload }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  updateProfile: (payload) => request('/api/me/profile', { method: 'PATCH', body: payload }),
  updateSettings: (payload) => request('/api/me/settings', { method: 'PATCH', body: payload }),
  changePassword: (payload) => request('/api/auth/password', { method: 'POST', body: payload }),
  stats: () => request('/api/me/stats'),

  listPosts: (params = {}) => request(`/api/posts?${new URLSearchParams(clean(params))}`),
  createPost: (payload) => request('/api/posts', { method: 'POST', body: payload }),
  createPostMultipart: (formData, opts) => upload('/api/posts', formData, opts),
  updatePost: (id, payload) => request(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
  updatePostMultipart: (id, formData, opts) =>
    upload(`/api/posts/${encodeURIComponent(id)}`, formData, { ...opts, method: 'PATCH' }),
  deletePost: (id) => request(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  calendar: (month) => request(`/api/calendar?month=${encodeURIComponent(month)}`),
  // 我最近用过的地点 / 标签 / 心情（编辑记录时的输入候选）
  suggestions: () => request('/api/suggestions'),

  // 纪念日
  anniversaries: () => request('/api/anniversaries'),
  anniversariesOfFriend: (friendId) =>
    request(`/api/anniversaries/of/${encodeURIComponent(friendId)}`),
  createAnniversary: (payload) => request('/api/anniversaries', { method: 'POST', body: payload }),
  updateAnniversary: (id, payload) =>
    request(`/api/anniversaries/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
  deleteAnniversary: (id) => request(`/api/anniversaries/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // 好友
  friends: () => request('/api/friends'),
  lookupUser: (username) => request(`/api/users/lookup?username=${encodeURIComponent(username)}`),
  requestFriend: (payload) => request('/api/friends/requests', { method: 'POST', body: payload }),
  acceptFriend: (userId) =>
    request(`/api/friends/requests/${encodeURIComponent(userId)}/accept`, { method: 'POST' }),
  removeFriend: (userId) => request(`/api/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  setFriendAlias: (userId, alias) =>
    request(`/api/friends/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { alias } }),
  // 我对某个好友的推送设置（免推送 / 单独 key / 清掉例外）
  setFriendPush: (userId, payload) =>
    request(`/api/friends/${encodeURIComponent(userId)}/push`, { method: 'PATCH', body: payload }),

  // 我自己的默认推送通道（手机通知）
  pushSettings: () => request('/api/me/push'),
  savePushSettings: (payload) => request('/api/me/push', { method: 'PATCH', body: payload }),
  testPush: () => request('/api/me/push/test', { method: 'POST' }),

  shareInfo: (token) => request(`/api/s/${encodeURIComponent(token)}`),
  sharePosts: (token, params = {}) =>
    request(`/api/s/${encodeURIComponent(token)}/posts?${new URLSearchParams(clean(params))}`),
  sharePost: (token, id) =>
    request(`/api/s/${encodeURIComponent(token)}/posts/${encodeURIComponent(id)}`),
  // 限时分享链接：生成 / 列表 / 撤销
  createShareLink: (payload) => request('/api/share/links', { method: 'POST', body: payload }),
  shareLinks: () => request('/api/share/links'),
  revokeShareLink: (token) => request(`/api/share/links/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  // 应用内「好友的时间线」（需登录 + 好友关系）
  friendTimeline: (name) => request(`/api/u/${encodeURIComponent(name)}/timeline`),
  friendTimelinePosts: (name, params = {}) =>
    request(`/api/u/${encodeURIComponent(name)}/timeline/posts?${new URLSearchParams(clean(params))}`),
};

export function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  return out;
}
