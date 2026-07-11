# Weekend Productivity Challenge: Instanote — an AI Daily Planner That Works Offline First

Tags: #productivity #aws #bedrock #genai

I'm Shashank, a Solutions Architect who spends weekdays drawing architecture diagrams for other people's workloads — so for the AWS Build a Productivity App Weekend Challenge, I wanted to eat my own cooking. The result is **Instanote**: a notes-and-tasks app with an AI daily planner, built under one rule I set before writing a line of code: *the entire app must run on my laptop with zero AWS account, and the exact same code must deploy to AWS with one command.* This post covers the features, but mostly the architecture decisions and trade-offs behind them — because that's where the interesting weekend went.

## 🎯 Vision & What the App Does

The problem is one I live with: notes scattered across three apps, tasks with no due dates, and a morning ritual of staring at the pile wondering what to do first. Instanote's answer is one workspace — notes with tags and due dates — plus an AI layer that turns the pile into a plan, under a non-negotiable constraint: **the AI never changes my data without my explicit approval.**

Here's the walkthrough, with why each feature earns its place in *my* day:

- **Capture and organize.** Create, search, sort, complete, and delete notes with details, tags, and due dates. Changes sync across open clients in realtime over WebSockets. Payoff: one inbox for my brain instead of three.
- **The notes assistant (with approvals).** A chat panel searches my notes, lists what's due in the next seven days, answers how-to questions from bundled help docs — and can *propose* creating or completing a note. Any state-changing tool pauses for an Approve/Deny click. Payoff: I can delegate to the AI without ever wondering what it silently rewrote.
- **One-click "Plan my day."** The planner gathers my overdue, due-today, upcoming, and undated notes and asks Bedrock for a numbered, priority-ordered plan with a morning/afternoon/evening time block per item, overdue first. Payoff: it kills the what-do-I-do-first paralysis before my coffee cools.
- **Today's agenda.** A dedicated API returns overdue plus due-today items, soonest first, timezone-aware. Payoff: the glanceable version of the plan when I don't need prose.
- **Translate any note** to French, German, or Hindi. Payoff: the Hindi translation, read aloud, lets my parents hear a note in their own language.
- **Listen to notes as MP3.** Amazon Polly neural voices — Léa (French), Vicki (German), Kajal (Hindi), Joanna (English). If Polly is unreachable locally, the browser's speech synthesis takes over. Payoff: notes become audio while I'm making breakfast.
- **Semantic help search.** Bedrock Knowledge Bases with S3 Vectors indexes the bundled documentation, so "how do digests work?" gets an actual answer. Payoff: the app explains itself; I don't have to.
- **Daily 8 AM email digest.** EventBridge Scheduler mails every due and overdue item each morning (Asia/Kolkata), with a "send test digest now" button to verify delivery first. Payoff: one calm email replaces my anxiety scroll through the app.
- **Hardened sharing.** WAF rate limiting, a strict CSP, per-user note caps, and a demo account that cannot delete notes or redirect email. Payoff: productivity you can share safely — the demo link at the bottom exists because of this.

## 🛠️ How I Built It

The spine of this project is the loop: **built 100% locally first, then pushed to AWS.** Same typed application code, three runtimes, zero rewrites.

**Stage 1 — laptop only, zero AWS account.** I used AWS Blocks, a new local-first framework (June 2026 preview). You declare typed blocks — `DistributedTable`, `Agent`, `Realtime`, `CronJob`, `EmailClient`, `KnowledgeBase` — and locally they run as persistent mocks: a deterministic canned LLM (or opt-in Ollama for real local inference), TF-IDF search standing in for Bedrock Knowledge Bases, email captured to the console. `npm run dev` gives the *complete* app offline — approvals, realtime, digests, all of it. As an SA I'd call this the biggest architectural win of the stack: the feedback loop for 90% of the build was hot-reload speed, not deploy speed.

**Stage 2 — LocalStack proves the real CDK path.** Mocks validate behavior; they don't validate CloudFormation. So before touching a real account, I deployed the same CDK synthesis to LocalStack to exercise the actual API Gateway, Lambda, DynamoDB, SQS, and SSM paths. Three genuine battles:

- **Change sets hung indefinitely.** LocalStack's change-set execution stalled on this stack. Fix: deploy with `--method=direct` CloudFormation instead.
- **Custom resources silently no-op'd.** The DynamoDB GSIs that CDK provisions via custom resources never materialized, and neither did runtime configuration. Fix: post-deploy fixup scripts that recreate the GSIs and provision SSM secrets and Blocks config explicitly.
- **Runtime mismatch.** LocalStack 4.4 predates `nodejs24.x`, so a CDK Aspect downgrades every Lambda to `nodejs22.x` at synth time — gated behind `LOCALSTACK_DEPLOY=true` so real AWS is untouched.

Community LocalStack also doesn't emulate Bedrock, SES v2, or CloudFront. Rather than pretend, the app degrades deliberately there (empty help search, surfaced email errors, canned model through the *real* SQS→Lambda agent path), and the e2e suite asserts those documented gaps instead of skipping them — emulator limitations as test assertions, not surprises.

**Stage 3 — one command to AWS.** `npm run deploy`. Identical application logic, now backed by DynamoDB, Bedrock, Polly, SES, EventBridge Scheduler, and CloudFront.

**The offline AgentCore experiment.** In `agentcore/` I rebuilt the same agent brain on the Amazon Bedrock AgentCore runtime contract — fully offline. `agent.py` serves the real contract (`POST /invocations`, `GET /ping`) via `BedrockAgentCoreApp`, running a Strands agent on Ollama. `gateway.py` is a local stand-in for AgentCore Gateway: an MCP server over streamable HTTP exposing Instanote's typed API as five tools. `memory.py` provides file-backed short-term events and long-term facts, with OpenTelemetry spans per invocation and a `smoke.py` validator. Promotion path to managed AgentCore: swap the Ollama model for a Bedrock model ID and point at a real Gateway URL — the entrypoint doesn't change.

**Quality gate.** 26 typed end-to-end tests (auth, optimistic-locking CRUD, realtime delivery, digest email, translation, Polly degradation, planner, knowledge retrieval, approval denial, conversation owner-scoping) plus TypeScript checking behind one `npm run check`.

## 🏗️ AWS Services Used / Architecture Overview

| Service | Role | Why this choice |
|---|---|---|
| Amazon Bedrock — Claude Sonnet | Conversational assistant | Multi-turn tool orchestration needs reasoning quality; Sonnet's balanced profile earns its cost here |
| Amazon Bedrock — Haiku-class fast model | Quick AI: translate, planner | One-shot, latency-sensitive, high-frequency tasks — pay Haiku prices, get snappy answers |
| Amazon Polly | Neural TTS, 4 voices | Purpose-built TTS is cheaper and better than pressing an LLM into the job |
| Bedrock Knowledge Bases + S3 Vectors | Semantic help search | Managed ingestion + retrieval; S3 Vectors keeps vector storage costs trivial at this scale |
| Lambda + API Gateway | Typed RPC API | Scale-to-zero for a weekend app with spiky traffic |
| DynamoDB | Notes, profiles, conversations (GSIs for due-date/title sort) | Partition key = userId makes per-user isolation a data-layer guarantee, not a code convention |
| SQS | Async agent runs | Agent turns outlive API Gateway timeouts; decouple and stream results back |
| API Gateway WebSockets | Realtime sync | Push, not poll |
| EventBridge Scheduler | 8 AM digest cron | Native timezone support (Asia/Kolkata) without UTC math |
| Amazon SES | Digest delivery | Batch send, verified identities |
| CloudFront + S3 | Static hosting | Cheap, global, TLS by default |
| AWS WAF + strict CSP | Edge security | See the trade-off note below |
| SSM Parameter Store | JWT/realtime secrets (SecureString) | No secrets in code, config, or Lambda env |
| AWS CDK via AWS Blocks | All infrastructure | One typed codebase, three runtimes |

```
User ──▶ CloudFront (+WAF, CSP) ──▶ API Gateway ──▶ Lambda
                                                      ├──▶ DynamoDB (notes/profiles/convos)
                                                      ├──▶ Bedrock (Sonnet chat · Haiku quick AI)
                                                      ├──▶ Polly (neural MP3)
                                                      └──▶ SQS ──▶ Lambda (async agent runs)
User ◀── API GW WebSockets (realtime sync) ◀──────────┘
EventBridge Scheduler (8 AM cron) ──▶ Lambda ──▶ SES (digest email)
```

**Two agents, deliberately.** The conversational assistant carries conversation persistence, a sliding context window, streaming, and HITL interrupt machinery — infrastructure worth paying for in a chat. Translate and plan-my-day need none of it, so they run on a second `inferenceOnly` agent: no persistence tables, no conversation state, just prompt in, text out. Same provider ladder (Bedrock → Ollama → canned), half the moving parts, and a model tier matched to the job — Sonnet where reasoning compounds across turns, Haiku where the task is mechanical and the volume is high. That's most of the Bedrock bill decided in two lines of config.

**Human-in-the-loop for AI writes.** `addNote` and `completeNote` are declared `needsApproval: true`. Reads are free; writes interrupt and wait. This is an insecure-design control (OWASP A04), not a UX flourish: an LLM with ungated write access is an incident report waiting for a timestamp. Crucially, the tool context derives `userId` from the authenticated session — the model *cannot* name another user, so even prompt injection can't cross a tenant boundary.

**Edge hardening over app-level hardening.** WAF rate limiting (500 req/5 min/IP) and a strict CSP (`frame-ancestors 'none'`, self-only scripts) live at CloudFront — one config block. Rejecting credential-stuffing at the edge means abusive traffic never invokes a Lambda, so the security control doubles as a cost control. App-level checks still exist (Zod validation, size caps, per-user note limits); defence-in-depth just starts where requests are cheapest to reject.

## 📚 What I Learned

**Local-first is a genuine speed win, not a demo trick.** Mocks for iteration, LocalStack for infrastructure truth, AWS for reality — each stage caught a different class of bug, and only one stage cost money. The discipline that made it work: encode emulator gaps as explicit test assertions.

**Agentic patterns are plumbing you get right once.** Zod schemas give the model a typed tool contract; HITL interrupts make writes safe by construction; sliding-window persistence bounds context cost. None of it is exotic — it's the same input-validation and least-privilege thinking SAs have always preached, applied to a model.

**AgentCore's runtime contract is developable fully offline.** The managed platform's HTTP contract, gateway pattern, and memory model all have faithful local equivalents (Ollama + FastMCP + files). That reframed AgentCore from "cloud service to learn later" into something I prototyped on a Saturday train.

**Security is cheap when the platform has hooks.** The full OWASP Top 10 mapping (`docs/security.md`) mostly cost configuration, not engineering — which is exactly how it should be.

## 🔗 Try It / Links

- **Live demo:** LIVE_URL_PLACEHOLDER
- **Source:** https://github.com/schinchli/todo-notes-app
<!-- NOTE: the repo is currently private — either make it public before submitting, or rely on the live URL for judging. -->
- **Demo account:** `demo@instanote.app` (password shared separately). Hardened by design: it cannot delete notes or change the digest email address, so the seeded data survives every visitor.

Sign in, hit "Plan my day," approve the note the assistant proposes, and let Kajal read it back in Hindi. That thirty-second loop is why I built this.

<!-- Word count: ~1,500 words of prose (1,880 total by wc -w, including table and diagram markup) -->
