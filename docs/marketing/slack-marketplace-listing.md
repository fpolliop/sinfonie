# Slack Marketplace listing for Sinfonie (paste-ready)

## App name
Sinfonie

## Short description (≤ 140 chars)
Desktop on-call assistant: watches your support and alert channels, triages each thread with your code at hand, drafts replies you approve.

## Long description
Sinfonie is a macOS app for engineers who run several repositories at once. Its on-call assistant connects to Slack as you, watches the channels you choose (a support channel, an alerts channel), and turns every new request or alert into an incident. For each incident an AI model reads the thread, looks at the relevant code on your Mac, and writes a short report: severity, likely cause, evidence, next steps, and, when appropriate, a draft reply.

Nothing is posted without you: drafts appear in the app, you edit them, and only the message you press Send on goes to the thread, as you. Tokens stay encrypted on your Mac; Sinfonie has no server that reads your messages.

Works with Slack, Jira, Linear and GitHub, and with Claude, Codex, Gemini and Grok as the model.

## Category
Developer tools (also: Customer support)

## Links
- Website: https://sinfonie.dev
- Privacy policy: https://sinfonie.dev/privacy
- Support: https://sinfonie.dev/support
- Download: https://sinfonie.dev/download

## Icon
site/assets/slack-app-icon-512.png (512×512 PNG)

## Scopes and justification (user token scopes)
| Scope | Used for |
|---|---|
| channels:read, groups:read | Listing the user's channels so they can pick which ones to watch. |
| channels:history, groups:history | Reading new messages and thread replies only in the channels the user added to the watch list. Polled at most once per minute per channel. |
| users:read | Showing the author's name next to a message instead of a user id. |
| search:read.public | Letting the assistant find earlier threads about the same problem when triaging. |
| chat:write | Posting the one reply the user explicitly approved, in the incident's thread, as the user. |

No bot user. No direct messages are read. No message content leaves the user's Mac except to the AI provider the user configured, for the thread being triaged.

## AI disclosure
Sinfonie uses large language models (the user chooses the provider: Anthropic, OpenAI, Google, xAI or a local model) to summarise threads and draft replies. Drafts are shown in the app and are only posted after the user reviews and approves them. The model receives the thread text and, when relevant, code from the user's own repositories.

## Test plan for reviewers
1. Download Sinfonie for macOS (Apple silicon): https://sinfonie.dev/download. Open the DMG and drag the app to Applications. The app is signed and notarized.
2. Launch it. Skip setup, or create a space named "Test" with no repositories.
3. Open Settings (⌘,) → Integrations → Slack → Sign in with Slack. A dialog shows the authorization link; open it, approve on Slack. The app shows "connected as <you>" within seconds.
4. Settings → Spaces → Test → On call: search for a channel you are a member of, add it as "support requests", and enable the watcher.
5. Post a message in that channel. Within one to two minutes it appears in the On call view (sidebar), with an AI triage report shortly after (requires a configured AI provider or Claude Code login; without one the incident still appears, marked untriaged).
6. Open the incident: a draft reply may be offered. Press "Send in thread as you" to post it, or Dismiss. Nothing is posted otherwise.
7. Settings → Integrations → Slack → Disconnect revokes the app's token on the Mac.

## Support contact
hello@sinfonie.dev
