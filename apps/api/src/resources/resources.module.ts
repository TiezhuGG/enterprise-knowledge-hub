import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { CorrectionStore, S3Objects, uploadLimits } from '@zhiheng/resources';

@Injectable()
export class Resources extends CorrectionStore implements OnModuleDestroy {
  constructor() { super(process.env.DATABASE_URL, process.env.DATABASE_SCHEMA,
    process.env.RESOURCE_CURSOR_SECRET || (['development','test'].includes(process.env.NODE_ENV??'') ? process.env.DEV_AUTH_SECRET : undefined), new S3Objects(process.env.S3_BUCKET??''), uploadLimits()); }
  async onModuleDestroy() { await this.close(); }
}
@Global()
@Module({ providers: [Resources], exports: [Resources] })
export class ResourcesModule {}
