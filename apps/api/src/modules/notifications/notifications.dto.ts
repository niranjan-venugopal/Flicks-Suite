import { IsBoolean, IsIn } from 'class-validator';
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
