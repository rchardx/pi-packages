import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  assetName,
  inspectPack,
  loadPackages,
  nightlyVersion,
  packNightly,
} from "./nightly-pack.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

async function fixture(t: TestContext, files = ["index.ts", "src", "README.md"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-nightly-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "packages", "example");
  await mkdir(join(directory, "src"), { recursive: true });
  const manifest = {
    name: "@rchardx/pi-example",
    version: "0.1.0",
    private: true,
    type: "module",
    files,
    pi: { extensions: ["./index.ts"] },
    // npm pack must not run package lifecycle scripts.
    scripts: { prepack: "node -e 'process.exit(99)'" },
  };
  const original = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, "package.json"), original);
  for (const file of ["index.ts", "src/runtime.ts", "README.md", "LICENSE"]) {
    await writeFile(join(directory, file), `fixture: ${file}\n`);
  }
  return { root, directory, original, destination: join(root, "archives") };
}

test("nightly versions combine each stable base, run number and complete commit", () => {
  assert.equal(nightlyVersion("0.1.0", "42", sha), `0.1.0-nightly.42.g${sha}`);
  assert.equal(nightlyVersion("2.3.4", "43", sha), `2.3.4-nightly.43.g${sha}`);
  for (const base of ["", "01.1.0", "0.1", "0.1.0-rc.1", "0.1.0+build"]) {
    assert.throws(() => nightlyVersion(base, "42", sha), /stable package base/u);
  }
  for (const run of ["0", "01", "-1", "1.5", "", "42\n"]) {
    assert.throws(() => nightlyVersion("0.1.0", run, sha), /run number/u);
  }
  for (const invalid of ["abc123", sha.toUpperCase(), `${sha}\n`, "a".repeat(41)]) {
    assert.throws(() => nightlyVersion("0.1.0", "42", invalid), /commit SHA/u);
  }
});

test("asset filenames stay fixed across versions and reject unexpected package names", () => {
  assert.equal(assetName("@rchardx/pi-ask"), "pi-ask-nightly.tgz");
  assert.equal(assetName("@rchardx/pi-web-access"), "pi-web-access-nightly.tgz");
  assert.throws(() => assetName("../../outside"), /Unexpected workspace/u);
  assert.throws(() => assetName("@other/pi-ask"), /Unexpected workspace/u);
});

test("pack inspection rejects missing runtime files and accidental private files", () => {
  const files = ["index.ts", "src/runtime.ts", "package.json", "README.md", "LICENSE"];
  const output = (paths: string[], filename = "fixture.tgz") =>
    JSON.stringify([{ filename, files: paths.map((path) => ({ path })) }]);
  assert.equal(inspectPack(output(files)), "fixture.tgz");
  for (const extra of [
    ".env",
    "test/a.test.ts",
    "src/.secret.ts",
    "src/../config.ts",
    "src/key.json",
  ]) {
    assert.throws(() => inspectPack(output([...files, extra])), /Unexpected tarball file/u);
  }
  for (const required of files) {
    assert.throws(() => inspectPack(output(files.filter((file) => file !== required))), /missing/u);
  }
  assert.throws(() => inspectPack(output(files, "../escape.tgz")), /filename/u);
  assert.throws(() => inspectPack("[]"), /one npm tarball/u);
});

test("real npm pack changes only the staged version and retains private package metadata", async (t) => {
  const { root, directory, original, destination } = await fixture(t);
  await packNightly(root, destination, "42", sha);
  assert.deepEqual(await readdir(destination), ["pi-example-nightly.tgz"]);
  assert.equal(await readFile(join(directory, "package.json"), "utf8"), original);
  const archive = join(destination, "pi-example-nightly.tgz");
  const packed = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
  );
  assert.equal(packed.version, `0.1.0-nightly.42.g${sha}`);
  assert.equal(packed.private, true);
  assert.deepEqual(packed.pi, { extensions: ["./index.ts"] });
  assert.equal(
    execFileSync("tar", ["-xOf", archive, "package/src/runtime.ts"], { encoding: "utf8" }),
    "fixture: src/runtime.ts\n",
  );
});

test("invalid versions and nonempty destinations fail before packing", async (t) => {
  const { root, destination } = await fixture(t);
  await assert.rejects(packNightly(root, destination, "0", sha), /run number/u);
  await assert.rejects(readdir(destination), { code: "ENOENT" });
  await mkdir(destination);
  await writeFile(join(destination, "keep.txt"), "existing archive");
  await assert.rejects(packNightly(root, destination, "42", sha), /must be empty/u);
  assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "existing archive");
});

test("pack rejects unexpected files without changing the source package", async (t) => {
  const { root, directory, original, destination } = await fixture(t, ["*"]);
  await writeFile(join(directory, "credentials.json"), "not-a-real-secret");
  await assert.rejects(packNightly(root, destination, "42", sha), /Unexpected tarball file/u);
  assert.equal(await readFile(join(directory, "package.json"), "utf8"), original);
});

test("workspace discovery requires private named packages", async (t) => {
  const { root, directory } = await fixture(t);
  const packages = await loadPackages(root);
  assert.deepEqual(
    packages.map((pkg) => pkg.name),
    ["@rchardx/pi-example"],
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "@rchardx/pi-example", version: "0.1.0" }),
  );
  await assert.rejects(loadPackages(root), /private workspace/u);
});
