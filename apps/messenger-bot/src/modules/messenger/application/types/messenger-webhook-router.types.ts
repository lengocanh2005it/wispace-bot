export interface RouterContext {
  isDuplicateMid?: boolean;
  isDuplicatePostback?: boolean;
  userId?: number;
  linkContext?: {
    ref: string;
    topic: string;
    cadence: string;
    userId: number;
  } | null;
  shouldEnforceRateLimit?: boolean;
}
