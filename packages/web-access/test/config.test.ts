import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";
import { assertAllowedAddress, download } from "../src/http.ts";
import { fixture } from "./_server.ts";

test("configuration defaults to no network exceptions", () => {
  assert.deepEqual(parseConfig({}), { allowRanges: [] });
  assert.deepEqual(parseConfig({ allowRanges: [] }), { allowRanges: [] });
});

for (const value of [
  null,
  [],
  true,
  "text",
  { allowedRanges: [] },
  { allowRanges: null },
  { allowRanges: "198.18.0.0/16" },
  { allowRanges: [42] },
  { search: null },
  { search: false },
  { search: [] },
  { search: {} },
  { search: { provider: "auto" } },
  { search: { provider: "deepseek", apiKey: "not-allowed" } },
]) {
  test(`rejects malformed configuration ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseConfig(value));
  });
}

for (const cidr of [
  "198.18.0.0",
  "198.18.0.0/33",
  "::1/129",
  "garbage/16",
  "127.1/8",
  "198.18.0.0/16/1",
  "198.18.0.0/016",
  " 198.18.0.0/16",
  "fe80::1%eth0/64",
  "0.0.0.0/0",
  "::/0",
  "2001:db8::/0",
  "::ffff:198.18.0.0/112",
  "::ffff:0:0/96",
]) {
  test(`rejects invalid or all-address CIDR ${cidr}`, () => {
    assert.throws(() => parseConfig({ allowRanges: [cidr] }));
  });
}

test("search is an explicit opt-in independent of network exceptions", () => {
  assert.deepEqual(parseConfig({ search: { provider: "deepseek" } }), {
    allowRanges: [],
    search: { provider: "deepseek" },
  });
  const config = parseConfig({ allowRanges: ["198.18.0.0/16"], search: { provider: "deepseek" } });
  assert.equal(config.search?.provider, "deepseek");
  assert.doesNotThrow(() => assertAllowedAddress("198.18.1.2", config.allowRanges));
  assert.throws(() => assertAllowedAddress("127.0.0.1", config.allowRanges), /non-public/u);
});

test("CIDR exceptions are additive, family-aware and limited to their boundaries", () => {
  const { allowRanges } = parseConfig({ allowRanges: ["198.18.0.1/16", "fd12:3456::/48"] });
  for (const address of [
    "198.18.0.0",
    "198.18.255.255",
    "::ffff:198.18.1.2",
    "fd12:3456::1",
    "8.8.8.8",
    "2606:4700:4700::1111",
  ]) {
    assert.doesNotThrow(() => assertAllowedAddress(address, allowRanges));
  }
  for (const address of [
    "198.19.0.0",
    "fd12:3456:1::1",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
  ]) {
    assert.throws(() => assertAllowedAddress(address, allowRanges), /non-public/u);
  }
  assert.throws(() => assertAllowedAddress("not an IP", allowRanges), /Invalid network/u);
});

test("missing configuration uses defaults, but malformed or unreadable files fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "web-access.json");
  assert.deepEqual(await loadConfig(path), { allowRanges: [] });
  await writeFile(path, '{"allowRanges":["198.18.0.0/16"]}');
  const loaded = await loadConfig(path);
  assert.doesNotThrow(() => assertAllowedAddress("198.18.1.2", loaded.allowRanges));
  await writeFile(path, "{");
  await assert.rejects(loadConfig(path), /Invalid web access configuration/u);
  await writeFile(path, '{"allowRanges":["0.0.0.0/0"]}');
  await assert.rejects(loadConfig(path), /all-address/u);
  await assert.rejects(loadConfig(directory), /Cannot read web access configuration/u);
});

test("allowed DNS answers and IP literals work, including redirects inside the allowed range", async (t) => {
  const { network, requests } = await fixture(t, (request, response) => {
    if (request.url === "/start")
      response.writeHead(302, { location: "http://198.18.1.2/final" }).end();
    else response.writeHead(200, { "content-type": "text/plain" }).end("Allowed via TUN");
  });
  network.lookup = async () => [{ address: "198.18.1.1", family: 4 }];
  const { allowRanges } = parseConfig({ allowRanges: ["198.18.0.0/16"] });
  await assert.rejects(download("http://example.test/start", undefined, network), /non-public/u);
  assert.equal(requests.length, 0);
  const open = network.open;
  const connected: string[] = [];
  network.open = (url, address, signal) => {
    connected.push(address.address);
    return open(url, address, signal);
  };
  const page = await download("http://example.test/start", undefined, network, allowRanges);
  assert.equal(page.url, "http://198.18.1.2/final");
  assert.equal(page.text, "Allowed via TUN");
  assert.deepEqual(connected, ["198.18.1.1", "198.18.1.2"]);
});

test("an allowed first hop cannot redirect to an unlisted private range", async (t) => {
  const { network, requests } = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: "http://127.0.0.1/private" }).end();
  });
  network.lookup = async () => [{ address: "198.18.1.1", family: 4 }];
  const { allowRanges } = parseConfig({ allowRanges: ["198.18.0.0/16"] });
  await assert.rejects(
    download("http://example.test", undefined, network, allowRanges),
    /non-public/u,
  );
  assert.equal(requests.length, 1);
  network.lookup = async () => [
    { address: "198.18.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(
    download("http://example.test", undefined, network, allowRanges),
    /non-public/u,
  );
  assert.equal(requests.length, 1);
});
