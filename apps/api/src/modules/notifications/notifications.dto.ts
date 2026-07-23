import { IsBoolean, IsIn, IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationChannel,
} from './notifications.service';

export class UpdateNotificationPreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_EVENTS })
  @IsIn(NOTIFICATION_EVENTS as unknown as string[])
  event: NotificationEvent;

  @ApiProperty({ enum: ['in_app', 'email'] })
  @IsIn(['in_app', 'email'])
  channel: NotificationChannel;

  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}

export class UpdateEmailDigestDto {
  @ApiProperty({ enum: ['urgent', 'hourly', 'daily'] })
  @IsIn(['urgent', 'hourly', 'daily'])
  frequency: 'urgent' | 'hourly' | 'daily';
}

export class SnoozeNotificationDto {
  @ApiProperty({ description: 'Future ISO timestamp to hide the row until' })
  @IsISO8601()
  until: string;
}
