export interface WebActivityWriterPort {
  recordActive(userId: number, activeAt?: string): Promise<void>;
}

export const WEB_ACTIVITY_WRITER = Symbol('WEB_ACTIVITY_WRITER');
