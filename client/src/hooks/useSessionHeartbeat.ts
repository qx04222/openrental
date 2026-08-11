import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

const HEARTBEAT_INTERVAL = 60_000; // 60 seconds

export function useSessionHeartbeat() {
  const heartbeat = trpc.loginSessions.heartbeat.useMutation();
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    // Periodic heartbeat to keep lastActiveAt fresh.
    // Stop polling once the session is gone — retrying won't help and the
    // 401-spam was visible in prod logs for 30+ hours per stale tab.
    intervalRef.current = setInterval(() => {
      heartbeat.mutate(undefined, {
        onError: (err) => {
          // tRPC v10+ exposes status as data.httpStatus, code as data.code.
          // Either path can be missing depending on the error origin, so
          // check both — plus the literal message we use elsewhere.
          const status = err.data?.httpStatus;
          const code = err.data?.code;
          const isAuthError =
            status === 401 ||
            status === 403 ||
            code === "UNAUTHORIZED" ||
            code === "FORBIDDEN";
          if (isAuthError) {
            clearInterval(intervalRef.current);
          }
        },
      });
    }, HEARTBEAT_INTERVAL);

    // On page close/navigate away — send logout signal (not just heartbeat)
    const handleBeforeUnload = () => {
      navigator.sendBeacon("/api/admin-auth/beacon-logout");
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // On visibility change to hidden (tab switch, minimize) — send heartbeat
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        navigator.sendBeacon("/api/admin-auth/heartbeat");
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalRef.current);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
