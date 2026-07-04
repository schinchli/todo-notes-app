import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins, aws_lambda as lambda } from 'aws-cdk-lib';

import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
// Set by scripts/localstack.sh — deploying to LocalStack, not real AWS.
const isLocalStack = process.env.LOCALSTACK_DEPLOY === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

if (sandboxMode) {
  // Make all resources deletable so sandbox:destroy can clean up the entire stack.
  // This overrides removal policies and deletion protection (e.g. RDS) for every
  // resource in the stack, including any you add below.
  // Remove these lines if you want to manage teardown behavior yourself.
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}

if (isLocalStack) {
  // LocalStack 4.4 community: the resource-groups mock rejects the group's
  // ResourceQuery JSON (cosmetic resources — safe to drop), and cookies need
  // cross-domain attributes since the frontend is served from localhost.
  for (const node of blocksStack.node.findAll()) {
    if (cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::ResourceGroups::Group') {
      node.node.scope?.node.tryRemoveChild(node.node.id);
    }
  }
  // LocalStack 4.4 predates the nodejs24.x Lambda runtime — downgrade at synth.
  // Covers both L1 CfnFunctions and raw CfnResources (custom resource providers).
  cdk.Aspects.of(blocksStack).add({
    visit(node) {
      if (node instanceof lambda.CfnFunction && node.runtime === 'nodejs24.x') {
        node.runtime = 'nodejs22.x';
      } else if (
        cdk.CfnResource.isCfnResource(node) &&
        node.cfnResourceType === 'AWS::Lambda::Function' &&
        (node as any).cfnProperties?.Runtime === 'nodejs24.x'
      ) {
        node.addPropertyOverride('Runtime', 'nodejs22.x');
      }
    },
  });
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
  // Let the runtime code know too, so it also skips the KnowledgeBase block.
  blocksStack.handler.addEnvironment('LOCALSTACK_DEPLOY', 'true');
}

// Add static site hosting only when deploying (not in sandbox mode).
// Skipped on LocalStack too: CloudFront is not emulated in community edition.
if (!sandboxMode && !isLocalStack) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    buildOutputDir: 'dist',
    api: blocksStack
  });
}