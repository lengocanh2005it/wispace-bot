import { promises as fs } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import {
  DOPPLER_RUNTIME_ENV_SYNC_TMP,
  DopplerRuntimeSyncService,
} from './doppler-runtime-sync.service';

describe('DopplerRuntimeSyncService', () => {
  const createService = (values: Record<string, string | undefined>) => {
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return new DopplerRuntimeSyncService(config);
  };

  it('skips when runtime sync is disabled', () => {
    const service = createService({
      DOPPLER_RUNTIME_SYNC_ENABLED: 'false',
    });

    expect(service.scheduleSync()).toEqual({
      accepted: false,
      skipped: true,
      reason: 'runtime_sync_disabled',
    });
  });

  it('skips webhook for non-prd config', () => {
    const service = createService({
      DOPPLER_RUNTIME_SYNC_ENABLED: 'true',
      DOPPLER_PROJECT: 'messenger-bot',
      DOPPLER_CONFIG: 'prd',
    });

    expect(
      service.scheduleSync({
        project: 'messenger-bot',
        config: 'dev',
      }),
    ).toEqual({
      accepted: false,
      skipped: true,
      reason: 'config_mismatch',
    });
  });

  it('accepts prd webhook payload without running sync in unit test', () => {
    const setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockImplementation(() => 0 as unknown as NodeJS.Immediate);

    const service = createService({
      DOPPLER_RUNTIME_SYNC_ENABLED: 'true',
      DOPPLER_PROJECT: 'messenger-bot',
      DOPPLER_CONFIG: 'prd',
      DEPLOY_DIR: '/deploy',
      DEPLOY_ENV_FILE: '/deploy/.env',
      DEPLOY_COMPOSE_FILE: '/deploy/docker-compose.prod.yml',
      DOPPLER_RUNTIME_TOKEN: 'dp.st.prd.test',
      DOPPLER_RUNTIME_SYNC_DEBOUNCE_SECONDS: '60',
    });

    const result = service.scheduleSync({
      project: { name: 'messenger-bot' },
      config: { name: 'prd' },
      type: 'secrets.update',
    });

    expect(result).toEqual({ accepted: true });
    setImmediateSpy.mockRestore();
  });

  it('writes env via /tmp then copyFile to bind-mounted deploy path', async () => {
    const writeFile = jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const copyFile = jest.spyOn(fs, 'copyFile').mockResolvedValue(undefined);
    const chmod = jest.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    const unlink = jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

    const service = createService({});
    await (
      service as unknown as {
        writeEnvAtomically: (envFile: string, content: string) => Promise<void>;
      }
    ).writeEnvAtomically('/deploy/.env', 'PORT=5007\n');

    expect(writeFile).toHaveBeenCalledWith(
      DOPPLER_RUNTIME_ENV_SYNC_TMP,
      'PORT=5007\n',
      { mode: 0o600 },
    );
    expect(copyFile).toHaveBeenCalledWith(
      DOPPLER_RUNTIME_ENV_SYNC_TMP,
      '/deploy/.env',
    );
    expect(chmod).toHaveBeenCalledWith('/deploy/.env', 0o600);
    expect(unlink).toHaveBeenCalledWith(DOPPLER_RUNTIME_ENV_SYNC_TMP);

    writeFile.mockRestore();
    copyFile.mockRestore();
    chmod.mockRestore();
    unlink.mockRestore();
  });

  it('merges safe runtime defaults after Doppler download', () => {
    const service = createService({});
    const instance = service as unknown as {
      mergeEnv: (content: string) => string;
    };

    const merged = instance.mergeEnv('FOO=bar\n');

    expect(merged).toContain('FOO=bar');
    expect(merged).toContain('DOPPLER_RUNTIME_SYNC_ENABLED=false');
    expect(merged).not.toContain('DOCKER_GID');
    expect(merged).not.toContain('DEPLOY_HOST_DIR');
  });
});
