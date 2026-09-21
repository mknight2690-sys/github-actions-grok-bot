# Persistent Free Cloud Agent (GitHub Actions)

Multi-step AI agent with memory, scheduled wake-ups, and **infinite loop** mode.

## Features

| Feature | Description |
|---------|-------------|
| **Memory** | Saves conversation across runs in `.agent-state/memory.json` |
| **Scheduled wake-ups** | Every **5 minutes** |
| **Inbox** | Queue a task for the next automatic run |
| **Continue mode** | Resume previous conversation |
| **Loop Forever** | Re-run the same prompt indefinitely until you stop it |
| **On-demand** | Trigger immediately from CLI or Electron app |

## Fix: "Bad credentials" error

This means your GitHub token is wrong, expired, or missing scopes.

**Do this:**

1. Go to: GitHub → Settings → Developer settings → **Personal access tokens** → **Tokens (classic)**
2. Click **Generate new token (classic)**
3. Give it a name
4. Enable **exactly these scopes**:
   - ✅ `repo` (Full control of private repositories)
   - ✅ `workflow` (Update GitHub Action workflows)
5. Generate and **copy** the token (it starts with `ghp_`)
6. Paste it into the Electron app (or set `GITHUB_TOKEN`) with **no spaces or quotes**

Also make sure:
- The repo exists and you pushed `agent.yml` to the `main` branch
- You have permission to trigger Actions on that repo

## Setup

1. Push this project to a GitHub repo
2. Add secret `OPENAI_API_KEY` (free key from https://openrouter.ai)
3. Use a classic PAT with `repo` + `workflow` scopes

## CLI usage

```bash
cd cli
npm install

set GITHUB_TOKEN=ghp_...
set GITHUB_OWNER=your-username
set GITHUB_REPO=your-repo

# Single run
node index.js "Research something"

# Continue from memory
node index.js --mode continue "Expand on that"

# Infinite loop (Ctrl+C to stop)
node index.js --loop "Keep monitoring X and report changes"

# Queue for next 5-minute scheduled run
node index.js --inbox "Do this when you wake up"
```

## Electron app

```bash
cd electron-app
npm install
npm start              # dev
npm run dist:win       # build .exe on Windows
```

Buttons:
- **Run Once** – single execution
- **Loop Forever** – keeps repeating the prompt (uses memory after first run)
- **Stop Loop** – stops after the current run finishes
- **Queue for next scheduled run** – puts task in the inbox

## Limits

- Free GitHub Actions minutes are limited
- Loop mode will consume minutes quickly
- 5-minute schedule also consumes minutes even for heartbeats
- You can change the schedule in `.github/workflows/agent.yml`

## Security

Never commit tokens. Prefer a classic PAT limited to `repo` + `workflow`.
