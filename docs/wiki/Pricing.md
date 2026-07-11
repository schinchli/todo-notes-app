# Pricing Estimate

This is a light personal-use estimate. Re-check AWS pricing before publishing
or running long-lived demos.

Assumptions:

- 1-3 users
- about 200 notes
- about 30 assistant conversations per month
- about 100 quick AI calls per month
- about 100 Polly reads per month
- low frontend traffic

Estimated monthly cost: **roughly $9-14/month**.

Main drivers:

| Service | Why it costs money |
|---|---|
| AWS WAF | Fixed WebACL and rule cost |
| Amazon Bedrock | Assistant and quick AI tokens |
| Amazon Polly | Neural speech characters |

Usually small or near-zero at this scale:

- Lambda
- DynamoDB
- CloudFront
- S3
- EventBridge Scheduler
- SES
- SSM Parameter Store
- SQS

The deeper worksheet is in `docs/pricing-and-cleanup.md`.
