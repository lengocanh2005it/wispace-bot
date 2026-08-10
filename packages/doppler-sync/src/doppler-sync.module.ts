import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  DOPPLER_SYNC_PLATFORM_CONFIG,
  DopplerRuntimeSyncService,
} from './doppler-runtime-sync.service';

@Module({})
export class DopplerSyncModule {
  static forPlatform(platformName: string): DynamicModule {
    return {
      module: DopplerSyncModule,
      imports: [ConfigModule],
      providers: [
        {
          provide: DOPPLER_SYNC_PLATFORM_CONFIG,
          useValue: { platformName },
        },
        DopplerRuntimeSyncService,
      ],
      exports: [DopplerRuntimeSyncService],
    };
  }
}
