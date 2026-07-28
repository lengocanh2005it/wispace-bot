import { Module } from '@nestjs/common';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';

@Module({
  providers: [InternalApiKeyGuard],
  exports: [InternalApiKeyGuard],
})
export class CommonModule {}
