# context-bar

A Claude Code mod that draws a live card above the prompt: how full the context window is, what fills it, how much of your usage limits is left, and what the session has cost. It works in the terminal and in the desktop app's Code tab.

## What it shows

- **Context**: tokens used out of the window, the percent, and where auto-compact starts. Below that, a bar split by category (system prompt, tools, MCP tools, memory files, messages, free space, compaction buffer). Hover a segment to see its name and size.
- **Usage**: your 5-hour and weekly limits, each with a meter, the percent used and the time until it resets, plus any other window your account reports. The last row is the session's cost estimated at API prices, the same figure `/cost` shows.
- **Handoff button** (`h`): writes a handoff document of the conversation, clears it, and starts a fresh conversation from that document. If any step fails, nothing is cleared and a toast says why.

## Install

Run this in a terminal:

```bash
claude plugin install context-bar --marketplace iagodemacedo/context-bar
```

It installs at the user scope, so the card appears in every new session, in the terminal and in the desktop app's Code tab. Start a new session after installing.

From inside a terminal session you can also type `/plugin install context-bar --marketplace iagodemacedo/context-bar`, answer `y` to add the marketplace, and press Enter to keep the user scope. The `/plugin` command is not available in the desktop app's Code tab, so install from a terminal once and the desktop picks it up.

## Update and remove

```bash
claude plugin update context-bar
```

```bash
claude plugin uninstall context-bar
```

## Notes

- Built and tested on macOS with Claude Code 2.1.300. The handoff document is saved under `/tmp`.
- Usage limits appear when your account reports them (Pro and Max plans). Otherwise the row says there is no reading yet.
- Where an organization manages Claude Code, the hook that refreshes right after a compaction does not run. The card still refreshes every 15 seconds.

## Develop

```bash
git clone https://github.com/iagodemacedo/context-bar && cd context-bar
```

```bash
claude --plugin-dir .
```

Saving a file reloads the mod in that session. Before a commit, run `claude plugin validate .` and `claude plugin test .`.

## License

MIT
