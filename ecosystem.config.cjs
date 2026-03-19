const path = require('path')

const ROOT = __dirname
const LOGS = path.resolve(ROOT, 'logs')

module.exports = {
  apps: [
    {
      name: 'auroracraft-server',
      cwd: ROOT,
      script: 'node_modules/.bin/tsx',
      args: 'server/src/index.ts',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      wait_ready: false,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.resolve(LOGS, 'server-error.log'),
      out_file: path.resolve(LOGS, 'server-out.log'),
      merge_logs: true,
    },
    {
      name: 'auroracraft-client',
      cwd: path.resolve(ROOT, 'client'),
      script: 'node_modules/.bin/vite',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.resolve(LOGS, 'client-error.log'),
      out_file: path.resolve(LOGS, 'client-out.log'),
      merge_logs: true,
    },
    {
      name: 'auroracraft-opencode',
      cwd: ROOT,
      script: 'opencode',
      args: 'serve',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.resolve(LOGS, 'opencode-error.log'),
      out_file: path.resolve(LOGS, 'opencode-out.log'),
      merge_logs: true,
    },
  ],
}
