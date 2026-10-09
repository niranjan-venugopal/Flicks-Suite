import { Injectable } from '@nestjs/common';
import { EmployeesService } from './employees.service';

/**
 * Public facade for the employees module (house rule 3: cross-module imports
 * go through public.ts). Round R R2 exposes the invite resend to the FAM
 * support console — nothing else leaks.
 */
@Injectable()
export class EmployeesPublicService {
  constructor(private readonly employees: EmployeesService) {}

  /** Re-send the welcome / invite email to a person who has not joined yet. */
  resendInvite(employeeId: string, tenantId: string, actorUserId: string) {
    return this.employees.resendInvite(employeeId, tenantId, actorUserId);
  }
}
