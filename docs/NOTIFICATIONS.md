# Phone notifications (Web Push)

MJ sends real push notifications to your phone, even when the app is closed: **reminders** (repeating every 10 min with a **Stop** button), **breaking-news alerts** and the **morning news briefing**. It uses the free Web Push standard (VAPID keys), so there is no paid service. Everything is also saved in the in-app history (bell icon) with read/unread.

Reminders are stored on the server, so they fire whichever chat you are in, and even if you close the app or start a new chat.

## Setup (once)

1. **Keys.** `backend/.env` already has `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. To make new ones: `npx web-push generate-vapid-keys`.
   Never put the private key in the frontend or in git. The "subject" is `mailto:` + your `OWNER_EMAIL` (or set `VAPID_SUBJECT`).
2. **AppSail → Configuration:** add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (and optionally `VAPID_SUBJECT`), then rebuild and redeploy:
   ```bash
   cd backend
   npm run docker:build
   catalyst deploy
   ```
   `GET /health` then shows `"push": true` under `features`.
3. **Frontend:** push to GitHub so Vercel redeploys. `frontend/vercel.json` forwards `/api/*` to AppSail, so the browser never hits CORS.
4. **Cron:** keep the `cron-job.org` call to `POST /jobs/tick` (every 5 min) so reminders and alerts are checked while the app is idle.

## Turn it on, on your phone

**Android (Chrome or Edge)**
1. Open the MJ site, tap the menu, **Install app / Add to Home screen** (recommended, not required).
2. Open **Settings** (sidebar) → **Phone notifications** → **Enable notifications** → **Allow**.
3. Tap **Send a test**. A notification should appear within seconds. Lock the phone and send another to check.

**iPhone (iOS 16.4 or newer)**
1. Open the MJ site in **Safari**, tap **Share → Add to Home Screen**.
2. Open MJ **from the Home Screen icon** (not from Safari).
3. **Settings → Enable notifications → Allow**, then **Send a test**.

Notification categories can be switched on and off in the same screen. Turning notifications off removes this device from the server.

## What is sent, and what is not
The payload is encrypted end to end by the Web Push protocol. It contains only the title, a short text, a link back into the app and (for reminders) the reminder id used by the Stop button. No tokens or secrets are ever put in a notification.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "Enable notifications" says the server is not set up | `VAPID_*` missing in AppSail, or the app was not redeployed. Check `/health` → `features.push`. |
| Permission shows "blocked" | Browser site settings → Notifications → Allow for the MJ site, then reopen Settings. |
| iPhone shows "install the app" | Notifications only work from the Home Screen app on iPhone. Follow the iPhone steps. |
| Test works, reminders do not | The cron call is not running (app asleep). Check `cron-job.org` history for HTTP 200. |
| Stop button on the notification fails | Open MJ once so it saves your connection for the notification, then try again. Or press **Stop this reminder** in the in-app notification list. |
| Notifications stopped arriving | Open the app once: it re-registers this device automatically if the browser refreshed its subscription. |
| Expired devices | Removed automatically when the push service reports 404/410. |

## Tests
Server: `cd backend && npm test` (push service, subscribe validation, history, preferences, stop-reminder, chat sessions).
Manual: enable → send test → close the app → send test again → tap the notification (it should open/focus MJ) → tap **Stop** on a repeating reminder.
