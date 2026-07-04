# Architecture

## System overview

Daymark is a single AWS Blocks application. The browser imports a generated typed client, while the backend composes infrastructure-aware blocks inside one scope.

```text
Browser UI
  │ typed RPC + session cookie
  ▼
API Gateway / local server
  ▼
ApiNamespace ── AuthBasic
  ├── DistributedTable: notes
  ├── DistributedTable: profiles
  ├── Realtime: note events
  ├── Agent: conversations, tools, streaming
  ├── KnowledgeBase: bundled help documents
  └── CronJob ── EmailClient: daily digest
```

Local development substitutes persistent local mocks. LocalStack and AWS use synthesized CDK resources.

## Main boundaries

### Frontend

`src/main.ts` owns browser state, AWS Blocks auth UI integration, notes interactions, digest settings, and assistant chat. `src/domain/notes.ts` contains pure note filtering, summary, and due-date logic. `src/styles/app.css` contains the responsive design system.

The frontend never constructs transport payloads or calls service endpoints directly. It imports `api` and `authApi` from `aws-blocks`.

### Backend

`aws-blocks/index.ts` is the composition root. It declares schemas, blocks, assistant tools, the digest job, and the public typed API.

`aws-blocks/index.cdk.ts` creates the Blocks stack, configures sandbox behavior, adds production hosting, and applies LocalStack compatibility adjustments only when `LOCALSTACK_DEPLOY=true`.

### User help content

Files in `knowledge/` are user-facing source documents. Local development indexes them with TF-IDF. AWS deployment ingests them through Bedrock Knowledge Bases.

## Data model

### Notes table

- Partition key: `userId`
- Sort key: `noteId`
- Secondary indexes: `userId + dueDate`, `userId + title`
- Concurrency: integer `version` field with conditional writes
- Dates: epoch milliseconds; `0` represents no due date

### Profiles table

- Partition key: `userId`
- Stores digest email and opt-in status

### Agent persistence

The Agent block manages conversation and message persistence. The API checks the authenticated user's conversation list before read, send, or resume operations.

## Request flows

### Note write

1. Browser calls the typed API.
2. API resolves the authenticated user.
3. Input is validated and normalized.
4. DynamoDB/local table write completes.
5. A best-effort realtime event is published.
6. Browser reloads the sorted note list.

### Assistant request

1. Browser creates an owner-scoped conversation.
2. Browser subscribes to an unguessable realtime channel before sending.
3. API verifies conversation ownership and submits the Agent async job.
4. Agent can call user-scoped tools.
5. State-changing tools pause for explicit approval.
6. Streamed chunks update the browser conversation.

### Daily digest

1. EventBridge Scheduler invokes the shared handler at 8:00 AM Asia/Kolkata.
2. The job scans opted-in profiles.
3. It queries each user's open notes due within 24 hours, including overdue items.
4. EmailClient batches messages through SES.

## Security decisions

- Every application API method requires authentication.
- User identity always comes from the server-side session, never a browser argument.
- User data is partitioned by authenticated username.
- Conversation ownership is checked before message read, send, and resume.
- Mutating assistant tools require approval.
- API inputs have runtime validation and size limits.
- Errors for unauthorized conversation IDs use a non-enumerating `Not found` response.

`AuthBasic` is suitable for this MVP and local workflow. Use Cognito or OIDC for MFA, federation, advanced recovery, or enterprise policies.
