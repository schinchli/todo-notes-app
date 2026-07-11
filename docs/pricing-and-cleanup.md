# Instanote — Pricing & Cleanup

Prices verified July 2026 against aws.amazon.com pricing pages (us-east-1, on-demand). Re-check before publishing — Bedrock model pricing moves often.

## 1. Monthly cost estimate (light personal use)

Assumptions: 1–3 users, ~200 notes, ~30 assistant conversations/mo, ~100 quick-AI calls, ~100 Polly reads, everything else idle-ish.

| Service | What we use | Est. monthly cost |
|---|---|---|
| AWS WAF | 1 WebACL ($5.00) + 1 rate-limit rule ($1.00) + $0.60/M requests | **~$6.01** |
| Bedrock — Claude Sonnet | Chat assistant: 500K in × $3/M + 100K out × $15/M | **$3.00** ($2.00 on Sonnet 5 promo $2/$10, thru Aug 31 2026) |
| Bedrock — Claude Haiku 4.5 | Quick AI (translate/plan): 200K in × $1/M + 50K out × $5/M | **$0.45** |
| Amazon Polly (neural) | ~150K chars × $16/1M chars | **$2.40** ($0 in first 12 mo — 1M chars/mo free) |
| API Gateway (REST) | <100K calls × $3.50/M | **$0.35** |
| DynamoDB (on-demand) | <1M WRU ($0.625/M) + <1M RRU ($0.125/M), storage well under free 25 GB | **$0.10–0.75** |
| CloudFront | <10 GB egress + requests — inside always-free 1 TB + 10M req/mo | **$0.00** |
| Lambda | <100K invocations — inside always-free 1M req + 400K GB-s/mo | **$0.00** |
| EventBridge Scheduler | 1 daily schedule (~30 invocations; 14M/mo free) | **$0.00** |
| SES | ~30 emails × $0.10/1,000 | **~$0.00** |
| S3 + S3 Vectors | KB docs + embeddings, a few MB | **<$0.10** |
| SSM Parameter Store | Standard parameters (JWT/token secrets) | **$0.00** |

**(a) Total: roughly $9–14/month** (≈$12 typical; ≈$10 during the Sonnet 5 promo, ≈$7 in the first year when Polly's 1M-char free tier applies).

**(b) Top 3 cost drivers:** WAF fixed fee (~$6 — half the bill), Bedrock tokens (~$2.50–3.50), Polly neural (~$2.40). API Gateway/CloudFront are noise at this scale.

**(c) Free tier / credits:** CloudFront (1 TB), Lambda (1M req), DynamoDB (25 GB storage), EventBridge Scheduler (14M), SES (3,000 msgs, 12 mo) are effectively free here. Accounts created after Jul 15 2025 get the credit-based Free Plan instead: $100 sign-up + $100 for onboarding tasks ($200 total, expires in 6 months or when spent) — enough to run Instanote free for its whole trial window. WAF, Bedrock, and Polly (after year 1) have no always-free allowance; credits absorb them.

**(d) At idle:** the stack is fully serverless — no traffic means the bill collapses to the WAF WebACL fixed fee (~$6/mo) plus pennies of S3/DynamoDB storage.

## 2. Complete cleanup (back to $0)

Run from the repo root, in order:

```bash
# 1. Tear down the production CloudFormation stack
#    (CloudFront, WAF, Lambda, DynamoDB, API Gateway, SQS, SES identities, …)
npm run destroy                      # → aws-blocks/scripts/destroy.ts

# 2. If you ever ran a personal sandbox stack
npm run sandbox:destroy              # → aws-blocks/scripts/sandbox-destroy.ts

# 3. Manual: RETAIN-ed S3 resources. The KnowledgeBase block ('help-docs' in
#    aws-blocks/index.ts) defaults removalPolicy to 'retain', so its data
#    bucket AND the S3 Vectors bucket/index survive step 1.
aws s3 ls | grep -i help-docs        # find the retained KB data bucket
aws s3 rb s3://<kb-data-bucket> --force
aws s3vectors list-vector-buckets    # then delete-index / delete-vector-bucket
# (Alternative: set removalPolicy: 'destroy' on the KnowledgeBase and redeploy
#  once before destroying — then CloudFormation removes everything.)

# 4. Optional: remove the CDK bootstrap (only if nothing else uses CDK
#    in this account/region). Empty its staging bucket first.
aws s3 ls | grep cdk-hnb659fds       # cdk-hnb659fds-assets-<acct>-<region>
aws s3 rm s3://<staging-bucket> --recursive
aws cloudformation delete-stack --stack-name CDKToolkit

# 5. Local dev leftovers (LocalStack container + local state)
./scripts/localstack.sh down         # docker rm -f todo-notes-localstack
rm -rf .bb-data .blocks-sandbox
docker rm -f todo-notes-localstack   # no-op if step above already ran
```

Verify: `aws cloudformation list-stacks` shows the app stack `DELETE_COMPLETE`, `aws s3 ls` shows no instanote/help-docs/blocksconfig buckets, and Billing → Bills reads $0 for WAF/CloudFront the next day.

## 3. Best-practice cross-check

Validated against the Well-Architected Serverless Lens and recent AWS posts on serverless agentic apps:

- **Least-privilege IAM** — each Lambda gets a role scoped by the Blocks constructs to only its table/queue/KB ARN; matches the Serverless Lens security pillar and the AgentOps guidance on deterministic, scoped controls ([AgentOps on Bedrock AgentCore, Jun 2026](https://aws.amazon.com/blogs/machine-learning/agentops-operationalize-agentic-ai-at-scale-with-amazon-bedrock-agentcore/)).
- **Human-in-the-loop for agentic writes** — the assistant requires user approval before mutating notes; this mirrors AWS's HITL approval patterns for agent tools ([HITL constructs for agentic workflows, Apr 2026](https://aws.amazon.com/blogs/machine-learning/human-in-the-loop-constructs-for-agentic-workflows-in-healthcare-and-life-sciences/)) and the resilience guidance to gate high-stakes actions ([Build resilient generative AI agents, Sep 2025](https://aws.amazon.com/blogs/architecture/build-resilient-generative-ai-agents/)).
- **WAF at the edge** — rate-limit rule on the CloudFront-fronted WebACL blocks abuse before it reaches API Gateway/Lambda (and before it costs Bedrock tokens) — the main defense-in-depth spend and worth its $6.
- **Secrets in SSM SecureString** — JWT/live-token secrets are SecureString parameters (standard tier, free), not env-var literals; least-privilege `ssm:GetParameter` per function.
- **Pay-per-request DynamoDB** — on-demand mode fits spiky personal traffic; no idle provisioned capacity, and the 2024 50%+ on-demand price cut makes it pennies at this scale.
- **Right model per task** — Sonnet for multi-turn agentic chat, Haiku 4.5 for cheap single-shot translate/plan calls (5–15× cheaper per token) — the model-tiering pattern AWS recommends for serverless agents ([Effectively building AI agents on AWS Serverless, Aug 2025](https://aws.amazon.com/blogs/compute/effectively-building-ai-agents-on-aws-serverless/)).
- **Async agent execution** — assistant runs via SQS → Lambda (queue-buffered), matching the event-driven/externalized-state pattern from the same Compute Blog post.
- **Gap: no billing guardrail.** No AWS Budgets alarm is provisioned. Add one:
  ```bash
  aws budgets create-budget --account-id $(aws sts get-caller-identity --query Account --output text) \
    --budget '{"BudgetName":"instanote-monthly","BudgetLimit":{"Amount":"10","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
    --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]}]'
  ```
- **Gap: Bedrock model ID should stay pinned** (no `latest` aliases) so the promo→standard Sonnet 5 price change (Sep 2026) never surprises the bill.

### Sources
- https://aws.amazon.com/bedrock/pricing/ · https://aws.amazon.com/polly/pricing/ · https://aws.amazon.com/waf/pricing/
- https://aws.amazon.com/cloudfront/pricing/ · https://aws.amazon.com/lambda/pricing/ · https://aws.amazon.com/dynamodb/pricing/on-demand/
- https://aws.amazon.com/api-gateway/pricing/ · https://aws.amazon.com/ses/pricing/ · https://aws.amazon.com/eventbridge/pricing/
- https://aws.amazon.com/blogs/compute/effectively-building-ai-agents-on-aws-serverless/
- https://aws.amazon.com/blogs/machine-learning/human-in-the-loop-constructs-for-agentic-workflows-in-healthcare-and-life-sciences/
- https://aws.amazon.com/blogs/machine-learning/agentops-operationalize-agentic-ai-at-scale-with-amazon-bedrock-agentcore/
- https://aws.amazon.com/blogs/architecture/build-resilient-generative-ai-agents/
