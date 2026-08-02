# O.S.C.A.R. on Windows

Complete install and operation guide for Windows, in PowerShell.

---

## First, what O.S.C.A.R. is

O.S.C.A.R. sits **in front of** the Claude Code CLI. It is a local translation proxy plus a launcher — it starts a proxy, points the CLI at it, and rewrites each request into whatever your backend speaks.

Two consequences worth knowing before you start:

- **It needs Claude Code.** Removing Claude Code does not give you a cleaner O.S.C.A.R.; it gives you a broken one, because there is nothing left to launch.
- **It does not install Claude Code for you.** `@anthropic-ai/claude-code` is not a dependency of this package — the only runtime dependency is `tsx`. When the CLI is missing, O.S.C.A.R. says so and exits rather than installing software on your machine behind your back.

The one exception is `oscar --agent`, a small built-in agent that talks to an OpenAI-compatible backend directly and needs no CLI. It is not the default and it is deliberately minimal.

## Prerequisites

### Node.js 18 or newer

```powershell
node --version
```

If that is below v18, install from [nodejs.org](https://nodejs.org).

### The Claude Code CLI

Already have the **Claude desktop app**? Skip this — O.S.C.A.R. finds the copy it bundles automatically.

Otherwise:

```powershell
npm i -g @anthropic-ai/claude-code
```

**Then open a new PowerShell window.** npm puts its shim in `%APPDATA%\npm`, and a shell started before the install will not have that on `PATH` yet. This is the single most common reason the next step fails.

O.S.C.A.R. looks for the CLI in four places, in order:

1. `sdk\bin\` inside the package (populated by `scripts\install-sdk.sh`)
2. The desktop app's versioned install directories
3. npm's global bin — `%APPDATA%\npm`
4. Anywhere on `PATH`

and under four names: `claude.exe`, `claude.cmd`, `claude.bat`, `claude`. On Windows npm installs a **`.cmd` shim**, not a `.exe`, which is why all four are searched.

### A backend

Anything OpenAI-compatible. [Ollama](https://ollama.com) is the easiest, local or cloud. You can also skip this entirely and use only your Anthropic account.

## Install

```powershell
cd D:\
git clone https://github.com/DeepakGhengat/oscar.git
cd D:\oscar
npm pack
npm install -g .\oscar-0.1.0.tgz
Remove-Item .\oscar-0.1.0.tgz
```

Verify:

```powershell
oscar --version
```

> **Why `npm pack` first?** `npm install -g .` on a local path creates a *symlink* to your working tree rather than an installation. Packing first produces a genuine copy containing only `src\`, `bin\` and `scripts\`.

If PowerShell refuses to run the generated shim:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## Configure

```powershell
oscar --setup
```

Pick a backend, answer the prompts. The wizard sends **one real one-token request** before writing anything, so a bad key fails here rather than mid-conversation.

The last question is the useful one:

```
Include your Anthropic account in /model? [n]:
```

Answer **y** and one `/model` list holds your Claude plan *and* your backend models, switchable mid-session. It needs a Claude plan or an API key; without one, leave it at **n**.

## Verify and run

```powershell
oscar --doctor
oscar
```

`--doctor` checks every backend and ends with a live completion. In hybrid it reports both halves and warns if there is no stored login to serve the Anthropic one.

Inside the session, run `/login` if you are not signed in to your Anthropic account yet.

## Everyday commands

| Command | What it does |
|---|---|
| `oscar` | Start the proxy and launch the CLI |
| `oscar --setup` | Reconfigure. Saves a profile of whatever it replaces |
| `oscar --doctor` | Check every backend, ending with a live completion |
| `oscar --profiles` | List saved configurations |
| `oscar --use <name>` | Switch to a saved configuration |
| `oscar --model` | Pick a backend model offline and write it to `.env` |
| `oscar --model <id>` | Start the session on a named model |
| `oscar --switch` | Hot-swap the model on a **running** proxy, from a second terminal |
| `oscar --agent` | O.S.C.A.R.'s own built-in agent instead of the CLI |

Inside a session, `/model` switches models with no restart, and `/agents` manages subagents.

## Which model am I on?

The status line at the bottom shows it live:

```
⬢ O.S.C.A.R.  ·  glm-5.2:cloud → cloud  ·  2 backends  ·  D:/oscar
⬢ O.S.C.A.R.  ·  Opus 5 (1M context) → anthropic  ·  D:/oscar
```

The arrow is the destination: a provider id for your own backends, `anthropic` for the vendor. It reports the model the session is actually on, so it updates the moment you switch.

## Where things live

| Path | What | Safe to delete? |
|---|---|---|
| `C:\Users\<you>\.oscar\` | O.S.C.A.R. config and saved profiles | Yes — you will re-run `--setup` |
| `C:\Users\<you>\.oscar\profiles\` | Saved configurations | Yes, loses saved backends |
| `C:\Users\<you>\.oscar\cli-profile\` | Throwaway CLI profile used in backend-only mode | Yes, recreated |
| `C:\Users\<you>\.claude\` | **Your Anthropic login**, agents, skills | **No** — you will have to sign in again |
| `D:\oscar\` | The clone | Yes, once installed globally |

Your config lives outside the repo, so `git pull` never touches it.

## Updating

```powershell
cd D:\oscar
git pull
npm pack
npm install -g .\oscar-0.1.0.tgz
Remove-Item .\oscar-0.1.0.tgz
```

Config and saved profiles survive.

## Uninstalling

```powershell
npm uninstall -g oscar
Remove-Item -Recurse "$env:USERPROFILE\.oscar"
```

That removes O.S.C.A.R. only. Claude Code and your login are untouched.

Leftovers from before the rename, if you ever ran the old build:

```powershell
npm uninstall -g claude-code-free
Remove-Item -Recurse "$env:USERPROFILE\.claude-code-free"
Remove-Item -Recurse "$env:USERPROFILE\.oscar\claude-config"
```

## Troubleshooting

**`npm error code ENOENT ... open 'D:\package.json'`** — you are not in the repo. `cd D:\oscar` first; `npm pack` reads `package.json` from the current directory.

**`Could not find the CLI`** — Claude Code is not installed, or `PATH` has not caught up. Install it, then **open a new terminal**. The error lists every name and location searched.

**`oscar: command not found`** — npm's global directory is not on `PATH`. Find it with `npm prefix -g` and add it.

**`Not logged in · Run /login` while a backend is configured** — fixed in current builds. The CLI only uses an API key in an interactive session if that key is pre-approved in its profile; O.S.C.A.R. now writes the approval. If you still see it, `git pull` and reinstall.

**`/model` shows only Claude's models** — you are in Anthropic-only mode, where no proxy runs and there are no backend models to advertise. Switch with `oscar --use <name>`, or enable hybrid in `--setup`.

**`oscar --switch` says no proxy is responding** — it talks to a *running* proxy, so it needs a second terminal: `oscar` in one, `oscar --switch` in the other. With the proxy stopped use `oscar --model`. In Anthropic-only mode no proxy runs at all, and `--switch` will tell you so.

**Personal subagents disappear when switching backends** — in backend-only mode `CLAUDE_CONFIG_DIR` points at a throwaway profile, so personal agents in `~\.claude\agents` are not visible. Define subagents at **project** scope (`.claude\agents\` in your project) and they work in every mode, or run in hybrid, where the override does not apply.

**Blank replies from a reasoning model** — its budget is going to reasoning. Raise `max_tokens`, or set `OSCAR_MAX_OUTPUT_TOKENS` higher.

More, symptom-first: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
