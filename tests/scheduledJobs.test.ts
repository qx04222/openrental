import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduledJobStates, runScheduledJob, trackScheduledJob } from "../server/services/scheduledJobs";
import { logger } from "../server/_core/logger";
const acquired = async (_name: string, work: () => Promise<unknown>) => { await work(); return true; };
afterEach(() => vi.restoreAllMocks());
describe("observed scheduled work", () => {
 it("does not label a registered-but-unrun task successful", () => {
  trackScheduledJob("not_run_test", "* * * * *", "UTC");
  expect(getScheduledJobStates().find(j => j.name === "not_run_test")).toMatchObject({status:"not_run",lastSuccessAt:null,runs:0});
 });
 it("does not run work when another database runner holds the lock", async () => {
  trackScheduledJob("locked_test", "* * * * *", "UTC"); const work = vi.fn();
  await runScheduledJob("locked_test", work, async () => false);
  expect(work).not.toHaveBeenCalled();
  expect(getScheduledJobStates().find(j => j.name === "locked_test")).toMatchObject({status:"skipped",runs:0,skipped:1,lastSuccessAt:null});
 });
 it("records thrown failures without claiming a successful run", async () => {
  vi.spyOn(console,"error").mockImplementation(() => {});
  trackScheduledJob("failed_test", "* * * * *", "UTC");
  await runScheduledJob("failed_test", async () => { throw new Error("database unavailable"); }, acquired);
  expect(getScheduledJobStates().find(j => j.name === "failed_test")).toMatchObject({status:"failed",errors:1,lastSuccessAt:null});
 });
 it("observes logged per-record errors even if a handler resolves", async () => {
  vi.spyOn(console,"warn").mockImplementation(() => {});
  trackScheduledJob("warn_test", "* * * * *", "UTC");
  await runScheduledJob("warn_test", async () => { logger.warn("One record failed"); }, acquired);
  expect(getScheduledJobStates().find(j => j.name === "warn_test")).toMatchObject({status:"warning",warnings:1,lastSuccessAt:null});
 });
 it("records aggregate failures returned by a job", async () => {
  trackScheduledJob("aggregate_test", "* * * * *", "UTC");
  await runScheduledJob("aggregate_test", async () => ({ settled:4, failed:2 }), acquired);
  expect(getScheduledJobStates().find(j => j.name === "aggregate_test")).toMatchObject({status:"warning",errors:2});
 });
 it("keeps local overlap from overwriting the active run's result", async () => {
  trackScheduledJob("overlap_test", "* * * * *", "UTC");
  let release!: () => void;const work=vi.fn(() => new Promise<void>(resolve => { release=resolve; }));
  const first=runScheduledJob("overlap_test",work,acquired);await runScheduledJob("overlap_test",work,acquired);release();await first;
  expect(work).toHaveBeenCalledOnce();
  expect(getScheduledJobStates().find(j => j.name === "overlap_test")).toMatchObject({status:"completed",runs:1,skipped:1});
 });
});
