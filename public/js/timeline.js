/** 时间线渲染：日期分组、动态卡片、媒体网格、空状态 */
import {
  clockOf,
  dayKeyOf,
  dayLabel,
  el,
  formatBytes,
  formatDuration,
  linkify,
  relativeTime,
  svgIcon,
  todayKey,
} from './util.js';
import { resolveCardTheme, themeFromAvatar } from './theme.js';

export const MOODS = {
  '😀': '开心',
  '😌': '平静',
  '😴': '困',
  '😮‍💨': '累',
  '🔥': '干劲十足',
  '🥲': 'emo',
  '🎉': '庆祝',
  '🍜': '吃好吃的',
  '💪': '运动',
  '📚': '学习',
  '💼': '工作',
  '✈️': '出行',
};

export const VISIBILITY_LABEL = {
  public: '所有人可见',
  link: '仅分享链接可见',
  private: '仅自己可见',
};

export function groupByDay(posts) {
  const groups = [];
  const map = new Map();
  for (const post of posts) {
    const key = post.postDay || dayKeyOf(post.occurredAt || post.createdAt);
    if (!map.has(key)) {
      const group = { day: key, posts: [] };
      map.set(key, group);
      groups.push(group);
    }
    map.get(key).posts.push(post);
  }
  return groups;
}

function mediaGrid(media, { onOpen }) {
  if (!media.length) return null;
  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');
  const others = media.filter((m) => m.kind !== 'image' && m.kind !== 'video');
  const wrap = el('div', { class: 'media-list' });

  const makeTile = (item, index) => {
    const tile = el('button', {
      type: 'button',
      class: `media-tile ${item.kind}`,
      'aria-label': item.kind === 'video' ? '播放视频' : '查看大图',
      onclick: () => onOpen(media, media.indexOf(item)),
    });
    const src = item.kind === 'video' ? item.posterUrl : item.url;
    if (src) {
      tile.append(
        el('img', {
          src,
          alt: item.name || '',
          loading: index < 2 ? 'eager' : 'lazy',
          decoding: 'async',
        })
      );
    } else {
      tile.classList.add('no-poster');
      tile.append(svgIcon('video', 28));
    }
    if (item.kind === 'video') {
      tile.append(el('span', { class: 'play-badge' }, svgIcon('playback', 18)));
      if (item.duration) {
        tile.append(el('span', { class: 'media-duration' }, formatDuration(item.duration)));
      }
    }
    return tile;
  };

  videos.forEach((v, i) => wrap.append(makeTile(v, i)));
  if (images.length) {
    const grid = el('div', {
      class: `media-grid cols-${Math.min(images.length, 3)}${images.length === 1 ? ' single' : ''}`,
    });
    images.forEach((img, i) => grid.append(makeTile(img, i)));
    wrap.append(grid);
  }
  for (const other of others) {
    wrap.append(
      el(
        'a',
        { class: 'file-chip', href: other.url, target: '_blank', rel: 'noopener' },
        svgIcon('download', 16),
        el('span', {}, other.name || '附件'),
        el('em', {}, formatBytes(other.bytes))
      )
    );
  }
  return wrap;
}

/**
 * 记录卡片的主题色：自己和好友用同一套卡片框架，只靠底色区分。
 *  - 自己：设置里的主题色（'' = 默认白，不加底色）
 *  - 好友：他们自己的设置优先；没设置就用他们头像取色（异步，取到再上色）
 */
function applyCardTheme(card, post, opts) {
  const isMine = !!opts.isMine;
  const author = post.author || {};
  const { accent, avatarUrl } = resolveCardTheme({
    theme: isMine ? opts.myCardTheme : author.cardTheme,
    avatarUrl: author.avatarUrl,
    isMine,
  });
  if (accent) {
    card.classList.add('tinted');
    card.style.setProperty('--card-accent', accent);
    return;
  }
  if (!avatarUrl) return;
  themeFromAvatar(avatarUrl).then((color) => {
    if (!color || !card.isConnected) return;
    card.classList.add('tinted');
    card.style.setProperty('--card-accent', color);
  });
}

/**
 * 单条动态卡片
 * @param {object} post
 * @param {object} opts { onOpenMedia, onEdit, onDelete, canEdit, meId, myCardTheme }
 */
export function postCard(post, opts = {}) {
  const { onOpenMedia = () => {}, onEdit = null, onDelete = null, canEdit = false, meId = null } = opts;
  const isMine = post.isOwner || !post.author || (meId && post.author.id === meId);
  const card = el('article', {
    class: `card post${isMine ? '' : ' from-friend'}`,
    dataset: { id: post.id },
  });
  applyCardTheme(card, post, { ...opts, isMine });

  // 好友的动态：卡片顶部显示作者，与「我的」明确区分
  if (!isMine && post.author) {
    const avatar = post.author.avatarUrl
      ? el('img', { class: 'post-avatar', src: post.author.avatarUrl, alt: '', loading: 'lazy' })
      : el('div', { class: 'post-avatar placeholder' }, (post.author.displayName || '?').slice(0, 1));
    card.append(
      el(
        'div',
        { class: 'post-author' },
        avatar,
        el(
          'div',
          { class: 'post-author-text' },
          el('strong', {}, post.author.displayName || post.author.username),
          el('span', { class: 'muted' }, `@${post.author.username}`)
        ),
        el('span', { class: 'friend-badge' }, '好友')
      )
    );
  }

  const head = el('header', { class: 'post-head' });
  head.append(
    el(
      'div',
      { class: 'post-time' },
      // 左上角 = 「事情发生的时间」；旁边的「xx 分钟前」= 这条记录的发布时间
      el('strong', {}, clockOf(post.occurredAt || post.createdAt)),
      el('span', { class: 'rel' }, relativeTime(post.createdAt))
    )
  );

  const meta = el('div', { class: 'post-meta' });
  if (post.mood) {
    const moodText = MOODS[post.mood] ? `${post.mood} ${MOODS[post.mood]}` : post.mood;
    meta.append(el('span', { class: 'chip mood' }, moodText));
  }
  if (post.location) {
    meta.append(el('span', { class: 'chip loc' }, svgIcon('location', 13), post.location));
  }
  if (post.visibility && post.visibility !== 'public') {
    meta.append(el('span', { class: 'chip vis' }, VISIBILITY_LABEL[post.visibility] || post.visibility));
  }
  if (meta.childElementCount) head.append(meta);

  if (canEdit && isMine && (onEdit || onDelete)) {
    const actions = el('div', { class: 'post-actions' });
    if (onEdit) {
      actions.append(
        el(
          'button',
          { type: 'button', class: 'icon-btn small', 'aria-label': '编辑', onclick: () => onEdit(post) },
          svgIcon('edit', 16)
        )
      );
    }
    if (onDelete) {
      actions.append(
        el(
          'button',
          {
            type: 'button',
            class: 'icon-btn small danger',
            'aria-label': '删除',
            onclick: () => onDelete(post),
          },
          svgIcon('trash', 16)
        )
      );
    }
    head.append(actions);
  }
  card.append(head);

  if (post.body) {
    const { body, more } = collapsibleBody(linkify(post.body));
    card.append(body, more);
  }
  const grid = mediaGrid(post.media || [], { onOpen: onOpenMedia });
  if (grid) card.append(grid);
  if (post.tags && post.tags.length) {
    const tags = el('div', { class: 'tag-row' });
    for (const tag of post.tags) {
      tags.append(el('a', { class: 'tag', href: `#/search?tag=${encodeURIComponent(tag)}` }, `#${tag}`));
    }
    card.append(tags);
  }
  return card;
}

export function dayHeader(day, posts, { today = todayKey() } = {}) {
  const times = posts.map((p) => clockOf(p.occurredAt || p.createdAt)).sort();
  const span = times.length
    ? times[0] === times[times.length - 1]
      ? times[0]
      : `${times[0]} - ${times[times.length - 1]}`
    : '';
  return el(
    'div',
    { class: 'day-header' },
    el(
      'div',
      { class: 'day-main' },
      el('span', { class: 'day-label' }, dayLabel(day, today)),
      el('span', { class: 'day-count' }, `${posts.length} 条`)
    ),
    span ? el('span', { class: 'day-span' }, span) : null
  );
}

/** 渲染整条时间线 */
export function renderFeed(container, posts, opts = {}) {
  container.textContent = '';
  if (!posts.length) {
    container.append(emptyState(opts));
    return;
  }
  for (const group of groupByDay(posts)) {
    const section = el('section', { class: 'day-group' });
    section.append(dayHeader(group.day, group.posts, opts));
    for (const post of group.posts) section.append(postCard(post, opts));
    container.append(section);
  }
  // 折叠按钮要等卡片真的进了 DOM 才量得准（脱节点上 scrollHeight 恒为 0）
  requestAnimationFrame(() => {
    for (const body of container.querySelectorAll('.post-body.clamped')) {
      if (body.scrollHeight > body.clientHeight + 2) body.dataset.foldable = '1';
      else body.classList.remove('clamped');
    }
    for (const btn of container.querySelectorAll('.post-more')) {
      const body = btn.closest('.post')?.querySelector('.post-body');
      btn.hidden = !body || !body.dataset.foldable;
    }
  });
}

/**
 * 正文太长时先折起来，点「展开」看全文。
 * 行数由 CSS 的 -webkit-line-clamp 控制（默认 6 行）。
 */
export function collapsibleBody(html) {
  const body = el('div', { class: 'post-body clamped', html });
  const more = el('button', { type: 'button', class: 'post-more', hidden: true }, '展开');
  more.addEventListener('click', () => {
    const folded = body.classList.toggle('clamped');
    more.textContent = folded ? '展开' : '收起';
  });
  return { body, more };
}

export function emptyState({ title = '还没有记录', hint = '', action = null } = {}) {
  const box = el('div', { class: 'empty' });
  box.append(el('div', { class: 'empty-emoji' }, '🌱'));
  box.append(el('h3', {}, title));
  if (hint) box.append(el('p', {}, hint));
  if (action) box.append(action);
  return box;
}

export function skeleton(count = 3) {
  const box = el('div', { class: 'skeleton-list' });
  for (let i = 0; i < count; i += 1) {
    box.append(
      el(
        'div',
        { class: 'card skeleton' },
        el('div', { class: 'sk-line w40' }),
        el('div', { class: 'sk-line' }),
        el('div', { class: 'sk-line w70' })
      )
    );
  }
  return box;
}

/**
 * 统计条。**即使还没有数据也要渲染出来**（显示占位符），
 * 否则刚登录进来统计区域会是空的/看起来像 null。
 */
export function statsBar(stats, { placeholder = false } = {}) {
  const items = [
    ['记录', stats?.posts],
    ['天数', stats?.days],
    ['图片视频', stats?.media],
  ];
  const box = el('div', { class: `stats${placeholder ? ' placeholder' : ''}`, 'data-stats-bar': '' });
  for (const [label, value] of items) {
    box.append(
      el(
        'div',
        { class: 'stat' },
        el('strong', {}, value === undefined || value === null ? '–' : String(value)),
        el('span', {}, label)
      )
    );
  }
  return box;
}

/** 把已经渲染出来的统计条就地更新（避免整体重绘） */
export function updateStatsBar(root, stats) {
  const box = (root || document).querySelector('[data-stats-bar]');
  if (!box || !stats) return false;
  const values = [stats.posts, stats.days, stats.media];
  box.classList.remove('placeholder');
  const strongs = box.querySelectorAll('.stat strong');
  strongs.forEach((node, i) => {
    node.textContent = values[i] === undefined || values[i] === null ? '–' : String(values[i]);
  });
  return true;
}
