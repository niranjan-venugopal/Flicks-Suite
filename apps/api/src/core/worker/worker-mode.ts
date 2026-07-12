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
