import {
  decryptAesGcm,
  encryptAesGcm,
  parseEncryptionKey,
} from '@wispace/bot-common/utils';
import type { ValueTransformer } from 'typeorm';

const KEY_ENV = 'ZALO_TOKEN_ENCRYPTION_KEY';

function getEncryptionKey(): Buffer {
  return parseEncryptionKey(process.env[KEY_ENV], KEY_ENV);
}

export function encryptOaToken(plaintext: string): string {
  return encryptAesGcm(plaintext, getEncryptionKey());
}

export function decryptOaToken(value: string): string {
  return decryptAesGcm(value, getEncryptionKey(), 'zalo_oa_tokens');
}

export const oaTokenColumnTransformer: ValueTransformer = {
  to: (value?: string | null) => (value ? encryptOaToken(value) : value),
  from: (value?: string | null) => (value ? decryptOaToken(value) : value),
};
