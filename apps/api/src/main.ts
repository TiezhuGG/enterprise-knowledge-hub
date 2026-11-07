import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { apiConfig } from '@zhiheng/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const config = apiConfig();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}
bootstrap().catch(() => {
  console.error('API startup failed; check configuration and port availability.');
  process.exitCode = 1;
});
