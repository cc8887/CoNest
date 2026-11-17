#!/usr/bin/env bash
# Real Linux image smoke: non-root CLI, private volume, main Runtime without live channels, and restart.
set -euo pipefail
conest_image=${1:?Usage: docker-smoke.sh conest:version}
conest_temporary=$(mktemp -d)
conest_volume=$(docker volume create)
conest_container=''
conest_mock_container=''
cleanup() {
  if [[ -n "$conest_mock_container" ]]; then docker rm -f "$conest_mock_container" >/dev/null 2>&1 || true; fi
  if [[ -n "$conest_container" ]]; then docker rm -f "$conest_container" >/dev/null 2>&1 || true; fi
  docker volume rm "$conest_volume" >/dev/null 2>&1 || true
  rm -rf -- "$conest_temporary"
}
trap cleanup EXIT
mkdir -p "$conest_temporary/deployment/secrets"
cp compose.yml "$conest_temporary/deployment/compose.yml"
cp containers/model-test.env.example "$conest_temporary/deployment/secrets/model-test.env"
docker compose -f "$conest_temporary/deployment/compose.yml" config --quiet
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$conest_image")" == linux/amd64 ]]
[[ "$(docker run --rm --entrypoint id "$conest_image" -u)" == 1000 ]]
docker run --rm "$conest_image" m0 doctor > "$conest_temporary/doctor.json"
python3 - "$conest_temporary/doctor.json" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]));assert value['node']=='v24.22.3' and value['platform']=='linux'
print('Image architecture, non-root user and Node doctor: PASS')
PY
# Start an empty member directory. Disable transport polling; no real credentials or external requests are needed.
docker run --rm --user 0 --entrypoint node -v "$conest_volume:/data" "$conest_image" --input-type=module -e '
import {writeFileSync} from "node:fs";
writeFileSync("/data/no-weixin.yml","- id: dsh-superagent-weixin\n  disabled: true\n",{mode:0o644});'
docker run --rm --read-only --tmpfs /tmp:noexec,nosuid,nodev --entrypoint node "$conest_image" -e '
try { require("/opt/dsh/node_modules/node-addon-require-builtin").getBindingInfo(); console.log("Native loader with noexec temporary storage: PASS") }
catch(error) { console.dir(error,{depth:8});process.exit(1) }'
conest_container=$(docker create --read-only --tmpfs /tmp:size=67108864,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --cpus 2 --network host -v "$conest_volume:/data" \
  -e CONEST_TEST_API_KEY=offline-test-key "$conest_image" start --patch /data/no-weixin.yml)
docker start "$conest_container" >/dev/null
check_ready() {
  local conest_attempt conest_token
  for conest_attempt in {1..90}; do
    docker logs "$conest_container" > "$conest_temporary/runtime.log" 2>&1
    conest_token=$(python3 - "$conest_temporary/runtime.log" <<'PY'
import re,sys
tokens=re.findall(r'[?&]token=([A-Za-z0-9_-]+)',open(sys.argv[1]).read())
print(tokens[-1] if tokens else '')
PY
)
    if [[ -n "$conest_token" ]] && CONEST_SMOKE_TOKEN="$conest_token" python3 -c '
import os,json,urllib.request,http.cookiejar,urllib.error
origin="http://127.0.0.1:3088"
client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
landing=client.open(origin+"/?token="+os.environ["CONEST_SMOKE_TOKEN"],timeout=2)
assert landing.geturl()==origin+"/"
assert b"<title>CoNest" in landing.read()
assert client.open(origin+"/index.html",timeout=2).status==200
headers={"x-orchestrator-request":"1","Origin":origin}
state=json.load(client.open(urllib.request.Request(origin+"/orchestrator/api/state",headers=headers),timeout=2))
assert state["health"]["runtime"]["state"]=="ready" and state["setup"]["problem"] is None and state["load"]["maxWorkers"]==1
registration=origin+"/orchestrator/registration/"
assert b"CoNest" in client.open(registration,timeout=2).read()
assert len(client.open(registration+"assets/portal.js",timeout=2).read())>10000
members=json.load(client.open(urllib.request.Request(registration+"api/members",headers=headers),timeout=2))
assert members["members"]==[] and members["portalOrigin"]=="http://127.0.0.1:3089"
try:
    urllib.request.urlopen(urllib.request.Request(registration+"api/members",headers=headers),timeout=2)
    raise AssertionError("Registration accepted an unauthenticated request")
except urllib.error.HTTPError as error: assert error.code==401
assert b"CoNest" in urllib.request.urlopen("http://127.0.0.1:3089/t/test-member/",timeout=2).read()
' >/dev/null 2>&1; then
      printf '%s\n' 'Fresh web enrollment, signed operator login, personal interface and ready Runtime: PASS'
      return
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$conest_container")" != true ]]; then break; fi
    sleep 1
  done
  python3 - "$conest_temporary/runtime.log" <<'PY'
import re,sys
text=open(sys.argv[1]).read();print(re.sub(r'([?&]token=)[A-Za-z0-9_-]+',r'\1[redacted]',text)[-12000:])
PY
  return 1
}
check_ready
docker restart --time 30 "$conest_container" >/dev/null
check_ready
printf '%s\n' 'Container restart: PASS'

# Exercise the immutable image through real DSH, with only model/iLink I/O replaced. No external network is available.
mkdir -p .artifacts
conest_mock_container=$(docker create --read-only --tmpfs /tmp:size=536870912,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --cpus 2 --network none \
  -v "$PWD/scripts:/opt/conest/scripts:ro" -v "$PWD/tests/fixtures:/opt/conest/tests/fixtures:ro" \
  -e CONEST_MOCK_DSH_BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  -e CONEST_MOCK_REPORT=/tmp/container-mock-report.json -e CONEST_MOCK_DIAGNOSTICS=/tmp/container-mock-diagnostics.json \
  -e CONEST_MOCK_JITTER_MS=37 --entrypoint node "$conest_image" /opt/conest/scripts/mock-runtime.mjs)
conest_mock_status=0
docker start -a "$conest_mock_container" > .artifacts/container-mock.log 2>&1 || conest_mock_status=$?
conest_mock_exit=$(docker inspect --format '{{.State.ExitCode}}' "$conest_mock_container")
if [[ "$conest_mock_exit" != 0 ]]; then conest_mock_status=$conest_mock_exit; fi
if [[ "$conest_mock_status" != 0 ]]; then
  docker cp "$conest_mock_container:/tmp/container-mock-diagnostics.json" .artifacts/container-mock-diagnostics.json >/dev/null 2>&1 || true
  tail -100 .artifacts/container-mock.log
  exit "$conest_mock_status"
fi
docker cp "$conest_mock_container:/tmp/container-mock-report.json" .artifacts/container-mock-report.json >/dev/null
python3 - .artifacts/container-mock-report.json <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
assert value['admittedUsers']==10 and value['privateRouters']==10 and value['tickets']==100 and value['deliveries']==210
assert value['reportToOriginAndReceipt']=='100 matched' and value['replayAndCompletedRestart']=='passed'
print('Linux image: 10 web tenants, 100 Tickets, one shared queue, isolation and original-account receipts: PASS')
PY
