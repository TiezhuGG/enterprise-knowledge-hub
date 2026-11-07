import { Injectable, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException, ForbiddenException, HttpException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { authConfig, redisConfig } from '@zhiheng/config';
import type { SessionInfo } from '@zhiheng/contracts';
import { developmentIdentity } from './identity';

export const SESSION_COOKIE = 'zhiheng_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const equalSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
interface StoredSession { account: string; csrf: string; expires: number }

@Injectable()
export class AuthService implements OnModuleDestroy {
  readonly config = authConfig();
  private redis?: Redis;
  private connecting?: Promise<void>;
  private client() {
    if (!this.redis) {
      this.redis = new Redis({ ...redisConfig(), maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, commandTimeout: 3000 });
      this.redis.on('error', () => {}); // Never log URLs, cookies or credentials.
    }
    return this.redis;
  }
  private async store<T>(operation: (client: Redis) => Promise<T>): Promise<T> {
    const client = this.client();
    try {
      if (client.status === 'wait') this.connecting = client.connect();
      if (client.status === 'connecting' || client.status === 'connect') await this.connecting;
      return await operation(client);
    } catch { throw new ServiceUnavailableException('Identity service unavailable'); }
  }
  private key(token: string) { return `${this.config.prefix}session:${digest(token)}`; }
  async limit(ip: string) {
    const count = await this.store(client => client.eval(`local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n`, 1, `${this.config.prefix}login:${digest(ip)}`));
    if (Number(count) > 10) throw new HttpException('Too many login attempts', 429);
  }
  checkOrigin(origin: string | undefined) {
    if (origin !== this.config.origin) throw new ForbiddenException('Invalid request origin');
  }
  async login(account: string, secret: string, previous?: string) {
    const profile = developmentIdentity(account, this.config.disabledAccounts);
    if (!equalSecret(secret, this.config.secret) || !profile) throw new UnauthorizedException('Invalid development credentials');
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expires = Date.now() + this.config.ttl * 1000;
    await this.store(client => client.set(this.key(token), JSON.stringify({ account, csrf, expires }), 'EX', this.config.ttl));
    if (previous) await this.revoke(previous);
    return { token, session: { ...profile, expires_at: new Date(expires).toISOString(), csrf_token: csrf } satisfies SessionInfo };
  }
  async session(token?: string): Promise<SessionInfo | null> {
    if (!this.config.enabled || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const raw = await this.store(client => client.get(this.key(token)));
    if (!raw) return null;
    let stored: StoredSession;
    try { stored = JSON.parse(raw); } catch { return null; }
    if (!stored || typeof stored !== 'object' || typeof stored.account !== 'string' || typeof stored.csrf !== 'string' || !Number.isFinite(stored.expires) || stored.expires <= Date.now()) return null;
    const profile = developmentIdentity(stored.account, this.config.disabledAccounts);
    if (!profile) { await this.revoke(token); return null; }
    return { ...profile, expires_at: new Date(stored.expires).toISOString(), csrf_token: stored.csrf };
  }
  async revoke(token: string) { await this.store(client => client.del(this.key(token))); }
  onModuleDestroy() { this.redis?.disconnect(); }
}
