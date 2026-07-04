#!/usr/bin/env bash
# LocalStack harness — test the real CDK deploy path without an AWS account.
#
#   scripts/localstack.sh up         start LocalStack container (community edition)
#   scripts/localstack.sh bootstrap  cdklocal bootstrap against LocalStack
#   scripts/localstack.sh deploy     run the standard `npm run deploy` against LocalStack
#   scripts/localstack.sh status     LocalStack health + deployed stacks
#   scripts/localstack.sh down       stop and remove the container
#
# NOTE: community LocalStack does not emulate Bedrock (Agent/KnowledgeBase),
# AppSync Events (Realtime), EventBridge Scheduler, or CloudFront — expect
# those resources to fail or be skipped. DynamoDB, Lambda, SQS, S3, SSM,
# API Gateway, and SES core paths are emulated.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=todo-notes-localstack
ENDPOINT=http://localhost:4566
# 4.4.0 = last community release that runs without LOCALSTACK_AUTH_TOKEN
# (from 2026.03.0 the unified image requires a token — free tier available
# at localstack.cloud; set LOCALSTACK_AUTH_TOKEN + IMAGE=latest to use it).
IMAGE=${LOCALSTACK_IMAGE:-localstack/localstack:4.4.0}

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export AWS_ENDPOINT_URL=$ENDPOINT
export AWS_ENDPOINT_URL_S3=http://s3.localhost.localstack.cloud:4566

case "${1:-}" in
  up)
    if docker ps --format '{{.Names}}' | grep -q "^$CONTAINER$"; then
      echo "LocalStack already running."
    else
      docker rm -f $CONTAINER 2>/dev/null || true
      docker run -d --name $CONTAINER -p 4566:4566 \
        -v /var/run/docker.sock:/var/run/docker.sock \
        ${LOCALSTACK_AUTH_TOKEN:+-e LOCALSTACK_AUTH_TOKEN=$LOCALSTACK_AUTH_TOKEN} \
        "$IMAGE"
    fi
    echo -n "Waiting for LocalStack"
    for _ in $(seq 1 60); do
      if curl -s $ENDPOINT/_localstack/health | grep -q '"cloudformation"'; then
        echo " — ready."
        exit 0
      fi
      echo -n "."
      sleep 2
    done
    echo " — timed out." && exit 1
    ;;

  bootstrap)
    npx cdklocal bootstrap aws://000000000000/$AWS_REGION
    ;;

  deploy)
    # Direct cdklocal deploy. --method=direct skips change sets, whose
    # LocalStack implementation hangs/loses change sets on large templates.
    # LOCALSTACK_DEPLOY=true makes index.cdk.ts strip resources LocalStack
    # can't emulate (ResourceGroups, CloudFront hosting).
    export LOCALSTACK_DEPLOY=true BLOCKS_STAGE=production
    NODE_OPTIONS='--conditions=cdk' npx cdklocal deploy \
      --require-approval never --method=direct \
      --outputs-file .blocks-sandbox/outputs.json \
      --context projectRoot="$PWD"
    # LocalStack parity fixups:
    # 1. CFN drops DynamoDB GSIs — re-add them from the synthesized template.
    python3 scripts/fix-localstack-gsis.py
    # 2. The BlocksSecretsBulk custom resource doesn't persist SSM secrets —
    #    provision them directly (both with and without leading slash; the
    #    runtime looks them up without one). Idempotent: skip if present.
    STACK=$(node -e 'const o=require("./.blocks-sandbox/outputs.json");console.log(Object.keys(o)[0])')
    for secret in auth-jwt-secret live-token-secret; do
      NAME="$STACK-todo-notes-app-$secret"
      if ! aws --endpoint-url=$ENDPOINT ssm get-parameter --name "$NAME" >/dev/null 2>&1; then
        VAL=$(openssl rand -hex 32)
        aws --endpoint-url=$ENDPOINT ssm put-parameter --name "$NAME" --type SecureString --value "$VAL" >/dev/null
        aws --endpoint-url=$ENDPOINT ssm put-parameter --name "/$NAME" --type SecureString --value "$VAL" >/dev/null
        echo "provisioned secret: $NAME"
      fi
    done
    # 3. The BlocksConfigDeployment custom resource doesn't run either —
    #    materialize blocks-config.json (runtime config: SSM param names,
    #    realtime URLs, AsyncJob queue URL) into the config bucket directly.
    python3 - <<'PYEOF'
import json, subprocess
def aws(*a):
    r = subprocess.run(["aws", "--endpoint-url=http://localhost:4566", *a, "--output", "json"],
                       capture_output=True, text=True)
    return json.loads(r.stdout) if r.stdout.strip() else {}
outputs = json.load(open(".blocks-sandbox/outputs.json"))
stack = list(outputs.keys())[0]
# WebSocket APIs are not emulated in community LocalStack — the CFN resource
# is a stub (Ref resolves to "unknown"). Realtime publish is best-effort in
# the app, so a placeholder id is fine.
apis = [a for a in aws("apigatewayv2", "get-apis").get("Items", []) if a.get("ProtocolType") == "WEBSOCKET"]
ws = apis[0]["ApiId"] if apis else "unknown"
q = aws("sqs", "get-queue-url", "--queue-name", f"{stack}-todo-notes-app-assistant-job").get("QueueUrl", "")
host = "execute-api.us-east-1.localhost.localstack.cloud:4566"
cfg = {
    "LOG_LEVEL": "error",
    "BLOCKS_SSM_PARAM_JWT_SECRET": f"/{stack}-todo-notes-app-auth-jwt-secret",
    "BLOCKS_SSM_PARAM_TOKEN_SECRET": f"/{stack}-todo-notes-app-live-token-secret",
    "BLOCKS_RT_WS_URL": f"wss://{ws}.{host}/rt",
    "BLOCKS_RT_CALLBACK_URL": f"https://{ws}.{host}/rt",
    "BLOCKS_QUEUE_URL_" + stack.upper().replace("-", "_") + "_TODO_NOTES_APP_ASSISTANT_JOB": q,
}
bucket = [b["Name"] for b in aws("s3api", "list-buckets")["Buckets"] if "blocksconfig" in b["Name"]][0]
open("/tmp/blocks-config.json", "w").write(json.dumps(cfg))
subprocess.run(["aws", "--endpoint-url=http://localhost:4566", "s3", "cp",
                "/tmp/blocks-config.json", f"s3://{bucket}/blocks-config.json"], check=True)
print("uploaded blocks-config.json ->", bucket)
PYEOF
    # Point the locally-served frontend at the LocalStack API (same thing
    # Blocks' own deploy does with the real AWS API URL).
    node -e '
      const fs = require("fs");
      const outputs = JSON.parse(fs.readFileSync(".blocks-sandbox/outputs.json", "utf-8"));
      const stack = Object.values(outputs)[0];
      const apiUrl = stack.ApiUrl;
      if (!apiUrl) { console.error("No ApiUrl in outputs"); process.exit(1); }
      fs.writeFileSync(".blocks-sandbox/config.json",
        JSON.stringify({ apiUrl, environment: "localstack" }, null, 2));
      console.log("API URL (LocalStack):", apiUrl);
    '
    echo "NOTE: .blocks-sandbox/config.json now points the frontend AND npm run"
    echo "test:e2e at LocalStack. To go back to the local dev server, restore:"
    echo '  {"apiUrl": "http://localhost:3000/aws-blocks/api", "environment": "local"}'
    ;;

  status)
    curl -s $ENDPOINT/_localstack/health | python3 -m json.tool | grep -E '"(available|running)"' -B1 | head -30 || true
    echo "--- stacks ---"
    aws --endpoint-url=$ENDPOINT cloudformation list-stacks \
      --query 'StackSummaries[].{Name:StackName,Status:StackStatus}' --output table 2>/dev/null || true
    ;;

  down)
    docker rm -f $CONTAINER
    ;;

  *)
    echo "Usage: scripts/localstack.sh {up|bootstrap|deploy|status|down}"
    exit 1
    ;;
esac
