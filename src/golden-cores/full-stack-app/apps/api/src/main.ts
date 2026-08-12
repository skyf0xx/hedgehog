import { loadEnv } from 'config';
import { Logger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

const env = loadEnv();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // apps/web runs on its own origin in local dev (see the port comment
  // below), so the browser's fetches to this api are cross-origin by
  // default — enable CORS for that origin rather than rediscovering this
  // per project.
  app.enableCors({ origin: env.WEB_ORIGIN });
  // Every route lives under /api. apps/web's NEXT_PUBLIC_API_BASE_URL
  // (apps/web/.env.example) has to carry the same suffix or every request
  // from the browser lands one path segment short of a route that exists —
  // change one and change the other.
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
