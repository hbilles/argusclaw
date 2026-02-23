# Slack Bridge Setup Guide

This guide walks you through creating a Slack app and connecting it to ArgusClaw.

## Prerequisites

- A Slack workspace where you have permission to install apps
- ArgusClaw gateway running (or ready to start)

## 1. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** > **From scratch**
3. Name it (e.g., "ArgusClaw") and select your workspace
4. Click **Create App**

## 2. Enable Socket Mode

Socket Mode lets the bot connect via WebSocket — no public URL required.

1. In the left sidebar, go to **Settings** > **Socket Mode**
2. Toggle **Enable Socket Mode** to ON
3. You'll be prompted to generate an **App-Level Token**:
   - Name it (e.g., "socket-token")
   - Add the `connections:write` scope
   - Click **Generate**
4. Copy the token — this is your `SLACK_APP_TOKEN` (starts with `xapp-`)

## 3. Configure Bot Token Scopes

1. In the left sidebar, go to **Features** > **OAuth & Permissions**
2. Scroll to **Bot Token Scopes** and add these scopes:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mentions in channels |
| `chat:write` | Send messages and replies |
| `commands` | Register slash commands |
| `im:history` | Read DM messages |
| `im:read` | View DM channel list |
| `im:write` | Open DMs with users |

## 4. Install to Workspace

1. Still on **OAuth & Permissions**, scroll to the top
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`)

## 5. Enable Event Subscriptions

1. In the left sidebar, go to **Features** > **Event Subscriptions**
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, add:
   - `app_mention` — triggers when someone @mentions the bot in a channel
   - `message.im` — triggers when someone sends a DM to the bot
4. Click **Save Changes**

## 6. Configure Slash Commands (Optional)

Slash commands provide a native Slack experience. They're optional — the bridge also supports text-based commands (`!memories`, `!stop`, etc.) that work without any Slack-side configuration.

1. In the left sidebar, go to **Features** > **Slash Commands**
2. Click **Create New Command** for each:

| Command | Description |
|---------|-------------|
| `/argus_memories` | List stored memories |
| `/argus_forget` | Forget a memory by topic |
| `/argus_sessions` | Show active/recent sessions |
| `/argus_stop` | Cancel the current task |
| `/argus_heartbeats` | List scheduled heartbeats |
| `/argus_connect` | Connect an OAuth service |
| `/argus_auth_status` | Check auth connection status |
| `/argus_disconnect` | Disconnect an OAuth service |

For each command:
- Set the **Request URL** to anything (Socket Mode handles routing, but Slack requires a value) — e.g., `https://localhost`
- Add a short description
- Click **Save**

> **Note**: You don't need a real URL — Socket Mode intercepts all slash commands before they reach any URL.

## 7. Enable Interactivity

This is required for the HITL approval buttons (Approve/Reject).

1. In the left sidebar, go to **Features** > **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. Set the **Request URL** to anything (e.g., `https://localhost`) — Socket Mode handles it
4. Click **Save Changes**

## 8. Get Your Slack User IDs

The bridge uses an allowlist of Slack user IDs for security.

1. In Slack, click on your profile picture (top right)
2. Click **Profile**
3. Click the **...** (more) button
4. Click **Copy member ID**
5. Add this ID to `SLACK_ALLOWED_USER_IDS` in your `.env` file

Repeat for each user who should have access. Separate multiple IDs with commas.

## 9. Add the Bot to Channels

The bot only responds in channels where it's been invited.

In each channel where you want to use ArgusClaw:
```
/invite @ArgusClaw
```

The bot can also be DMed directly — no invite needed.

## 10. Configure Environment Variables

Add the following to your `.env` file:

```bash
# Bot User OAuth Token (from step 4)
SLACK_BOT_TOKEN=xoxb-your-token-here

# App-Level Token for Socket Mode (from step 2)
SLACK_APP_TOKEN=xapp-your-token-here

# Comma-separated Slack user IDs (from step 8)
SLACK_ALLOWED_USER_IDS=U0123456789,U9876543210
```

## 11. Running

### With Docker (recommended)

```bash
# Run gateway + Telegram + Slack bridges
docker compose --profile slack up --build

# Run gateway + Slack only (no Telegram)
docker compose --profile slack up gateway bridge-slack --build
```

### Local development

```bash
# Install dependencies
npm install

# Run gateway + Slack bridge
npm run dev:slack

# Run gateway + both bridges
npm run dev:all
```

## 12. Usage

### Channel conversations
- **@mention** the bot in any channel it's been invited to: `@ArgusClaw what's on my calendar today?`
- The bot replies in a **thread** to keep the channel clean
- If you mention it inside an existing thread, it continues that thread

### Direct messages
- Open a DM with the bot for private conversations
- Messages are replied to directly (no threading)

### Commands

**Slash commands** (if configured in step 6):
- `/argus_memories` — List all stored memories
- `/argus_forget coding style` — Forget a specific memory
- `/argus_sessions` — Show active/recent task sessions
- `/argus_stop` — Cancel the current multi-step task
- `/argus_heartbeats` — List scheduled heartbeats

**Text commands** (always available, no setup needed):
- `!memories` — List memories
- `!forget <topic>` — Forget a memory
- `!sessions` — Show sessions
- `!stop` — Cancel current task
- `!heartbeats` — List heartbeats
- `!heartbeat_enable <name>` — Enable a heartbeat
- `!heartbeat_disable <name>` — Disable a heartbeat

### Approval flow
When the agent wants to perform a sensitive action (write files, send emails, etc.), it sends a message with interactive buttons:
- **Approve** — Allow this one action
- **Allow for Session** — Auto-approve similar actions for the rest of the session
- **Reject** — Block the action

### Heartbeats to Slack channels
You can configure heartbeats to send to specific Slack channels by adding a `channel` field in `config/argusclaw.yaml`:

```yaml
heartbeats:
  - name: morning-briefing
    schedule: "0 8 * * 1-5"
    prompt: "Give me a morning summary..."
    enabled: true
    channel: "slack:C0123456789"  # Your Slack channel ID
```

To find a channel ID: right-click the channel name in Slack > **View channel details** > the ID is at the bottom of the dialog.

## Troubleshooting

### Bot doesn't respond to mentions
- Verify the bot is invited to the channel (`/invite @ArgusClaw`)
- Check that `app_mention` event is subscribed (step 5)
- Verify the user's Slack ID is in `SLACK_ALLOWED_USER_IDS`
- Check bridge logs: `docker compose --profile slack logs bridge-slack`

### Bot doesn't respond to DMs
- Check that `message.im` event is subscribed (step 5)
- Verify `im:history` and `im:read` scopes are added (step 3)
- Ensure the user's Slack ID is in the allowlist

### Slash commands don't work
- Verify commands are created in the Slack app config (step 6)
- Make sure the `commands` scope is added (step 3)
- Try reinstalling the app to the workspace (step 4)
- Text-based commands (`!memories`, etc.) work as a fallback

### Approval buttons don't appear
- Verify **Interactivity** is enabled (step 7)
- Check that the `chat:write` scope is present

### "Not connected to gateway" errors
- Ensure the gateway is running and the socket path matches
- Check that both containers share the `socket-vol` volume
- Look at gateway logs for socket server startup messages
