export type ZaloWelcomeSource = 'linked' | 'organic';

export interface ZaloWelcomeRecordRepositoryPort {
  tryClaimWelcome(
    zaloUserId: string,
    windowMs: number,
    leaseMs: number,
  ): Promise<boolean>;
  markWelcomed(zaloUserId: string, source: ZaloWelcomeSource): Promise<void>;
}

export const ZALO_WELCOME_RECORD_REPOSITORY = Symbol(
  'ZALO_WELCOME_RECORD_REPOSITORY',
);
