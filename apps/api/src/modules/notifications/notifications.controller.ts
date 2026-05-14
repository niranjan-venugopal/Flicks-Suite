import {
  Controller,
  Get,
  Patch,
  Post,
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
