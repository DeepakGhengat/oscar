# Repository topics

GitHub topics are repository settings, not files — nothing in this repo can set
them. This is the list to apply, kept here so it does not have to be
reinvented, and so `package.json` keywords and the GitHub topics stay the same
set.

Every entry below is a valid GitHub topic: lowercase, alphanumeric with
hyphens, under 50 characters. GitHub allows at most 20; this is exactly 20.

```
ai
llm
claude
claude-code
anthropic
vibe-coding
coding-agent
ai-agent
ai-coding-assistant
llm-proxy
local-llm
ollama
openai
openai-api
deepseek
vllm
lm-studio
developer-tools
cli
typescript
```

## Applying them

In the browser: repository home → the gear beside **About** → **Topics**.

Or in one call, with a token that has `repo` scope:

```bash
curl -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DeepakGhengat/oscar/topics \
  -d '{"names":["ai","llm","claude","claude-code","anthropic","vibe-coding","coding-agent","ai-agent","ai-coding-assistant","llm-proxy","local-llm","ollama","openai","openai-api","deepseek","vllm","lm-studio","developer-tools","cli","typescript"]}'
```

`PUT` replaces the whole set rather than adding to it, so send the full list.

## Why these

- **ai, llm, anthropic, openai** — the broad terms people browse.
- **claude, claude-code** — what this actually drives. The product is named
  O.S.C.A.R. and its own identifiers say so, but discovery metadata has to use
  the words people search for, and someone looking for this tool is searching
  for the CLI it runs.
- **vibe-coding, ai-coding-assistant, coding-agent, ai-agent** — the category.
- **ollama, deepseek, vllm, lm-studio, local-llm, openai-api, llm-proxy** — the
  specific backends, which is how people arrive with a concrete need.
- **developer-tools, cli, typescript** — what it is and what it is built in.

## Note on visibility

Topics only aid discovery on a **public** repository. While this one is
private they are stored but nobody outside can search them.
