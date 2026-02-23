import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "./config.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotewiz-config-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadRuntimeConfig loads valid project config", () => {
  withTempDir((dir) => {
    const projectDir = path.join(dir, "project-a");
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify(
        {
          projects: {
            alpha: {
              path: projectDir,
              description: "demo",
              skipPermissions: false,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, ".env"), "WEB_AUTH_TOKEN=test-token\n", "utf8");

    const { appConfig, runtimeConfig } = loadRuntimeConfig(dir);
    assert.equal(Object.keys(appConfig.projects).length, 1);
    assert.equal(appConfig.projects.alpha.alias, "alpha");
    assert.equal(appConfig.projects.alpha.path, fs.realpathSync(projectDir));
    assert.equal(runtimeConfig.webAuthToken, "test-token");
  });
});

test("loadRuntimeConfig rejects skipPermissions=true without reason", () => {
  withTempDir((dir) => {
    const projectDir = path.join(dir, "project-a");
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify(
        {
          projects: {
            alpha: {
              path: projectDir,
              skipPermissions: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.throws(() => loadRuntimeConfig(dir), /skipPermissionsReason is required/i);
  });
});

test("loadRuntimeConfig rejects missing project path", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify(
        {
          projects: {
            alpha: {
              path: path.join(dir, "missing"),
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.throws(() => loadRuntimeConfig(dir), /path does not exist/i);
  });
});
