#!/usr/bin/env bash
# Tests deploy/squid/squid.conf: CONNECT to registry.npmjs.org:443 works,
# everything else is refused. Needs internet access (it really connects).
#
#   deploy/squid/test.sh
#   TEST_SUBNET=10.250.81.0/24 deploy/squid/test.sh   # if Docker's address pools are full
#
# Starts the pinned squid image with this config on a throwaway network, and a
# curl client next to it; both are removed on exit. On the server you can also
# test the live proxy from a builder's point of view:
#   docker run --rm --network oojam_builder_net curlimages/curl:8.11.1 \
#     -sS -o /dev/null -w '%{http_code}\n' -x http://egress:3128 https://registry.npmjs.org/-/ping
set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SQUID_IMAGE=${SQUID_IMAGE:-ubuntu/squid:6.6-24.04_edge@sha256:8a3baed477e2c282ab8aa5edad442f69873246964f225c5c2ae8364b6610963c}
CURL_IMAGE=${CURL_IMAGE:-curlimages/curl:8.11.1}
RUN_ID=oojam-squid-test-$$
NET=$RUN_ID

pass=0
fail=0
cleanup() {
  docker rm -f "$RUN_ID-egress" "$RUN_ID-client" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -n ${TEST_SUBNET:-} ]]; then
  docker network create --subnet "$TEST_SUBNET" "$NET" >/dev/null
else
  docker network create "$NET" >/dev/null
fi
docker run -d --name "$RUN_ID-egress" --network "$NET" --network-alias egress \
  -v "$HERE/squid.conf:/etc/squid/squid.conf:ro" "$SQUID_IMAGE" >/dev/null
docker run -d --name "$RUN_ID-client" --network "$NET" --entrypoint sleep "$CURL_IMAGE" infinity >/dev/null

for i in $(seq 1 30); do
  if docker exec "$RUN_ID-client" sh -c 'nc -z egress 3128' 2>/dev/null; then break; fi
  if [[ $(docker inspect -f '{{.State.Running}}' "$RUN_ID-egress") != true || $i == 30 ]]; then
    echo "squid did not start:"; docker logs "$RUN_ID-egress" 2>&1 | tail -n 30; exit 1
  fi
  sleep 1
done

# check NAME EXPECTED_CODE URL — the HTTP status curl ends up with through the proxy
# (for a refused CONNECT that is the proxy's 403; curl exits non-zero then).
check() {
  local name=$1 expected=$2 url=$3 code
  code=$(docker exec "$RUN_ID-client" curl -sS -o /dev/null --max-time 20 -w '%{http_code}' \
    -x http://egress:3128 "$url" 2>/dev/null || true)
  # When CONNECT is refused curl reports the tunnel's status as 000 and the
  # proxy's in http_connect.
  if [[ $code == 000 ]]; then
    code=$(docker exec "$RUN_ID-client" curl -sS -o /dev/null --max-time 20 -w '%{http_connect}' \
      -x http://egress:3128 "$url" 2>/dev/null || true)
  fi
  if [[ $code == "$expected" ]]; then
    echo "PASS  $name ($code)"; pass=$((pass + 1))
  else
    echo "FAIL  $name (expected $expected, got $code)"; fail=$((fail + 1))
  fi
}

check "CONNECT registry.npmjs.org:443"                  200 https://registry.npmjs.org/-/ping
check "package metadata"                                200 https://registry.npmjs.org/left-pad
check "CONNECT github.com:443 refused"                  403 https://github.com/
check "CONNECT api.anthropic.com:443 refused"           403 https://api.anthropic.com/
check "CONNECT registry.yarnpkg.com:443 refused"        403 https://registry.yarnpkg.com/
check "plain-HTTP proxying refused"                     403 http://registry.npmjs.org/-/ping
check "CONNECT registry.npmjs.org on another port"      403 https://registry.npmjs.org:8443/
check "cloud metadata refused"                          403 http://169.254.169.254/hetzner/v1/metadata

echo
docker logs "$RUN_ID-egress" 2>&1 | grep -E 'TCP_DENIED|TCP_TUNNEL' | tail -n 8 || true
echo
if [[ $fail -eq 0 ]]; then
  echo "all $((pass + fail)) checks passed"
else
  echo "$fail of $((pass + fail)) checks failed"; exit 1
fi
