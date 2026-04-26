const { spawn } = require('child_process');

const child = spawn(process.execPath, ['ui/server.js'], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', code => process.exit(code ?? 0));
