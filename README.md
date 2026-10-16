# DayLog · 分享你每天在做什么

一个**移动端优先**的每日记录 Web 应用：随手记下「几点、在做什么」，可以带**文字 / 图片 / 视频**，
然后生成一条链接（附二维码）分享给家人朋友看。他们**不需要注册、不需要装 App**，手机浏览器直接打开。

```
┌─────────────────────────┐        ┌─────────────────────────┐
│  你：今天在做什么        │        │  朋友：打开分享链接      │
│  09:12 到公司，开周会    │  ───▶  │  只读时间线（按天分组）  │
│  12:30 [图片] 午饭       │  链接  │  图片/视频可点开看       │
│  19:40 [视频] 打球       │  +二维码│  手机扫码即可            │
└─────────────────────────┘        └─────────────────────────┘
```

## 30 秒跑起来

需要 **Node.js ≥ 22.5**（用到内置的 `node:sqlite`，无任何第三方依赖，不需要 `npm install`）。

```bash
cd projects/daylog
npm start
```

启动后终端会打印本机和局域网地址：

```
  DayLog 已启动 🎉
  本机访问    http://localhost:81
  局域网访问  http://192.168.1.20:81   (WLAN)
```

- 电脑上打开 `http://localhost:81` → 第一个注册的账号自动成为管理员。
- 手机上打开 `http://192.168.1.20:81`（需和电脑在同一个 WiFi）→ 可以直接拍照上传。
- 想让外网的朋友也能看，见下面「[分享到外网](#分享到外网)」。

## 功能

**记录**
- 文字 + 图片 + 视频，一条记录里可以混着传（最多 12 个附件）
- 支持「拍照」直接调起手机相机；相册多选；桌面端可粘贴/拖入文件
- 发布面板里**长按图片 / 视频即可拖动调整顺序**：被拖的格子会「抬起」成一块跟手浮层（带缩放、倾斜、
  阴影），其余格子平滑让位，松手滑回落点；上传顺序也跟着变
- **两个时间分得很清楚**：
  - **发布时间**（`created_at`）＝ 你按下发布的那一刻，**发布后固定不变**
  - **事情发生的时间**（`occurred_at`）＝ 面板里那个可以改的时间（补记昨天的事就改它），
    **排序、按天分组、日历标注全按它算**
  - 卡片表现：**左上角是"事情发生的时间"**，旁边那个「xx 分钟前」是**发布时间**；
    编辑面板底部会写一行「发布时间 10/9 17:43（改上面的时间只改"事情发生的时间"）」
- 时间可改（补记昨天的事）；**地点、标签、心情**都在面板里点选（三个面板同一套结构）：
  - 上面是**选项卡片网格**（两列，📍 / `#` / emoji + 名称），下面是**输入框 + 确定同一行**；
    进来**不自动聚焦输入框**（想直接点已有项就不用先收键盘），也没有多余说明文字
  - **地点**：候选 = 你最近填过的 12 个地点，点一下**立刻生效**；自己写的用输入框 + 确定
  - **标签**：候选 = 最近用过的标签，点候选是**加/去**（可多选），确定提交
  - **心情**：预设表情 + **你自己写过的心情**（如 `😭 累瘫了`）**同在一个网格里**，
    点一下立刻生效；输入框里可写「一个表情 + 一小段说明」（说明最多 8 个字）
  - **长按任意卡片**（预设或自定义都行）→ 卡片右上角出现**删除键**，点它就删掉这个选项，
    点别处自动收起；删掉的选项记在本机（`localStorage`），以后不再出现
- 正文太长时**先折叠 6 行**、右下角给「展开 / 收起」；展开后显示全文（分享页同样生效）
- 一条记录有多张图片/视频时，附件按**不小于 132px** 的尺寸排成**一行横向滚动**（可以左右滑着看），
  只有一张时铺满整行
- **附件可点开编辑**（在发布/编辑面板里**轻点**附件格子；长按仍然是拖动排序）：
  - **图片**：**裁剪**（拖动 / 四角缩放，自由 · 1:1 · 4:3 · 3:4 吸附）、**涂鸦**（7 色 / 3 档粗细 /
    清空）、**emoji 遮挡**（36 个表情，点哪放哪、可拖动、滑杆调大小、可删）；统一**撤销**栈；
    导出按裁剪后的原始像素合成（最长边 ≤ `IMAGE_MAX_EDGE`，带透明的图仍存 png，其余 jpeg 0.9）
  - **视频**：选起止时间**裁剪**（`captureStream` + `MediaRecorder` 录选区，优先 mp4、退回 webm），
    浏览器不支持时给明确中文提示并保留「不裁剪」的取消路径
  - 保存后**就地替换**那个附件：新附件直接换文件；已有附件会「删掉旧的 + 上传新的」，
    在附件条里的位置不变
- **纪念日 / 倒计时**（设置页管理，可多条目）：
  - 每条可设**名称、图标、日期、说明**；可**修改**、**移除**；保存后**立即生效，不用手动刷新**
  - **图标**：11 个预设，网格最后一格是**自定义输入框**（和预设同样大小，但用**虚线框 + 灰底**
    表明它是输入框，placeholder 是 ✏️），**只收一个表情**、不接受文字（👨‍👩‍👧、🇨🇳 这类多码点
    emoji 不会被切坏）
  - **说明**：最多 **20 个字**，超出自动截断；设置页列表里**单独占第三排**（名称 / 日期+剩余天数 / 说明），
    不会把日期那一行挤乱
  - **生日**是一条特殊的纪念日（每账号唯一，永远特别关注）
  - 自定义纪念日里可把**其中一条设为「特别关注」**（全局唯一）
  - **首页**显示两个倒计时：**生日** + **特别关注的那一条**；当天显示「今天是…！🎉（N 周年/N 岁）」
  - 倒计时写明**目标年份**（如 `2027 年 5 月 20 日`），跨年顺延后也不会看错
  - **倒计时卡片（首页 / 日历通用）分两行**：第一行是倒计时（图标 + 「距离 X 还有 N 天」+ 箭头），
    第二行是日期 + 说明；**没有说明时**日期回到第一行、整张卡片就只有一行。
    有说明时把日期挪到第二行是有原因的：第一行「主文案 + 日期 + 箭头」要 375px，
    卡片只有 338px，硬塞会把主文案或日期挤成省略号；说明放不下时**整体换行**（最多三行），
    绝不截断用户写的说明
  - **日历**：有纪念日的日期会在格子上标出图标并高亮；日历下方先列出「本月纪念日」，
    再按剩余天数列出「全部倒计时」
  - 已过今年的日期自动顺延到明年；2 月 29 日在平年会落到 2 月 28 日（不会溢出到 3 月）
- 单张图片 ≤ 20MB、单个视频 ≤ 300MB，图片会在手机端先压缩到 1920px 再上传（省流量、快）
- 视频自动截取第 1 秒画面做封面，时间线里不会一片黑

**查看**
- 首页按天看，左右切换日期，也可以「看全部」
- 顶部 **全部 / 好友 / 我** 三个标签可以**左右滑动切换**（也可以直接点）：
  三页常驻、切换只是横向平移 + 用各自缓存即时重绘，所以**不会白一下、也不会闪骨架屏**；
  松手时按滑动距离或甩动速度决定翻页，两端有橡皮筋；三页数据会提前预热，滑过去即见
- **记录卡片主题色**：自己和好友的卡片是**同一套框架**（同样的圆角 / 边框 / 内边距），
  只靠底色区分 —— 自己的默认白，好友的用 TA 的**头像取色**（缩到 12×12 取平均 ≈ 先模糊再采样，
  再规范化到看得出来的饱和度 / 亮度）；
  自己的底色可以在**设置 → 记录卡片底色**里改成：默认白 / 跟随头像 / 5 个预设 / 自定义颜色
- 日历视图：有记录的日子会标出条数，点进去直达当天
- 搜索：关键词（内容/地点/标签）、点标签直接筛
- 图片/视频全屏查看，左右滑动切换，视频可拖动进度条

**分享**
- **每次分享生成一条独立、限时的链接**：`/s/<token>`（设置页或首页右上角分享面板里生成，带二维码）
- 生成时选两样东西，都**写进链接记录**（不是写在 URL 参数里）：
  - **范围**：某一天 / 某个月 / 全部时间线
  - **有效期**：1 小时 / 1 天 / 7 天 / 30 天（默认 7 天）
- 访客打开链接就是那个范围，页面上**没有筛选入口**；手改 URL 参数也没用（范围由服务端按链接决定）
- 链接失效会给出明确提示：过期「这个分享链接已过期」、被撤销「对方已撤销这个链接」、
  老版永久链接「这个分享链接无效」
- 分享页里时间线按天分组、支持「加载更多」（**不再重复显示**「今天 · 今天 / 今天 · 2026-10-09 /
  全部时间线 / 2026 年 10 月 · 整月」这类范围摘要与说明文字）
- 每条记录可选 **所有人可见 / 仅分享链接可见 / 仅自己可见**
- 分享页只有这一条链接对应的内容，**没有筛选入口**，顶部写明「限时分享：某一天 · 23 小时后过期」
- **旧的永久分享链接已彻底取消**：不再有 `share_token`、没有「允许通过链接访问」开关、
  也没有「重置链接」；老链接（`/share/<token>`）打开会提示失效，请对方重新生成一条
- 访客可只读浏览、不需要账号；分享页带「我也要记录」入口

**好友（互相可见，和分享是两套独立机制）**
- 底部「好友」页：按**用户名**精确查找 → 发出申请 → 对方同意后成为好友
- 双向可见：成为好友后，双方的时间线上会**直接出现对方的动态**
- 时间线顶部可切换 **我 / 好友 / 全部**（**左右滑动**或点击切换）：
  - **我**：只有自己（含私密记录），首页顶部显示**纪念日倒计时**
  - **好友 / 全部**：顶部出现**可横向滚动的头像 + @用户名筛选条**，点头像只看这个人
    （头像外圈的亮环表示「这天有记录」，右下角数字是条数；再点一次取消筛选）
  - `我` —— 只有自己（含「仅自己可见」的私密记录）
  - `好友` —— 只有好友的公开动态
  - `全部` —— 我 + 好友按时间合并（默认）
- **视觉区分**：好友的动态带作者头像、昵称、`好友` 徽标；卡片**不再**用左侧色条，
  而是**用自己的主题色当底色**（好友的没设置过就从他头像取色），见下文「记录卡片底色」
- 好友的卡片没有编辑/删除按钮（你只能改自己的）
- 隐私：`仅自己可见` 的记录**永远**不会出现在好友或分享视图里
- 「好友的时间线」页面（应用内点好友头像打开，`/u/<用户名>/timeline`）**需要登录且是好友**
  （未登录 401、不是好友 403），免得别人靠猜用户名就能翻记录；它和限时分享链接是两套机制
- 可以给好友设**备注名**（只影响你自己的显示）：设过之后**别人一律显示你起的备注名**
  （时间线里的作者、好友列表…）；只有在**点开 TA 的时间线页面**时以 TA 自己的昵称为主，
  用括号标注你起的备注名（如 `Myself（老板）`）；随时**解除好友**
- 请求是双向确认的：你申请对方 → 对方同意；如果对方也申请了你，则自动成为好友

**其他**
- 支持 PWA：手机上「添加到主屏幕」后像 App 一样打开
- 深色模式自动跟随系统
- 数据都在本地 `data/` 目录（SQLite + 原图/原视频文件），可一键导出 JSON 备份
- 修改密码后其他设备自动退出登录

## 几个容易踩的坑（已在代码里规避，改代码时请注意）

1. **一个遮罩层只能有一个 `.sheet`**。曾经因为复用遮罩层时又塞了一个空面板，导致两个 `width:100%` 的
   flex 子项各被压成一半宽、整体左移（表现为面板右侧被裁切）。`ui.js` 里做了复用保护，
   `scripts/ui-test.mjs` 用 DOM 桩锁死了这个不变量。
2. **视图函数里不要在异步回调中调用 `render()`**。`render → viewFriends → loadFriends → render`
   会形成无限循环，真机上表现为整页卡死、导航点不动、输入框打不进字。
   好友页的刷新由 `friends.js` 内部局部重绘负责。
3. **`loadHome()` 必须显式传 `scope`**，否则会被参数默认值悄悄重置，出现"看不见某些记录"。
   `scripts/verify-served.mjs` 会检查所有调用点。
4. **在途请求要带 token 丢弃过期响应**，否则切界面时旧响应会覆盖新数据（记录"时有时无"）。
   同理，`stale` 标记保证「切回首页/切回前台/增删改后」一定重新拉取。
5. **编辑动态的附件也要走 multipart**。曾经编辑模式只发 JSON，导致新加的图片/视频被静默丢弃；
   现在 `PATCH /api/posts/:id` 也接受 multipart。
6. **`[hidden]` 必须显式写 `display: none !important`**。作者样式里的 `display` 会覆盖
   `hidden` 属性自带的 `display:none`，不同浏览器的 UA 处理还不一致。
7. **`.sheet-backdrop` 要显式约束 `left/right/width`**。`position: fixed` 的块级盒子若没有宽度约束，
   会收缩到内容宽度，在宽屏上表现为面板不与视口对齐。
8. **首页倒计时必须渲染在「有没有记录」判断之前**。曾经它写在 `if (!posts.length) { ...; return; }`
   之后，导致当天还没发记录时永远看不到倒计时。
9. **原生日期输入框（`<input type="date">`）在手机上要显式约束宽度/高度**，否则会超出容器、
   高度不齐；另外 `hidden` 与作者样式 `display` 的优先级问题（见第 6 条）同样适用于它。
10. **给已存在的表加字段要写显式迁移**。`CREATE TABLE IF NOT EXISTS` 不会补列，
   本项目在 `Store.#migrate()` 里用「ALTER TABLE + 忽略 duplicate column」的方式平滑升级。
11. **「新增」之后必须就地重绘，不能只通知外层**。设置页「添加纪念日」曾把 `onSaved` 直接接到
    外层的 `onChanged`（只标记首页过期），新增的条目要手动刷新才出现；现在统一走
    `onSaved: () => { paint(); onChanged?.(); }`，和「编辑 / 删除」保持一致。
12. **发帖后要刷新「当前正在看的那个视图」**。发帖只重载时间线，在**日历**页发帖时日历上的
    条数 / 标记要手动刷新才更新；现在发帖后会按 `state.view === 'calendar'` 补一次 `loadCalendar()`。
13. **高亮样式别靠单侧 padding**。`.anniversary-row.special` 曾用 `padding-left: 8px; padding-right: 4px`
    做底色，导致该行内容整体右移、文字列变窄、说明多折一行（看起来「横向变窄」）。
    现在所有行统一 `padding: 10px 8px; margin: 0 -8px`：内容位置和以前完全一致，
    底色却能左右对称铺满整行。
14. **长度限制要按「码点 / 字素」截，不能直接 `slice`**。`String.slice` 会把 emoji 的代理对切成
    半个乱码；说明（20 字）与图标统一用 `[...str]` / `Intl.Segmenter` 截断，
    前端 `public/js/anniversaries.js` 与服务端 `src/http/routes/anniversaries.js` 两侧都做兜底。
15. **面板内容要包在 `.sheet-body` 里**。`.sheet` 只有 `padding-bottom`（安全区），左右内边距和段间距
    都由 `.sheet-body` 提供 —— 发布面板当初把 `textarea` / 附件条 / 元信息 / 工具栏直接挂在 `.sheet` 上，
    结果**左右完全贴边、段与段之间没有间距**，内容超高时也无法滚动。现在统一 `sheet.append(header, body)`。
16. **拖动排序后不能再沿用渲染时捕获的下标**。附件的「移除」原本用 `renderAttachments()` 里的
    `index` 去 `splice`，一旦长按拖动改了 DOM 顺序就会删错那一个；现在每个附件带稳定 `key`，
    删除按 key、松手时按 DOM 顺序写回 `state.attachments`（上传 / 封面顺序也跟着变）。
17. **要「抬起」的东西不能留在 `overflow` 容器里**。附件条是 `overflow-x: auto` 的滚动容器
    （另一轴的计算值会变成 `auto`），把格子 `scale()` 放大后会被上下边界裁掉、露出半截；
    另外只移动 DOM 节点也做不到「跟着手指走」。所以拖动时另建一块 `position: fixed` 的浮层挂到
    `document.body` 上：外层逐帧 `translate3d` 跟手（rAF 插值 + 轻微倾斜），内层播一次
    `attach-lift` 放大动画，原格子只留成占位（变淡 + 内描边），松手再把浮层滑回落点后移除。
18. **切标签别走 `location.hash` → `hashchange` → `render()`**。那条路径会把整个 `#main` 清空重建：
    切一下闪一下、骨架屏还会再闪一次，滑动手势更不可能做。现在首页是「三页常驻的滑动容器」：
    - 三页 DOM 一直在，切页只改轨道的 `translateX`，内容用**各页自己的缓存**即时重绘；
    - 每页的数据、加载状态、请求 token、缓存 key 都是独立的（`state.panes`），
      `state.home` 只作为"当前页"的镜像，老代码照旧能用；
    - 切页用 `history.replaceState` 改地址，**不触发 `hashchange`**（否则又会去重建视图）；
    - `#home-list` / `#home-top` 这两个 id 会**跟着当前页搬**，这样
      `document.querySelector('#home-list')`、调试入口、回归测试都不用改；
    - 容器高度由 JS 跟着当前页设（带过渡），否则矮的那一页下面会留一大段空白；
    - 非当前页只加 `pointer-events: none`（**不要**用 `visibility: hidden`：会在滑进来的瞬间
      重新绘制，手机上表现为"白一下"）；
    - 手势用 pointer 事件，主方向是竖向就让给页面滚动（`touch-action: pan-y`），
      只有横向意图才接管；松手按「滑过 22% 屏」或「甩动 > 0.4px/ms」翻页。
19. **`renderFeed()` 会先清空容器**。搜索页的时间线摘要（`找到 N 条`）如果写在 `renderFeed()` 之前，
    会被它抹掉、永远显示不出来；现在统一 `renderFeed()` 之后再 `prepend()`。
    首页那行「今天 · N 条 / 其中好友 N 条」已经**去掉**：日期分组头（`day-header`）里本来就有
    「今天 N 条」，再写一遍是重复信息。
20. **头像地址必须带版本号（`?v=updated_at`）**。头像文件每次上传都是新文件名，但**地址**如果一直是
    `/u/<id>/avatar`，浏览器就会按 `Cache-Control` 把上一张钉住 —— 表现就是「换了头像，刷新后还是旧的 /
    干脆显示不出来」。现在 `publicUser()`、帖子作者（`postJson`）都带上 `updated_at`；同时
    `/u/:id/avatar` 对**带版本**的地址给 `max-age=31536000, immutable`，对**不带版本**的老地址给
    `no-cache`（必须校验），`sendFile()` 也补了 `If-Modified-Since` → `304`，所以校验不会重复下载整张图。
21. **绝对定位的角标必须有自己的定位祖先**。好友头像右下角那个条数角标（`.chip-count`）原本是
    `.friend-chip` 的直接子元素，而 `.friend-chip` 没有 `position` —— 于是它挂到了最近的定位祖先上；
    加上滑动轨道的 `will-change: transform` 也会成为包含块，角标就跑到**轨道右下角**去了，
    表现是页面/卡片角上莫名冒出一个蓝色小圆点。现在多包一层 `.chip-avatar-wrap { position: relative }`。
22. **`overflow: hidden` 会制造滚动容器，`sticky` 会以它为参照**。滑动容器和每页一开始都写了
    `overflow: hidden`，结果里面的 `sticky` 日期条以「页顶 + `--top-h`(52px)」为参照，
    凭空多出 52px 空白、而且不再跟随页面滚动。现在容器用 **`overflow-x: clip`**（只裁剪、不产生滚动容器，
    老浏览器有 `@supports not (overflow: clip)` 兜底），每页本身不再加任何 `overflow`。
23. **区分「我和好友的记录」不要用某一侧加色条**。左侧色条 + 固定淡蓝底看起来像两种卡片；
    现在两者是同一套框架，只靠**卡片主题色**区分（`--card-accent` + `color-mix` 混进底色，
    深色模式单独给一个混合比例）。自己的主题色可设（默认白 / 跟随头像 / 预设 / 自定义 `#rrggbb`，
    存在 `users.card_theme`，走显式迁移），好友的没设置时**从他的头像取色**：
    把头像画到 12×12 画布（缩小本身就是先模糊再取平均）→ 取平均 → 把饱和度/亮度夹到
    「当底色看得出来、又不影响读字」的区间。取色失败（隐私模式 / 跨域）就退回默认白。
26. **`overflow: clip` 会把卡片的投影一起裁掉**。滑动容器为了裁掉相邻页用了 `overflow-x: clip`，
    结果卡片左右两侧的阴影被齐边切掉（看着很廉价）。修法是给容器左右各留 8px 内边距（底部 10px）
    再用负 margin 抵掉，让「裁剪边界」落在卡片外面；但这样相邻页又会滑进这 8px 里露出来 ——
    所以**页与页之间再留 16px 空隙**（`.scope-track { gap: 16px }`），空隙正好落在阴影区里。
    注意：翻页的平移量因此是**页宽 + gap**（`pagerStep()`），不能再用 `clientWidth`（含内边距）。
27. **倒计时卡片里「主文案 + 日期 + 箭头」一行放不下**。三者自然宽度合计 375px，而卡片内容区只有
    338px（390 视口），以前靠 `flex-wrap` 换行，加了说明之后会变成三行、箭头也被挤到第二行。
    现在卡片改成两段：`.cd-top`（图标 + 主文案 + 头像/箭头，`flex-wrap: nowrap`）和
    `.cd-meta`（日期 + 说明）；**有说明时日期下移到 `.cd-meta`**，没有说明时留在第一行。
    另外 `DOM.append(null)` 会插入**字面量 "null"**（`el()` 会跳过 null，`append()` 不会）——
    「今天 + age=0」的卡片就这样漏出过一个 `null`，所以可空项一律先判断再 append。
28. **分享页里的记录不属于「当前登录的访问者」**。`postJson()` 曾经写成
    `row.author || viewer`：分享页查询不会附作者信息，于是「小明打开 Myself 的分享页」时，
    Myself 的记录被安上了**小明的头像和用户名**。现在兜底只在
    `viewer.id === row.user_id` 时生效，分享接口还会显式把 owner 作为作者附上。
29. **「是不是直接运行」不能只比较 `process.argv[1]`**。`src/server.js` 末尾用
    `process.argv[1] === 本文件` 判断是否 `startServer()` —— 这在 `node src/server.js` 下没问题，
    但 **pm2 是用它自己的 `lib/ProcessContainerFork.js` 去 `import()` 应用的**
    （spawn 的命令是 `node <pm2>/lib/ProcessContainerFork.js`，应用路径放在 `pm_exec_path` 里），
    此时 `argv[1]` 是 pm2 的包装脚本：判断恒为 false，进程在 `pm2 list` 里显示 `online`、
    **却永远不监听端口、日志里一行都没有**（`pm2 start src/server.js` 一直"起不来"就是这个）。
    现在除了比较 argv，还认 pm2 注入的 `pm_id` / `pm_exec_path`（fork 与 cluster 都会注入）。
    回归测试：`node scripts/pm2-mode-test.mjs`（用同样的加载方式启动并真请求 `/api/health`，
    不需要安装 pm2）。
30. **「分享范围」不要放在 URL 参数里**。旧做法是一条永久 `share_token` + `?range=today|date|all`
    区分三种分享页，结果：链接永久有效（发出去就收不回来）、范围能被访客改掉、换范围要重新拼参数。
    现在每次分享都往 `share_links` 表写一条记录（`scope` 某天/某月/全部 + `expires_at` +
    `revoked_at`），URL 只有 `/s/<token>`：范围由服务端按链接决定（客户端传 `range`/`date`
    一律忽略），到期 410 `share_expired`、撤销 410 `share_revoked`。旧的 `share_token` 字段与
    `/api/share/*`、`/api/me/share/rotate` 全部下线（`/api/auth/me` 也不再下发 `shareToken`）。
    顺带补了一个洞：`/u/<用户名>/timeline`（应用内看好友的时间线）以前**不需要登录**就能看，
    靠猜用户名就能翻别人的公开记录；现在要求登录 + 好友关系（401 / 403）。


31. **编辑时已有附件也必须进附件条**（用户报的 bug）。`openComposer` 以前只把「新选的文件」放进
    `state.attachments`，编辑一条带图的记录时附件条是空的 —— 于是**根本没法删、也没法拖动排序**。
    现在打开面板时把 `post.media` 也铺进去（`existing: true` 的条目没有 `file`，用服务端 URL 当预览，
    不能 `revokeObjectURL`），删除记进 `state.removed`；提交时带 `removeMediaIds` + `mediaOrder`
    （顺序里可以混 `new:0`，对应本次 multipart 上传的文件）。服务端给 `media` 加了 `sort_order`
    （显式迁移 + 按旧顺序回填 0..n-1），查询按它排序，删除时连文件一起清掉。
32. **`DOM.append(null)` 会插入字面量 `"null"`**。`el()` 会跳过 null，`append()` 不会 ——
    「今天 + 周年数为 0」的倒计时卡片就这样漏出过一个 `null`。可空项一律先判断再 append。
33. **倒计时卡片里「主文案 + 日期 + 箭头」一行放不下**（合计 375px，卡片内容区只有 338px）。
    卡片因此分成 `.cd-top`（图标 + 主文案 + 头像/箭头）与 `.cd-meta`（日期 + 说明）两段：
    有说明时日期下移到第二行，没有说明时留在第一行、整张卡只有一行。
34. **`overflow: clip` 会把卡片投影一起裁掉**，所以滑动容器左右各留 8px 内边距（负 margin 抵掉）、



35. **「发布时间」和「事情发生的时间」要分开存**。以前只有一个 `created_at`，既当发布时间又当
    「事情发生时间」—— 补记/改时间会把「这条是什么时候发的」也一起改掉，排序与"多久之前"都跟着乱。
    现在 `posts.occurred_at` 是后者（可改，排序 / 分组 / 日历都按它，老数据用
    `UPDATE posts SET occurred_at = created_at` 一次性回填），`created_at` 永远是发布时间；
    卡片左上角显示 `occurred_at`、旁边的「xx 分钟前」显示 `created_at`。
    为了兼容，接口仍接受 `createdAt`，但会当作 `occurred_at` 存。



36. **「已生成的链接」列表最多显示 5 行，超过就自己滚**。分享改成限时链接后这个列表会越攒越多
    （设置页每条还有复制 / 撤销），不限高会把页面拉得非常长。现在按**实际行高**算出「5 行」的
    高度写进 `max-height`（`capLinkList()`；行高会随字体 / 换行变，所以不写死 px）：超过 5 条
    内部滚动、≤5 条时完全不留滚动条。分享面板里的「已创建的链接」和设置页共用这套规则。
    同页所有操作按钮统一居右（`.settings-card .field-actions { justify-content: flex-end }`）。



37. **手机上传的文件经常没有 MIME 类型**（`file.type === ''` 或 `application/octet-stream`）。
    客户端以前只按 `^video/`、`^image/` 判断类型，于是「IMG_1234.MOV / IMG_1234.mp4」会被判成
    **不支持的格式**直接丢掉 —— 用户看到的就是「上传不了视频」。现在 `media.js` 的 `kindOf()`
    同时看 **mime + 文件名后缀**（`EXT_VIDEO` / `EXT_IMAGE`），服务端本来就会用后缀兜底
    （`normalizeMime`），所以两边一致。
38. **浏览器解不了的视频不要拒绝上传**。iPhone 默认拍 HEVC/H.265，Chrome 读不出元数据 ——
    以前 `processVideo()` 直接抛「这个视频浏览器无法读取」，等于传不上去。现在读不出信息也照样
    上传原文件（`width/height/duration/poster` 全为 null，带一句 `warning` 提示），首页用
    `.media-tile.no-poster` 兜底显示；附件裁剪面板遇到这种视频会说明「没法裁剪」并禁用裁剪按钮，
    关掉面板直接保存即可。另外 `Number(null) === 0`：读不出的时长 / 尺寸别写成 0，否则以后
    分不清「0 秒」和「不知道多久」（`finalizeMedia()` 里的 `num()`）。


39. **视频又慢又卡，根子是「原文件太大 / 码率太高」**。手机拍的视频动辄几十上百 MB、码率几十 Mbps，
    Wi-Fi 拉不动、解码也吃力 —— 服务端已经支持 Range（`sendFile()` 会回 206 + `accept-ranges`），
    所以问题不在传输方式，而在文件本身。做法：
    - **附件编辑器里有「压缩到 720p」**：把画面缩到 ≤1280 宽、用 ~2.5Mbps 重录一遍
      （`compressVideo()`：canvas `captureStream` + `MediaRecorder`，声音从原视频轨道接过来；
      要按原速过一遍，所以给了进度百分比）。实测 1080p/12Mbps → 1280×720，2.5MB → 700KB。
    - **加附件时如果视频 >24MB 会问一句**「压缩后上传？」，确认后直接在附件格子上显示压缩进度
      （`compressFile()` 对外导出，`item.progress` 渲染成 `.attach-progress`）。
    - **压缩后如果没小多少就不替换**（避免白等一场），失败也退回原文件上传。
    - `/m/:id` 改成 `public, max-age=31536000, immutable`（附件 id 一次性、内容永不改变），
      同一个视频再看就是秒开。


- **局域网可直接用**：默认监听 `0.0.0.0`，手机连同一 WiFi 就能访问；PWA/Service Worker 在 HTTPS 或 localhost 下才会启用。


40. **好友备注名的 UPDATE 必须按「这一行的两个方向」定位**。`friendships` 一行只有一个
    (requester_id, addressee_id)，备注名分 `alias_by_requester` / `alias_by_addressee` 两列。
    原来写的是 `UPDATE ... WHERE requester_id = ? AND addressee_id = ?` 并把 `(我, 对方)` 传进去：
    当「我」是**接收方**（对方来加的我）时这条 SQL 命中 0 行 —— 接口老老实实回 200、前端提示
    「已保存」，数据库里一个字节都没变，用户看到的就是**「改了备注名没生效」**。
    现在和同文件其它语句一样用 `(a=? AND b=?) OR (a=? AND b=?)` 两个方向匹配，并明确写哪一列。
    教训：`e2e.js` / `smoke-live.mjs` 里原来的备注名用例，设备注的人**都是发起方**，方向反着的
    那一半永远绿 —— 补了「接收方设备注」的用例。另外「好友时间线页」顶部的名片还额外漏了一次
    （`ownerProfile()` 当时拿不到访问者），现在也按访问者的备注名显示。

## 目录结构

```
daylog/
├── src/
│   ├── server.js            # HTTP 服务、路由注册、静态资源、优雅退出
│   ├── config.js            # 端口/目录/大小限制等配置（支持环境变量）
│   ├── push.js              # 手机通知：服务器出站推送到企业微信/ntfy/Bark/webhook
│   ├── db/store.js          # SQLite 数据层（建表、查询、统计）
│   ├── lib/
│   │   ├── multipart.js     # 零依赖 multipart/form-data 流式解析器
│   │   ├── crypto.js        # scrypt 口令哈希、会话令牌、分享令牌
│   │   ├── time.js          # 时区安全的日期/时间换算
│   │   └── qr.js            # 纯 JS 二维码生成（SVG / 矩阵）
│   ├── media/files.js       # 上传暂存、落盘、封面、清理
│   └── http/                # 请求上下文、错误处理、各路由模块
├── public/
│   ├── index.html           # 主应用（SPA）
│   ├── share.html           # 访客分享页
│   ├── css/style.css        # 移动优先样式（含深色模式）
│   ├── js/                  # app / api / ui / timeline / composer / attachment-editor / media / share
│   ├── icons/               # PWA 图标（SVG + PNG）
│   ├── manifest.webmanifest
│   └── sw.js                # Service Worker
├── scripts/
│   ├── healthcheck.js       # 环境自检（不启动服务）
│   ├── mp-test.js           # multipart 解析器单元测试（63 项）
│   ├── qr-test.js           # 二维码生成 + 反向解码自检
│   ├── pm2-mode-test.mjs    # pm2 加载方式回归（不需要装 pm2）
│   └── e2e.js               # 端到端测试（66 项，真启动服务跑完整流程）
├── ecosystem.config.cjs     # pm2 配置（可选，见「用 pm2 常驻运行」）
└── data/                    # 运行时生成：daylog.db + uploads/
```

## 常用命令

```bash
npm start          # 启动服务
npm run check      # 环境自检（Node 版本、目录、模块、静态资源）
npm test           # 端到端测试（独立临时数据目录，不动你的数据）
node scripts/mp-test.js         # 上传解析器单元测试（63 项：二进制/跨块/1MB/空文件）
node scripts/qr-test.js         # 二维码自检（生成 + 反向解码校验）
node scripts/ui-test.mjs        # 底部面板 DOM 结构回归（21 项，防「一遮罩两面板」）
node scripts/cal-test.mjs       # 日历布局算式核对（正方形格子 / 铺满宽度 / 高度放得下）
node scripts/anniversary-note-test.mjs  # 纪念日展示回归（说明第三排 / 20 字截断 / 自定义图标 / 倒计时两行，40 项）
node scripts/dom-ui-test.mjs <用户名> <密码>  # 真实 headless Chrome 联调（首页倒计时 / 头像条 / 日历标注，25 项）
node scripts/verify-served.mjs  # 核验服务器实际返回的前端文件是否含各项修复（61 项）
node scripts/friends-api-test.mjs  # 好友 API 联调（查找/申请/同意/备注/合并时间线）
node scripts/pm2-mode-test.mjs  # pm2 加载方式回归（模拟 pm2 的包装脚本启动，验证端口真的起来）
node scripts/smoke-live.mjs     # 对「已启动的服务」做真实冒烟测试（69 项，含好友与分享）
```

`smoke-live.mjs` 会实际注册一个 `smokeXXXXXX` 账号并发几条记录（含图片、视频、分享、私密），
用来验证整套流程在真机上是否通；跑完可以直接在应用里把该账号的记录删掉。

浏览器里还可以用 `window.daylogDebugLayout()` 做布局自检：会列出所有超出视口的元素、
底部面板的实际位置/宽度/是否居中、以及祖先元素的 `transform` 等（排查固定定位问题很有用）。
它同时会检查「一个遮罩层里是否只有一个 `.sheet`」这个结构不变量（违例会导致面板错位）。

**关于缓存**：`.html/.js/.css/.webmanifest/sw.js` 一律返回 `no-store`，Service Worker 也是
网络优先（失败才用缓存）。所以改完代码**刷新即生效**，不需要手动清缓存；「设置」页底部会显示
`build xxx`，可用来确认当前跑的是哪一版。图标等图片资源仍是长缓存。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `81` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` 则只有本机能访问） |
| `DAYLOG_DATA_DIR` | `./data` | 数据目录（数据库 + 上传文件） |
| `DAYLOG_ALLOW_SIGNUP` | `1` | 是否允许自助注册，`0` 关闭 |
| `DAYLOG_SIGNUP_CODE` | 空 | 设置后注册需要邀请码 |
| `DAYLOG_MAX_IMAGE_MB` | `20` | 单张图片上限 |
| `DAYLOG_MAX_VIDEO_MB` | `300` | 单个视频上限 |
| `DAYLOG_MAX_FILES_PER_POST` | `12` | 单条记录附件数上限 |
| `DAYLOG_TRUST_PROXY` | `0` | 放在反向代理/内网穿透后面时设为 `1` |
| `DAYLOG_SESSION_DAYS` | `90` | 登录有效期（天） |
| `DAYLOG_PUSH` | 空 | `0` = 整站关掉手机通知（管理员总开关）|
| `DAYLOG_PUSH_ENDPOINT` | 官方地址 | 覆盖企业微信服务地址（测试 / 自建代理用）|
| `DAYLOG_PUBLIC_URL` | 按请求 Host | 通知里链接用的站点地址 |
| `TZ` | `Asia/Shanghai` | 服务器兜底时区（客户端会带自己的时区，通常不用管） |

### 手机通知（推送到手机上）

**为什么不是浏览器的 Web Push**：那要求 HTTPS（Service Worker / Push API 只在安全上下文里可用）。
本项目的思路是**服务器出站推送** —— Node 主动 POST 给推送服务的接口，由**你手机上的那个 App** 弹原生通知，
所以纯 HTTP 也能用、也不用域名。

**规则（收件人视角，谁的记录推给谁）**：某个人发了新记录 → 推给**他的好友**，每个收件人各用**自己**的通道：

| 优先级 | 收件人的设置 | 位置 |
| --- | --- | --- |
| ① | 把这个人设成**免推送** → 什么都不推 | 好友页 → 他那行的「推送」按钮 |
| ② | 给这个人单独配的 key → 用它 | 同上（「给 TA 单独配一条通道」）|
| ③ | 自己的**默认通道** → 用它 | 设置页 → 「手机通知」 |

> 作者自己不会收到自己的推送；不是好友的人发帖也不会推给你。
> ④ **没有"服务器级通道"**：2026-10-11 起，通道只能来自用户自己的设置。
> （早先支持过 `DAYLOG_PUSH_WECOM_KEY` + `DAYLOG_PUSH_OWNER` 的服务器级通道，
> 结果出现了「我明明没配 key，却还能收到推送」这种让人怀疑的现象，已彻底移除。）
> 也就是说：**没配就是没配**，「发送测试通知」会如实报「还没配推送通道」。

密钥存在自己的 SQLite 里，接口**只回掩码**（`…61b8`），设置页有「发送测试通知」按钮可以一键验证。

**企业微信（推荐，5 分钟）**：

1. 手机/桌面企业微信 → 任意群 → 群设置 → **群机器人** → 添加 → 复制它的 **Webhook 地址**
   （形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx`）
2. 登录 DayLog → **设置 → 手机通知** → 通道选「企业微信机器人」→ 保存 → 点「发送测试通知」
   - key 那一栏**三种粘法都认**：整条 Webhook 地址（自动取出 `key=` 后面那串）、`key=xxx` 片段、或者只贴那串 key。
   - key 写错不会「假装成功」：企业微信失败也回 HTTP 200，代码会读 `errcode` 并把真实错误（如 `invalid webhook url`）显示出来。

**其它通道**：同一张卡片里可以选 ntfy（`https://ntfy.sh/你的topic`）、Bark（`https://api.day.app/你的key`）
或自定义 webhook（会收到 `{title, body, link, text}` 的 JSON）。

**推送内容**：`谁 + 一句话摘要（默认 60 字，可在设置页改成 0 = 只推标题）+ 心情/日期/标签 + 点开就跳到那天的链接`。

**可靠性**：通知是 fire-and-forget —— 5 秒超时、失败只记一条 warn 日志
（`tail ~/.pm2/logs/daylog-error.log`），**绝不影响发帖**（有测试覆盖：端点不可达时发帖照样 201）。
企业微信**失败也回 HTTP 200**，所以代码会检查 `errcode`（key 写错/被重置会被真的记成失败）。

### 收件箱（通知层）：让 agent 也能"收到"人的动态

手机推送是给人用的；**agent 不是常驻进程，没人能推送给它**（它不会被叫醒）。
所以反过来做：把"有事发生"写进**收件人的收件箱**，再把未读摘要**捎带在每个 API 响应里** ——
agent 唯一的动作就是调 API，于是"人做了事 → agent 下次一调用就必然看到"，即使不是实时的。

| kind | 什么时候 | 写给谁 |
| --- | --- | --- |
| `post` | 好友发了新记录 | 作者的每个好友 |
| `friend_request` | 有人发好友申请 | 收请求的人 |
| `friend_accepted` | 好友申请被同意 | 双方各一条 |

作者**不会**收到自己动作的通知；跟事件无关的人**收不到**（按收件人逐个判断，有测试覆盖）。
这一层与"手机推送"**完全解耦** —— 就算 `DAYLOG_PUSH=0` 全站关掉推送，收件箱照样记。

```
GET  /api/me/notifications?limit=20&unread=1    # 未读概览 + items（含 postId / dayKey / actorName）
POST /api/me/notifications/read                 # { all: true } | { ids: [...] } | { upTo: <毫秒> }
```

**捎带字段**：任何"登录用户的 JSON 响应"，只要他有未读，就会多一个 `notifications`：

```json
{
  "posts": [ "..." ],
  "notifications": {
    "unread": { "total": 2, "byKind": { "post": 1, "friend_request": 1 } },
    "items": [
      { "id": 12, "kind": "post", "actorName": "小明", "actorUsername": "ming",
        "postId": "p_xxx", "dayKey": "2026-10-11",
        "summary": "小明 发了新记录：今天把收件箱做好了", "createdAt": 1791659058051, "read": false }
    ],
    "hint": "你有 1 条好友新记录、1 个好友申请待处理（GET /api/me/notifications 查看…）",
    "serverTime": 1791659058100
  }
}
```

- **没有未读时不塞这个字段**（不给所有响应加噪音）；收件箱接口自己不再套一层（避免重复）。
- 捎带查询失败**绝不影响正常响应**（fail-open，有测试）。
- 每人最多保留 500 条（自动裁剪）；**不做历史回填** —— 部署之后发生的事才算。
- 技能 CLI 也接了：`node daylog.mjs inbox [--read]`，而且**每个命令跑完都会顺口提示**未读。

示例：

```bash
# Windows PowerShell
$env:PORT=9000; $env:DAYLOG_ALLOW_SIGNUP=0; npm start
# macOS / Linux
PORT=9000 DAYLOG_ALLOW_SIGNUP=0 npm start
```

## 分享到外网

**推荐：Cloudflare Tunnel**（免费、自带 HTTPS、不用改路由器）

```bash
# 1. 安装 cloudflared 后（Windows: winget install Cloudflare.cloudflared）
cloudflared tunnel --url http://localhost:81
# 2. 它会输出一个 https://xxxx.trycloudflare.com 地址，把这个地址发给朋友
```

用隧道时建议加上：

```bash
$env:DAYLOG_TRUST_PROXY=1; npm start   # 让应用正确识别 https 与访客 IP
```

其他方式：`ngrok http 81`、frp、或部署到有公网 IP 的服务器/内网穿透盒子。
**注意**：暴露到公网后，请给账号设置足够强的密码，并确认「分享」开关的状态。

## 用 pm2 常驻运行（可选）

想让它开机/异常退出后自己起来，可以用 pm2。**别用 `pm2 start src/server.js` 然后纳闷为什么访问不了** ——
pm2 不是直接跑你的脚本，而是先跑它自己的 `lib/ProcessContainerFork.js` 再由那个文件 `import()` 你的应用，
所以应用里的 `process.argv[1]` 是 pm2 的包装脚本、不等于 `server.js`。
如果代码里用「`argv[1] === 本文件`」判断"是不是直接运行"，在 pm2 下就永远为假：
进程在 `pm2 list` 里是 `online`，**却从来不监听端口，日志里连一行都没有**。
本项目已经在 `src/server.js` 里认了 pm2 注入的 `pm_id` / `pm_exec_path`（见踩坑 29），
`pm2 start src/server.js` 现在也能正常起；不过更推荐用仓库里的配置文件：

```bash
npm i -g pm2
# 端口、数据目录、注册开关等都写在 ecosystem.config.cjs 里（默认 81）
pm2 start ecosystem.config.cjs
pm2 logs daylog            # 看到「DayLog 已启动 🎉」才算真的起来了
pm2 restart daylog --update-env
pm2 save                   # 记住当前进程列表
```

排查时按这三步走：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `status` 是 `online`，但访问不了、日志空白 | 应用被 pm2 的包装脚本 import，没跑启动逻辑 | 用 `ecosystem.config.cjs`，或确认 `src/server.js` 里的 `isDirectRun` 认了 `pm_id`/`pm_exec_path` |
| `status` 是 `errored`、`↺` 一直涨，日志里 `EADDRINUSE` | 端口被占用 —— 最常见的是**之前手动 `npm start` 的那个进程还开着** | 先停掉手动起的进程（`Ctrl+C`，或找到 PID 结束），再 `pm2 restart daylog` |
| 改了 `PORT` / `DAYLOG_*` 却不生效 | pm2 守护进程只在启动时记一次环境变量，也**不读 `.env`** | 改 `ecosystem.config.cjs` 的 `env`，然后 `pm2 restart daylog --update-env` |

另外两点：**必须单进程**（数据库是 `node:sqlite`，`-i 2`/cluster 会让多进程同时写同一个库文件）；
**Node 版本要 ≥ 22.5**，用 nvm 切换过版本后 pm2 守护进程还是老 Node，需要 `pm2 kill` 再 `pm2 start`。
Windows 上 `pm2 startup` 不适用（那是 systemd 的），要开机自启请用 pm2-installer / nssm 之类的服务包装。

## 数据与备份

- 数据库：`data/daylog.db`（SQLite，WAL 模式）
- 上传文件：`data/uploads/`（文件名即附件 ID，数据库里存元信息）
- 备份：直接复制整个 `data/` 目录即可；也可以在「设置 → 导出我的数据」下载 JSON

## HTTP 接口（自用/二次开发参考）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/signup` `/login` `/logout` | 注册 / 登录 / 退出 |
| `GET` | `/api/auth/me` | 当前用户 + 统计 + 分享令牌 |
| `GET` | `/api/posts` | 时间线（`scope=mine\|friends\|all\|only`、`author`、`friendId`、`from` `to` `q` `tag` `limit` `cursor`），返回 `counts`（各作者条数） |
| `POST` | `/api/posts` | 新建（JSON 或 `multipart/form-data`） |
| `PATCH` `DELETE` | `/api/posts/:id` | 编辑 / 删除（`PATCH` 同时支持 `multipart` 以**追加**图片/视频） |
| `GET` | `/api/friends` | 好友列表 + 待处理请求（incoming / outgoing） |
| `GET` | `/api/users/lookup?username=` | 按用户名精确查找用户（附关系状态） |
| `POST` | `/api/friends/requests` | 发起好友申请（`{username}` 或 `{userId}`） |
| `POST` | `/api/friends/requests/:id/accept` | 同意申请（`:id` 是**发起人**的用户 id） |
| `DELETE` | `/api/friends/:id` | 拒绝 / 撤回 / 解除好友 |
| `PATCH` | `/api/friends/:id` | 设置备注名 `{alias}` |
| `POST` | `/api/uploads` | 先传后发（返回附件 ID） |
| `POST` | `/api/uploads/avatar` | 头像上传 |
| `GET` | `/m/:id` | 附件（支持 Range，视频可拖动） |
| `GET` | `/u/:id/avatar` | 头像 |
| `GET` | `/api/calendar?month=YYYY-MM` | 日历统计 |
| `PATCH` | `/api/me/profile` `/api/me/settings` | 资料 / 记录卡片主题色 `{cardTheme}`（`''`、`white`、`avatar`、预设 id、`#rrggbb`） |
| `POST` | `/api/share/links` | 生成一条限时分享链接 `{scope, day?, month?, hours?}` → `{link}` |
| `GET` `DELETE` | `/api/share/links` `/api/share/links/:token` | 我生成的链接列表 / 撤销某条 |
| `GET` | `/api/me/export` | 导出全部数据 |
| `GET` | `/api/s/:token` `/api/s/:token/posts` | 访客读取限时分享（无需登录；范围由链接决定，URL 参数会被忽略） |
| `GET` | `/api/u/:name/timeline/posts` | 应用内好友时间线（需登录 + 好友关系；支持 `date`/`from`+`to`） |
| `GET` | `/api/qr?data=...` | 二维码 SVG |
| `GET` | `/api/health` | 健康检查 |

上传接口的字段约定：`media`（附件）、`poster`（视频封面）、`post`（JSON 字符串，含 `body`/`createdAt`/`mediaMeta` 等）。

## 设计取舍

- **零依赖**：只用了 Node 标准库（`node:sqlite`、`node:http`、`node:crypto`），
  上传解析器是自己写的流式实现，因此不需要 `npm install`，也不会有依赖供应链风险。
- **前端不用框架**：原生 ES Module + DOM，没有构建步骤，改完刷新即可，手机上也更轻。
- **时区安全**：每条记录都带客户端时区，服务器按「你所在时区的那一天」归组，跨时区旅行时日期不会错位。
