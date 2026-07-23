import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './health.controller';

@Module({
  imports: [LoggerModule.forRoot()],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
