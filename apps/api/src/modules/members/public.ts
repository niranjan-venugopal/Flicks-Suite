import { Injectable } from '@nestjs/common';
import { MembersService } from './members.service';

/**
 * Public facade for the members module (house rule: cross-module imports go
 * through public.ts). Currently exposes the PM guest-seat membership
 * operations to the pm module — nothing else leaks.
 */
@Injectable()
export class MembersPublicService {
  constructor(private readonly members: MembersService) {}

  inviteExternalGuest(
    tenantId: string,
    actorUserId: string,
    input: { email: string; fullName?: string; projectName: string },
  ) {
    return this.members.inviteGuest(tenantId, actorUserId, input);
  }

  revokeGuestMembership(
    tenantId: string,
    actorUserId: string,
    guestUserId: string,
  ) {
    return this.members.revokeGuestMembership(tenantId, actorUserId, guestUserId);
  }
}
