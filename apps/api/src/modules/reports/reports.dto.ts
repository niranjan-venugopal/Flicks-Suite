import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportRangeDto {
  @ApiPropertyOptional({ example: '2026-04-01', description: 'YYYY-MM-DD inclusive' })
  @IsString()
  @IsOptional()
  @Matches(DATE_RE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-05-12', description: 'YYYY-MM-DD inclusive' })
  @IsString()
  @IsOptional()
  @Matches(DATE_RE, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}
