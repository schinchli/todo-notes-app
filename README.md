# Todo Notes — AWS Blocks demo

Notes app with tags, due dates, an AI assistant, and a daily email digest.
Built entirely on [AWS Blocks](https://docs.aws.amazon.com/blocks/): every
feature runs fully local (no AWS account) and deploys to managed AWS services
with zero code changes.

## Features → Blocks

| Feature | Block | Local | On AWS |
|---|---|---|---|
| Notes CRUD (tags, due dates, optimistic locking) | `DistributedTable` | in-memory / `.bb-data` | DynamoDB + GSIs |
| Sign-in, per-user isolation | `AuthBasic` | local JWT | DynamoDB-backed users |
| Live sync across tabs | `Realtime` | local WebSocket | API Gateway WebSocket |
| AI assistant (search notes, list due, create/complete with approval) | `Agent` | canned provider, or Ollama `llama3.1:8b` if running | Bedrock Claude Sonnet (global inference profile) |
| Help search ("how does X work?") | `KnowledgeBase` over `./knowledge` | TF-IDF | Bedrock Knowledge Bases + S3 Vectors |
| Daily due-notes digest, 8 AM IST | `CronJob` | in-process timer | EventBridge Scheduler |
| Digest delivery | `EmailClient` | captured to console + `.bb-data/**/emails.json` | Amazon SES |

## Run locally (no AWS account)

```bash
npm install
npm run dev        # http://localhost:3000
npm run test:e2e   # e2e tests against the same typed client the UI uses
npm run typecheck  # TypeScript type checking
npm run check      # typecheck + production build + full e2e suite
```

Optional: run `ollama serve` + `ollama pull llama3.1:8b` for real local LLM
responses; otherwise the assistant uses the built-in canned provider.

## Deploy to LocalStack (real deploy path, no AWS account)

Tests the actual CDK/CloudFormation deployment against emulated AWS on
`localhost:4566`. Requires Docker (colima works).

```bash
./scripts/localstack.sh up          # start LocalStack 4.4.0 (last token-free release)
./scripts/localstack.sh bootstrap   # cdklocal bootstrap
./scripts/localstack.sh deploy      # deploy + parity fixups + config upload
./scripts/localstack.sh status      # health + stacks
./scripts/localstack.sh down        # stop container
```

What works on community LocalStack: full CRUD API (API Gateway → Lambda →
DynamoDB with GSIs), auth/JWT sessions, per-user settings, and the AI
assistant end-to-end via SQS → Lambda (canned model — Bedrock isn't emulated).

Known parity gaps handled automatically by `scripts/localstack.sh` and the
`LOCALSTACK_DEPLOY=true` branch in `aws-blocks/index.cdk.ts`:

| Gap | Handling |
|---|---|
| `latest` image requires a license (since 2026-03) | pinned to `4.4.0`; set `LOCALSTACK_AUTH_TOKEN` + `LOCALSTACK_IMAGE=localstack/localstack:latest` to use a free-tier token |
| CFN change sets hang / vanish | `--method=direct` deploy |
| `AWS::ResourceGroups::Group` mock rejects its query JSON | stripped at synth |
| CloudFront (Hosting) not emulated | skipped at synth; frontend served locally |
| Bedrock KnowledgeBase not emulated (Ref → `"unknown"`) | KB block skipped; help search degrades gracefully |
| `nodejs24.x` runtime unknown to LocalStack 4.4 | downgraded to `nodejs22.x` at synth |
| Custom resources (secrets, GSIs, config upload) silently no-op | re-done post-deploy by the script |
| API Gateway WebSockets (Realtime) not emulated | `rt.publish` is best-effort in app code |

## Deploy to AWS

One-time: configure AWS CLI credentials, then bootstrap CDK:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

Then:

```bash
npm run sandbox           # fast ephemeral backend on AWS, frontend served locally
npm run deploy            # full CloudFormation deploy (hosting included)
npm run sandbox:destroy   # tear down sandbox resources
npm run destroy           # tear down production stack
```

Before production use:

- **SES**: verify the `fromAddress` in `aws-blocks/index.ts` (currently
  `noreply@example.com`) as an SES identity, and request production access to
  leave the SES sandbox.
- **Bedrock**: enable model access for the Claude models
  (the agent uses the `BedrockModels.BALANCED` global inference profile).
- Knowledge base ingestion runs asynchronously after deploy — gate on
  `kb.waitUntilSynced()` or check the Bedrock console.

## Project structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Backend: Blocks, API, agent tools, cron digest |
| `src/index.ts` | Frontend: lit-html notes UI, settings, assistant chat |
| `knowledge/` | Help docs ingested by the KnowledgeBase |
| `test/e2e.test.ts` | E2E suite: auth, CRUD, settings, KB, agent |
| `index.html` | HTML shell |

## Frontend experience

The responsive Daymark workspace includes quick capture, local search and
status filters, due-date context, digest settings, and an approval-aware
assistant panel. Draft inputs survive realtime and assistant redraws, and the
interface includes explicit loading, empty, error, and success states.

Keyboard focus, semantic labels, reduced-motion preferences, and mobile layouts
are supported. Destructive deletes require confirmation; agent tools that write
data continue to use the Blocks approval flow.

## Production checklist

- Replace `AuthBasic` with `AuthCognito` or `AuthOIDC` if the app needs MFA,
  social sign-in, federation, or enterprise identity controls.
- Configure and verify the SES sender currently represented by
  `noreply@example.com`, then request SES production access.
- Enable the selected Bedrock model and confirm regional availability and
  quotas in the deployment account.
- Run `npm run check`, deploy to a sandbox, and smoke-test auth, agent approval,
  realtime updates, and digest delivery before promoting to production.

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## For Agents

Full Building Block documentation: `node_modules/@aws-blocks/blocks/README.md`

**Do not use local files or in-memory storage** — use Building Blocks for all data persistence and cloud abstractions (they mock locally and deploy to AWS automatically).

Start in `aws-blocks/index.ts` (backend) and `src/index.ts` (frontend). Test via `npm run test:e2e`. The API transport (JSON-RPC) is auto-generated and intentionally invisible — do not curl endpoints directly. Testing is best done through the e2e tests which use the same typed client as the frontend.
