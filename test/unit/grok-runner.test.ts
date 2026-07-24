import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  runGrokModels,
  runGrokModelsAsync,
  spawnGrok,
  validateGrokAuth,
} from "../../src/grok-runner.ts";

function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const oldPath = process.env.PATH;
  process.env.PATH = path;
  return fn().finally(() => {
    process.env.PATH = oldPath;
  });
}

describe("spawnGrok", () => {
  it("starts the provider process without running a synchronous --version preflight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-grok-build-runner-"));
    const grokPath = join(dir, "grok");
    const logPath = join(dir, "argv.log");
    writeFileSync(
      grokPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = "--version" ]; then
  sleep 10
  exit 0
fi
printf '%s\\n' '{"type":"text","data":"PI_GROK_OK"}'
printf '%s\\n' '{"type":"end","stopReason":"EndTurn"}'
`,
    );
    chmodSync(grokPath, 0o755);

    await withPath(dir, async () => {
      const proc = spawnGrok("hello", { modelId: "grok-build" });
      let stdout = "";

      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("close", resolve);
      });

      assert.equal(exitCode, 0);
      assert.match(stdout, /PI_GROK_OK/);
      const invocations = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      assert.doesNotMatch(invocations, /--version/);
    });
  });
});

describe("runGrokModels", () => {
  it("runs `grok models` without a synchronous --version preflight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-grok-build-models-"));
    const grokPath = join(dir, "grok");
    const logPath = join(dir, "argv.log");
    writeFileSync(
      grokPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = "--version" ]; then
  echo 'version probe should not run' >&2
  exit 88
fi
if [ "$1" = "models" ]; then
  printf '%s\\n' 'Available models:'
  printf '%s\\n' '  * grok-build (default)'
  exit 0
fi
exit 2
`,
    );
    chmodSync(grokPath, 0o755);

    await withPath(dir, async () => {
      const result = runGrokModels();

      assert.equal(result.ok, true);
      assert.match(result.stdout, /grok-build/);
      const invocations = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      assert.doesNotMatch(invocations, /--version/);
      assert.match(invocations, /^models$/m);
    });
  });
});

describe("runGrokModelsAsync", () => {
  it("returns model output without blocking while the child runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-grok-build-models-async-"));
    const grokPath = join(dir, "grok");
    writeFileSync(
      grokPath,
      `#!/bin/sh
if [ "$1" = "models" ]; then
  /bin/sleep 0.2
  printf '%s\\n' 'Available models:'
  printf '%s\\n' '  * grok-build (default)'
  exit 0
fi
exit 2
`,
    );
    chmodSync(grokPath, 0o755);

    await withPath(dir, async () => {
      const started = Date.now();
      const resultPromise = runGrokModelsAsync();
      assert.ok(Date.now() - started < 100);
      const result = await resultPromise;

      assert.equal(result.ok, true);
      assert.match(result.stdout, /grok-build/);
    });
  });

  it("returns classified failures without rejecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-grok-build-models-async-failure-"));
    const grokPath = join(dir, "grok");
    writeFileSync(
      grokPath,
      `#!/bin/sh
printf '%s\\n' 'not authenticated' >&2
exit 1
`,
    );
    chmodSync(grokPath, 0o755);

    await withPath(dir, async () => {
      const result = await runGrokModelsAsync();

      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.notEqual(result.stderr, "");
    });
  });
});

describe("validateGrokAuth", () => {
  it("checks auth with `grok models` without a synchronous --version preflight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-grok-build-auth-"));
    const grokPath = join(dir, "grok");
    const logPath = join(dir, "argv.log");
    writeFileSync(
      grokPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = "--version" ]; then
  echo 'version probe should not run' >&2
  exit 88
fi
if [ "$1" = "models" ]; then
  printf '%s\\n' 'Available models:'
  printf '%s\\n' '  * grok-build (default)'
  exit 0
fi
exit 2
`,
    );
    chmodSync(grokPath, 0o755);

    await withPath(dir, async () => {
      assert.equal(validateGrokAuth(), true);
      const invocations = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      assert.doesNotMatch(invocations, /--version/);
      assert.match(invocations, /^models$/m);
    });
  });
});
