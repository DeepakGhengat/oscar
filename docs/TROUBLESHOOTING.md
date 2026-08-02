# Troubleshooting

Start here:

```bash
claude-code-free --doctor
```

It checks config, keys and reachability, then finishes with a real completion.
Exits non-zero on failure, so it works in scripts and CI.

---

## `claude-code-free: command not found`

npm's global bin directory isn't on your `PATH`.

```bash
npm prefix -g
```

Add that path to `PATH` and open a new terminal. On Windows it's usually
`C:\Users\<you>\AppData\Roaming\npm`.

## The command runs but prints nothing, exit code 0

You're on a build predating the fix for this. Reinstall:

```bash
npm rm -g claude-code-free && npm pack && npm install -g ./claude-code-free-0.1.0.tgz
```

The cause was a CLI-entry guard comparing `argv[1]` against `import.meta.url`.
A global install symlinks the package, so those two paths differ and the
entry point never fired.

## PowerShell: "cannot be loaded because running scripts is disabled"

npm's `.ps1` shim is blocked by execution policy.

```bash
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

---

## `/model` doesn't list my backend models

Check the proxy's startup output:

```
models:  26 across 2 backend(s)
```

**If that line is missing or shows 0** — no backend answered. Run
`claude-code-free --doctor`.

**If a provider is named as not answering** — it was too slow or is down.
claude-code-free retries a partial result after 5 seconds, so restarting usually
fixes a transient case.

**If the count looks right but `/model` is still bare** — Claude Code's gateway
discovery didn't run. It requires all of:

- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (the launcher sets this)
- `ANTHROPIC_BASE_URL` pointing somewhere that isn't `api.anthropic.com`
- no `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` in your environment

That last one is easy to miss — any of those switches Claude Code to a
third-party provider mode where discovery is skipped entirely.

**If you launched Claude Code yourself** rather than through `claude-code-free`, none of
the required environment is set. Use the `claude-code-free` command.

---

## 401 in the middle of a conversation

Your backend rejected its key. The message names the provider:

```
Your backend rejected the request (401). https://ollama.com/v1 (provider "cloud")
refused the API key — this is not a Claude Code login problem.
```

Run `claude-code-free --doctor` to confirm which one and why.

The common cause is a **placeholder key against a hosted backend**. Presets
default to values like `ollama` or `lm-studio`, which are fine locally and
useless remotely.

### Why setup didn't catch it

On many hosted backends the model listing is public:

```
GET  /v1/models           no auth   → 200
GET  /v1/models           fake key  → 200
POST /v1/chat/completions no auth   → 401
```

So any check based on listing models passes with a bogus key. That's why the
wizard and `--doctor` both end with a real completion instead.

## `Failed to authenticate` right at startup

If it names your backend, see above. If it mentions Claude Code's own login,
the dummy-key mechanism didn't take effect — usually a stale profile. Remove
the throwaway profile and relaunch:

```bash
rm -rf ~/.claude-code-free/claude-config
```

---

## Model works in `--doctor` but not in Claude Code

Usually a name mismatch. `claude-code-free --doctor` reports it:

```
! "glm-5.2:cloud" is not served here — closest: glm-5.2
```

Ollama's local naming carries a `:cloud` suffix that the cloud API doesn't use.
Fix with `claude-code-free --model`, which lists only names the backend actually serves.

## Replies are blank

A reasoning model consumed its whole budget on chain-of-thought. claude-code-free
surfaces the reasoning rather than showing nothing, but the real fix is more
room — raise `CCF_MAX_OUTPUT_TOKENS`, or remove it.

## Answers get cut off mid-sentence

The opposite problem: your ceiling is too low, or the backend's own limit is
below what Claude Code requested. Set a realistic ceiling per model:

```json
{ "providers": { "local": { "baseURL": "...", "models": {
    "qwen2.5:7b": { "maxOutputTokens": 4096 } } } } }
```

## The model ignores tools and writes prose instead

Some smaller models don't support function calling, or support it poorly.
There is no fallback for this yet — the request is sent with tool definitions
and the model simply doesn't use them. Try a model advertising tool support,
or a larger one.

---

## Port already in use

```bash
PROXY_PORT=8899 claude-code-free
```

Or set `PROXY_PORT` in `~/.claude-code-free/.env`.

## Everything worked yesterday

Check whether Claude Code updated. Model discovery depends on behaviour that
is version-specific; verified against **2.1.219**. If `/model` stops listing
backend models after an update, that's the likely cause — everything else will
keep working.

---

## Getting more detail

Run the proxy in one terminal to watch its log:

```bash
npm start
```

and Claude Code in another, pointed at it:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 ANTHROPIC_API_KEY=claude-code-free-dummy-key CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 claude
```

Every request is logged with its model mapping:

```
POST /v1/messages → openai (200)  model: claude-ccf-local-qwen2.5-7b → qwen2.5:7b via local
```
