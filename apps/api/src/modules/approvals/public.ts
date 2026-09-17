/**
 * Approvals public facade (house rule 3: cross-module imports go through
 * public.ts). Leave, attendance (regularizations), timesheet, dashboard and
 * the FAM console consume routing ONLY through what is re-exported here.
 */
export {
  ApprovalRoutingService,
  ORG_WIDE_REVIEW_ROLES,
  ESCALATION_SLA_MS,
  LIVE_EMPLOYEE_STATUSES,
  RESET_ESCALATION,
  routeStateColumns,
  shapeEscalation,
  authorRoutingView,
  dateInTimezone,
  approvalDeepLink,
  hasValidManagerSql,
  isLiveReviewerSql,
} from './approval-routing.service';
export type {
  ApprovalKind,
  EscalationLevel,
  EscalationReason,
  EscalationDto,
  EscalationPlan,
  EscalationSummary,
  MayAct,
  Recipient,
  ReviewerCtx,
  Route,
  RoutePerson,
  RouteState,
  RoutedColumns,
} from './approval-routing.service';
export { ApprovalEscalationJob } from '../../jobs/approval-escalation.job';
export type { SweepResult } from '../../jobs/approval-escalation.job';
export { ApprovalsModule } from './approvals.module';
