import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('llm_usage_events')
@Index('idx_llm_usage_user_date', ['userId', 'usageDate'], {
  where: '"user_id" IS NOT NULL',
})
@Index(
  'idx_llm_usage_platform_external_date',
  ['platform', 'externalUserId', 'usageDate'],
  { where: '"external_user_id" IS NOT NULL' },
)
@Index('idx_llm_usage_feature_date', ['feature', 'usageDate'])
@Index('idx_llm_usage_platform_usage_date', ['platform', 'usageDate'])
export class LlmUsageEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({
    name: 'occurred_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  occurredAt: Date;

  @Column({ name: 'usage_date', type: 'date' })
  usageDate: string;

  @Column({ type: 'varchar', length: 32 })
  feature: string;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: string;

  @Column({
    name: 'external_user_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  externalUserId: string | null;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ type: 'varchar', length: 64 })
  model: string;

  @Column({ name: 'prompt_tokens', type: 'int', default: 0 })
  promptTokens: number;

  @Column({ name: 'completion_tokens', type: 'int', default: 0 })
  completionTokens: number;

  @Column({ name: 'total_tokens', type: 'int', default: 0 })
  totalTokens: number;

  /** Subset of promptTokens served from OpenAI's automatic prompt cache. */
  @Column({ name: 'cached_tokens', type: 'int', default: 0 })
  cachedTokens: number;

  @Column({
    name: 'openai_response_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  openaiResponseId: string | null;

  @Column({
    name: 'correlation_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  correlationId: string | null;

  @Column({ name: 'tool_round', type: 'smallint', nullable: true })
  toolRound: number | null;

  @Column({ type: 'varchar', length: 16, default: 'ok' })
  status: string;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({
    name: 'estimated_cost_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    nullable: true,
  })
  estimatedCostUsd: string | null;
}
