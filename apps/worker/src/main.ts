import 'reflect-metadata';
import { Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { redisConfig } from '@zhiheng/config';
import { DEVELOPMENT_JOB, DEVELOPMENT_QUEUE, type DevelopmentPing } from '@zhiheng/contracts';

@Injectable()
class WorkerRuntime implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<DevelopmentPing>;
  async onModuleInit() {
    // No business handlers or production ingestion are implemented in P1-01.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Development smoke worker cannot run in production');
    }
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
  async onModuleDestroy() { await this.worker?.close(); }
}
@Module({ providers: [WorkerRuntime] })
class WorkerModule {}

NestFactory.createApplicationContext(WorkerModule).then(app => {
  app.enableShutdownHooks();
}).catch(() => {
  console.error('Worker startup failed');
  process.exitCode = 1;
});
