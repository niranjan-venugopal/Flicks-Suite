import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CalendarRangeDto {
  @ApiProperty({ example: '2026-05-01' })
  @IsString()
  @IsNotEmpty()
  from: string;

  @ApiProperty({ example: '2026-05-31' })
  @IsString()
  @IsNotEmpty()
  to: string;
}
