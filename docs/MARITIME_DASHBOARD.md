# Maritime dashboard startup

## No extra setup for Maritime users

Deploy this repository's Dockerfile on Maritime and open the agent Dashboard.
The Dockerfile runs `maritime-entrypoint.sh`, which supplies the exact origin
`https://maritime.sh` before starting Node when `DASHBOARD_TRUSTED_ORIGINS` is
unset. No user-entered environment variable or special deploy link is required.

The browser uses Maritime's origin while the application runs behind its
proxy. The existing origin check must allow that known dashboard origin.
The default belongs in this repository's Maritime startup adapter, not in the
shared environment schema or HTTP middleware.

## What the setting means

`DASHBOARD_TRUSTED_ORIGINS` lists extra browser origins allowed to submit setup
requests. An origin is a scheme, hostname, and optional port, not an agent ID
or URL path. This is not a password, authentication, or a CORS wildcard.
Maritime's proxy must still authenticate and authorize access to the agent.
The application still rejects missing or foreign origins and cross-site
`Sec-Fetch-Site` metadata.

Explicit operator configuration always wins. A custom comma-separated list
replaces the default; an explicitly empty value disables it. Invalid values
are left for the existing environment validation to reject, not silently
replaced. Never reflect arbitrary request origins or disable the checks.

## Render and other hosts

The shared environment loader still defaults to an empty extra-origin list.
Direct `npm start` / `node dist/server.js` does not add Maritime as trusted.
Normal Render deployments accessed through their own service URL use the
existing same-origin path and need no extra trusted origin. The separate
Render repositories are unchanged.

This is an entrypoint-specific default, not automatic host detection. When
reusing this repository's Dockerfile outside Maritime, explicitly set
`DASHBOARD_TRUSTED_ORIGINS=""` unless that host also uses a reviewed,
authenticated dashboard proxy that requires an exact origin override.

## Existing deployments

Rebuild and deploy the updated revision on the same Maritime agent, preserving
its environment, database, deployment identity, encryption key, and `/data`.
Restarting an old image does not install this code change. An existing explicit
override, including an empty string, is intentionally not overwritten.

After deployment, verify the browser owner-save flow. An empty JSON test body
sent to `POST /api/setup/owner` with `Origin: https://maritime.sh` and
`Sec-Fetch-Site: same-origin` should pass origin checking and then return
`400 {"error":"INVALID_REQUEST"}` without saving an owner. Foreign-origin or
cross-site requests should still return `403 {"error":"FORBIDDEN"}`.
The localhost probe alone does not prove the live proxy path.

## Regression checks

```bash
bash -n maritime-entrypoint.sh
npm test -- test/unit/maritime-entrypoint.test.ts test/security/public-dashboard-http.test.ts
```

The new entrypoint tests execute the actual startup script with inert command
stubs, so they do not open a database or write to `/data`. They cover the
no-variable startup, explicit overrides, shared middleware defaults, direct
service requests, and missing/foreign/cross-site request rejection. A live
Maritime browser check remains separate from offline tests.
