# Destroy And Cleanup

Use this when the demo or production stack is no longer needed.

## 1. Destroy The App Stack

```bash
npm run destroy
```

For sandbox resources:

```bash
npm run sandbox:destroy
```

## 2. Stop LocalStack

```bash
./scripts/localstack.sh down
```

Optional local cleanup:

```bash
rm -rf .bb-data .blocks-sandbox
```

## 3. Check Retained Resources

Some knowledge-base resources may be retained by design. Check for retained S3
and S3 Vectors resources before assuming the account is fully clean.

Useful checks:

```bash
aws cloudformation list-stacks
aws s3 ls
aws s3vectors list-vector-buckets
```

If you are sure the retained data is no longer needed, delete the retained
knowledge-base buckets and vector resources manually.

## 4. Optional CDK Bootstrap Cleanup

Only do this if no other CDK apps use the same account and region.

```bash
aws cloudformation delete-stack --stack-name CDKToolkit
```

Empty the CDK bootstrap bucket first if CloudFormation reports it is not empty.

## 5. Billing Check

After cleanup, check the AWS Billing console the next day. WAF, CloudFront,
S3, DynamoDB, and retained vector resources are the main things to verify.
