import { useState, useEffect } from "react";

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: { email: string; role: string } | null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    user: null,
  });

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/admin-auth/verify-session", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setState({ isAuthenticated: true, isLoading: false, user: data });
        } else {
          setState({ isAuthenticated: false, isLoading: false, user: null });
        }
      } catch {
        setState({ isAuthenticated: false, isLoading: false, user: null });
      }
    }
    checkAuth();
  }, []);

  return state;
}
