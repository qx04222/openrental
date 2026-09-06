import { useQuery } from "@tanstack/react-query";
import { adminSessionQueryKey, loadAdminSession } from "@/lib/adminSession";

export function useAuth() {
  // Layout, route guard and page share one request and one consistent identity.
  const query = useQuery({ queryKey: adminSessionQueryKey, queryFn: loadAdminSession,
    staleTime: 30_000, retry: false, refetchOnMount: true });
  return { isAuthenticated: Boolean(query.data), isLoading: query.isPending,
    user: query.data ?? null, isError: query.isError, retry: () => { void query.refetch(); } };
}
