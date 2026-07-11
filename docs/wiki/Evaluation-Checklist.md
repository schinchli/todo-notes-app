# Evaluation Checklist

Use this before submitting the AWS Builder article.

## Challenge Requirements

- Title contains `Weekend Productivity Challenge: Instanote`.
- Article tag includes `productivity`.
- Article has at least 500 words.
- Article includes:
  - Vision & What the App Does
  - How You Built It
  - AWS Services Used / Architecture Overview
  - What You Learned
  - Link to App or Repo
- Repo is public and accessible during evaluation.
- App is clearly a personal AI-powered productivity tool.
- Article clearly lists AWS services used.
- Screenshots or repo evidence show working functionality.

## Demo Flow

1. Show the landing page.
2. Sign in with the demo account.
3. Click **Plan my day**.
4. Ask the assistant to create a note.
5. Approve the proposed write.
6. Translate a note.
7. Play it with text-to-speech.
8. Send a test digest.

## Guardrails To Mention

- Human approval for AI writes.
- Backend-owned user identity.
- Per-user data isolation.
- Zod schemas for API and tool inputs.
- AI usage limits.
- Demo account protections.
- WAF rate limiting.

## Final Checks

```bash
npm run check
```

Confirm the README, blog post, wiki, and screenshots are committed and pushed.
