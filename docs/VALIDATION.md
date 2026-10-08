# Verification · WhatsApp revision · 8 October 2026

## Passed

- TypeScript: `npm run typecheck`
- Unit / React DOM: `npm test` — **66 tests, 4 files passed**
- Production bundle: `npm run build`
- Formatting: `npm run format:check`

Node 24.19.0 / npm 11.9.0. Lockfile included.

## What was tested

- Both official GREEN-API host families; rejection of spoof domains, userinfo, unsafe schemes, unsupported paths and MAX `/v3`
- International phone normalization including +998
- WhatsApp `checkWhatsapp` string chatId request, `existsWhatsapp` response, LID/phone ID mapping and legacy response fallback
- Text sending up to 20,000 characters, incoming/extended text and outgoing statuses
- Serial polling/acknowledgment, acknowledgment retry, timeout, backoff and cancellation
- Duplicate suppression, unread counts, early-webhook races and status order
- StrictMode interactions, logout while requests are pending, isolation after reconnect
- Full React DOM flow using mocked HTTP: login → +998 recipient → `@lid` chat → send → phone-ID reply mapped back to the same chat → acknowledgment
- Local demo with no external requests

All HTTP tests use dummy values and mock responses. No user token was used, no real message was sent and no live queue event was deleted.

## What changed

The app now targets **WhatsApp only**, as requested. MAX `checkAccount`, numeric chat IDs, +7/+375-only validation and `/v3` were removed. The decorative first screen and optional search were removed. Core validation, tests and concurrency protections remain.

## Outstanding checks

The screenshot's generic network error cannot establish whether the cause is network availability, CORS, timeout, a browser extension or the service. Error handling now distinguishes timeout from an unknown browser/network failure; it does not falsely blame the token.

Real WhatsApp authorization, account settings, CORS and two-way delivery need a dedicated authorized test instance. The user must pair WhatsApp using the QR flow in the provider console, enable incoming webhooks, leave webhookUrl empty and use only one queue consumer. The app does not change those settings.

Browser E2E/visual QA was blocked earlier by Chromium socket creation being denied (`Operation not permitted`), including the approved escalation; the separate cloud browser could not reach the local Vite server. There is no successful browser run or screenshot for this revised UI. The updated Playwright tests are included for a machine that can launch Chromium. jsdom tests do not certify layout.

Known scope limits: in-memory history; no reload recovery; LID aliases cover contacts resolved during this session, not rare account-ID migrations; no media, hosting, employer submission.

## User feedback

On 8 October 2026 the user reported that the app worked. This is user feedback, not independently observed proof of a specific live send/receive test. Automated results above remain mocked.
