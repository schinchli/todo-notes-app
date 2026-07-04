# LocalStack

## Purpose

LocalStack validates the real synthesized deployment path without an AWS account. It is slower than local mocks but catches CDK, packaging, API Gateway, Lambda, DynamoDB index, SQS, S3, SSM, and environment configuration issues.

## Workflow

```bash
./scripts/localstack.sh up
./scripts/localstack.sh bootstrap
./scripts/localstack.sh deploy
npm run test:e2e
./scripts/localstack.sh status
```

Stop the container with:

```bash
./scripts/localstack.sh down
```

The harness defaults to LocalStack 4.4.0, the last token-free community image used by this project. Override `LOCALSTACK_IMAGE` and provide `LOCALSTACK_AUTH_TOKEN` when testing a newer licensed image.

## Compatibility adjustments

The harness and `aws-blocks/index.cdk.ts` apply only to LocalStack deployments:

- Use direct CloudFormation deployment instead of change sets.
- Remove the unsupported Resource Groups helper.
- Skip CloudFront hosting and Bedrock KnowledgeBase resources.
- Downgrade unsupported `nodejs24.x` functions to `nodejs22.x` during synthesis.
- Recreate DynamoDB GSIs when LocalStack custom resources do not.
- Provision SSM secrets and upload Blocks runtime configuration explicitly.
- Treat realtime publishing as best-effort because WebSocket emulation is incomplete.

## Expected differences

- `searchHelp` returns an empty array because Bedrock Knowledge Bases are unavailable.
- Digest sending returns `EmailSendFailedException` because the pinned community
  image does not emulate the SES v2 API used by `EmailClient`; local development
  captures the email and AWS sends it through SES normally.
- The Agent uses the canned provider through the deployed SQS-to-Lambda path.
- The frontend remains locally served.
- Realtime updates may be unavailable.

The E2E suite detects the LocalStack environment and asserts both documented
emulator gaps while testing all other supported paths normally.

## Returning to local development

Deployment rewrites `.blocks-sandbox/config.json`. Restore it after LocalStack testing:

```json
{
  "apiUrl": "http://localhost:3000/aws-blocks/api",
  "environment": "local"
}
```
