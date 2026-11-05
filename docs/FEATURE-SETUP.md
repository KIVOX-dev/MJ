# Feature setup: pictures, natural voice, attachments, email to others

## Picture generation ("draw me...")
Ask in the app or in Telegram: "Draw a futuristic city at sunset", "Make a logo for my bakery", "A portrait poster of a lion, watercolor".
MJ writes a detailed prompt for you, creates the picture, and shows it as a card (tap to enlarge or download). In Telegram it arrives as a photo.

Engines are tried best first. Set the keys you have in AppSail → Configuration (and `backend/.env`):

| Setting | Engine | Quality | Cost |
|---|---|---|---|
| `GEMINI_API_KEY` | Google Gemini image model | Best, writes readable text inside pictures | Free key from https://aistudio.google.com/apikey (free allowance may be limited) |
| `HF_TOKEN` | FLUX.1 on Hugging Face | Very good | Free token from https://huggingface.co/settings/tokens ("Make calls to Inference Providers") |
| `POLLINATIONS_API_KEY` (optional) | Pollinations FLUX | Good | Works with no key, but adds a watermark and allows about 1 picture per 45 s. A free key removes that. |

With no keys, the no-key Pollinations fallback is used. Pictures are stored for 30 days. A daily limit of 40 protects your allowance.
`GET /health` shows which engines are active under `features.images`.

## Natural voice for replies
The phone's own voices sound robotic. MJ can use Groq's natural **Orpheus** voices (Hannah, Diana, Autumn, Austin, Daniel, Troy).
One-time step: a Groq admin must accept the model terms at
https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english (open it, click **Accept**).
Then choose a voice in the app: Settings → Voice. Until then, or for Tamil text, MJ uses the phone voice automatically.

## Better voice transcription
- Settings → Voice → **Language I speak to MJ**: choose English or Tamil instead of Automatic. This is the biggest accuracy gain for accented speech.
- Server default for Telegram voice notes: set `STT_LANGUAGE=en` (or `ta`).
- MJ uses the most accurate Whisper model first and a vocabulary hint (names, places, "MJ", "reminder").

## Attachments
Use the paperclip in the message box: up to 4 files per message.
- Photos (JPEG/PNG): resized on the phone, then read by the vision model.
- PDFs (up to 6 MB) and text files (up to 2 MB): read as text. Scanned PDFs without text need photos of the pages instead.

## Emailing other people
"Send an email to someone@example.com saying hi". MJ writes a draft and shows you the recipient, subject and text. It sends only after you say yes in a **new** message. Replies go to your own address, and at most 20 emails to others per day are sent.
