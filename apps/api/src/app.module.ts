import {SearchController} from './resources/search.controller';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard, Public } from './auth/auth.guard';
import { ResourcesModule } from './resources/resources.module';
import { KnowledgeController, DocumentController } from './resources/resources.controller';
import { UploadController, VersionsController } from './resources/uploads.controller';
import { JobsController } from './resources/jobs.controller';
import { ResourceFilter } from './resources/resources.filter';
import type { HealthResponse } from '@zhiheng/contracts';

@Controller('health')
class HealthController {
  @Public()
  @Get('live')
  live(): HealthResponse {
    return { service: 'api', status: 'ok', timestamp: new Date().toISOString() };
  }
}

@Module({ imports: [ResourcesModule], controllers: [HealthController, AuthController, KnowledgeController, DocumentController, UploadController, VersionsController, JobsController, SearchController], providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ResourceFilter }] })
export class AppModule {}
