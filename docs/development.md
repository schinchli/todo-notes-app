# Development

## Setup

```bash
npm install
npm run dev
```

The development server runs the AWS Blocks local implementations and Vite at `http://localhost:3000`. Data persists in `.bb-data/`.

## Change workflow

1. Put infrastructure, data, auth, agent, and API work in `aws-blocks/`.
2. Put browser behavior in `src/main.ts`.
3. Put pure note-domain logic in `src/domain/` and add unit coverage.
4. Put visual changes in `src/styles/` and verify desktop and mobile layouts.
5. Update `knowledge/` for user-facing help content.
6. Update `docs/` and the README when behavior or operations change.
7. Run `npm run check` before committing.

## Conventions

- Use AWS Blocks for persistence and cloud abstractions.
- Call the generated typed client; do not hand-build JSON-RPC requests.
- Authenticate every new `ApiNamespace` method.
- Derive user identity from the server session.
- Validate external input before persistence or background submission.
- Use conditional writes for read-modify-write operations.
- Keep realtime delivery best-effort when the durable write already succeeded.
- Require agent approval for state-changing tools.
- Keep domain helpers deterministic and independent of DOM or network APIs.

## Tests

`test/domain.test.ts` covers pure filtering, summaries, and date presentation. `test/e2e.test.ts` uses the same generated client as the UI and covers auth, user isolation, CRUD, indexes, locking, settings, help retrieval, agent persistence, and conversation authorization.

```bash
npm run test:unit
npm run test:e2e
npm run check
```

The E2E test starts a local server when one is not already running. When `.blocks-sandbox/config.json` targets LocalStack, the same suite runs against API Gateway and Lambda.

## Generated files

Do not commit runtime state or build output:

- `.bb-data/`
- `.blocks-sandbox/`
- `.hosting/`
- `build-temp/`
- `cdk.out/`
- `dist/`
- generated AWS Blocks client/spec files

CDK synthesis and production builds recreate everything they need.
