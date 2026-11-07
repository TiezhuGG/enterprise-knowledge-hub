import { Body, Controller, Get, Post, Req, Res, HttpCode, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, SESSION_COOKIE, equalSecret } from './auth.service';
import { Public, sessionToken, type AuthRequest } from './auth.guard';

const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, path: '/api/v1', secure: false };
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public()
  @Post('dev-login')
  @HttpCode(200)
  async login(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    if (!this.auth.config.enabled) throw new NotFoundException();
    this.auth.checkOrigin(req.headers.origin);
    if (!req.is('application/json') || typeof body !== 'object' || body === null) throw new BadRequestException('JSON credentials required');
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['account', 'secret'].includes(key)) || typeof fields.account !== 'string' || typeof fields.secret !== 'string' || fields.secret.length > 1024) throw new BadRequestException('Invalid login fields');
    await this.auth.limit(req.socket.remoteAddress ?? 'unknown');
    const result = await this.auth.login(fields.account, fields.secret, sessionToken(req));
    res.cookie(SESSION_COOKIE, result.token, { ...cookieOptions, maxAge: this.auth.config.ttl * 1000 });
    console.log(JSON.stringify({ event: 'auth.login', actor_id: result.session.identity.actor_id, tenant_id: result.session.identity.tenant_id, request_id: res.getHeader('X-Request-Id') }));
    return { data: result.session };
  }
  @Get('session')
  session(@Req() req: AuthRequest) { return { data: req.authSession }; }
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    this.auth.checkOrigin(req.headers.origin);
    const token = sessionToken(req);
    const session = await this.auth.session(token);
    if (session) {
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !equalSecret(csrf, session.csrf_token)) throw new ForbiddenException('Invalid CSRF token');
      await this.auth.revoke(token!);
      console.log(JSON.stringify({ event: 'auth.logout', actor_id: session.identity.actor_id, tenant_id: session.identity.tenant_id, request_id: res.getHeader('X-Request-Id') }));
    }
    res.clearCookie(SESSION_COOKIE, cookieOptions);
  }
}
