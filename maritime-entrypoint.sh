#!/usr/bin/env bash
# Starts the agent on Maritime with no external services.
#
# When DATABASE_URL is unset, runs a local PostgreSQL whose data lives on the
# persistent /data volume. When DEPLOYMENT_ID or APP_ENCRYPTION_KEY is unset,
# generates it once and keeps it on /data so restarts reuse the same value.
# Values set in the environment always win.
set -euo pipefail

# This entrypoint is the Maritime adapter used by the included Dockerfile.
# Maritime serves the dashboard through its authenticated proxy, not the
# container origin. Keep the default here, not in the shared HTTP middleware.
# An explicit override (including an empty string) always wins.
export DASHBOARD_TRUSTED_ORIGINS="${DASHBOARD_TRUSTED_ORIGINS-https://maritime.sh}"

PG_BIN=/usr/lib/postgresql/15/bin
PG_DATA=/data/pg
PG_SOCKET_DIR=/run/postgresql
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DB=imessage_agent
PG_USER=agent
SECRETS_DIR=/data/secrets

as_postgres() {
    runuser -u postgres -- "$@"
}

postgres_is_running() {
    as_postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" status > /dev/null 2>&1
}

start_local_postgres() {
    mkdir -p "$PG_DATA" "$PG_SOCKET_DIR"
    chown postgres:postgres "$PG_DATA" "$PG_SOCKET_DIR"
    chmod 700 "$PG_DATA"

    if [ ! -f "$PG_DATA/PG_VERSION" ]; then
        as_postgres "$PG_BIN/initdb" -D "$PG_DATA" --auth=trust --username=postgres > /dev/null
    fi

    # A restart after an unclean stop leaves a lock file with no live server.
    if ! postgres_is_running; then
        rm -f "$PG_DATA/postmaster.pid"
        as_postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" -w -l "$PG_DATA/server.log" \
            -o "-c listen_addresses=$PG_HOST -c port=$PG_PORT -c unix_socket_directories=$PG_SOCKET_DIR" \
            start > /dev/null
    fi

    psql_admin() {
        as_postgres psql -h "$PG_HOST" -p "$PG_PORT" -U postgres -tAc "$1"
    }
    if [ "$(psql_admin "SELECT 1 FROM pg_roles WHERE rolname = '$PG_USER'")" != "1" ]; then
        psql_admin "CREATE ROLE $PG_USER LOGIN" > /dev/null
    fi
    if [ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'")" != "1" ]; then
        psql_admin "CREATE DATABASE $PG_DB OWNER $PG_USER" > /dev/null
    fi

    export DATABASE_URL="postgresql://$PG_USER@$PG_HOST:$PG_PORT/$PG_DB"
}

# Prints the stored secret, generating it with the given command on first use.
stored_secret() {
    local name="$1"
    shift
    local path="$SECRETS_DIR/$name"
    if [ ! -f "$path" ]; then
        mkdir -p "$SECRETS_DIR"
        chmod 700 "$SECRETS_DIR"
        "$@" > "$path"
        chmod 600 "$path"
    fi
    cat "$path"
}

mkdir -p /data/codex /data/workspaces

if [ -z "${DATABASE_URL:-}" ]; then
    start_local_postgres
fi
if [ -z "${DEPLOYMENT_ID:-}" ]; then
    export DEPLOYMENT_ID="$(stored_secret deployment_id node -e 'console.log(require("node:crypto").randomUUID())')"
fi
if [ -z "${APP_ENCRYPTION_KEY:-}" ]; then
    export APP_ENCRYPTION_KEY="$(stored_secret app_encryption_key openssl rand -base64 32)"
fi

exec node dist/server.js
