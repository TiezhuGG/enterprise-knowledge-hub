import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { apiConfig, redisConfig } from '../packages/config/dist/index.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('invalid port configuration fails before startup', () => {
  for (const value of ['', 'abc', '0', '65536', '3.5']) {
    assert.throws(() => apiConfig({ API_PORT: value }));
    assert.throws(() => redisConfig({ REDIS_PORT: value }));
  }
  assert.equal(apiConfig({}).host, '127.0.0.1');
});

test('API boots without storage, protects resource endpoints and restarts', { timeout: 20000 }, async () => {
  const port = await freePort();
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, ['apps/api/dist/main.js'], {
      env: { ...process.env, API_HOST: '127.0.0.1', API_PORT: String(port) },
      stdio: 'pipe',
    });
    const exited = once(child, 'exit');
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    try {
      let response;
      for (let retry = 0; retry < 80; retry++) {
        assert.equal(child.exitCode, null, logs);
        try { response = await fetch(`http://127.0.0.1:${port}/api/v1/health/live`); break; }
        catch { await delay(100); }
      }
      assert.ok(response, logs);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.service, 'api');
      assert.equal(body.status, 'ok');
      assert.ok(Number.isFinite(Date.parse(body.timestamp)));
      const missing = await fetch(`http://127.0.0.1:${port}/api/v1/knowledge-bases`);
      assert.equal(missing.status, 401);
    } finally {
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.ok(code === 0 || signal === 'SIGTERM', logs);
    }
  }
});
