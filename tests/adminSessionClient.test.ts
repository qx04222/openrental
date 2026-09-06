import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdminSession } from "../client/src/lib/adminSession";
afterEach(() => vi.unstubAllGlobals());
describe("admin session failure semantics", () => {
  it.each([401, 403])("only treats %s as signed out", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
    await expect(loadAdminSession()).resolves.toBeNull();
  });
  it.each([429, 500, 503])("preserves %s as a retryable failure", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
    await expect(loadAdminSession()).rejects.toThrow("unavailable");
  });
  it("does not disguise a disconnected network as logout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(loadAdminSession()).rejects.toThrow();
  });
  it("requires a verified stable identity, including email-less users", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ isAuthenticated:true, userId:42, email:null, role:"super_admin" })));
    await expect(loadAdminSession()).resolves.toEqual({ userId:42, email:null, role:"super_admin" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ isAuthenticated:false })));
    await expect(loadAdminSession()).rejects.toThrow("Invalid");
  });
});
