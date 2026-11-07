import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard, Public } from './auth/auth.guard';
import type { HealthResponse } from '@zhiheng/contracts';

@Controller('health')
class HealthController {
  @Public()
  @Get('live')
  live(): HealthResponse {
    return { service: 'api', status: 'ok', timestamp: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController, AuthController], providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }] })
export class AppModule {}
