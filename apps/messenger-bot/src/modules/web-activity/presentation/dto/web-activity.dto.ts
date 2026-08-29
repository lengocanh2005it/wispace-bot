import { IsInt, IsISO8601, IsOptional, IsPositive } from 'class-validator';

export class RecordWebActivityBody {
  @IsInt()
  @IsPositive()
  userId!: number;

  @IsOptional()
  @IsISO8601()
  activeAt?: string;
}
