# Weekend Productivity Challenge: Instanote — an AI Daily Planner That Works Offline First

Tags: #productivity #aws #bedrock #genai

I built **Instanote** for the AWS Weekend Productivity Challenge because my notes were doing what notes always do: multiplying quietly and then refusing to tell me what mattered first.

Instanote is a notes and tasks app with an AI daily planner, reminders, translation, text-to-speech, voice capture, realtime sync, searchable help, and a daily email digest. The friendly version is: I wanted one place where I could throw ideas during the day, come back in the morning, and ask, "What should I actually do now?"

The important design choice is that the AI is helpful but not sneaky. It can search, summarize, translate, plan, and propose changes. It cannot silently create or complete notes. Any write action pauses and asks me to approve or deny it.

![Instanote AI productivity cockpit](screenshots/landing-page.png)

The full implementation notes, folder structure, AWS setup, destroy steps, pricing estimate, screenshots, guardrails, and evaluation checklist are in the repository README and wiki: https://github.com/schinchli/todo-notes-app

## Vision & What the App Does

The problem Instanote solves is not "I need another place to type notes." The problem is that capture is easy, but follow-through is hard.

I usually have a mix of half-formed ideas, follow-ups, due dates, reminders, and small tasks that are too important to forget but too scattered to trust. A plain notes app stores them. Instanote tries to move them forward.

From the user's point of view, Instanote works like this:

1. Capture a note with a title, details, tags, due date, and optional reminder.
2. Use the dashboard to see open work, overdue items, due-today notes, reminders, and today's agenda.
3. Click **Plan my day** to get a prioritized, time-blocked AI plan.
4. Ask the assistant to search notes, summarize open work, explain the app, or propose a new note.
5. Approve or deny any AI-proposed write.
6. Translate a note and listen to it through text-to-speech.
7. Turn on the morning digest so due work arrives by email.

The AI/ML features are intentionally part of the workflow, not a separate novelty panel. The planner helps decide what to do. The assistant helps operate the notes. Retrieval helps answer questions from the app docs. Translation and speech make the same note usable in more contexts. The digest brings the plan back to the user the next morning.

For a quick show-and-tell, I would demo this flow: sign in, click **Plan my day**, ask the assistant to create a note, approve the write, translate a note to Hindi, and press **Listen**. That gives a clean view of planning, agentic tool use, human approval, translation, and speech.

## How You Built It

I approached the build as a small solutions architecture exercise, not just a UI sprint.

The rule I set early was: **build locally first, deploy to AWS later, and avoid rewriting the application logic between those two worlds.**

Instanote uses AWS Blocks. In the backend, I define typed blocks such as `DistributedTable`, `Agent`, `Realtime`, `CronJob`, `EmailClient`, and `KnowledgeBase`. Locally, those blocks have persistent local implementations. That means I can run the app on my laptop with local tables, local realtime behavior, local email capture, local help search, and a deterministic assistant.

That local-first approach made the build much more relaxed. I could iterate on notes, reminders, approvals, translation fallback, digest behavior, and the landing page without waiting for cloud deploys.

After the local loop worked, I used LocalStack as the second stage. LocalStack was useful because it tested a different kind of truth: CDK synthesis, CloudFormation behavior, Lambda packaging, DynamoDB indexes, SQS wiring, SSM configuration, and deployed API paths. Some services are not fully emulated in the community image, especially Bedrock Knowledge Bases, SES v2, CloudFront, and API Gateway WebSockets. Instead of pretending those gaps did not exist, I documented them and made the tests assert the expected fallback behavior.

The final stage was deploying the same typed app model to AWS. That deployment adds the managed data layer, static hosting, API, WebSockets, async agent path, Bedrock model calls, Polly audio, scheduler, email delivery, WAF, and secure parameters.

The biggest implementation challenge was not getting the model to say something useful. It was keeping the model in the right box.

The main guardrails are:

- the backend derives `userId` from the authenticated session;
- the model never chooses which user's data to access;
- tool inputs are validated with Zod schemas;
- read-only tools can run directly;
- mutating tools require approval;
- note writes use optimistic locking;
- the demo account cannot delete seeded notes or redirect email;
- AI usage counters limit daily model and speech calls;
- WAF rate limiting protects the deployed edge.

I also added an evaluation path for myself: TypeScript checks, unit tests, end-to-end tests, production build, screenshot generation, and a challenge checklist in the wiki. The goal was to make the project easy to review, not just easy to run.

## AWS Services Used / Architecture Overview

Instanote uses AWS across hosting, API, data, AI, scheduling, email, security, and configuration.

| AWS service | How Instanote uses it |
|---|---|
| Amazon CloudFront | Static frontend delivery and edge security headers |
| Amazon S3 | Static assets and knowledge-base source documents |
| AWS WAF | Per-IP rate limiting |
| Amazon API Gateway HTTP API | Typed application API |
| Amazon API Gateway WebSockets | Realtime note and assistant events |
| AWS Lambda | API handlers, digest logic, async agent workers |
| Amazon DynamoDB | Notes, profiles, conversations, and AI usage counters |
| Amazon SQS | Async assistant execution path |
| Amazon Bedrock | Assistant and quick AI tasks |
| Bedrock Knowledge Bases + S3 Vectors | Help-document retrieval |
| Amazon Polly | Neural text-to-speech |
| Amazon EventBridge Scheduler | Daily digest schedule |
| Amazon SES | Digest email delivery |
| AWS Systems Manager Parameter Store | Secure runtime parameters |
| AWS CDK through AWS Blocks | Infrastructure as code |

Architecture overview:

```text
Browser
  │
  ▼
CloudFront + S3 + WAF
  │
  ▼
API Gateway HTTP API ──▶ Lambda ──▶ DynamoDB
                         │   │
                         │   ├──▶ Amazon Bedrock
                         │   ├──▶ Amazon Polly
                         │   ├──▶ Bedrock Knowledge Bases
                         │   └──▶ SQS ──▶ Agent worker Lambda
                         │
Browser ◀── API Gateway WebSockets ◀── Realtime events

EventBridge Scheduler ──▶ Digest Lambda ──▶ Amazon SES
```

There are two AI paths. The conversational assistant uses the full agent path: tool calling, streaming, conversation persistence, and approval interrupts. The quick AI path handles focused tasks like translation and daily planning without carrying long-lived conversation state.

For light personal use, my estimate is roughly **$9-14/month**, with the main drivers being WAF, Bedrock tokens, and Polly neural speech. The repo wiki has the implementation guide, pricing notes, and destroy steps so a reviewer can reproduce or clean up the stack safely.

## What You Learned

The biggest thing I learned is that local-first cloud development is not just convenient; it changes the emotional pace of building. When the app works locally with realistic mocks, cloud deployment becomes a validation step instead of the first moment the product feels real.

I also learned that small AI features can feel more useful than one giant assistant. A daily plan, a safe proposed write, a translation, a spoken note, and a morning digest each solve one practical problem. Together, they make the app feel like a real productivity companion.

Another lesson was that guardrails need to be product features, not just backend rules. The approval card matters because the user can see the boundary. The demo account restrictions matter because judges can safely explore the app. The AI call limits matter because a shared demo should not become an open-ended model bill.

Finally, I learned that documentation is part of the product. The README explains the project, the wiki explains how to implement and destroy it, and the article tells the story. That separation made the submission easier to read and easier to evaluate.

## Link to App or Repo

- **Public source repository:** https://github.com/schinchli/todo-notes-app

The README is the best next stop. It links to the wiki pages for implementation in an AWS account, cleanup/destroy steps, pricing, evaluation checks, screenshots, guardrails, and project structure.

<!--
Validation pass 1 — challenge format:
- Title contains "Weekend Productivity Challenge: Instanote".
- Tag line includes "productivity".
- Required sections present:
  1. Vision & What the App Does
  2. How You Built It
  3. AWS Services Used / Architecture Overview
  4. What You Learned
  5. Link to App or Repo
- Word count is above 500.
- Repo link included.

Validation pass 2 — eligibility:
- Personal AI-powered productivity tool: yes.
- AWS services clearly listed: yes.
- Working functionality demonstrated via screenshots and public repo: yes.
- Publish between July 10, 2026 9:00 AM PT and July 13, 2026 1:00 PM PT.
-->
