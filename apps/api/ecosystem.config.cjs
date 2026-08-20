// pm2 配置：在服务器上运行 `pm2 start ecosystem.config.cjs` 即可
// 假定 cwd 为 /opt/pms-repair/apps/api，部署包只覆盖 dist + node_modules，.env 保留在服务器上维护
module.exports = {
  apps: [
    {
      name: 'pms-api',
      script: 'dist/main.js',
      cwd: '.',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--max-old-space-size=512',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '700M',
      autorestart: true,
      restart_delay: 3000,
      out_file: '/var/log/pms-api/out.log',
      error_file: '/var/log/pms-api/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
