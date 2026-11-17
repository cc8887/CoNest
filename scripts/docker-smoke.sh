#!/usr/bin/env bash
# Real Linux image smoke: non-root CLI, private volume, main Runtime without live channels, and restart.
set -euo pipefail
conest_image=${1:?Usage: docker-smoke.sh conest:version}
conest_temporary=$(mktemp -d)
conest_volume=$(docker volume create)
conest_container=''
cleanup() {
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
# This account is a fixture. Disable the Source before startup so it never contacts iLink.
docker run --rm --user 0 --entrypoint node -v "$conest_volume:/data" "$conest_image" --input-type=module -e '
import {writeFileSync,chownSync} from "node:fs";
writeFileSync("/data/weixin-account.json",JSON.stringify({id:"offline-bot",ownerId:"offline-owner",token:"offline-test-token",baseURL:"https://ilinkai.weixin.qq.com/"}),{mode:0o600});
chownSync("/data/weixin-account.json",1000,1000);
writeFileSync("/data/no-weixin.yml","- id: dsh-superagent-weixin\n  disabled: true\n",{mode:0o644});'
docker run --rm -v "$conest_volume:/data" "$conest_image" init
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
import os,json,urllib.request
url="http://127.0.0.1:3088/orchestrator/api/state?token="+os.environ["CONEST_SMOKE_TOKEN"]
request=urllib.request.Request(url,headers={"x-orchestrator-request":"1"})
state=json.load(urllib.request.urlopen(request,timeout=2))
assert state["health"]["runtime"]["state"]=="ready" and state["setup"]["problem"] is None and state["load"]["maxWorkers"]==1
' >/dev/null 2>&1; then
      printf '%s\n' 'Main Runtime ready without GitHub or live channel traffic: PASS'
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
