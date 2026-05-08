import {
  Controller,
  Get,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { CalendarService } from './calendar.service';
import { CalendarRangeDto } from './calendar.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Public } from '../../core/auth/decorators/public.decorator';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Calendar')
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('events')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Unified calendar feed',
    description:
      'Returns holidays + own leaves (any status) + direct reports approved leaves overlapping the range.',
  })
  async listEvents(
    @Query() query: CalendarRangeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.calendarService.listEvents(
      user.sub,
      user.tenantId,
      query.from,
      query.to,
    );
  }

  @Get('me/ical-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Personal iCal subscription URL',
    description:
      'Returns a stable URL that Google Calendar / Outlook can subscribe to (read-only). The URL embeds an HMAC-signed token tied to the user + tenant.',
  })
  getIcalUrl(@CurrentUser() user: JwtPayload) {
    return {
      url: this.calendarService.buildIcalUrl(user.sub, user.tenantId),
    };
  }

  @Get('me.ics')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'iCal feed (token-authenticated)',
    description:
      'Token-authenticated text/calendar feed for Google/Outlook subscriptions. Pass uid, tid, token query params from /me/ical-url.',
  })
  async getIcal(
    @Query('uid') uid: string,
    @Query('tid') tid: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const subscriber = await this.calendarService.resolveIcalSubscriber(
      uid,
      tid,
      token,
    );
    const ical = await this.calendarService.buildIcal(
      subscriber.userId,
      subscriber.tenantId,
      subscriber.employeeId,
    );
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="flicks-suite.ics"',
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(ical);
  }
}
