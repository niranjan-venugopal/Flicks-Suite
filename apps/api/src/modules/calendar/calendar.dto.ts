import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { MEETING_PROVIDERS, type MeetingProvider } from '@flicks/shared/constants';

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

export class CalendarRangeDto {
  @ApiProperty({ example: '2026-09-01' })
  @IsString()
  @Matches(DATE_YMD, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-09-30' })
  @IsString()
  @Matches(DATE_YMD, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}

export class AttendeeInputDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;
}

/**
 * Round J — create an event / schedule a meeting. All-day events carry
 * `startDate`/`endDate` (inclusive YYYY-MM-DD); timed ones carry
 * `startAt`/`endAt` ISO instants. `attendees` is a nested array and MUST keep
 * `@Type(() => AttendeeInputDto)` — the global pipe's enableImplicitConversion
 * rewrites nested values otherwise (house rule 5).
 */
export class CreateCalendarEventDto {
  @ApiProperty({ enum: ['event', 'meeting'] })
  @IsIn(['event', 'meeting'])
  kind!: 'event' | 'meeting';

  @ApiProperty({ example: 'Sprint sync' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: 'Board room' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  location?: string;

  @ApiProperty({ default: false })
  @IsBoolean()
  allDay!: boolean;

  @ApiPropertyOptional({ example: '2026-09-15', description: 'All-day only (inclusive)' })
  @ValidateIf((o: CreateCalendarEventDto) => o.allDay === true)
  @IsString()
  @Matches(DATE_YMD, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-09-15', description: 'All-day only (inclusive); defaults to startDate' })
  @ValidateIf((o: CreateCalendarEventDto) => o.allDay === true && o.endDate !== undefined)
  @IsString()
  @Matches(DATE_YMD, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;

  @ApiPropertyOptional({ example: '2026-09-15T04:30:00.000Z', description: 'Timed only' })
  @ValidateIf((o: CreateCalendarEventDto) => o.allDay !== true)
  @IsISO8601({ strict: true })
  startAt?: string;

  @ApiPropertyOptional({ example: '2026-09-15T05:00:00.000Z', description: 'Timed only' })
  @ValidateIf((o: CreateCalendarEventDto) => o.allDay !== true)
  @IsISO8601({ strict: true })
  endAt?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata', description: 'Authoring zone; defaults to the workspace zone' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ enum: ['private', 'company'], default: 'private' })
  @IsOptional()
  @IsIn(['private', 'company'])
  visibility?: 'private' | 'company';

  @ApiPropertyOptional({ enum: MEETING_PROVIDERS, default: 'none' })
  @IsOptional()
  @IsIn(MEETING_PROVIDERS as unknown as string[])
  meetingProvider?: MeetingProvider;

  @ApiPropertyOptional({ example: 'https://teams.microsoft.com/l/meetup-join/…' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  meetingUrl?: string;

  @ApiPropertyOptional({ example: '#3E7BFA' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a #rrggbb hex' })
  color?: string;

  @ApiPropertyOptional({ type: [AttendeeInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AttendeeInputDto)
  attendees?: AttendeeInputDto[];
}

export class UpdateCalendarEventDto extends PartialType(CreateCalendarEventDto) {}

export class RsvpDto {
  @ApiProperty({ enum: ['accepted', 'declined', 'tentative'] })
  @IsIn(['accepted', 'declined', 'tentative'])
  response!: 'accepted' | 'declined' | 'tentative';
}

export class CalendarPeopleQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}
