import type {
  CreateUserCalendarInput,
  UserCalendarRecord,
} from '@wispace/wispace-client';

export type { CreateUserCalendarInput, UserCalendarRecord };

export interface UserCalendarListResponse {
  data: UserCalendarRecord[];
  count: number;
}
