import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service';
import { PresenceController } from './presence.controller';
import { PresenceGateway } from '../../gateways/presence.gateway';

/**
 * Presence module (PRD v4 §5). The gateway lives here (not app root) so the
 * controller can read its live-activity map for batched resolution.
 */
@Module({
  controllers: [PresenceController],
  providers: [PresenceService, PresenceGateway],
  exports: [PresenceService, PresenceGateway],
})
export class PresenceModule {}
