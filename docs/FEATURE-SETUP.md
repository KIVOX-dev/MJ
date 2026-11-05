# Feature setup: pictures, voices, attachments, email

All keys go in AppSail → Configuration (and `backend/.env` for local runs). After changing them, **restart** the app. `GET /health` shows what is switched on under `features`.

## Pictures ("draw me...")
Ask in the app or Telegram: "Draw a futuristic city at sunset", "Make a logo for my bakery".
Engines are tried best first:

| Setting | Engine | Result | Cost |
|---|---|---|---|
| `GEMINI_API_KEY` (optional) | Google Gemini | Best, readable text inside pictures | Free key from Google AI Studio (allowance may be limited) |
| `HF_TOKEN` | **FLUX.1 on a free Hugging Face Space** | Real, ChatGPT-style pictures (about 6-10 s) | Free: uses your free daily GPU allowance. Create a token at huggingface.co/settings/tokens |
| *(nothing needed)* | Groq draws vector graphics | Logos, icons, posters, illustrations (not photos) | Free, uses Groq |

If the Hugging Face allowance is used up or the Space is busy, MJ falls back to the Groq drawing engine automatically. Hugging Face's own paid "Inference Providers" are not used (they need pre-paid credits).
Pictures are stored 30 days. A daily limit of 40 protects your allowance.

## Voices (listening and speaking)
- `SARVAM_API_KEY`: Sarvam AI. **Human-sounding voices** (Priya, Ritu, Kavya, Shubh...) in English and Tamil, and very accurate transcription of Indian English and Tamil. Works on Sarvam's free plan. You can put several keys, separated by commas; they are used in turn.
- Without Sarvam: Whisper for listening and Microsoft neural voices (Neerja, Prabhat, Pallavi...) for speaking. These also work with no account.
- If Sarvam is down or its free allowance is used up, MJ switches to Whisper and the Microsoft voices by itself.
- In the app: Settings → Voice to choose the voice; the headphone icon opens **voice mode** (talk hands-free, like ChatGPT).
- `STT_LANGUAGE=en` (or `ta`) is the default language hint for Telegram voice notes. In the app you can choose it under Settings → Voice.

## Your name
`OWNER_NAME` (default `Kaviarasan M`): emails MJ writes for you are signed with it. In chat MJ still says "Sir".

## Emailing other people
"Send an email to someone@example.com about..." MJ writes a draft and shows a card (app) or message (Telegram) with a **Send** button. Nothing is sent until you tap Send; you can edit the subject and text first. It goes through Brevo as "<your name> via MJ", replies come to your own address, and at most 20 emails to others are sent per day.

## Attachments
Paperclip in the message box, up to 4 files: photos (JPEG/PNG, resized on the phone), PDFs (6 MB) and text files (2 MB).
