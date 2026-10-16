/**
 * pm2 配置：pm2 start ecosystem.config.cjs
 *
 * 为什么要用这个文件，而不是 `pm2 start src/server.js`：
 *  1. pm2 是**守护进程**在跑应用，它只认「启动守护进程那一刻」的环境变量；
 *     你当前终端里临时 export 的 PORT / DAYLOG_* 不一定能传进应用，
 *     pm2 也**不会读 .env**（本项目只读 process.env，本来就没有 .env）。
 *     所以把这些值写在下面的 env 里最稳；改完执行 `pm2 restart daylog --update-env`。
 *  2. pm2 默认工作目录是「你敲 pm2 命令时所在的目录」，用 cwd 固定成项目根目录，
 *     免得换个目录敲命令就找不到模板/数据。
 *
 * 注意：
 *  - **必须单进程**：数据库是 node:sqlite（单文件），用 `-i 2` / cluster 起多实例
 *    会让多个进程同时写同一个库文件，迟早写坏。
 *  - 需要 Node ≥ 22.5（node:sqlite）。用 nvm 切换过 Node 版本后，
 *    pm2 的守护进程还是老版本，要 `pm2 kill` 再 `pm2 start`。
 */
const path = require('node:path');
const fs = require('node:fs');

/**
 * 可选：把**敏感配置**（比如企业微信机器人 key）放在项目根下的 `.env.secrets` 里，
 * 而不是写进这个文件 —— 这个文件是要进版本库/被拷来拷去的，密钥不该躺在这里。
 * 格式就是一行一个 KEY=VALUE，# 开头是注释；文件不存在就当作没配（功能自动关闭）。
 * 改完这个文件或 .env.secrets 之后要 `pm2 restart ecosystem.config.cjs --update-env` 才会生效。
 */
function loadSecrets(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch {
    /* 没这个文件就是没配密钥 */
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: 'daylog',
      script: 'src/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // 起来不到 10 秒就退出，算「起不来」，别无限重启刷日志
      min_uptime: '10s',
      env: {
        PORT: 81,
        HOST: '0.0.0.0',
        // 数据目录默认就是项目下的 data/（config.js 按项目根目录解析），
        // 想放到别处（比如移动硬盘）就打开下面这行：
        // DAYLOG_DATA_DIR: 'D:/daylog-data',
        DAYLOG_ALLOW_SIGNUP: '1',
        DAYLOG_TRUST_PROXY: '0',
        TZ: 'Asia/Shanghai',
        // 通知里链接用哪个地址（默认按请求的 Host 推，固定下来更稳）
        DAYLOG_PUBLIC_URL: 'http://106.55.38.48:81',
        // 敏感项从 .env.secrets 读（见上面的 loadSecrets）
        ...loadSecrets(path.join(__dirname, '.env.secrets')),
        NODE_ENV: 'production',
      },
    },
  ],
};
