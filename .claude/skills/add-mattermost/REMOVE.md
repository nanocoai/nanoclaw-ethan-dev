# Remove Mattermost Channel

1. Comment out `import './mattermost.js'` in `src/channels/index.ts`
2. Remove `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN`, `MATTERMOST_CALLBACK_URL`, `MATTERMOST_TEAM` from `.env` (or from the OneCLI vault, if migrated there)
3. `pnpm uninstall chat-adapter-mattermost`
4. Rebuild and restart
