import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { IdentityContext, SessionInfo } from '@zhiheng/contracts';
import { AuthService, SESSION_COOKIE, equalSecret } from './auth.service';

export const Public = () => SetMetadata('public', true);
export interface AuthRequest extends Request {
  identity?: IdentityContext;
  authSession?: SessionInfo;
}
export function sessionToken(request: Request): string | undefined {
  const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim());
  const matches = cookies.filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  return matches[0]!.slice(SESSION_COOKIE.length + 1);
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const session = await this.auth.session(sessionToken(request));
    if (!session) throw new UnauthorizedException('Authentication required');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      this.auth.checkOrigin(request.headers.origin);
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !equalSecret(csrf, session.csrf_token)) throw new ForbiddenException('Invalid CSRF token');
    }
    // Only the verified server-side session supplies identity, never headers/body/query.
    request.identity = session.identity;
    request.authSession = session;
    return true;
  }
}
