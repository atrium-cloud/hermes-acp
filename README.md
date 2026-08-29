# hermes-agent-acp

`hermes-agent-acp` is an [Agent Client Protocol](https://agentclientprotocol.com/) v1 adapter for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It uses Hermes' `tui_gateway` backend and presents an ACP surface that is compliant with the latest stable ACP v1 schema.

## Requirements

- Hermes Agent 0.20.6 or above, configured with a model provider

The binary is `hermes-agent-acp`, not `hermes-acp`: Hermes' own installer, `hermes update`, and `hermes uninstall` all claim `~/.local/bin/hermes-acp` (and `/usr/local/bin/hermes-acp`) for the upstream `hermes acp` launcher, so a binary of that name is overwritten on every Hermes install and deleted on uninstall.

## ACP support

The adapter supports rich prompts, streamed message and tool updates, permissions and elicitations, modes and model configuration, slash commands, session list/resume/load/close/delete, and head-only session forks.

MCP passthrough, audio prompts, breakpoint forks, and Hermes interactions that require its own frontend are not exposed. Unknown Hermes gateway events without an ACP v1 representation are dropped. See [docs/caveats.md](docs/caveats.md) for the complete limitations.

This project is a stopgap. It will be retired when Hermes ships a current, reliable ACP implementation upstream.

## Acknowledgements

The architecture follows [codex-acp](https://github.com/JetBrains/codex-acp) (an ACP adapter over `codex app-server`) and [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp), both Apache 2.0. The tool-kind table and tool-failure heuristic are ported from Hermes Agent's own `acp_adapter` (MIT, Nous Research); see [NOTICE](NOTICE).

## Contributing

External pull requests are not accepted. Issues and security reports remain welcome, and forks are permitted under the Apache 2.0 license. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licensing

`hermes-agent-acp` is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE). Attribution notices are in [NOTICE](NOTICE), and brand-use guidance is in [TRADEMARKS.md](TRADEMARKS.md).
