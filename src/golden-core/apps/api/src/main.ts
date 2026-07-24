import { loadEnv } from 'config';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

loadEnv();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  // Defaults to 3333, not 3000 — `apps/web`'s `next dev` also defaults to
  // 3000, and both apps run side by side in local dev (see root `dev`
  // script), so the api needs a distinct default port to avoid colliding.
  const port = process.env.PORT || 3333;
  await app.listen(port);
  app
    .get(Logger)
    .log(`Application is running on: http://localhost:${port}/${globalPrefix}`);
}

bootstrap();
