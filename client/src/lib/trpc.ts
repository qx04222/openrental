import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/routers/app.router";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export const trpc = createTRPCReact<AppRouter>();
