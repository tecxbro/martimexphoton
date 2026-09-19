# Deploy the iMessage Codex Agent

This guide deploys the included Dockerfile with PostgreSQL and persistent storage, then connects the first authorized iMessage. The executable production runtime is composed. Clean deployment and protected live-provider evidence remain separate release checks.

## 1. Container deployment

Build the included [`Dockerfile`](../Dockerfile) from the repository root:

```bash
docker build -t imessage-codex-agent .
```

Configure your hosting environment with:

- one long-running container instance with an HTTPS service URL;
- one PostgreSQL database (13 or newer); and
- one persistent volume mounted at `/data` and writable by the service user.

Supply the infrastructure environment values in section 4 before starting the service. The owner phone, Photon, and ChatGPT are configured from the deployed dashboard.

The Dockerfile installs pinned dependencies with development and optional packages, builds TypeScript, and starts `maritime-entrypoint.sh`, which then runs `node dist/server.js` (the same entrypoint as `npm start`). Startup applies the checked-in database migrations.

When `DATABASE_URL` is unset, the entrypoint starts a local PostgreSQL 15 with its data under `/data/pg`. When `DEPLOYMENT_ID` or `APP_ENCRYPTION_KEY` is unset, it generates the value once and stores it under `/data/secrets`, so restarts keep the same identity. Values set in the environment always win. A host that provides only a persistent `/data` volume, such as Maritime, needs no other resources. The Maritime deploy button also sets `DASHBOARD_TRUSTED_ORIGINS` so the setup page works inside the Maritime agent Dashboard. Keep `.npmrc`: the Dockerfile explicitly copies it. Use `/healthz` for liveness, and supply `PORT` if your host requires a port other than the default `10000`. The service URL opens the setup dashboard.

### Webhook intake for hosts that put the agent to sleep

The default intake holds a persistent `app.messages` stream. A host that snapshots and stops an idle agent, such as Maritime with auto-sleep, cannot hold that stream, and nothing wakes the agent when a message arrives. For those hosts only, set `SPECTRUM_INTAKE_MODE=webhook`:

1. Register a webhook with Spectrum for the project (`POST https://spectrum.photon.codes/projects/$PROJECT_ID/webhooks/`, see <https://photon.codes/docs/webhooks/quickstart>). The URL is the host's public address for the path `/webhooks/spectrum`. Save the signing secret. Spectrum shows it one time.
2. Set `SPECTRUM_WEBHOOK_SECRET` to that secret and `SPECTRUM_INTAKE_MODE=webhook`, then restart.
3. On Maritime, set the agent's signed webhook address to the path `webhooks/spectrum` with the same secret. Maritime checks the signature before it wakes the agent, and this service checks it again.

In webhook mode the service never opens the stream, because Spectrum delivers to a registered webhook and to an open stream at the same time. Deliveries are at-least-once; the durable inbound consumer already ignores a message it has seen. Spectrum waits 30 seconds per attempt and makes 6 attempts, and it has no dead-letter queue, so a host wake that takes longer than that loses the message. Hosts that keep the agent running should keep the default stream mode.

## 2. Required accounts and credentials

| Requirement | Why it is needed | Where to obtain it |
|---|---|---|
| Hosting environment | Runs a long-lived container with PostgreSQL and a persistent volume | Your infrastructure provider |
| Photon account | Creates or connects the Spectrum project, iMessage line, and persistent message stream | Photon dashboard |
| Allowed owner phone | Restricts who can command the agent | Your personal phone number |
| ChatGPT device login or OpenAI API key | Authenticates Codex | ChatGPT account security or OpenAI Platform |
| Supermemory API key | Optional semantic memory | Supermemory dashboard |

In the dashboard, U.S. owners enter a normal 10-digit phone number; `+1` is added automatically, though pasting a complete `+1` number also works. International owners select **Not in the U.S.?**, choose their country, and enter either a national or complete international number. The server validates the selected country and stores only normalized E.164. The result becomes the only authorized sender and the phone registered during Photon owner provisioning. Photon separately assigns the iMessage destination displayed at completion.

Never place credentials in source control, screenshots, tickets, database rows, Supermemory, or logs.

## 3. Resources

Provision these resources through your hosting environment:

| Resource | Required shape | Purpose |
|---|---|---|
| Service | One long-running container | Setup dashboard, health HTTP, queue workers, Codex runtime, Spectrum loop |
| PostgreSQL | Version 13 or newer, reachable from the service | Operational source of truth and pg-boss queue |
| Persistent volume | Mounted at `/data` | Codex credentials, sessions, and workspaces |

Size the service, database, and volume for your workload. The volume makes this version single-instance; horizontal scaling requires redesigning credential and workspace ownership. Control rollout from your own reviewed checkout.

## 4. Environment values during deployment

Configure these values before startup:

- `DATABASE_URL` as the PostgreSQL connection secret;
- `DEPLOYMENT_ID` as an explicit stable UUID;
- `APP_ENCRYPTION_KEY` as a stable 32-byte encryption secret;
- `CODEX_HOME=/data/codex`;
- `AGENT_WORKSPACE_ROOT=/data/workspaces`; and
- `CODEX_AUTH_MODE=chatgpt`.

For a **new deployment only**, generate a UUID with `node -e 'console.log(require("node:crypto").randomUUID())'` and an encryption key with `openssl rand -base64 32`. Save both in the service configuration and preserve them across restarts. Never regenerate them when attaching existing application data. The phone stays in the dashboard.

### Preserve an existing deployment UUID

Before replacing a version that derives its UUID from `RENDER_SERVICE_ID`, run this command in that version's private service shell, from its application directory:

```bash
node --input-type=module -e 'import { loadEnvironment } from "./dist/config/env.js"; console.log(loadEnvironment().DEPLOYMENT_ID)'
```

This prints only the effective deployment UUID. Capture it in your private deployment configuration and set `DEPLOYMENT_ID` to that exact UUID before upgrading or moving hosts. Preserve the existing `APP_ENCRYPTION_KEY`, PostgreSQL data, and Codex/workspace volume as well. If the old shell is unavailable, recover the correct deployment row from PostgreSQL through a trusted operator; do not guess or generate a replacement UUID. Changing the UUID would change database and memory namespaces.

See [Configuration](./CONFIGURATION.md) for every supported variable.

## 5. Setup dashboard

1. Open the deployed Web Service URL in a trusted browser.
2. Save the owner's phone, complete Photon setup, and then complete ChatGPT setup.

Dashboard setup mutations require a matching `Origin` and a non-cross-site
fetch context.

Owner status returns only a masked phone, and the write route never echoes the submitted raw number. Photon setup is unavailable until an owner is stored. Raw provider credentials, project secrets, Codex credentials, database credentials, and unrestricted provider errors remain server-side.

## 6. ChatGPT device-login flow

The default mode is `CODEX_AUTH_MODE=chatgpt`.

1. Enable device-code login in the ChatGPT account or workspace if required.
2. Open the deployed service URL.
3. Save the owner phone and complete Photon authentication on the agent dashboard.
4. Select **Connect ChatGPT**, open the device-auth popup, sign in, and enter the one-time code.
5. Keep the dashboard open. It closes the popup when the browser permits, returns focus to setup, and shows Codex preparing.
6. Confirm the dashboard reaches **Your agent is ready** and `/readyz` returns HTTP 200.

Credentials persist under `/data/codex`. Do not print or copy `$CODEX_HOME/auth.json`. The private service shell remains an operator recovery path if permissions need repair:

```bash
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
npm run codex:status
```

## 7. API-key authentication flow

API-key mode uses OpenAI Platform billing and does not use a ChatGPT device login.

1. Add `OPENAI_API_KEY` as a service secret.
2. Set `CODEX_AUTH_MODE=api_key`.
3. Rebuild and deploy the Web Service.
4. Check the dashboard or `/readyz` for authentication and capability state.

Do not run `npm run codex:login` in this mode. The runtime passes `OPENAI_API_KEY` only to the Codex child process through an explicit allowlist; it must not be written to the disk or logged.

## 8. Readiness verification

Check the generated service URL:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected results:

- `/healthz` returns HTTP 200 when the HTTP process is alive.
- `/readyz` returns HTTP 200 only when configuration, storage, PostgreSQL, migrations, queue, owner identity, Codex authentication, Codex capabilities, and Spectrum are ready.
- `/readyz` returns HTTP 503 with a detailed component snapshot and bounded remediation actions when setup is incomplete or a critical dependency is degraded.
- A fresh deployment before owner setup is expected to return `/healthz` 200 and `/readyz` 503.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

The readiness response includes component states, bounded error codes, and remediation actions. It never includes raw owner phone values, credentials, private paths, or unrestricted provider errors. Do not use `/healthz` as deployment acceptance.

## 9. First-message test

Only start after `/readyz` returns 200.

1. Send a direct iMessage from the configured owner phone number.
2. Confirm one terminal response is delivered.
3. Send from an unauthorized handle and confirm zero Codex child processes start.
4. Restart the Web Service normally.
5. Wait for `/readyz` to return 200 and send a follow-up.
6. Record the exact commit, hosting release ID, timestamps, redacted readiness responses, and provider paths actually exercised in [`../test/e2e/render-smoke.md`](../test/e2e/render-smoke.md).

Offline unit, integration, and chaos tests do not prove a live deployment, Photon, Codex, or Supermemory path.

## 10. Updating an existing deployment

1. Review the incoming commit and new migration notes.
2. Confirm a database recovery point exists.
3. Run the repository's required checks, including `npm run docs:check` and `npm run build`.
4. Preserve the deployment UUID as described in section 4, then deploy the reviewed revision.
5. Confirm startup migrations succeed before accepting messages.
6. Require `/healthz` and `/readyz` to return 200.
7. Run one authorized non-mutating message and one restart follow-up.

Before deploying this version, delete both former dashboard credential variables from the existing service; startup rejects either obsolete key, even when empty. An active database owner wins. If none exists, the runtime imports `OWNER_PHONE_NUMBER`, then the former long Render alias, then one unambiguous E.164 `AGENT_OWNER_HANDLES` value. It never imports authorization from stored Photon metadata and never overwrites a database owner on later restarts. Multiple handles or a non-phone handle require the user to open the dashboard and save the intended phone. After verifying migration, old owner environment values may be removed manually.

## 11. Rollback

Application rollback and schema rollback are separate decisions.

1. Stop new execution and allow graceful shutdown to checkpoint state.
2. Record the current and target application commits.
3. Read every intervening migration `.notes.md` file.
4. Deploy the prior revision only if it is compatible with the current schema.
5. Preserve PostgreSQL, pg-boss state, the persistent disk, and outbound cursors.
6. Restart, run reconciliation, verify both health endpoints, and send one authorized non-mutating message.

Do not run an improvised down migration or delete pg-boss tables, durable messages, outbound cursors, Codex credentials, or workspaces. If compatibility is uncertain, roll forward with a fix or restore application and database together to a matched recovery point.

For incident and provider-outage procedures, use [Operations](./OPERATIONS.md). For visible deployment failures, use [Troubleshooting](./TROUBLESHOOTING.md).
