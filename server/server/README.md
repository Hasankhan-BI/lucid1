# Lucid — Data Analytics Copilot

A working, self-hostable data analytics SaaS: upload a CSV, get an
auto-built dashboard, plain-language insights, a linear forecast, and a
chat agent that only answers from what's actually in your data.

This is a real backend (accounts, persistence, a secure LLM proxy) behind
the dashboard UI — not a client-only demo. It's intentionally built with a
small, boring stack so one person can run and understand every part of it.

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite, via Node's built-in `node:sqlite` module (no native
  binaries to install — `npm install` is all you need). Swap for Postgres
  later; see "Moving to Postgres" below.
- **Frontend:** a single static HTML/CSS/JS app (no build step), served by
  the same Express server
- **LLM:** Google's Gemini API, called **only from the server** — the
  browser never sees your API key

## Quick start

```bash
npm install
cp .env.example .env
# edit .env: set JWT_SECRET to a random string, and GEMINI_API_KEY to your key
npm start
```

Then open **http://localhost:3000**. Create an account, upload a CSV (or
click "Load sample dataset" once logged in), and explore the dashboard.

Get a free Gemini API key at https://aistudio.google.com/apikey — the app runs
fine without one, except the chat tab, which will show a clear error until
a key is set.

## How it's put together

```
public/            Static frontend (index.html + app.js). Talks to the
                    backend over fetch(); never calls Gemini directly.
src/index.js        Express app: wires up routes, serves the frontend.
src/auth.js          Register/login/JWT session middleware.
src/datasets.js       Upload, profiling trigger, dataset retrieval, forecast.
src/chat.js            The grounded chat proxy — the one place the
                        Gemini API key is used.
src/profiling.js        Pure functions: type detection, stats, outliers,
                         correlations, trend detection, insight generation,
                         linear forecasting. No I/O — easy to unit test.
src/storage.js            Local-disk file storage. This is the one seam
                           you'd swap for S3/R2 in production.
src/db.js                   All persistence. This is the one seam you'd
                             swap for Postgres in production.
```

### Why the chat agent doesn't hallucinate

Every chat request rebuilds a JSON "context" object from data already
computed and stored for that dataset — column stats, correlations,
rule-based insights, the forecast, and a 5-row sample. That JSON is placed
directly in the system prompt with explicit instructions: only use these
numbers, say so when something isn't covered, and caveat forecasts as
projections. The model never sees your raw file, and it has nothing to
hallucinate from besides numbers you can also see on the dashboard.

This is "RAG" in the sense of retrieval-augmented generation — the
retrieval step is a database lookup of precomputed stats rather than a
vector similarity search, which is the right tradeoff for structured
spreadsheet data. If you extend this to long PDFs or reports, that's
where you'd add real chunking + embeddings + a vector store (see below).

## Known limitations (by design, for a first working version)

- **CSV/TSV only.** Excel and PDF need server-side libraries and are a
  natural next step — see `src/datasets.js`, the `upload` route.
- **15MB upload cap, 5,000-row response cap.** Fine for most business
  spreadsheets; bigger files need background job processing instead of
  parsing inline on the request. See "Scaling further" below.
- **SQLite, one file, one process.** Great for a single small deployment;
  won't survive multiple server instances writing at once.
- **In-memory rate limiting.** Resets if the server restarts, and doesn't
  coordinate across multiple instances.
- **No billing/usage metering yet.** Nothing stops a user from running up
  your Gemini bill — add this before letting strangers use it for free.

## Deploying on Railway

Railway will build straight from the `Dockerfile` in this repo — `railway.json`
is already set up to point at it and to use `/api/health` for deploy checks.

**1. Get the code onto Railway.** Either connect a GitHub repo (push this
`server/` folder's contents as the repo root, or set the service's **Root
Directory** to `server` if you keep it nested), or deploy straight from
your machine with the CLI:

```bash
npm install -g @railway/cli
railway login
cd server            # the folder with the Dockerfile
railway init          # or: railway link, if you already made a project
railway up             # builds and deploys
```

**2. Add a Volume.** In the Railway dashboard, right-click the project
canvas (or ⌘K → "Volume") and attach a volume to this service with mount
path **exactly `/data`** — that has to match the `DATABASE_PATH=/data/dev.db`
and `UPLOADS_DIR=/data/uploads` already baked into the Dockerfile. Without
this step the app still runs, but every account and file is wiped on the
next deploy.

**3. Set service variables** (Variables tab): `JWT_SECRET`, `GEMINI_API_KEY`,
and one Railway-specific one —

```
RAILWAY_RUN_UID=0
```

This one matters and is easy to miss: **Railway mounts volumes as the root
user**, but this Dockerfile deliberately runs the app as a non-root user
for security. Without `RAILWAY_RUN_UID=0`, the app can start but will fail
silently (or with permission-denied errors) trying to write to `/data`.
Setting this tells Railway to run the container as root specifically so it
can write to the volume — a Railway platform quirk, not a downgrade of the
app's own security posture.

**4. Generate a public domain.** Networking tab → Generate Domain. Railway
handles HTTPS for you automatically here — unlike the bare VPS/Docker
Compose setup, there's no Caddy/nginx step needed.

**5. Verify persistence, not just that it boots.** Visit the generated
`*.up.railway.app` URL, register an account, and upload a dataset. Then
trigger a fresh deploy (`railway up` again, or push a commit if using
GitHub) and log back in — your account and dataset should still be there.
If they're gone, double-check the volume's mount path is exactly `/data`
and that `RAILWAY_RUN_UID=0` is set.

Expect a few seconds of downtime on each redeploy while the volume detaches
from the old deployment and attaches to the new one — that's expected
Railway behavior with attached volumes, not a bug in the app.

## Deploying with Docker on a VPS

The repo includes a `Dockerfile` and `docker-compose.yml` already set up so
your database and uploaded files survive restarts, redeploys, and even
`docker compose down` — the #1 way people accidentally lose all their data
on a fresh VPS deploy is skipping this.

**1. On your VPS, get the code and your `.env` in place:**

```bash
# copy or git clone the project onto the server, then:
cd server
cp .env.example .env
nano .env   # set JWT_SECRET (long random string) and GEMINI_API_KEY
```

Leave `DATABASE_PATH` and `UPLOADS_DIR` in `.env` alone — `docker-compose.yml`
overrides both to point inside the container at `/data`, which is where the
named volume is mounted. You don't need to create that path yourself.

**2. Build and start it:**

```bash
docker compose up -d --build
```

This builds the image, starts the container, and creates a Docker-managed
volume called `lucid_data` the first time it runs. Check it's healthy:

```bash
docker compose ps
curl http://localhost:3000/api/health
```

**3. Why your data survives now:**

- `dev.db` (all accounts and datasets) and every uploaded file are written
  to `/data` *inside the container*, which is really the `lucid_data`
  volume living on the host — not inside the container's own filesystem.
- Restarting, rebuilding, or redeploying the container (`docker compose up
  -d --build` again after a code change) reuses the same volume
  automatically. Your data is untouched.
- The only command that deletes it is `docker compose down -v` (the `-v`
  removes volumes) — avoid that unless you mean it.

**4. Put the app behind HTTPS.** Docker Compose here only exposes plain
HTTP on port 3000. For a real deployment, put a reverse proxy in front of
it — Caddy is the least fiddly option because it gets you free automatic
HTTPS certificates:

```bash
# example: a one-line Caddy setup on the same VPS, pointed at your domain
caddy reverse-proxy --from yourdomain.com --to localhost:3000
```

(Or run Caddy as its own container in the same `docker-compose.yml` with a
`Caddyfile` — that's the more permanent version of the same idea.)

**5. Back up the volume periodically** — it's the only copy of your data:

```bash
docker run --rm -v lucid_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/lucid-backup-$(date +%F).tar.gz -C / data
```

Run that on a cron schedule and copy the resulting `.tar.gz` off the VPS
(to S3, another machine, wherever) — a volume on the same disk as the VPS
protects you from container mistakes, not from the VPS itself dying.

## Deploying without Docker

If you'd rather not use Docker, the same rules apply directly on the VPS:
run the app with a process manager instead of a bare `node` command so it
restarts on crash and on server reboot —

```bash
npm install -g pm2
pm2 start src/index.js --name lucid
pm2 save
pm2 startup   # prints a command to run once, so pm2 restarts on server reboot
```

— and set `DATABASE_PATH` / `UPLOADS_DIR` in `.env` to a path *outside* the
project folder that you control and back up separately (e.g. `/var/lucid-data/dev.db`),
so a `git pull` or redeploy that touches the project directory can never
touch your data. Put Caddy or nginx in front of it for HTTPS the same way
as in the Docker section above.

## Moving to Postgres

`src/db.js` is the only file that touches the database. To move to
Postgres: install the `pg` package, rewrite the functions in `db.js` to
use SQL over a `pg` connection pool (the function signatures can stay
identical), and point `DATABASE_URL` at your Postgres instance. Nothing
in `auth.js`, `datasets.js`, or `chat.js` needs to change.

## Scaling further

- **Background jobs for parsing:** move the profiling call in
  `datasets.js` into a queue (BullMQ + Redis, or a serverless function
  triggered on upload) so large files don't block the request.
- **Object storage:** swap `src/storage.js` for an S3/R2-backed version;
  the function signatures (`saveRaw`, `saveRows`, `loadRows`) are the
  contract the rest of the app relies on.
- **Real RAG for unstructured documents:** chunk text, embed chunks
  (Voyage or OpenAI embeddings), store vectors in pgvector or Pinecone,
  and retrieve the top-k relevant chunks per question instead of — or
  alongside — the structured context object already used here.
- **Billing:** meter rows-processed and chat-messages-sent per user, and
  wire up Stripe for plan enforcement.
- **Auth:** the current email/password + JWT setup is fine to start;
  Clerk, Auth0, or Supabase Auth are drop-in upgrades if you want social
  login, magic links, or SSO later.

## Security notes

- Passwords are hashed with bcrypt; never stored in plain text.
- The Gemini API key lives only in `.env` on the server — it is never
  sent to or readable from the browser.
- Every dataset and chat route checks `userId` ownership before returning
  data; cross-user access returns 404 (not 403), so one user can't even
  confirm another user's dataset exists.
- Chat is rate-limited per user (20 messages / 10 minutes by default —
  tune `RATE_LIMIT`/`RATE_WINDOW_MS` in `src/chat.js`).
