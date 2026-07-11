# Security — OWASP Top 10 (2021) mapping

How Instanote addresses each OWASP Top 10 category, and where the control
lives. Infra controls apply to the AWS deployment (`npm run deploy`);
application controls apply everywhere, including local and LocalStack.

| # | Category | Controls |
|---|---|---|
| A01 | Broken Access Control | Every API method calls `requireAuth`; notes/settings are partition-keyed by `userId` so cross-user reads are impossible at the data layer; assistant conversations are owner-checked (`requireOwnedConversation`) before reads/resumes; agent tool context derives `userId` from the session, never from the model. |
| A02 | Cryptographic Failures | TLS end to end (CloudFront + API Gateway); JWT signing secret and realtime token secret in SSM SecureString; session cookie is `HttpOnly; Secure; SameSite`; no secrets in the repo, `config.json`, or Lambda env (`backendConfig` warning respected). |
| A03 | Injection | No SQL surface (DynamoDB via typed SDK); all API inputs validated with Zod schemas (length caps on title/body/tags, enum-validated language codes, bounded timezone offsets); lit-html escapes interpolations by default (no `unsafeHTML` used); strict CSP as defence in depth. |
| A04 | Insecure Design | State-changing assistant tools (`addNote`, `completeNote`) require human approval (HITL interrupts); optimistic locking on note writes; per-user note cap (`INSTANOTE_MAX_NOTES`, default 200) bounds resource consumption; digest recipient is a validated email; Polly input capped at 3000 chars. |
| A05 | Security Misconfiguration | CloudFront ResponseHeadersPolicy sets HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy plus a strict custom CSP (`frame-ancestors 'none'`, `object-src 'none'`, self-only scripts); prod stack removal policies retain data; sandbox/prod separation. |
| A06 | Vulnerable & Outdated Components | Lockfile-pinned dependencies; `npm audit` in the release checklist; no CDN-loaded scripts — everything is bundled and served from the same origin. |
| A07 | Identification & Authentication Failures | Password policy minLength 12; AWS WAF rate limiting (500 req / 5 min / IP) throttles credential stuffing at the edge; sessions are short-lived JWTs (24 h) in HttpOnly cookies; demo account cannot be used to delete data or redirect email. |
| A08 | Software & Data Integrity Failures | Single-origin, bundled frontend (no third-party script integrity surface); CDK-defined infra (no console drift); deploys from a clean `npm run check` (typecheck + unit + build + 26 e2e tests). |
| A09 | Security Logging & Monitoring Failures | All API invocations logged to CloudWatch via Lambda; WAF metrics + sampled requests in CloudWatch; agent tool calls recorded in conversation history (audit trail of AI actions); OTEL spans in the AgentCore variant. |
| A10 | SSRF | The server never fetches user-supplied URLs. Outbound calls go only to fixed AWS service endpoints (Polly, Bedrock, SES, DynamoDB). The Ollama endpoint is operator-set env config, not user input. |

## Demo account hardening

The shared `demo@instanote.app` account is evaluation-safe:

- **Cannot delete notes** — visitors can't wipe the seeded demo data.
- **Cannot change the digest email address** — prevents using the shared
  account to send email to arbitrary third parties.
- **Same note cap as everyone** (200) — bounds flooding.
- **Strong generated password** (20 chars, not committed — see
  `.demo-credentials`, gitignored; regenerate with `scripts/seed-demo.mjs`).

## Residual risks / accepted trade-offs

- `style-src 'unsafe-inline'` is required by lit-html inline styles. Script
  injection remains blocked (`script-src 'self'`).
- AuthBasic has no built-in per-account lockout; WAF IP rate limiting is the
  compensating control. Move to `AuthCognito` for lockout, MFA, and passkeys.
- SES digest requires a verified sender identity
  (`INSTANOTE_FROM_ADDRESS`); until verified, `sendDigestNow` surfaces the
  SES error to the caller rather than failing silently.
