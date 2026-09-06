export const adminSessionQueryKey = ["admin-session"] as const;
export interface AdminUser { userId: number; email: string | null; role: string }
/** Only an explicit authentication rejection means signed out. A temporary
 * network/server/rate-limit failure must offer retry instead of false logout. */
export async function loadAdminSession(): Promise<AdminUser | null> {
  const response = await fetch("/api/admin-auth/verify-session", { credentials: "include", cache: "no-store" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Session verification unavailable");
  const data = await response.json();
  if (data.isAuthenticated !== true || !Number.isInteger(data.userId) || typeof data.role !== "string") throw new Error("Invalid session response");
  return { userId: data.userId, email: typeof data.email === "string" ? data.email : null, role: data.role };
}
