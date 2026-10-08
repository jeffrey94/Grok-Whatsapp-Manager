# Notes for agents working on this repo

- Never run `npm run pair`, `src/pair.js`, `npm start`, or
  `deploy/whatsapp-bridge-control.sh start|restart|ensure` unless the operator has
  explicitly asked for it in the current task. These contact WhatsApp.
- Never touch the Telegram bridge (`/home/box/grokbot-telegram-bridge`) from here.
- Tests must stay offline: use `test/helpers/fake-baileys.js` and
  `test/helpers/mock-gateway.js`. Don't call the real gateway on :1340.
- `scripts/sample-quotes-live.mjs` is the one exception: it wakes a real agent
  through :1340 (fake socket, nothing reaches WhatsApp). Run it only when
  the operator asks for a live-agent sample run.
- Don't read, print or copy `auth/`, `config.json` or `gateway.json` contents.
- Platform-neutral logic lives in `src/core/`. Keep WhatsApp specifics in
  `src/whatsapp/`.
- Run `npm test && npm run check` before committing.
