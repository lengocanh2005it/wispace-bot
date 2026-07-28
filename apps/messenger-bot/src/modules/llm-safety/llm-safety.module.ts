import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmSafetyEventEntity } from '@wispace/chat-metering';
import { LlmSafetyService } from './llm-safety.service';

@Module({
  imports: [TypeOrmModule.forFeature([LlmSafetyEventEntity])],
  providers: [LlmSafetyService],
  exports: [LlmSafetyService],
})
export class LlmSafetyModule {}
