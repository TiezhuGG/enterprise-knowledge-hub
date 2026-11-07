import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Redis } = require('ioredis');
const { redisConfig, authConfig } = require('@zhiheng/config');
const prefix = `test:${randomUUID()}:`;
const secret = randomBytes(32).toString('hex');
const origin = 'http://127.0.0.1:5173';
const redis = new Redis({ ...redisConfig(), maxRetriesPerRequest: 1 });
redis.on('error', () => {});
let logs = '';
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function start(extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/api/dist/main.js'], { env: {
    ...process.env, API_PORT: String(port), API_HOST: '127.0.0.1', NODE_ENV: 'test',
    DEV_AUTH_ENABLED: 'true', DEV_AUTH_SECRET: secret, AUTH_ORIGIN: origin,
    AUTH_REDIS_PREFIX: prefix, SESSION_TTL_SECONDS: '3600', DEV_DISABLED_ACCOUNTS: '', ...extra,
  }, stdio: 'pipe' });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const exited = once(child, 'exit');
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('API exited unexpectedly');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health/live`);
      if (response.ok) return {
        async request(path, options = {}) { return fetch(`http://127.0.0.1:${port}/api/v1${path}`, { ...options, signal: AbortSignal.timeout(8000) }); },
        async stop() { child.kill('SIGTERM'); await exited; },
      };
    } catch {}
    await delay(100);
  }
  child.kill('SIGTERM'); throw new Error('API startup timeout');
}
async function login(api, account = 'employee', options = {}) {
  return api.request('/auth/dev-login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ account, secret }), ...options });
}
async function identity(api, cookie, extraHeaders = {}, path = '/auth/session') {
  return api.request(path, { headers: { Cookie: cookie, ...extraHeaders } });
}
const cookieFrom = response => response.headers.get('set-cookie').split(';')[0];

test('authentication configuration defaults closed and rejects production development login', () => {
  assert.equal(authConfig({}).enabled, false);
  assert.throws(() => authConfig({ NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true', DEV_AUTH_SECRET: secret }));
  assert.throws(() => authConfig({ NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true', DEV_AUTH_SECRET: 'short' }));
});

test('real HTTP + Redis identity lifecycle and negative cases', { timeout: 45000 }, async t => {
  let api;
  try {
    await redis.ping();
    api = await start();
    await t.test('untrusted identity, login origin and invalid credentials are rejected', async () => {
      assert.equal((await identity(api, '', { Authorization: 'Bearer forged', 'X-Tenant-Id': 'forged', 'X-User-Id': 'admin' })).status, 401);
      assert.equal((await identity(api, 'zhiheng_session=forged')).status, 401);
      assert.equal((await login(api, 'employee', { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } })).status, 403);
      assert.equal((await login(api, 'employee', { body: JSON.stringify({ account: 'employee', secret: 'invalid' }) })).status, 401);
      assert.equal((await login(api, 'missing')).status, 401);
      assert.equal((await login(api, 'employee', { body: JSON.stringify({ account: 'employee', secret, tenant_id: 'forged' }) })).status, 400);
    });
    const response = await login(api);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    assert.match(response.headers.get('set-cookie'), /Path=\/api\/v1/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-request-id'));
    let cookie = cookieFrom(response);
    let session = (await response.json()).data;
    assert.ok(!JSON.stringify(session).includes(cookie.split('=')[1]));
    await t.test('tenant/header/body changes cannot replace trusted identity', async () => {
      const changed = await identity(api, cookie, { 'X-Tenant-Id': 'forged', 'X-User-Id': 'admin' }, '/auth/session?tenant_id=forged&role=admin');
      assert.deepEqual((await changed.json()).data.identity, session.identity);
      const other = await login(api, 'other');
      assert.notEqual((await other.json()).data.identity.tenant_id, session.identity.tenant_id);
    });
    await t.test('session survives API restart; relogin rotates and revokes old cookie', async () => {
      await api.stop(); api = await start();
      assert.equal((await identity(api, cookie)).status, 200);
      const renewed = await login(api, 'employee', { headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } });
      assert.equal(renewed.status, 200);
      assert.equal((await identity(api, cookie)).status, 401);
      cookie = cookieFrom(renewed); session = (await renewed.json()).data;
    });
    await t.test('logout enforces origin and CSRF, revokes immediately and is idempotent', async () => {
      const action = headers => api.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, ...headers } });
      assert.equal((await action({})).status, 403);
      assert.equal((await action({ 'X-CSRF-Token': 'wrong' })).status, 403);
      assert.equal((await action({ Origin: 'https://evil.example', 'X-CSRF-Token': session.csrf_token })).status, 403);
      assert.equal((await identity(api, cookie)).status, 200);
      assert.equal((await action({ 'X-CSRF-Token': session.csrf_token })).status, 204);
      assert.equal((await identity(api, cookie)).status, 401);
      assert.equal((await action({ 'X-CSRF-Token': session.csrf_token })).status, 204);
    });
    await t.test('disabled membership invalidates an existing session', async () => {
      const response = await login(api); const cookie = cookieFrom(response);
      await api.stop(); api = await start({ DEV_DISABLED_ACCOUNTS: 'employee' });
      assert.equal((await identity(api, cookie)).status, 401);
      assert.equal((await login(api)).status, 401);
    });
    await t.test('server expiry rejects a previously valid cookie', async () => {
      await api.stop(); api = await start({ SESSION_TTL_SECONDS: '1' });
      const response = await login(api); assert.equal(response.status, 200);
      const cookie = cookieFrom(response);
      assert.equal((await identity(api, cookie)).status, 200);
      await delay(1100);
      assert.equal((await identity(api, cookie)).status, 401);
    });
    await t.test('corrupt server session is rejected without trusting its payload', async () => {
      const token = randomBytes(32).toString('base64url');
      const hash = createHash('sha256').update(token).digest('hex');
      await redis.set(`${prefix}session:${hash}`, 'null', 'EX', 10);
      assert.equal((await identity(api, `zhiheng_session=${token}`)).status, 401);
    });
    await t.test('login attempts have a Redis-backed bound', async () => {
      const ipHash = createHash('sha256').update('127.0.0.1').digest('hex');
      await redis.set(`${prefix}login:${ipHash}`, '10', 'EX', 60);
      assert.equal((await login(api)).status, 429);
    });
    await t.test('disabled development entry and unavailable Redis fail closed', async () => {
      await api.stop(); api = await start({ DEV_AUTH_ENABLED: 'false' });
      assert.equal((await login(api)).status, 404);
      assert.equal((await identity(api, cookie)).status, 401);
      await api.stop(); api = await start({ REDIS_PORT: String(await freePort()) });
      assert.equal((await login(api)).status, 503);
      assert.equal((await identity(api, 'zhiheng_session=' + 'a'.repeat(43))).status, 503);
    });
    assert.ok(logs.includes('"event":"auth.login"'));
    assert.ok(logs.includes('"event":"auth.logout"'));
    for (const sensitive of [secret, session.csrf_token, cookie.split('=')[1]]) assert.ok(!logs.includes(sensitive));
  } finally {
    await api?.stop();
    try {
      if (redis.status === 'ready') {
        const keys = await redis.keys(`${prefix}*`); // Only this test's random namespace.
        if (keys.length) await redis.del(...keys);
      }
    } finally { redis.disconnect(); }
  }
});

test('global guard protects future write routes and overwrites untrusted context', async () => {
  const { AuthGuard } = require('./dist/auth/auth.guard.js');
  const trusted = { actor_id: 'server-user', tenant_id: 'server-tenant' };
  const auth = {
    async session() { return { identity: trusted, csrf_token: 'valid-csrf' }; },
    checkOrigin(value) { if (value !== origin) throw new Error('bad origin'); },
  };
  const guard = new AuthGuard(auth, { getAllAndOverride() { return false; } });
  const request = { method: 'POST', headers: { cookie: 'zhiheng_session=token', origin }, identity: { actor_id: 'admin' } };
  const context = { getHandler() {}, getClass() {}, switchToHttp() { return { getRequest() { return request; } }; } };
  await assert.rejects(() => guard.canActivate(context));
  request.headers['x-csrf-token'] = 'valid-csrf';
  assert.equal(await guard.canActivate(context), true);
  assert.equal(request.identity, trusted);
});
