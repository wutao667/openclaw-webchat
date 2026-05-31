# openclaw-wechat-plugin

Browser WebChat channel for OpenClaw. Chat with your OpenClaw agents directly from a web browser — no third-party IM platform needed.

## Prerequisites

- OpenClaw Gateway >= 2026.3.28
- A WebChat Chat Server running at a public (or reachable) address

## Install

```bash
openclaw plugins install openclaw-wechat-plugin
```

## Quick Start

### 1. Deploy the Chat Server

On any machine with a public IP (or reachable from both browser and plugin), clone the [repo](https://github.com/wutao667/openclaw-wechat) and run:

```bash
git clone https://github.com/wutao667/openclaw-wechat.git
cd openclaw-wechat/server
npm install
node server.js
```

The Chat Server listens on port `3100`:
- Browser → `ws://<host>:3100/ws`
- Plugin → `ws://<host>:3100/plugin`

For production, add a TLS reverse proxy (Caddy/Nginx) for WSS support.

### 2. Configure Channel

Edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "webchat": {
      "enabled": true,
      "serverUrl": "wss://your-domain.com/plugin",
      "pluginId": "webchat-openclaw-plugin",
      "agents": [
        { "agentId": "main", "name": "我的助手" }
      ]
    }
  }
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `enabled` | Enable this channel | `true` |
| `serverUrl` | Chat Server `/plugin` WebSocket URL | `ws://localhost:3100/plugin` |
| `agents` | Agents exposed to browser users | `[{ agentId: "nezha", name: "哪吒" }]` |
| `dmPolicy` | Direct message policy | `open` |

### 3. Restart Gateway

```bash
openclaw gateway restart
```

### 4. Open Browser

Visit `https://your-domain.com`, enter a username, select an agent, and start chatting.

## Architecture

```
Browser ──WS──→ Chat Server (public) ──WS──→ Plugin ──dispatch──→ OpenClaw Core → Agent
```

The plugin initiates an outbound WebSocket connection to the Chat Server (long-connection, not webhook). This means OpenClaw instances behind NAT/firewalls can still connect as long as they have outbound internet access.

## Multiple OpenClaw Instances

Each instance installs the plugin with a different `agentId`, all connecting to the same Chat Server. The server routes messages by `agentId`.

```json
// Instance A
{ "agents": [{ "agentId": "instance-a", "name": "Bot A" }] }

// Instance B
{ "agents": [{ "agentId": "instance-b", "name": "Bot B" }] }
```

## Session Isolation

- Session key: `webchat:{userId}:{agentId}`
- Same user + same agent across browsers → shared history
- Different users → completely isolated

## Development

Full source code at [github.com/wutao667/openclaw-wechat](https://github.com/wutao667/openclaw-wechat).
