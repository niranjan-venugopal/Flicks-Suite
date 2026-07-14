import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../core/auth/decorators/public.decorator';
import { CrmEmailService } from './email.service';

/** 1×1 transparent GIF (43 bytes) — the classic tracking pixel. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Public email endpoints (PRD v5 §7.1 / C11): open pixel, wrapped-link
 * redirects and the {{unsubscribe_link}} target. No auth — each token scopes
 * to exactly one message/link and enumeration yields nothing. Tighter
 * throttles because these are internet-facing.
 */
@ApiExcludeController()
@Controller()
export class CrmEmailPublicController {
  constructor(private readonly email: CrmEmailService) {}

  @Get('t/o/:token')
  @Public()
  @Throttle({ medium: { ttl: 60_000, limit: 60 } })
  async open(@Param('token') token: string, @Res() res: Response) {
    await this.email.trackOpen(token).catch(() => undefined);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(PIXEL);
  }

  @Get('t/c/:token')
  @Public()
  @Throttle({ medium: { ttl: 60_000, limit: 60 } })
  async click(@Param('token') token: string, @Res() res: Response) {
    const url = await this.email.trackClick(token).catch(() => null);
    if (!url) {
      res.status(404).send('Link not found');
      return;
    }
    res.redirect(302, url);
  }

  @Get('u/:token')
  @Public()
  @Throttle({ medium: { ttl: 60_000, limit: 10 } })
  async unsubscribe(@Param('token') token: string, @Res() res: Response) {
    const ok = await this.email.unsubscribe(token).catch(() => false);
    res
      .status(ok ? 200 : 404)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(
        ok
          ? '<html><body style="font-family:sans-serif;background:#0b0b14;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>You\'re unsubscribed</h2><p style="color:#9aa">You won\'t receive further sales emails from this sender.</p></div></body></html>'
          : '<html><body style="font-family:sans-serif;background:#0b0b14;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>Link not found</h2></div></body></html>',
      );
  }
}
