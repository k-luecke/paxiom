const { spawn } = require('child_process');

const child = spawn(process.execPath, ['sdk/signing-daemon.js'], {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', code => process.exit(code ?? 0));
