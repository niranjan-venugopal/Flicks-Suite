import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CalendarService } from './calendar.service';
import {
  CalendarPeopleQueryDto,
  CalendarRangeDto,
  CreateCalendarEventDto,
  RsvpDto,
  UpdateCalendarEventDto,
} from './calendar.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Public } from '../../core/auth/decorators/public.decorator';
import type { JwtPayload } from '@flicks/shared/types';

/**
 * Round J — the Teams-style workspace calendar. HRMS-core like leave: no
 * module grant, every workspace seat except guests (GuestScopeGuard) and
 * auditors (refused in-service) can read the feed, create events and invite
 * any member. Only the organizer (or owner / HR admin) edits or cancels.
 */
@ApiTags('Calendar')
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get('events')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Unified calendar feed',
    description:
      'Holidays, my leave, team availability (teammates + reports), birthdays & work anniversaries, my CRM calls & meetings and the events / meetings I can see, over an inclusive YYYY-MM-DD range (max 93 days). Also returns the workspace calendar prefs.',
  })
  listEvents(@Query() query: CalendarRangeDto, @CurrentUser() user: JwtPayload) {
    return this.calendarService.listFeed(user, query.from, query.to);
  }

  @Get('people')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Invitable workspace members (active seats, no guests / auditors)' })
  listPeople(@Query() query: CalendarPeopleQueryDto, @CurrentUser() user: JwtPayload) {
    return this.calendarService.listPeople(user, query.q);
  }

  @Get('me/ical-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Personal iCal subscription URL',
    description:
      'Returns a stable URL that Google Calendar / Outlook can subscribe to (read-only). The URL embeds an HMAC-signed token tied to the user + tenant.',
  })
  getIcalUrl(@CurrentUser() user: JwtPayload) {
    return { url: this.calendarService.buildIcalUrl(user.sub, user.tenantId) };
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
    const subscriber = await this.calendarService.resolveIcalSubscriber(uid, tid, token);
    const ical = await this.calendarService.buildIcal(subscriber.userId, subscriber.tenantId, subscriber.employeeId);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="flicks-suite.ics"');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(ical);
  }

  @Get('events/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'One event / meeting with its attendees (404 when not visible to the caller)' })
  getEvent(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtPayload) {
    return this.calendarService.getEvent(user, id);
  }

  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Create an event or schedule a meeting (organizer = caller)' })
  createEvent(@Body() dto: CreateCalendarEventDto, @CurrentUser() user: JwtPayload) {
    return this.calendarService.createEvent(user, dto);
  }

  @Patch('events/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Edit an event (organizer, owner or HR admin)' })
  updateEvent(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCalendarEventDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.calendarService.updateEvent(user, id, dto);
  }

  @Delete('events/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Cancel an event (soft; attendees are notified; idempotent)' })
  cancelEvent(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtPayload) {
    return this.calendarService.cancelEvent(user, id);
  }

  @Post('events/:id/rsvp')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Accept / tentatively accept / decline an invitation' })
  rsvp(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RsvpDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.calendarService.rsvp(user, id, dto);
  }
}
