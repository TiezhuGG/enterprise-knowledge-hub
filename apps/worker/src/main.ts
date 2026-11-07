import 'reflect-metadata';
import {LifecycleRuntime} from './lifecycle';
import {lifecyclePolicy} from '@zhiheng/resources';
import { Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { redisConfig } from '@zhiheng/config';
import { IngestionRuntime } from './ingestion';
import { DEVELOPMENT_JOB, DEVELOPMENT_QUEUE, type DevelopmentPing } from '@zhiheng/contracts';

@Injectable()
class WorkerRuntime implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<DevelopmentPing>;
  private ingestion?: IngestionRuntime;
  private lifecycle?:LifecycleRuntime;
  async onModuleInit() {
    const enabled=process.env.INGEST_ENABLED??(process.env.DATABASE_URL?'true':'false');
    if(!['true','false'].includes(enabled))throw new Error('Invalid INGEST_ENABLED');
    if(enabled==='true'){this.ingestion=new IngestionRuntime();await this.ingestion.start()}
    if(lifecyclePolicy().enabled){this.lifecycle=new LifecycleRuntime();await this.lifecycle.start()}
    if(process.env.NODE_ENV==='production'){if(!this.ingestion&&!this.lifecycle)throw new Error('No production worker configured');return}
    this.worker = new Worker<DevelopmentPing>(DEVELOPMENT_QUEUE, async job => {
      if (job.name !== DEVELOPMENT_JOB || typeof job.data?.nonce !== 'string') {
        throw new Error('Unsupported development job');
      }
      return { nonce: job.data.nonce };
    }, { connection: redisConfig(), concurrency: 1 });
    this.worker.on('error', () => console.error('Worker Redis connection error'));
    this.worker.on('failed', () => console.error('Development job failed'));
    await this.worker.waitUntilReady();
    console.log('Development worker ready');
  }
  async onModuleDestroy() { await this.lifecycle?.stop();await this.ingestion?.stop(); await this.worker?.close(); }
}
@Module({ providers: [WorkerRuntime] })
class WorkerModule {}

NestFactory.createApplicationContext(WorkerModule).then(app => {
  app.enableShutdownHooks();
}).catch(() => {
  console.error('Worker startup failed');
  process.exitCode = 1;
});
