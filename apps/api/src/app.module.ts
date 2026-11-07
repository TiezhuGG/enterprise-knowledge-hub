import { Controller, Get, Module } from '@nestjs/common';
import type { HealthResponse } from '@zhiheng/contracts';

@Controller('health')
class HealthController {
  @Get('live')
  live(): HealthResponse {
    return { service: 'api', status: 'ok', timestamp: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
