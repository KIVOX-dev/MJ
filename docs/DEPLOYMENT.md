# Deployment

Frontend → **Vercel**. Backend → **Zoho Catalyst AppSail** as a Docker (custom runtime) image.

## 1. Build the image

All backend commands run from `backend/`.

AppSail only accepts OCI images for **linux/amd64**.

```bash
npm run docker:build
# = docker build --platform linux/amd64 -f docker/Dockerfile -t mj:latest .
```

Local smoke test (secrets from your `.env`, never baked into the image):

```bash
npm run docker:up
curl localhost:9000/health
curl localhost:9000/ready
```

## 2. Deploy to AppSail (Catalyst CLI)

```bash
npm i -g zcatalyst-cli
catalyst login
# run catalyst commands from backend/
catalyst init            # pick/create the project; choose "AppSail" when asked
# or, in an existing project:
catalyst appsail:add     # Runtime: "Docker Image" -> protocol "Docker Image" -> pick mj:latest -> name it "mj"
catalyst deploy          # or: catalyst deploy appsail
```

Standalone (no init), from a folder containing `catalyst.json`:

```bash
catalyst deploy appsail --name mj --source docker://mj:latest --port 9000
```

Alternative: `docker save mj:latest -o mj.tar` then use `docker-archive://mj.tar`.

Notes
- The image already defines the start command (`node dist/server.js`) and port (9000); `--port` overrides it.
- `app-config.json` is not used for container images; settings live in `catalyst.json`.

## 3. Environment variables (set in the Catalyst console, AppSail → Configuration)

Do **not** put secrets in the image or in git. Required: `MONGODB_URI`, `GROQ_API_KEYS`, `CORS_ORIGINS`
(your Vercel URL, e.g. `https://mj.vercel.app`, comma-separated for several). Also `GROQ_MODELS`,
`DEFAULT_TIMEZONE`, and the `WHATSAPP_*` / `OWNER_WHATSAPP_NUMBER` values. Set `NODE_ENV=production`.
Leave `DNS_SERVERS` unset unless Atlas SRV lookups fail.

MongoDB Atlas → Network Access must allow AppSail's egress IPs (use `0.0.0.0/0` on the free tier,
protected by a strong DB password, since AppSail egress IPs aren't fixed).

## 4. Vercel frontend

- Import the repo in Vercel and set **Root Directory = `frontend`** (framework preset: Vite; `frontend/vercel.json` is included).
- Env var: `VITE_API_URL` = your AppSail URL.
- Add the Vercel production domain to the backend's `CORS_ORIGINS`. Preview deployments use different
  domains, so add them too if you need them.
- Never call Groq, Gmail or WhatsApp directly from the browser; the frontend only talks to the MJ API.

## 5. WhatsApp webhook

After deploy, set the callback URL in the Meta console to `https://<appsail-url>/webhook/whatsapp`
(added in Phase 2) with your `WHATSAPP_VERIFY_TOKEN`.
