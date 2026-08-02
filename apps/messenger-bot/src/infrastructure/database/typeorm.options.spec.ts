import { getTypeOrmOptions } from './typeorm.options';

describe('getTypeOrmOptions', () => {
  it('verifies PostgreSQL certificates when TLS is enabled', () => {
    const options = getTypeOrmOptions(
      {
        DB_SSL: 'true',
        DB_SSL_CA: 'trusted-ca',
      },
      { includeUsers: false },
    );

    expect(options.ssl).toEqual({
      rejectUnauthorized: true,
      ca: 'trusted-ca',
    });
  });
});
