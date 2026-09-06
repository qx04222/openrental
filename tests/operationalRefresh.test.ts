import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createOperationalRefresh, procedureFromKey, shouldRefreshOperations } from "../client/src/lib/operationalRefresh";
afterEach(() => vi.useRealTimers());
describe("event-driven operational refresh", () => {
 it("recognizes business writes but excludes heartbeat and authentication", () => {
  expect(shouldRefreshOperations([["rentals","approve"]])).toBe(true);
  expect(shouldRefreshOperations([["workOrders","update"]])).toBe(true);
  expect(shouldRefreshOperations([["loginSessions","heartbeat"]])).toBe(false);
  expect(shouldRefreshOperations([["fieldAuth","login"]])).toBe(false);
  expect(procedureFromKey(undefined)).toBe("");
 });
 it("coalesces writes and invalidates dependent views without clearing unrelated data", async () => {
  vi.useFakeTimers();const client=new QueryClient();
  const queue=[["reports","internalWorkQueue"],{type:"query"}];const planning=[["planning","timeline"],{type:"query"}];const settings=[["siteSettings","getAll"],{type:"query"}];
  for(const key of [queue,planning,settings]) client.setQueryData(key,{value:1});
  const spy=vi.spyOn(client,"invalidateQueries");const refresh=createOperationalRefresh(client);refresh();refresh();refresh();await vi.advanceTimersByTimeAsync(150);
  expect(spy).toHaveBeenCalledTimes(1);expect(client.getQueryState(queue)?.isInvalidated).toBe(true);expect(client.getQueryState(planning)?.isInvalidated).toBe(true);expect(client.getQueryState(settings)?.isInvalidated).toBe(false);client.clear();
 });
});
