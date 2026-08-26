import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { ConfigService } from '@nestjs/config';
import { parse as parseDotenv } from 'dotenv';
import type {
  DopplerRuntimeSyncResult,
  DopplerWebhookPayload,
} from './doppler-runtime-sync.types';

const execFileAsync = promisify(execFile);

/** Kept only for compatibility with existing bind-mounted deployments. */
export const DOPPLER_RUNTIME_ENV_SYNC_TMP = '/tmp/.env.sync.tmp';
export const DOPPLER_SYNC_PLATFORM_CONFIG = 'DOPPLER_SYNC_PLATFORM_CONFIG';

export interface DopplerSyncPlatformConfig {
  platformName: string;
}

@Injectable()
export class DopplerRuntimeSyncService {
  private readonly logger = new Logger(DopplerRuntimeSyncService.name);
  private syncInFlight = false;
  private lastSyncStartedAt = 0;

  constructor(
    private readonly configService: ConfigService,
    @Inject(DOPPLER_SYNC_PLATFORM_CONFIG)
    private readonly platformConfig: DopplerSyncPlatformConfig,
  ) {}

  scheduleSync(payload?: DopplerWebhookPayload): DopplerRuntimeSyncResult {
    if (!this.isEnabled()) {
      return {
        accepted: false,
        skipped: true,
        reason: 'runtime_sync_disabled',
      };
    }

    const skip = this.shouldSkipPayload(payload);
    if (skip) return { accepted: false, skipped: true, reason: skip };

    const now = Date.now();
    if (
      this.syncInFlight ||
      now - this.lastSyncStartedAt < this.readDebounceSeconds() * 1000
    ) {
      return { accepted: true, reason: 'debounced_or_in_flight' };
    }

    this.lastSyncStartedAt = now;
    this.syncInFlight = true;
    setImmediate(() => {
      void this.runSync().finally(() => {
        this.syncInFlight = false;
      });
    });

    return { accepted: true };
  }

  private isEnabled(): boolean {
    return (
      this.configService.get<string>('DOPPLER_RUNTIME_SYNC_ENABLED') === 'true'
    );
  }

  private shouldSkipPayload(payload?: DopplerWebhookPayload): string | null {
    if (!payload) return null;

    const project = this.readName(payload.project);
    const config = this.readName(payload.config);
    const expectedProject =
      this.configService.get<string>('DOPPLER_PROJECT')?.trim() ??
      this.platformConfig.platformName;
    const expectedConfig =
      this.configService.get<string>('DOPPLER_CONFIG')?.trim() ?? 'prd';

    if (project && project !== expectedProject) return 'project_mismatch';
    if (config && config !== expectedConfig) return 'config_mismatch';
    return null;
  }

  private readName(value?: { name?: string } | string): string | undefined {
    if (typeof value === 'string') return value.trim() || undefined;
    return value?.name?.trim() || undefined;
  }

  private readDebounceSeconds(): number {
    const value = Number(
      this.configService.get<string>('DOPPLER_RUNTIME_SYNC_DEBOUNCE_SECONDS') ??
        60,
    );
    return Number.isFinite(value) && value >= 0 ? value : 60;
  }

  private async runSync(): Promise<void> {
    const envFile = this.requireConfig('DEPLOY_ENV_FILE');
    const project =
      this.configService.get<string>('DOPPLER_PROJECT')?.trim() ??
      this.platformConfig.platformName;
    const config =
      this.configService.get<string>('DOPPLER_CONFIG')?.trim() ?? 'prd';
    const token = this.requireConfig('DOPPLER_RUNTIME_TOKEN');

    this.logger.log(
      `DOPPLER_RUNTIME_SYNC start project=${project} config=${config}`,
    );

    try {
      const { stdout } = await execFileAsync(
        'doppler',
        [
          'secrets',
          'download',
          '--no-file',
          '--format',
          'env',
          '-p',
          project,
          '-c',
          config,
        ],
        {
          env: {
            ...process.env,
            DOPPLER_TOKEN: token,
            HOME: '/tmp',
            DOPPLER_CONFIG_DIR: '/tmp/.doppler',
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      await this.writeEnvAtomically(envFile, this.mergeEnv(stdout));
      this.logger.log(
        `DOPPLER_RUNTIME_SYNC complete env=${envFile}; restart required`,
      );
    } catch (error) {
      this.logger.error(`DOPPLER_RUNTIME_SYNC failed: ${errorMessage(error)}`);
    }
  }

  private mergeEnv(content: string): string {
    const entries = new Map<string, string>(
      Object.entries(parseDotenv(content)),
    );
    entries.set('DOPPLER_RUNTIME_SYNC_ENABLED', 'false');
    if (!entries.has('HOME')) entries.set('HOME', '/tmp');
    if (!entries.has('CHAT_RATE_LIMIT_ENABLED')) {
      entries.set('CHAT_RATE_LIMIT_ENABLED', 'true');
    }
    if (!entries.has('ENFORCE_PROD_CHAT_QUOTA')) {
      entries.set('ENFORCE_PROD_CHAT_QUOTA', 'true');
    }
    return serializeEnvLines(entries);
  }

  private async writeEnvAtomically(
    envFile: string,
    content: string,
  ): Promise<void> {
    await fs.writeFile(DOPPLER_RUNTIME_ENV_SYNC_TMP, content, { mode: 0o600 });
    try {
      await fs.copyFile(DOPPLER_RUNTIME_ENV_SYNC_TMP, envFile);
      await fs.chmod(envFile, 0o600);
    } finally {
      await fs.unlink(DOPPLER_RUNTIME_ENV_SYNC_TMP).catch(() => undefined);
    }
  }

  private requireConfig(key: string): string {
    const value = this.configService.get<string>(key)?.trim();
    if (!value)
      throw new ServiceUnavailableException(`${key} is not configured`);
    return value;
  }
}

function serializeEnvLines(entries: Map<string, string>): string {
  return `${[...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}
