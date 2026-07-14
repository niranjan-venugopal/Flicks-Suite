/**
 * Worker split (PRD v5 §2.5): one codebase/image, two processes.
 *  • API process   — HTTP, request-path work, @Cron business jobs (v1).
 *  • Worker process — WORKER_MODE=true: outbox dispatcher + BullMQ consumers
 *    (domain-event fan-out, webhook deliveries, later imports/sequences).
 * Guards read this at call time so tests can flip it via env.
 */
export function isWorkerMode(): boolean {
  return process.env.WORKER_MODE === 'true';
}

/**
 * Inline worker (beta default): most deployments run ONE process, and an
 * API-only process left the outbox stalled forever ("OUTBOX STALLED" alerts —
 * webhooks/async fan-out never fired). Unless a dedicated worker is declared
 * (INLINE_WORKER=false alongside a WORKER_MODE=true replica), the API process
 * runs the queue consumers + outbox dispatcher itself. Safe by construction:
 * the dispatcher claims with FOR UPDATE SKIP LOCKED and enqueues are
 * idempotent by event id, so API + worker draining together never double-fire.
 */
export function isInlineWorker(): boolean {
  return !isWorkerMode() && process.env.INLINE_WORKER !== 'false';
}

/** True in any process that should consume queues + drain the outbox. */
export function runsWorkloads(): boolean {
  return isWorkerMode() || isInlineWorker();
}
