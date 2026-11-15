import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { isIP } from "node:net";
import type { TestContext } from "node:test";
import { type Network, openResponse } from "../src/http.ts";

export async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const requests: string[] = [];
  const lookups: string[] = [];
  const network: Network = {
    lookup: async (hostname) => {
      lookups.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
    open: async (url, _validated, signal) => {
      requests.push(url.href);
      const target = new URL(url);
      target.protocol = "http:";
      target.port = String(address.port);
      // Node skips lookup for IP literals; give the fixture a hostname so the
      // pinned test address is used instead of opening a real network socket.
      if (isIP(target.hostname.replace(/^\[|\]$/gu, ""))) target.hostname = "fixture.test";
      // Replace only the network destination; exercise the real HTTP client,
      // pinned lookup, Host preservation, streaming, and socket cancellation.
      return openResponse(target, { address: "127.0.0.1", family: 4 }, signal);
    },
  };
  return { server, network, requests, lookups };
}
