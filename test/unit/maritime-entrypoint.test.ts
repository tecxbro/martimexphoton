import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Request, Response } from "express";
import { test } from "vitest";

import { requireSameOrigin } from "../../src/http/same-origin.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Run the real entrypoint without a database, credentials, or writes to /data.
// Stubs accept only the expected startup calls and capture the child's setting.
function startupOrigins(override?: string): string {
  const bin = mkdtempSync(join(tmpdir(), "maritime-entrypoint-"));
  try {
    writeFileSync(
      join(bin, "mkdir"),
      '#!/bin/sh\n[ "$#" = 3 ] && [ "$1" = -p ] && [ "$2" = /data/codex ] && [ "$3" = /data/workspaces ]\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "node"),
      '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = dist/server.js ] || exit 90\nprintf "%s" "${DASHBOARD_TRUSTED_ORIGINS-unset}"\n',
      { mode: 0o755 },
    );
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      DATABASE_URL: "test-database-not-used",
      DEPLOYMENT_ID: "test-deployment-not-used",
      APP_ENCRYPTION_KEY: "test-key-not-used",
    };
    if (override !== undefined) env["DASHBOARD_TRUSTED_ORIGINS"] = override;
    const result = spawnSync("bash", [join(root, "maritime-entrypoint.sh")], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

function checkOrigin(
  trustedOrigins: readonly string[],
  headers: Record<string, string>,
) {
  let passed = false;
  let status: number | undefined;
  let body: unknown;
  const response = {
    set() { return response; },
    status(value: number) { status = value; return response; },
    json(value: unknown) { body = value; return response; },
  };
  const request = {
    protocol: "http",
    get(name: string) { return headers[name.toLowerCase()]; },
  };
  requireSameOrigin(trustedOrigins)(
    request as unknown as Request,
    response as unknown as Response,
    () => { passed = true; },
  );
  return { passed, status, body };
}

const proxyHeaders = {
  host: "127.0.0.1:18789",
  origin: "https://maritime.sh",
  "sec-fetch-site": "same-origin",
};

const forbidden = {
  passed: false,
  status: 403,
  body: { error: "FORBIDDEN" },
};

test("Maritime startup supplies the dashboard origin when unset", () => {
  assert.equal(startupOrigins(), "https://maritime.sh");
});

test("an explicit empty override disables the Maritime default", () => {
  assert.equal(startupOrigins(""), "");
});

test("an operator override replaces rather than expands the default", () => {
  const origin = "https://dashboard.example";
  assert.equal(startupOrigins(origin), origin);
  assert.deepEqual(checkOrigin([startupOrigins(origin)], proxyHeaders), forbidden);
});

test("an explicit multi-origin list is preserved unchanged", () => {
  const origins = "https://dashboard.example,https://other.example";
  assert.equal(startupOrigins(origins), origins);
});

test("startup does not silently repair invalid operator configuration", () => {
  assert.equal(startupOrigins("*"), "*");
});

test("the startup default lets Maritime proxy requests reach the handler", () => {
  assert.equal(checkOrigin([startupOrigins()], proxyHeaders).passed, true);
});

test("the Maritime default still rejects cross-site fetch metadata", () => {
  assert.deepEqual(checkOrigin([startupOrigins()], {
    ...proxyHeaders,
    "sec-fetch-site": "cross-site",
  }), forbidden);
});

test("the Maritime default does not trust foreign or lookalike origins", () => {
  const trusted = [startupOrigins()];
  for (const origin of [
    "https://untrusted.example",
    "https://maritime.sh.untrusted.example",
    "http://maritime.sh",
    "https://maritime.sh:8443",
    "null",
  ]) {
    assert.deepEqual(checkOrigin(trusted, { ...proxyHeaders, origin }), forbidden);
  }
});

test("the Maritime default still requires an Origin header", () => {
  assert.deepEqual(checkOrigin([startupOrigins()], {
    host: proxyHeaders.host,
    "sec-fetch-site": "same-origin",
  }), forbidden);
});

test("the shared middleware does not trust Maritime by default", () => {
  assert.deepEqual(checkOrigin([], proxyHeaders), forbidden);
});

test("direct service requests still work without extra trusted origins", () => {
  assert.equal(checkOrigin([], {
    host: "agent.onrender.com",
    origin: "https://agent.onrender.com",
    "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin",
  }).passed, true);
});
