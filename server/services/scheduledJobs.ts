import cron from "node-cron";
import { withDatabaseJobLock } from "../db/core";
import { logger, logObservation } from "../_core/logger";

export type JobStatus = "not_run" | "running" | "completed" | "warning" | "failed" | "skipped";
export interface JobState { name: string; schedule: string; timezone: string; status: JobStatus; startedAt: string | null; finishedAt: string | null; lastSuccessAt: string | null; durationMs: number | null; warnings: number; errors: number; runs: number; skipped: number }
const states = new Map<string, JobState>();
export function getScheduledJobStates(): JobState[] { return [...states.values()].map(s => ({ ...s })); }
export function trackScheduledJob(name: string, schedule: string, timezone: string) {
  states.set(name, { name, schedule, timezone, status: "not_run", startedAt: null, finishedAt: null, lastSuccessAt: null, durationMs: null, warnings: 0, errors: 0, runs: 0, skipped: 0 });
}
export async function runScheduledJob(name: string, work: () => Promise<unknown>, lock = withDatabaseJobLock): Promise<void> {
  const state = states.get(name);
  if (!state) throw new Error("Unregistered scheduled job");
  if (state.status === "running") { state.skipped++; return; }
  const started = Date.now();
  state.status = "running"; state.startedAt = new Date(started).toISOString(); state.warnings = 0; state.errors = 0;
  const observed = { warnings: 0, errors: 0 };
  try {
    const acquired = await lock(name, () => logObservation.run(observed, async () => {
      const result = await work();
      if (result && typeof result === "object" && "failed" in result && Number(result.failed) > 0) observed.errors += Number(result.failed);
    }));
    state.status = !acquired ? "skipped" : observed.errors || observed.warnings ? "warning" : "completed";
    if (acquired) state.runs++; else state.skipped++;
    if (state.status === "completed") state.lastSuccessAt = new Date().toISOString();
    logger.info("job.finished", { job: name, outcome: state.status, warnings: observed.warnings, errors: observed.errors });
  } catch (error) {
    state.status = "failed"; observed.errors++; state.runs++;
    logger.error("job.failed", { job: name, error });
  } finally {
    state.finishedAt = new Date().toISOString(); state.durationMs = Date.now() - started;
    state.warnings = observed.warnings; state.errors = observed.errors;
  }
}
export function registerScheduledJob(name: string, schedule: string, timezone: string, work: () => Promise<unknown>) {
  trackScheduledJob(name, schedule, timezone);
  return cron.schedule(schedule, () => runScheduledJob(name, work), { timezone, noOverlap: true });
}
