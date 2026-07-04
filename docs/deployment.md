# Deployment

## AWS sandbox

Use a sandbox for integration testing against managed AWS services while serving the frontend locally.

```bash
npm run sandbox
```

Destroy it when finished:

```bash
npm run sandbox:destroy
```

Sandbox resources use deletion-friendly policies and cross-domain session cookies.

## Production

Bootstrap each AWS account and region once:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

Validate and deploy:

```bash
npm run check
npm run deploy
```

The production stack includes API Gateway, Lambda, DynamoDB, SQS, S3, Bedrock integrations, EventBridge Scheduler, SES permissions, realtime infrastructure, CloudFront, and static hosting.

## Required configuration

### SES

Replace `noreply@example.com` with a verified identity. Verify the domain or address in SES and request production access when sending to unverified recipients.

### Bedrock

Enable the configured model and verify regional availability. Knowledge base ingestion happens asynchronously; wait for synchronization before validating search.

### Authentication

`AuthBasic` is appropriate for the current MVP. Migrate to `AuthCognito` or `AuthOIDC` when production requirements include MFA, federation, advanced account recovery, groups, or social identity.

## Release checklist

1. Pull the intended revision and install from the lockfile.
2. Run `npm run check`.
3. Run `NODE_OPTIONS='--conditions=cdk' npx cdk synth --context projectRoot="$PWD"`.
4. Review the synthesized changes and IAM permissions.
5. Deploy to an AWS sandbox first.
6. Verify sign-up/sign-in, note CRUD, cross-user isolation, assistant approval, realtime updates, help retrieval, and digest email.
7. Deploy production.
8. Confirm CloudFront, Lambda, SQS dead-letter queue, Scheduler, and SES health.

## Rollback and teardown

Use normal CDK/CloudFormation rollback for failed updates. Destroy production only when data loss is intended:

```bash
npm run destroy
```

Back up durable data before destructive operations. Production removal policies may retain selected resources even when the stack is removed.
