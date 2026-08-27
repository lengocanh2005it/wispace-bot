import { ConfigService } from '@nestjs/config';
import { DiscordOauthStateEntity } from './entities/discord-oauth-state.entity';
import { buildTypeOrmOptions } from './database.module';

describe('Discord DatabaseModule', () => {
  it('registers OAuth state entity with TypeORM', () => {
    const config = new ConfigService({
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_USER: 'test',
      DB_PASSWORD: 'test',
      DB_NAME: 'test',
    });

    const options = buildTypeOrmOptions(config);

    expect(options.entities).toContain(DiscordOauthStateEntity);
  });
});
