import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLocalEnv } from "../src/env.ts";

test("loadLocalEnv loads .env.local without overriding existing variables", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ts-env-"));
  const envPath = path.join(dir, ".env.local");
  const originalExisting = process.env.SYMPHONY_TEST_EXISTING;
  const originalLoaded = process.env.SYMPHONY_TEST_LOADED;
  process.env.SYMPHONY_TEST_EXISTING = "from-env";
  delete process.env.SYMPHONY_TEST_LOADED;

  await fs.writeFile(envPath, `
# local secrets
SYMPHONY_TEST_EXISTING=from-file
SYMPHONY_TEST_LOADED="from local file"
`, "utf8");

  const loaded = await loadLocalEnv([envPath]);

  assert.deepEqual(loaded, [envPath]);
  assert.equal(process.env.SYMPHONY_TEST_EXISTING, "from-env");
  assert.equal(process.env.SYMPHONY_TEST_LOADED, "from local file");

  restoreEnv("SYMPHONY_TEST_EXISTING", originalExisting);
  restoreEnv("SYMPHONY_TEST_LOADED", originalLoaded);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
