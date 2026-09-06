import { expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { mutationDefaults } from "../client/src/lib/networkPolicy";

it("does not repeat a completed write when its response is lost", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { ...mutationDefaults, retryDelay: 0 } } });
  const serverWrite = vi.fn(async () => {
    // The server committed successfully, but the client never received the response.
    throw new TypeError("Network connection lost after commit");
  });
  const mutation = client.getMutationCache().build(client, { mutationFn: serverWrite });
  await expect(mutation.execute(undefined)).rejects.toThrow("Network connection lost");
  expect(serverWrite).toHaveBeenCalledTimes(1);
  client.clear();
});
