import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { ConfigService } from '@nestjs/config';
import { parse as parseDotenv } from 'dotenv';
import type {
  DopplerRuntimeSyncResult,
  DopplerWebhookPayload,
} from '../../domain/entities/doppler-runtime-sync.types';

const execFileAsync = promisify(execFile);

/** Writable in container; `/deploy/` is only a bind-mounted file, not a directory. */
export const DOPPLER_RUNTIME_ENV_SYNC_TMP = '/tmp/.env.sync.tmp';
export const DOPPLER_RUNTIME_COMPOSE_SIDECAR_IMAGE = 'docker:29-cli';

@Injectable()
export class DopplerRuntimeSyncService {
  private readonly logger = new Logger(DopplerRuntimeSyncService.name);
  private syncInFlight = false;
  private lastSyncStartedAt = 0;

  constructor(private readonly configService: ConfigService) {}

  scheduleSync(payload?: DopplerWebhookPayload): DopplerRuntimeSyncResult {
    if (!this.isEnabled()) {
      return {
        accepted: false,
        skipped: true,
        reason: 'runtime_sync_disabled',
      };
    }

    const skip = this.shouldSkipPayload(payload);
    if (skip) {
      return { accepted: false, skipped: true, reason: skip };
    }

    const debounceSeconds = this.readDebounceSeconds();
    const now = Date.now();
    if (
      this.syncInFlight ||
      now - this.lastSyncStartedAt < debounceSeconds * 1000
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
    if (!payload) {
      return null;
    }

    const expectedProject =
      this.configService.get<string>('DOPPLER_PROJECT')?.trim() ??
      'messenger-bot';
    const expectedConfig =
      this.configService.get<string>('DOPPLER_CONFIG')?.trim() ?? 'prd';

    const projectName = this.readName(payload.project);
    const configName = this.readName(payload.config);

    if (projectName && projectName !== expectedProject) {
      return 'project_mismatch';
    }

    if (configName && configName !== expectedConfig) {
      return 'config_mismatch';
    }

    return null;
  }

  private readName(value?: { name?: string } | string): string | undefined {
    if (typeof value === 'string') {
      return value.trim() || undefined;
    }

    return value?.name?.trim() || undefined;
  }

  private readDebounceSeconds(): number {
    const raw = Number(
      this.configService.get<string>('DOPPLER_RUNTIME_SYNC_DEBOUNCE_SECONDS') ??
        60,
    );

    if (!Number.isFinite(raw) || raw < 0) {
      return 60;
    }

    return raw;
  }

  private async resolveContainerName(): Promise<string> {
    const configured = this.configService
      .get<string>('DEPLOY_CONTAINER_NAME')
      ?.trim();
    if (configured) {
      return configured;
    }

    // The container is renamed to ${APP_NAME}-old after each deploy, so a
    // hardcoded name goes stale. Resolve the real name via docker.sock:
    // inside the container, hostname = container ID.
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['inspect', os.hostname(), '--format', '{{.Name}}'],
        { cwd: '/tmp' },
      );
      const name = stdout.trim().replace(/^\//, '');
      if (name) {
        return name;
      }
    } catch {
      // docker.sock unavailable — fall back to default below
    }
    return 'messenger-bot';
  }

  private async runSync(): Promise<void> {
    const envFile = this.requireConfig('DEPLOY_ENV_FILE');
    const composeFile = this.requireConfig('DEPLOY_COMPOSE_FILE');
    const containerName = await this.resolveContainerName();
    const project =
      this.configService.get<string>('DOPPLER_PROJECT')?.trim() ??
      'messenger-bot';
    const config =
      this.configService.get<string>('DOPPLER_CONFIG')?.trim() ?? 'prd';
    const token = this.requireConfig('DOPPLER_RUNTIME_TOKEN');

    this.logger.log(
      `DOPPLER_RUNTIME_SYNC start project=${project} config=${config}`,
    );

    try {
      const hostCompose = await this.resolveHostComposeContext(
        containerName,
        envFile,
        composeFile,
      );

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

      const mergedEnv = await this.mergeDeployRuntimeVars(
        stdout,
        hostCompose.deployDir,
      );
      await this.writeEnvAtomically(envFile, mergedEnv);

      const { stdout: imageRaw } = await execFileAsync(
        'docker',
        ['inspect', containerName, '--format', '{{.Config.Image}}'],
        { cwd: '/tmp' },
      );
      const image = imageRaw.trim();
      if (!image) {
        throw new Error(`empty image from docker inspect ${containerName}`);
      }

      await this.recreateContainer(containerName, image, hostCompose);

      this.logger.log(
        `DOPPLER_RUNTIME_SYNC complete image=${image} env=${envFile}`,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`DOPPLER_RUNTIME_SYNC failed: ${message}`);
    }
  }

  private async recreateContainer(
    containerName: string,
    image: string,
    hostCompose: { deployDir: string },
  ): Promise<void> {
    // docker compose up -d <service> does NOT work here: the running
    // container was created by the zero-downtime deploy script (name
    // <app>-old, toggled port), not by compose — compose would recreate a
    // brand-new <app> container on the default port and collide.
    // Instead, clone the current container's config (name, port, mounts,
    // groups, resources, env) via the recreate-container.sh script in the
    // deploy dir, which the sidecar mounts along with docker.sock.
    await execFileAsync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-v',
        `${hostCompose.deployDir}:${hostCompose.deployDir}`,
        '-w',
        hostCompose.deployDir,
        '-e',
        `RECREATE_NAME=${containerName}`,
        '-e',
        `RECREATE_IMAGE=${image}`,
        DOPPLER_RUNTIME_COMPOSE_SIDECAR_IMAGE,
        'sh',
        '-c',
        'apk add --no-cache bash >/dev/null 2>&1; bash recreate-container.sh "$RECREATE_NAME" "$RECREATE_IMAGE"',
      ],
      {
        cwd: '/tmp',
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  }

  private async mergeDeployRuntimeVars(
    content: string,
    hostDeployDir: string,
  ): Promise<string> {
    const entries = new Map<string, string>(
      Object.entries(parseDotenv(content)),
    );

    entries.set('DOPPLER_RUNTIME_SYNC_ENABLED', 'true');
    entries.set('DEPLOY_DIR', '/deploy');
    entries.set('DEPLOY_HOST_DIR', hostDeployDir);
    entries.set('DEPLOY_ENV_FILE', '/deploy/.env');
    entries.set('DEPLOY_COMPOSE_FILE', '/deploy/docker-compose.prod.yml');
    entries.set(
      'DEPLOY_UID',
      String((process.getuid?.() ?? Number(entries.get('DEPLOY_UID'))) || 0),
    );
    entries.set(
      'DEPLOY_GID',
      String((process.getgid?.() ?? Number(entries.get('DEPLOY_GID'))) || 0),
    );
    entries.set('DOCKER_GID', String(await this.readDockerSocketGid()));

    if (!entries.has('HOME')) {
      entries.set('HOME', '/tmp');
    }

    if (!entries.has('CHAT_RATE_LIMIT_ENABLED')) {
      entries.set('CHAT_RATE_LIMIT_ENABLED', 'true');
    }

    if (!entries.has('ENFORCE_PROD_CHAT_QUOTA')) {
      entries.set('ENFORCE_PROD_CHAT_QUOTA', 'true');
    }

    return serializeEnvLines(entries);
  }

  private async readDockerSocketGid(): Promise<number> {
    const { stdout } = await execFileAsync(
      'stat',
      ['-c', '%g', '/var/run/docker.sock'],
      { cwd: '/tmp' },
    );
    const gid = Number(stdout.trim());

    if (!Number.isFinite(gid)) {
      throw new Error('invalid DOCKER_GID from docker.sock');
    }

    return gid;
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

  private async resolveHostComposeContext(
    containerName: string,
    envFile: string,
    composeFile: string,
  ): Promise<{ deployDir: string; composeFile: string }> {
    const configuredHostDir = this.configService
      .get<string>('DEPLOY_HOST_DIR')
      ?.trim();
    if (configuredHostDir) {
      return {
        deployDir: configuredHostDir,
        composeFile: path.posix.join(
          configuredHostDir,
          'docker-compose.prod.yml',
        ),
      };
    }

    const { stdout } = await execFileAsync(
      'docker',
      [
        'inspect',
        containerName,
        '--format',
        '{{range .Mounts}}{{if eq .Destination "/deploy/.env"}}{{.Source}}{{end}}{{end}}',
      ],
      { cwd: '/tmp' },
    );
    const envSource = stdout.trim();
    if (envSource) {
      const deployDir = path.posix.dirname(envSource);
      return {
        deployDir,
        composeFile: path.posix.join(
          deployDir,
          path.posix.basename(composeFile),
        ),
      };
    }

    return {
      deployDir: path.posix.dirname(envFile),
      composeFile,
    };
  }

  private requireConfig(key: string): string {
    const value = this.configService.get<string>(key)?.trim();
    if (!value) {
      throw new ServiceUnavailableException(`${key} is not configured`);
    }

    return value;
  }
}

function serializeEnvLines(entries: Map<string, string>): string {
  const body = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  return `${body}\n`;
}
