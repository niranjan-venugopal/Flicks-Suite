// ─── FAM (Flicks Admin Module) Types ─────────────────────────────────────────

import type { TenantStatus } from './auth.js';

export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export type PlanTier = 'starter' | 'growth' | 'scale' | 'enterprise';

export interface TenantWithHealth {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  planTier: PlanTier;
  planPrice: number;
  currency: string;
  mrr: number;
  trialEndsAt: string | null;
  createdAt: string;
  activeEmployeeCount: number;
  adminEmail: string;
  adminName: string;
  lastActiveAt: string | null;
  healthScore: number; // 0-100
  healthStatus: HealthStatus;
  churnRisk: 'low' | 'medium' | 'high';
  isImpersonatable: boolean;
}

export interface MrrBreakdown {
  totalMrr: number;
  currency: string;
  byPlan: Array<{
    plan: PlanTier;
    tenantCount: number;
    mrr: number;
    percentage: number;
  }>;
  growth: {
    newMrr: number;
    expansionMrr: number;
    contractionMrr: number;
    churnedMrr: number;
    netNewMrr: number;
    growthRate: number; // percentage
  };
  historicalMrr: Array<{
    month: string; // YYYY-MM
    mrr: number;
  }>;
}

export interface FunnelData {
  signups: number;
  trialing: number;
  converted: number;
  churned: number;
  conversionRate: number; // percentage
  trialToActiveRate: number; // percentage
  averageTrialDays: number;
  stages: Array<{
    stage: string;
    count: number;
    conversionRate: number;
    dropOffRate: number;
    averageDays: number;
  }>;
}

export interface SystemHealth {
  overallStatus: HealthStatus;
  checkedAt: string;
  services: Array<{
    name: string;
    status: HealthStatus;
    latencyMs: number | null;
    uptime: number | null; // percentage over 30 days
    lastCheckedAt: string;
    errorMessage: string | null;
  }>;
  database: {
    status: HealthStatus;
    activeConnections: number;
    maxConnections: number;
    latencyMs: number;
    replicationLagMs: number | null;
  };
  queues: Array<{
    name: string;
    depth: number;
    processingRate: number;
    errorRate: number;
    oldestJobAgeSeconds: number | null;
  }>;
  infrastructure: {
    cpuUsage: number; // percentage
    memoryUsage: number; // percentage
    diskUsage: number; // percentage
    region: string;
  };
}
