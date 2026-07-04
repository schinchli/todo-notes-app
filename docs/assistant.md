# Assistant runtimes

## Runtime model

The right-hand Notes assistant uses the AWS Blocks `Agent`, which is powered by the Strands Agents SDK. Its tools operate on the same authenticated note tables as the rest of the application.

| Environment | Agent execution | Model provider |
|---|---|---|
| Local development | AWS Blocks local async job and realtime mocks | Built-in deterministic offline provider, or opt-in Ollama |
| LocalStack | SQS and Lambda through LocalStack | Canned provider because Bedrock is not emulated |
| AWS | SQS, Lambda, persistence, and realtime AWS resources | Amazon Bedrock balanced global inference profile |

The UI calls `getAssistantStatus` after sign-in and displays the configured provider. Provider detection never sends note data; when Ollama is enabled it only checks Ollama's local model list.

## Built-in offline setup

Run `npm run dev`. No model download, AWS credentials, or network connection is required. The badge reads `Offline · built-in assistant`. This deterministic provider exercises conversation persistence, tool execution, approval pauses, and the complete UI/API path; its prose is intentionally limited.

## Optional Ollama setup

Choose a model that supports tool calling and fits the machine. For a lightweight starting point:

```bash
ollama serve
ollama pull qwen3:0.6b
INSTANOTE_OLLAMA_MODEL=qwen3:0.6b npm run dev
```

Open the app, sign in, and confirm the assistant badge reads `Offline · qwen3:0.6b`. Messages, conversations, and notes remain on the machine under `.bb-data/`. Set `INSTANOTE_OLLAMA_ENDPOINT` when Ollama is not listening at `http://localhost:11434/v1`.

If an explicitly configured Ollama server or model is unavailable, the badge reports that runtime as unavailable instead of silently changing providers. Restart without `INSTANOTE_OLLAMA_MODEL` to return to the built-in offline assistant.

## AgentCore clarification

Amazon Bedrock AgentCore Runtime is a managed production hosting platform. The AgentCore CLI can start a local server that mimics its runtime contract, but that server does not make a Bedrock model offline. Offline inference still requires a local model provider.

Instanote currently deploys its Strands-based AWS Blocks Agent through the application's Lambda/SQS stack rather than a separate AgentCore Runtime. This keeps authentication, tool context, approvals, persistence, and typed APIs in one application boundary. A future AgentCore deployment adapter can reuse the same conceptual tools, but it would be a separate production topology rather than a requirement for offline chat.

## Available tools

- `searchNotes`: searches title, body, and tags for the signed-in user.
- `listDueSoon`: lists incomplete notes due within seven days, including overdue notes.
- `addNote`: proposes a new note and waits for approval.
- `completeNote`: proposes completing a note and waits for approval.
- `searchHelp`: searches bundled product documentation.

Conversation reads, sends, and resumes are owner-checked by the API. Tool context always derives the user ID from the authenticated session.
