# Approach Note

Instanote was built as a show-and-tell productivity app with one guiding
principle: AI should help plan the day, but the user should stay in control of
every write.

## Product Approach

The app focuses on the morning review workflow:

1. Capture notes quickly.
2. Add due dates, reminders, and tags.
3. Let AI summarize, search, translate, and plan.
4. Require explicit approval before the assistant creates or completes notes.
5. Deliver a daily digest so due work reaches the user without opening the app.

This keeps the product grounded in a real productivity habit instead of making
the AI a disconnected chat panel.

## Architecture Approach

The architecture uses one typed AWS Blocks application that runs in three
places:

1. **Local development**: persistent local mocks, deterministic assistant,
   local TF-IDF help search, console-captured email, and optional Ollama.
2. **LocalStack**: the same CDK synthesis deployed to emulated API Gateway,
   Lambda, DynamoDB, SQS, S3, SSM, Scheduler, and SES paths where supported.
3. **AWS**: managed services for production, including CloudFront, S3, WAF,
   API Gateway, Lambda, DynamoDB, SQS, Bedrock, Polly, SES, EventBridge
   Scheduler, SSM Parameter Store, and Bedrock Knowledge Bases.

The implementation keeps deterministic state in DynamoDB and uses AI for
bounded tasks: assistant reasoning, planning, translation, and help retrieval.

## AI Safety Approach

The assistant receives typed tools and authenticated context. It cannot choose
another user ID, because the backend derives identity from the active session.

Read-only tools can run directly. Mutating tools use `needsApproval: true`, so
the UI receives an approval interrupt before the write occurs.

Additional controls:

- per-user note caps;
- per-account daily AI call limits;
- demo-account restrictions;
- WAF rate limiting at the edge;
- input validation with Zod schemas;
- optimistic locking for note writes.

## Build Approach

The build order was:

1. Implement notes, auth, settings, and local persistence.
2. Add assistant tools and approval flow.
3. Add daily planner, translation, text-to-speech, voice capture, reminders,
   and daily digest.
4. Validate with the local test suite.
5. Deploy the same code to LocalStack to exercise infrastructure paths.
6. Deploy to AWS with CDK/AWS Blocks.
7. Add show-and-tell polish: landing page, screenshots, README, blog post,
   pricing, cleanup, and security documentation.

## What To Demo First

For judges, show these in order:

1. Landing page: AI cockpit, feature board, AWS service map.
2. Sign in with the demo account.
3. Click **Plan my day**.
4. Ask the assistant to create a note and approve the write.
5. Translate a note to Hindi and play it with Polly or browser TTS fallback.
6. Send a test digest.

That flow demonstrates the AI/ML features, safety boundary, and production
architecture in under two minutes.
