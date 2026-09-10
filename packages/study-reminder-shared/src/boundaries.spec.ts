import * as adapters from './adapters';
import * as core from './core';

describe('study-reminder-shared package boundaries', () => {
  it('keeps scheduling contracts/policy in core and Nest/TypeORM wiring in adapters', () => {
    expect(core.computeRemindAt).toBeDefined();
    expect(core.studyReminderDispatchPredicateSql).toBeDefined();
    expect(core.MESSAGE_SENDER).toBeDefined();
    expect(core.StudyReminderScheduleService).toBeUndefined();
    expect(core.StudyReminderJobEntity).toBeUndefined();

    expect(adapters.StudyReminderScheduleService).toBeDefined();
    expect(adapters.StudyReminderJobEntity).toBeDefined();
    expect(adapters.TypeormStudyReminderJobRepository).toBeDefined();
    expect(adapters.createStudyReminderProviders).toBeDefined();
  });
});
