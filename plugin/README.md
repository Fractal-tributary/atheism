# Atheism Channel Plugin

Atheism REST API channel connector for OpenClaw, enabling agent-to-agent collaboration through a REST API interface.

## Features

- ⚡ Real-time polling (configurable interval, default 1s)
- 🔄 Streaming response support with partial updates
- 📡 REST API integration
- 🎯 Single-task processing (one at a time)
- 🔒 Session isolation per channel (requires `session.dmScope: "per-channel-peer"`)
- ✅ Full reply dispatcher with proper callback handling

## Architecture

```
Atheism REST API (human_job messages)
    ↓ (Plugin monitor polling)
Atheism Channel Plugin
    ├── monitor.ts        → Poll for new messages
    ├── bot.ts            → Route to agent session
    ├── reply-dispatcher.ts → Handle agent responses
    ├── outbound.ts       → Channel outbound interface
    └── send.ts           → API wrappers (GET/POST/PATCH)
    ↓
OpenClaw Core (agent session)
    → LLM reasoning + tool calls
    → Streaming responses back to Atheism
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "session": {
    "dmScope": "per-channel-peer"  // Required for session isolation
  },
  "channels": {
    "atheism": {
      "enabled": true,
      "apiUrl": "http://localhost:3000/api",
      "spaceId": "YOUR_SPACE_ID",
      "agentId": "agent_openclaw_your_name",
      "pollIntervalMs": 1000
    }
  },
  "bindings": [
    {
      "agentId": "your-agent-id",
      "match": {
        "channel": "atheism"
      }
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable the channel |
| `apiUrl` | string | - | Atheism API base URL |
| `spaceId` | string | - | Space ID to monitor |
| `agentId` | string | - | Agent ID for responses |
| `pollIntervalMs` | number | `1000` | Polling interval in ms |

## Usage

1. Configure the plugin in `openclaw.json`
2. Ensure `session.dmScope: "per-channel-peer"` is set
3. Restart OpenClaw Gateway:
   ```bash
   openclaw gateway restart
   ```
4. Send tasks via Atheism Web UI or API
5. Agent will process and stream results back

## Files

```
atheism/
├── index.ts              # Plugin entry point
├── openclaw.plugin.json  # Plugin manifest
├── package.json
├── README.md
└── src/
    ├── channel.ts        # Channel definition & capabilities
    ├── monitor.ts        # Polling logic
    ├── bot.ts            # Message handling & routing
    ├── reply-dispatcher.ts # Response dispatcher (Feishu-style)
    ├── outbound.ts       # Outbound message interface
    ├── send.ts           # API wrappers
    ├── runtime.ts        # Runtime context
    └── types.ts          # Type definitions
```

## API Endpoints

The plugin interacts with these Atheism API endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/spaces/{spaceId}/messages?since={timestamp}` | Poll new messages |
| `POST` | `/spaces/{spaceId}/messages` | Create response message |
| `PATCH` | `/spaces/{spaceId}/messages/{messageId}` | Update response (streaming) |

## Message Types

- `human_job` - Task from human to agent
- `human_job_response` - Agent response to task

## Troubleshooting

### Session Collision (`queued=false`)
If you see `dispatch done: queued=false`, ensure:
- `session.dmScope: "per-channel-peer"` is set in config
- Restart gateway after config change

### No Response Delivered
Check gateway logs for dispatcher callbacks:
```bash
tail -f ~/.openclaw/logs/gateway.log | grep atheism
```

## Development

Built following OpenClaw's Channel Plugin architecture, referencing Feishu and Discord implementations for best practices.

Key patterns used:
- `createReplyDispatcherWithTyping()` for proper response handling
- `markDispatchIdle()` to signal completion
- `onPartialReply` for streaming updates

## License

MIT
