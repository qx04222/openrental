import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
const db = vi.hoisted(() => ({ getDb: vi.fn(), execute: vi.fn() }));
vi.mock("../server/db", () => ({ getDb: db.getDb, sql: vi.fn() }));
import { readinessHandler, livenessHandler } from "../server/_core/readiness";

function response() {
  return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe("readiness contract", () => {
  it("requires a successful database query", async () => {
    db.getDb.mockResolvedValue({ execute: db.execute }); db.execute.mockResolvedValue([]);
    const res = response(); await readinessHandler({} as Request, res as unknown as Response);
    expect(db.execute).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
  it("returns 503 without exposing database errors", async () => {
    db.getDb.mockResolvedValue({ execute: db.execute }); db.execute.mockRejectedValue(new Error("private database URL"));
    const res = response(); await readinessHandler({} as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("private");
  });
  it("does not mistake missing configuration for ready", async () => {
    db.getDb.mockResolvedValue(null);
    const res = response(); await readinessHandler({} as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it("keeps liveness independent of the database", () => {
    const res = response(); livenessHandler({} as Request, res as unknown as Response);
    expect(db.getDb).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "ok", version: expect.any(String) }));
  });
});
