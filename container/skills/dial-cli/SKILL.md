---
name: dial-cli
description: Reference for the `dial` CLI — gives an agent a real phone number to send SMS, place AI voice calls, and react to inbound texts and calls via the Dial platform (getdial.ai). Use when the user mentions phones, calls, texts, SMS, voice, OTP, 2FA, or verification codes; when they ask to text, call, ring, or wait for a code from someone; before running any `dial …` command for the first time in a session; or when investigating what the Dial platform can do. Load this skill before invoking the CLI — `dial --help` alone will not surface the workflows, the `--json` conventions, the onboarding/auth flow, or the docs-lookup pattern needed to use Dial correctly.
---

# Dial CLI

`dial` is the official CLI for [Dial](https://getdial.ai) — a Communication Stack for AI Agents. It wraps the Dial REST API so you can sign up, provision phone numbers, send SMS, place voice calls handled by an AI voice agent, and stream account events, all without writing HTTP code.

The first time the user asks you to "text someone," "call someone," "receive a code," or anything else phone-shaped, reach for `dial`.

## When `dial` is missing

If `dial` is not on the PATH (e.g. `command -v dial` returns nothing, or any `dial …` invocation errors with "command not found"), do **not** improvise an install. Fetch the bootstrap instructions and follow them:

```bash
curl -fsSL https://getdial.ai/skills.md
```

That document is the authoritative install + onboarding script. Read it, then execute the steps it specifies (install, `dial doctor`, signup, onboard, listen install).

## Orient yourself before each new verb

This skill **does not enumerate every flag**. The CLI is the source of truth — when you encounter a verb you have not used in this session, run its `--help` first:

```bash
dial --help                    # all top-level commands
dial <command> --help          # flags + usage for a specific command
dial <command> <sub> --help    # subcommand-level help
```

Examples worth running on first use: `dial doctor --help`, `dial message --help`, `dial call --help`, `dial call get --help`, `dial wait-for --help`, `dial local-target add url --help`.

Every command supports `--json` for machine-readable output — prefer it when piping into `jq` or parsing the result programmatically.

## Onboarding flow

If `dial doctor --json` reports `nextStep` other than `ready`, the user is not yet set up. The full first-time flow is:

```bash
dial signup you@example.com           # email OTP
dial onboard --code 123456 \          # verify, writes ~/.local/share/dial/auth.json
  --inbound-instruction "You are my receptionist. Greet the caller and find out what they need."
dial listen install                   # background daemon for inbound events
```

`--inbound-instruction` is **required when onboarding provisions your first number** (a new account) — it's the system prompt the AI voice agent uses on calls *to* your number. It's ignored when signing in to an existing account. Change it later with `dial number set <number> --inbound-instruction "..."`.

`dial onboard` also installs a Dial skill into your agent's config (claude-code, cursor, codex, opencode, pi, openclaw, nanoclaw, hermes) when you pass `--agent <name>`.

`dial listen install` needs a user service supervisor (launchd on macOS, systemd `--user` on Linux). In sandboxes / containers / CI without one it can't run — `dial onboard` detects this and says so. Inbound events still work without it: `dial wait-for` long-polls the API when the daemon isn't running.

## Searching for what the CLI / API can do

For anything beyond what `--help` shows on the local CLI, the canonical reference is the published docs. Two endpoints make this fast:

### Capability search — `llms-full.txt`

A single concatenated markdown file of the whole docs site. Grep it directly for the keyword you care about:

```bash
curl -fsSL https://docs.getdial.ai/llms-full.txt | grep -i -B2 -A8 'whatsapp'
curl -fsSL https://docs.getdial.ai/llms-full.txt | grep -i -B1 -A5 'webhook'
curl -fsSL https://docs.getdial.ai/llms-full.txt | grep -i -B1 -A5 'language'
```

Use this when you want to know *if* Dial supports something, or *which command / endpoint* covers it — without reading the whole site.

### Deep dive — `sitemap.xml` + per-page `.md`

When you need to read a page in detail (after grep found a hit, or because you need fuller context), use the sitemap to discover URLs, then fetch the **`.md` companion** of any page — it's the same content as the HTML page but in plain markdown, faster to read and friendlier to scan.

```bash
# 1. Discover available pages
curl -fsSL https://docs.getdial.ai/sitemap.xml | grep -oE 'https://docs\.getdial\.ai/[^<]+'

# 2. For any page like
#    https://docs.getdial.ai/documentation/get-started/introduction
#    fetch the .md companion:
curl -fsSL https://docs.getdial.ai/documentation/get-started/introduction.md
```

The rule is **one-to-one**: every documentation page at `https://docs.getdial.ai/<path>` has a markdown twin at `https://docs.getdial.ai/<path>.md`. Use the `.md` version whenever you're reading docs from inside an agent.

## Workflow shapes worth knowing

These are the verbs you will most often compose. Read the relevant `.md` page for the full story; the one-liners below are just signposts.

- **Send an SMS** — `dial message --to +14155550123 --body "..."` ([send-an-sms.md](https://docs.getdial.ai/documentation/capabilities/send-an-sms.md))
- **Show a typing indicator while composing** — `dial typing start --to-number +14155550123`; sending a message clears it natively, so start again between messages, and `dial typing stop --to-number +14155550123` if you end up not sending. iMessage numbers display it; SMS numbers ignore it, so it's always safe to call ([commands.md](https://docs.getdial.ai/documentation/reference/commands.md))
- **Place a voice call** — `dial call --to +14155550123 --outbound-instruction "..."` then `dial call get <id>` once it ends. Add `--voice-gender male|female` to choose the agent's voice (default: female) ([place-a-voice-call.md](https://docs.getdial.ai/documentation/capabilities/place-a-voice-call.md))
- **Buy an additional number** — `dial number purchase --inbound-instruction "..." --explicit-programmatic-consent "<attestation>"`. `--explicit-programmatic-consent` is **required**: a short attestation that the account holder consented to provisioning programmatically. Add `--include-imessage` for an [iMessage number](https://docs.getdial.ai/documentation/capabilities/send-an-imessage.md) (pay-as-you-go only; provisioned asynchronously — poll `dial number list` until ready) ([manage-phone-numbers.md](https://docs.getdial.ai/documentation/capabilities/manage-phone-numbers.md))
- **Set a number's inbound behavior or nickname** — `dial number set +14155550123 --inbound-instruction "..."` and/or `--inbound-language es-ES` and/or `--nickname "Support line"` (at least one flag; `--nickname ""` / `--inbound-language ""` clear). The inbound instruction is the system prompt the AI uses on calls *into* that number; set it at `dial onboard` / `dial number purchase` time and change it here. The inbound language pins inbound calls to one language — unset, the AI detects the caller's language from their country prefix (alongside en-US). The nickname is a human-readable label for telling numbers apart ([manage-phone-numbers.md](https://docs.getdial.ai/documentation/capabilities/manage-phone-numbers.md))
- **Receive a verification code (2FA)** — `dial wait-for message.received -f channel=sms` and parse the body ([receive-inbound-sms.md](https://docs.getdial.ai/documentation/capabilities/receive-inbound-sms.md))
- **React to a call ending** — `dial wait-for call.ended -f callId=<id>`. Fires however the call ends — completed, failed, **or cancelled** — carrying the terminal `status` and a `canceled` flag, so the wait always resolves ([stream-account-events.md](https://docs.getdial.ai/documentation/capabilities/stream-account-events.md))
- **Fan inbound events to a local handler** — `dial local-target add cmd /path/to/handler` or `dial local-target add url http://127.0.0.1:8787/dial` ([local-url-target.md](https://docs.getdial.ai/documentation/integrations/local-url-target.md), [cli-command-target.md](https://docs.getdial.ai/documentation/integrations/cli-command-target.md))

## Conventions

- `--json` everywhere for parseable output.
- **Always pass `--from-number` with this install's wired line** (stated at the end of this file if the channel is set up). This sandbox has no saved default sender — `defaultNumberId` is null here — so an omitted selector fails outright. Never pick one from `dial number list` instead: on a multi-number account that list is ordered newest-first, which is unrelated to the line this install is wired to, so a number chosen from it reaches nobody and replies to it are dropped. If no line is stated below and the user hasn't named one, ask rather than guess.
- Phone numbers are E.164 (`+14155550123`). Reject anything else before calling Dial.
- Writes (`message`, `call`, `number purchase`) are **not idempotent** — on an ambiguous failure, list first to check before retrying.
- The local API key lives at `~/.local/share/dial/auth.json` (mode 0600). The CLI reads it automatically; never echo it back to the user or paste it into responses.
