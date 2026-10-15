# shellcheck shell=bash
# Shared helpers for deploy/bin/*. Sourced, not run.
# shellcheck disable=SC2034 # variables here are used by the scripts that source it

set -Eeuo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLATFORM_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
ENV_FILE=${OOJAM_ENV_FILE:-$DEPLOY_DIR/.env}
DATA_DIR=/opt/oojam/data
BACKUP_DIR=$DATA_DIR/backups

if [[ -t 2 ]]; then
  _bold=$'\033[1m' _red=$'\033[31m' _yellow=$'\033[33m' _reset=$'\033[0m'
else
  _bold='' _red='' _yellow='' _reset=''
fi

log() { printf '%s==> %s%s\n' "$_bold" "$*" "$_reset" >&2; }
warn() { printf '%swarning:%s %s\n' "$_yellow" "$_reset" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$_red" "$_reset" "$*" >&2; exit 1; }

# env_get NAME — the value of NAME in .env (last one wins, taken literally).
env_get() {
  [[ -f $ENV_FILE ]] || die "$ENV_FILE not found (run bin/bootstrap first)"
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# env_set NAME VALUE — replace NAME's line in .env (or append it).
env_set() {
  local name=$1 value=$2 tmp
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  awk -v k="$name" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

random_secret() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" --env-file "$ENV_FILE" "$@"
}

# su_psql ARGS… — psql as the superuser, over the socket inside the postgres container.
su_psql() {
  compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U postgres "$@"
}

# wait_healthy SERVICE [TIMEOUT_SECONDS]
wait_healthy() {
  local service=$1 timeout=${2:-180} id status i
  for ((i = 0; i < timeout; i += 2)); do
    id=$(compose ps -q "$service" 2>/dev/null || true)
    if [[ -n $id ]]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      [[ $status == healthy || $status == running ]] && return 0
    fi
    sleep 2
  done
  die "$service not healthy after ${timeout}s (docker compose logs $service)"
}

# confirm WORD PROMPT — the operator must type WORD to continue (OOJAM_YES=1 skips).
confirm() {
  local word=$1 prompt=$2 answer
  [[ ${OOJAM_YES:-} == 1 ]] && return 0
  [[ -t 0 ]] || die "needs confirmation; run interactively (or set OOJAM_YES=1)"
  printf '%s\nType %s%s%s to continue: ' "$prompt" "$_bold" "$word" "$_reset" >&2
  read -r answer
  [[ $answer == "$word" ]] || die "aborted"
}

# The platform and builder images are built with the platform repo as context,
# which contains deploy/.env and deploy/secrets/. Refuse to build unless the
# root .dockerignore keeps them (and infra/) out of every image.
check_dockerignore() {
  local f=$PLATFORM_DIR/.dockerignore missing=()
  [[ -f $f ]] || die "$f is missing: images built from $PLATFORM_DIR would contain deploy/.env and deploy/secrets"
  # Excluding all of deploy/ is fine too.
  if grep -Eq '^/?deploy/?(\*\*?)?$' "$f"; then
    return 0
  fi
  local pattern
  for pattern in 'deploy/.env' 'deploy/secrets'; do
    grep -Eq "^/?${pattern//./\\.}(/|\\*|\$)" "$f" || missing+=("$pattern")
  done
  if ((${#missing[@]})); then
    die "$f must exclude: ${missing[*]} (else secrets end up inside the platform/builder images)"
  fi
}

# Running dynamic containers (SPEC §3.2) that a restart of the worker would orphan.
busy_containers() {
  docker ps --format '{{.Names}}' | grep -E '^oojam-(build|smoke)-' || true
}

# The worker runs throwaway `postgres:17` containers (pre-deploy pg_dump, smoke
# DB). Point that tag at the digest-pinned image compose uses, so it is never
# pulled unpinned from Docker Hub.
tag_postgres_alias() {
  local pinned
  pinned=$(sed -n 's/^ *image: \(postgres:[^ ]*@sha256:[0-9a-f]*\)$/\1/p' "$DEPLOY_DIR/compose.yml" | head -n 1)
  [[ -n $pinned ]] || die "no pinned postgres image in compose.yml"
  docker image inspect "$pinned" >/dev/null 2>&1 || docker pull -q "$pinned" >/dev/null
  docker tag "$pinned" postgres:17
}

# The builder image (SPEC §4.1). builder/Dockerfile uses builder/ as its context.
build_builder() { # tag…
  local args=() t
  for t in "$@"; do args+=(-t "$t"); done
  docker build --pull "${args[@]}" -f "$PLATFORM_DIR/builder/Dockerfile" "$PLATFORM_DIR/builder"
}
