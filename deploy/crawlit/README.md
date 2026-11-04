# Crawlit on a server for MJ

[Crawlit](https://labs.arufian.dev/crawlit/) is a self-hosted web crawler (MIT licence). MJ uses it to read JavaScript-heavy pages,
search the web and crawl whole sites. This folder runs it on **your own server** behind HTTPS and a secret token.

```
MJ on Catalyst AppSail  --HTTPS + Bearer token-->  Caddy  -->  Crawlit  -->  Redis
                                                  (only ports 80/443 open to the internet)
```

Why the gateway: Crawlit has **no authentication**. Never publish its port (3000) or Redis (6379) to the internet. Here only Caddy is
exposed, and it answers `401` to anything without your token.

## What you need

| Item | Notes |
|---|---|
| A Linux server with Docker | **2 GB RAM or more recommended** (Chromium + Node + Redis). I have not measured the real memory use, so watch it on first run. Any VPS works. |
| A domain name | An **A record** pointing at the server's IP (e.g. `crawlit.yourdomain.com`). Caddy fetches the HTTPS certificate for it automatically. |
| Open ports 80 and 443 | 80 is needed for the certificate challenge. Keep everything else closed. |

Why not Catalyst AppSail? Its documentation does not state memory or CPU limits, whether free tiers can run a browser, or idle
behaviour, and Crawlit also needs Redis, so I cannot promise it fits. A small VPS is the predictable choice. Check current prices and free
offers (for example Oracle Cloud's Always Free tier) on the providers' own pages.

## Steps

1. **Install Docker** on the server: <https://docs.docker.com/engine/install/ubuntu/> (adapt for your distribution).
2. **Copy this folder** to the server (`git clone` your repository, or `scp -r deploy/crawlit user@server:~/crawlit`).
3. **Configure**
   ```bash
   cd crawlit
   cp .env.example .env
   openssl rand -hex 32          # prints a secret token: copy it
   nano .env                     # set CRAWLIT_DOMAIN and CRAWLIT_TOKEN
   ```
4. **Firewall** (Ubuntu example): `sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable`
5. **Start** (the first build downloads Chromium and takes several minutes):
   ```bash
   docker compose up -d --build
   docker compose ps            # all three services should be "running"/"healthy"
   ```
6. **Check it** from your own computer:
   ```bash
   curl -i https://crawlit.yourdomain.com/health                                   # expect 401 (no token)
   curl -s -H "Authorization: Bearer <your token>" https://crawlit.yourdomain.com/health   # expect {"status":"ok",...}
   ```
7. **Connect MJ** - in the Catalyst console, AppSail, `mj`, Environment Variables, add:
   - `CRAWLIT_URL` = `https://crawlit.yourdomain.com`
   - `CRAWLIT_TOKEN` = the same token

   Restart or redeploy. MJ's log should say `Crawlit connected`. MJ refuses to start with a remote `http://` URL or a missing token, so the
   secret can never be sent unencrypted or left off.

If the server is down or the token is wrong, MJ keeps working: it falls back to its built-in page reader (without the search and crawl tools).

## Keep it safe

- **Treat the token like a password.** Anyone holding it can make your server fetch web pages. To rotate it: change `CRAWLIT_TOKEN` in
  `.env`, run `docker compose up -d`, then update the same variable on AppSail.
- **Cloud servers:** containers can often reach the provider's metadata address. Block it with
  `sudo iptables -I DOCKER-USER -d 169.254.169.254 -j DROP` (and make it persistent for your distribution).
- **MJ's own rules still apply on top:** MJ never sends LinkedIn, Facebook, Instagram, X or private addresses to Crawlit, whatever the
  stealth browser could technically do. Crawlit's crawl endpoint obeys robots.txt.
- **Search:** Crawlit's search reads Google/DuckDuckGo result pages, which those sites' terms restrict. At personal volume the realistic effect
  is being throttled (`SEARCH_ENGINE=duckduckgo` is the default here). An official search API is the safer long-term choice.

## Operate it

```bash
docker compose logs -f crawlit      # what it is doing (the token is stripped from the gateway logs)
docker compose up -d --build        # apply changes
docker compose down                 # stop (add -v to also delete the Redis cache)
```

**Updating Crawlit:** the compose file pins the exact upstream commit that was reviewed (`eadb131`). To upgrade, review the changes on
<https://github.com/arufian/Crawlit>, then replace the commit hash in `docker-compose.yml` and rebuild.

## Not verified

This kit was written from Crawlit's documentation and source and its compose file passes `docker compose config`, but it has **not been
built or run end to end** (building third-party images on the development machine was not permitted). Expect to fix small things on first run, and
tell me what you see in `docker compose logs`.
