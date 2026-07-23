import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import {
  UpdateNotificationPreferenceDto,
  UpdateEmailDigestDto,
  SnoozeNotificationDto,
} from './notifications.dto';
import { BadRequestException } from '@nestjs/common';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('unread')
  @ApiOperation({ summary: 'Get unread notifications (bell popover)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Unread notifications + total count',
  })
  async getUnread(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? Number(limit) : 10;
    return this.notificationsService.getUnread(user.sub, parsed);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get my notification preference matrix (PRD §9.3)' })
  @ApiResponse({ status: 200, description: 'Per-event in-app + email toggles' })
  async getPreferences(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.getPreferences(user.sub);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update one notification preference toggle' })
  @ApiResponse({ status: 200, description: 'Updated preference' })
  async setPreference(
    @Body() dto: UpdateNotificationPreferenceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.notificationsService.setPreference(
      user.sub,
      dto.event,
      dto.channel,
      dto.enabled,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List notifications (paginated, /notifications page)' })
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'unread'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  async listAll(
    @CurrentUser() user: JwtPayload,
    @Query('filter') filter?: 'all' | 'unread',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.notificationsService.listAll(user.sub, {
      filter: filter === 'unread' ? 'unread' : 'all',
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @Get('inbox')
  @ApiOperation({ summary: 'Inbox view: active + snoozed rows (PRD v6 §11/P9)' })
  @ApiQuery({ name: 'scope', required: false, enum: ['pm', 'all'] })
  async getInbox(
    @CurrentUser() user: JwtPayload,
    @Query('scope') scope?: 'pm' | 'all',
  ) {
    return this.notificationsService.getInbox(user.sub, {
      scope: scope === 'pm' ? 'pm' : 'all',
    });
  }

  @Put('preferences/email-digest')
  @ApiOperation({ summary: 'Set email digest cadence (urgent | hourly | daily)' })
  async setEmailDigest(
    @Body() dto: UpdateEmailDigestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.notificationsService.setEmailDigestFreq(user.sub, dto.frequency);
    return { emailDigest: dto.frequency };
  }

  @Patch(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a notification (E in the Inbox)' })
  @ApiResponse({ status: 204, description: 'Archived' })
  async archive(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.notificationsService.archive(id, user.sub);
  }

  @Patch(':id/snooze')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Snooze a notification until a future instant (Z)' })
  @ApiResponse({ status: 204, description: 'Snoozed' })
  async snooze(
    @Param('id') id: string,
    @Body() dto: SnoozeNotificationDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    const until = new Date(dto.until);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new BadRequestException('until must be a future ISO timestamp');
    }
    await this.notificationsService.snooze(id, user.sub, until);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiResponse({ status: 204, description: 'Marked as read' })
  async markRead(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.notificationsService.markRead(id, user.sub);
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark every unread notification as read' })
  @ApiResponse({ status: 204, description: 'All marked as read' })
  async markAllRead(@CurrentUser() user: JwtPayload): Promise<void> {
    await this.notificationsService.markAllRead(user.sub);
  }
}
