# Security notes

- **Gateway:** loopback only (`127.0.0.1`/`::1`/`localhost`). The token is read
  in memory from `gateway.json`, which must not be readable by group or other
  users (mode 600). It is never logged or written anywhere.
- **Config:** `config.json` must be mode 600. It is read with `O_NOFOLLOW`
  (symlinks are refused). Config is file-only: no chat message can change
  routing, allowlists or agent setup.
- **WhatsApp session:** `auth/` is created at mode 700 and its files at 600.
  The bridge refuses a symlinked or foreign-owned auth dir. Anyone with a copy
  of `auth/` can act as the linked device, so never copy, commit or share it.
  To revoke access, remove the linked device on the phone (**Linked devices**).
- **Pairing artifacts** (pairing code, QR PNG) are written at mode 600 and
  removed after pairing.
- **Logs:** message bodies, prompts and replies are never logged. The logs
  hold ids, kinds and counts only. Baileys' own logger is reduced to messages
  and error text, never raw protocol objects or keys.
- **Git:** `.gitignore` covers `auth/`, `config.json`, `.env`, `state/`, logs,
  PNGs and `gateway.json`.
- **Supply chain:** only `baileys` is a direct dependency, pinned exactly with
  `package-lock.json`. Install with `npm ci --ignore-scripts`. Beware
  typosquats such as `@vreden-team/baileys` and `lotusbail`. The real package
  is `baileys` from github.com/WhiskeySockets/Baileys.
- **Untrusted input:** everything from WhatsApp is data. Header-like lines are
  stripped before the trusted header is added. Approvals are never granted
  from chat.
