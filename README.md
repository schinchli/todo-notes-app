# Instanote

**Catch ideas instantly. Find them anywhere.**

Instanote is a local-first notes application built with AWS Blocks. It combines structured notes, tags, due dates, realtime updates, a daily email digest, searchable help, and an approval-aware AI assistant in one responsive workspace.

The same typed application code runs against local mocks, a LocalStack deployment, or managed AWS services. Local development does not require an AWS account.

## What it does

- Create, search, sort, complete, and delete notes.
- Add details, tags, and due dates to each note.
- Keep each account's notes and settings isolated.
- Synchronize note changes across open clients when realtime transport is available.
- Ask an assistant to search notes, list upcoming work, or explain the app.
- Require explicit approval before the assistant creates or completes a note.
- Search bundled help content through a knowledge base.
- Send an optional 8:00 AM Asia/Kolkata digest of due and overdue notes.
- Send an on-demand test digest from settings before enabling the daily schedule.
- Run locally, deploy to LocalStack, or deploy to AWS without changing application logic.

## Technology

| Layer | Implementation |
|---|---|
| Frontend | TypeScript, Vite, Lit HTML |
| API | AWS Blocks `ApiNamespace` typed RPC |
| Authentication | `AuthBasic` |
| Data | `DistributedTable` / DynamoDB |
| Realtime | `Realtime` / API Gateway WebSocket |
| Assistant | `Agent`, local canned/Ollama provider, Amazon Bedrock on AWS |
| Help search | `KnowledgeBase`, local TF-IDF, Bedrock Knowledge Bases on AWS |
| Scheduling | `CronJob` / EventBridge Scheduler |
| Email | `EmailClient` / Amazon SES |
| Infrastructure | AWS CDK through AWS Blocks |
| Testing | Node test runner and typed end-to-end API tests |

## Requirements

- Node.js 22 or newer
- npm
- Docker for LocalStack testing
- AWS credentials only for sandbox or production AWS deployments
- Optional: Ollama and a tool-capable local model for richer offline responses

## Quick start

```bash
git clone https://github.com/schinchli/todo-notes-app.git
cd todo-notes-app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Local state is stored under `.bb-data/` and is intentionally excluded from Git. The assistant status badge shows its active runtime. The built-in deterministic provider works immediately, stays offline, and keeps agent tools and approvals testable without an external model.

### Offline Notes assistant

For richer local responses, install and start Ollama, pull a tool-capable model, and opt in when starting Instanote:

```bash
ollama serve
ollama pull qwen3:0.6b
INSTANOTE_OLLAMA_MODEL=qwen3:0.6b npm run dev
```

The assistant panel should display `Offline · qwen3:0.6b`. It can chat, search notes, list due items, and propose note changes without AWS credentials or internet access. Creating or completing notes still requires your approval. Model capability varies; keep the built-in default for deterministic development and CI.

Amazon Bedrock AgentCore's local development server reproduces the AgentCore runtime contract, but model inference is only offline when it is paired with a local provider such as Ollama. Instanote uses AWS Blocks' Strands-based Agent locally and Amazon Bedrock when deployed. See [assistant runtimes](docs/assistant.md).

## Validation

Run the complete local quality gate:

```bash
npm run check
```

This command runs TypeScript checking, domain unit tests, a production frontend build, and the full typed end-to-end suite, including realtime delivery, digest email, knowledge retrieval, and assistant conversations.

Useful individual commands:

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local backend and Vite frontend |
| `npm run typecheck` | Validate TypeScript without emitting files |
| `npm run test:unit` | Run pure note-domain tests |
| `npm run test:e2e` | Exercise auth, data, settings, help, and assistant APIs |
| `npm run build` | Build the production frontend |
| `npm run check` | Run every local validation step |
| `npm run spec` | Regenerate the AWS Blocks API specification |

## LocalStack

LocalStack exercises the actual CDK, CloudFormation, API Gateway, Lambda, DynamoDB, SQS, S3, SSM, Scheduler, and SES paths without using an AWS account.

```bash
./scripts/localstack.sh up
./scripts/localstack.sh bootstrap
./scripts/localstack.sh deploy
npm run test:e2e
./scripts/localstack.sh status
```

The deploy command temporarily points `.blocks-sandbox/config.json` at the LocalStack API. Restore local development afterward:

```json
{
  "apiUrl": "http://localhost:3000/aws-blocks/api",
  "environment": "local"
}
```

Community LocalStack does not emulate Bedrock Knowledge Bases, SES v2, CloudFront hosting, or API Gateway WebSockets completely. The app intentionally degrades help search to an empty result, exposes the digest send error, and treats realtime publishing as best-effort in this environment. See [LocalStack details](docs/localstack.md).

## AWS deployment

Bootstrap the target account and region once:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

Then choose a deployment mode:

```bash
npm run sandbox     # AWS backend with frontend served locally
npm run deploy      # production stack including static hosting
```

Destroy temporary or production resources with `npm run sandbox:destroy` or `npm run destroy`.

Before production deployment:

1. Replace `noreply@example.com` in `aws-blocks/index.ts` with a verified SES identity.
2. Request SES production access if recipients should not be restricted to verified identities.
3. Enable access to the configured Bedrock model and verify its availability in the target region.
4. Prefer `AuthCognito` or `AuthOIDC` when MFA, federation, social login, or enterprise identity is required.
5. Run `npm run check`, deploy to a sandbox, and smoke-test auth, assistant approvals, realtime behavior, and digest delivery.

See the full [deployment guide](docs/deployment.md).

## Repository layout

```text
.
├── aws-blocks/
│   ├── index.ts              # Backend blocks, schemas, tools, jobs, and typed API
│   ├── index.cdk.ts          # CDK stack and LocalStack compatibility adjustments
│   ├── index.handler.ts      # Lambda adapter
│   └── scripts/              # AWS Blocks lifecycle entry points
├── docs/
│   ├── architecture.md       # Components, boundaries, data, and request flows
│   ├── assistant.md          # Offline, LocalStack, Bedrock, and AgentCore runtimes
│   ├── deployment.md         # AWS sandbox and production operations
│   ├── development.md        # Local workflow, conventions, and quality gates
│   └── localstack.md         # LocalStack workflow and parity notes
├── knowledge/                # Source documents indexed by KnowledgeBase
├── scripts/
│   ├── localstack.sh         # LocalStack lifecycle and parity fixups
│   └── fix-localstack-gsis.py
├── src/
│   ├── domain/notes.ts       # Note types, filtering, due dates, and summary logic
│   ├── styles/app.css        # Responsive design system and component styling
│   └── main.ts               # Browser UI, auth shell, notes, settings, and assistant
├── test/
│   ├── domain.test.ts        # Pure domain unit tests
│   └── e2e.test.ts           # Typed API end-to-end tests
├── index.html                # Accessible HTML shell
├── package.json              # Scripts and dependencies
└── cdk.json                  # CDK application configuration
```

Generated folders such as `dist/`, `build-temp/`, `.hosting/`, `cdk.out/`, `.bb-data/`, and `.blocks-sandbox/` are not source and are excluded from version control.

## Architecture and security

Every public API method calls `auth.requireAuth` before accessing user data. DynamoDB partition keys use the authenticated username, note writes use optimistic locking, and assistant conversation reads/writes verify ownership. Agent tools receive the authenticated user ID through validated tool context, and tools that modify state require approval.

Inputs are validated at the API boundary for note length, tag limits, due dates, digest email addresses, and assistant message size. Realtime publication is intentionally non-blocking so transport outages cannot roll back successful writes.

For diagrams and detailed execution flows, read [architecture.md](docs/architecture.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Assistant runtimes and offline setup](docs/assistant.md)
- [Development workflow](docs/development.md)
- [Deployment and production checklist](docs/deployment.md)
- [LocalStack workflow and limitations](docs/localstack.md)
- [User getting started guide](knowledge/getting-started.md)
- [User FAQ](knowledge/faq.md)

## Common troubleshooting

- Port 3000 is already in use: run `npm run cleanup`, then restart development.
- Tests target the wrong backend: inspect `.blocks-sandbox/config.json` and restore the local URL shown above.
- Local assistant responses are intentionally concise by default: configure `INSTANOTE_OLLAMA_MODEL` for richer responses from a tool-capable Ollama model.
- LocalStack help search returns no results: Bedrock Knowledge Bases are not emulated; this is expected.
- Production email fails: verify the configured SES identity and confirm the account is out of the SES sandbox.
- Production help search is initially empty: knowledge base ingestion is asynchronous; wait for synchronization before testing retrieval.

## License

No license file is currently included. Add one before distributing the project outside its intended private use.
