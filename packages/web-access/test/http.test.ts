import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  assertAllowedAddress,
  download,
  MAX_RESPONSE_BYTES,
  MAX_URL_LENGTH,
  type Network,
  parseUrl,
  TIMEOUT_MS,
} from "../src/http.ts";
import { fixture } from "./_server.ts";

for (const url of [
  "file:///etc/passwd",
  "ftp://example.com",
  "data:text/plain,hello",
  "https://user:secret@example.com",
  "not a URL",
  `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`,
]) {
  test(`rejects invalid URL ${url.slice(0, 60)}`, () => assert.throws(() => parseUrl(url)));
}

for (const address of [
  "127.0.0.1",
  "0.0.0.0",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "192.0.2.1",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "::1",
  "::",
  "fc00::1",
  "fe80::1",
  "ff02::1",
  "2001:db8::1",
  "::ffff:127.0.0.1",
  "64:ff9b::a00:1",
]) {
  test(`blocks non-public address ${address}`, () =>
    assert.throws(() => assertAllowedAddress(address)));
}
for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
  test(`accepts public address ${address}`, () =>
    assert.doesNotThrow(() => assertAllowedAddress(address)));
}

const neverOpen: Network["open"] = async () => {
  throw new Error("Network must not be reached");
};
for (const url of [
  "http://127.1",
  "http://2130706433",
  "http://0x7f000001",
  "http://[::1]",
  "http://[::ffff:127.0.0.1]",
]) {
  test(`blocks normalized IP URL ${url}`, async () => {
    await assert.rejects(
      download(url, undefined, { lookup: async () => [], open: neverOpen }),
      /non-public/u,
    );
  });
}

test("blocks private and mixed DNS answers before making a request", async () => {
  for (const addresses of [["127.0.0.1"], ["8.8.8.8", "10.0.0.1"]]) {
    await assert.rejects(
      download("http://example.test", undefined, {
        lookup: async () => addresses.map((address) => ({ address, family: 4 })),
        open: neverOpen,
      }),
      /non-public/u,
    );
  }
  await assert.rejects(
    download("https://example.test", undefined, { lookup: async () => [], open: neverOpen }),
    /no addresses/u,
  );
});

test("follows relative redirects, validates every hop, pins connections and sends no credentials", async (t) => {
  const { network, requests, lookups } = await fixture(t, (request, response) => {
    assert.match(request.headers.host ?? "", /^example\.test:/u);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["accept-encoding"], "identity");
    if (request.url === "/start") {
      response.writeHead(302, { location: "/final", "set-cookie": "secret=value" }).end();
    } else {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Hello 世界");
    }
  });
  assert.deepEqual(await download("http://example.test/start#fragment", undefined, network), {
    url: "http://example.test/final",
    mediaType: "text/plain",
    text: "Hello 世界",
  });
  assert.deepEqual(requests, ["http://example.test/start", "http://example.test/final"]);
  assert.deepEqual(lookups, ["example.test", "example.test"]);
});

for (const [location, diagnostic] of [
  ["http://127.0.0.1/private", /non-public/u],
  ["file:///etc/passwd", /Only HTTP/u],
  ["http://user:secret@example.test", /credentials/u],
  ["http://example.test/downgrade", /HTTPS to HTTP/u],
] as const) {
  test(`rejects unsafe redirect ${location}`, async (t) => {
    const { network, requests } = await fixture(t, (_request, response) => {
      response.writeHead(302, { location }).end();
    });
    const scheme = location.endsWith("downgrade") ? "https" : "http";
    await assert.rejects(download(`${scheme}://example.test`, undefined, network), diagnostic);
    assert.equal(requests.length, 1);
  });
}

test("revalidates DNS after a same-host redirect", async (t) => {
  const { network, requests } = await fixture(t, (_request, response) =>
    response.writeHead(302, { location: "/again" }).end(),
  );
  let lookups = 0;
  network.lookup = async () => [
    { address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 },
  ];
  await assert.rejects(download("http://example.test", undefined, network), /non-public/u);
  assert.equal(requests.length, 1);
});

test("bounds redirects and rejects a missing Location", async (t) => {
  const { network, requests } = await fixture(t, (request, response) => {
    response.writeHead(302, request.url === "/missing" ? {} : { location: "/loop" }).end();
  });
  await assert.rejects(
    download("http://example.test/loop", undefined, network),
    /Too many redirects/u,
  );
  assert.equal(requests.length, 6);
  await assert.rejects(download("http://example.test/missing", undefined, network), /no Location/u);
});

for (const [name, status, headers, body, diagnostic] of [
  ["HTTP error", 403, { "content-type": "text/plain" }, "Forbidden", /HTTP 403/u],
  ["partial response", 206, { "content-type": "text/plain" }, "Part", /partial content/u],
  ["PDF", 200, { "content-type": "application/pdf" }, "%PDF", /Unsupported Content-Type/u],
  ["missing type", 200, {}, "unknown", /Content-Type: missing/u],
  [
    "compressed body",
    200,
    { "content-type": "text/plain", "content-encoding": "gzip" },
    "bytes",
    /Content-Encoding/u,
  ],
  [
    "unsupported charset",
    200,
    { "content-type": "text/plain; charset=not-a-charset" },
    "Hello",
    /encoding/u,
  ],
  [
    "oversized Content-Length",
    200,
    { "content-type": "text/plain", "content-length": String(MAX_RESPONSE_BYTES + 1) },
    "",
    /exceeds/u,
  ],
] as const) {
  test(`reports ${name}`, async (t) => {
    const { network } = await fixture(t, (_request, response) =>
      response.writeHead(status, headers).end(body),
    );
    await assert.rejects(download("http://example.test", undefined, network), diagnostic);
  });
}

test("bounds chunked bodies without trusting Content-Length", async (t) => {
  const { network } = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("a".repeat(MAX_RESPONSE_BYTES));
    response.end("x");
  });
  await assert.rejects(download("http://example.test", undefined, network), /exceeds/u);
});

test("accepts the body size boundary and declared non-UTF8 text", async (t) => {
  const { network } = await fixture(t, (request, response) => {
    if (request.url === "/latin") {
      response
        .writeHead(200, { "content-type": 'text/plain; charset="windows-1252"' })
        .end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    } else {
      response.writeHead(200, { "content-type": "text/plain" }).end("a".repeat(MAX_RESPONSE_BYTES));
    }
  });
  assert.equal(
    (await download("http://example.test", undefined, network)).text.length,
    MAX_RESPONSE_BYTES,
  );
  assert.equal((await download("http://example.test/latin", undefined, network)).text, "café");
});

test("rejects invalid UTF-8 and prematurely closed responses", async (t) => {
  const { network } = await fixture(t, (request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    if (request.url === "/encoding") response.end(Buffer.from([0xff]));
    else {
      response.write("incomplete");
      response.socket?.destroy();
    }
  });
  await assert.rejects(
    download("http://example.test/encoding", undefined, network),
    /encoded data/u,
  );
  await assert.rejects(download("http://example.test/broken", undefined, network));
});

test("cancels pending DNS and does not open a socket when resolution completes later", async () => {
  const controller = new AbortController();
  let finish: ((addresses: { address: string; family: number }[]) => void) | undefined;
  const pending = download("http://example.test", controller.signal, {
    lookup: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    open: neverOpen,
  });
  controller.abort(new Error("Cancelled by user"));
  await assert.rejects(pending, /Cancelled by user/u);
  assert.ok(finish);
  finish([{ address: "8.8.8.8", family: 4 }]);
});

test("rejects pre-aborted requests without DNS", async () => {
  await assert.rejects(
    download("http://example.test", AbortSignal.abort(new Error("Already cancelled")), {
      lookup: async () => {
        throw new Error("DNS must not run");
      },
      open: neverOpen,
    }),
    /Already cancelled/u,
  );
});

test("enforces the network deadline while DNS is stalled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = download("http://example.test", undefined, {
    lookup: () => new Promise(() => {}),
    open: neverOpen,
  });
  t.mock.timers.tick(TIMEOUT_MS);
  await assert.rejects(pending, /timed out/u);
});

test("cancellation closes a stalled response body", async (t) => {
  const { network, server } = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
  });
  const requested = once(server, "request");
  const controller = new AbortController();
  const pending = download("http://example.test", controller.signal, network);
  await requested;
  controller.abort(new Error("Stop reading"));
  await assert.rejects(pending, /Stop reading/u);
});
