# Implement In An AWS Account

This guide shows the path from local development to AWS deployment.

## 1. Prerequisites

- Node.js 22 or newer
- npm
- AWS CLI configured for the target account
- AWS CDK bootstrap permission
- SES sender identity you can verify
- Access to the configured Amazon Bedrock model in your target region
- Optional: Docker for LocalStack validation
- Optional: Ollama for richer local offline assistant responses

## 2. Run Locally First

```bash
git clone https://github.com/schinchli/todo-notes-app.git
cd todo-notes-app
npm install
npm run dev
```

The local runtime uses persistent mocks:

- `DistributedTable` stores local data on disk.
- `Agent` uses a deterministic offline model by default.
- `KnowledgeBase` uses local TF-IDF retrieval.
- `EmailClient` captures email locally.
- `Realtime` uses local realtime plumbing.

No AWS account is required for this step.

## 3. Optional Local AI With Ollama

```bash
ollama serve
ollama pull qwen3:0.6b
INSTANOTE_OLLAMA_MODEL=qwen3:0.6b npm run dev
```

Use this only when you want richer local assistant responses. The deterministic
provider is better for repeatable tests and demos.

## 4. Validate Locally

```bash
npm run check
```

This runs:

- TypeScript checking
- unit tests
- production build
- typed end-to-end tests

## 5. Optional LocalStack Pass

```bash
./scripts/localstack.sh up
./scripts/localstack.sh bootstrap
./scripts/localstack.sh deploy
npm run test:e2e
./scripts/localstack.sh status
```

LocalStack validates the CDK, API Gateway, Lambda, DynamoDB, SQS, S3, SSM,
Scheduler, and SES paths where the community image supports them.

Known gaps are documented in `docs/localstack.md`.

## 6. Configure AWS

Before production deployment:

1. Verify an SES sender identity.
2. Replace or set `INSTANOTE_FROM_ADDRESS` with that verified identity.
3. Enable the configured Bedrock model in your region.
4. Confirm whether WAF fixed monthly cost is acceptable.
5. Decide whether `AuthBasic` is enough or whether to migrate to Cognito/OIDC.

## 7. Bootstrap CDK

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

Use your target account ID and region.

## 8. Deploy

```bash
npm run check
npm run deploy
```

The deployment creates the production stack with frontend hosting, API,
storage, realtime, scheduler, email, AI, security, and secret resources.

## 9. Seed Demo Data

```bash
node scripts/seed-demo.mjs
```

The demo account is hardened:

- it cannot delete seeded notes;
- it cannot redirect digest email;
- it is capped on AI calls;
- credentials are stored outside Git.

## 10. Smoke Test

After deploy, verify:

- sign up and sign in;
- create, complete, search, and sort notes;
- add a reminder;
- click **Plan my day**;
- ask the assistant to create a note and approve it;
- translate a note;
- test text-to-speech;
- send a test digest;
- confirm user isolation.
