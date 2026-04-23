# Kcal — Calorie Tracker

A multi-user calorie tracking web app with a 30-day rolling history.  
Built with **Node.js + Express + SQLite**. No framework bloat, fully self-contained.

---

## Features
- Register / sign-in (JWT auth, bcrypt passwords)
- Log food + calories per day
- Navigate back through past days
- Circular progress ring (under / on-track / over)
- 30-day history with bar chart
- Per-user calorie targets
- Rate limiting + security headers

---

## Running locally

### Prerequisites
- Node.js 18+ — https://nodejs.org

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env
# Edit .env and set a real JWT_SECRET

# 3. Start the server
npm start
# → http://localhost:3000
```

For auto-restart during development:
```bash
npm run dev
```

The SQLite database is created automatically at `./data/calories.db` on first run.

---

## Hosting options

### Option A — Railway ⭐ Recommended for simplicity

Railway gives you a persistent filesystem (your SQLite file survives deploys and restarts),
which makes it the easiest option for this app. Cost: ~$5 USD/month after the free trial.

**Steps:**

1. Push your code to a GitHub repo (the `.gitignore` already excludes `data/` and `.env`)

2. Go to https://railway.app → New Project → Deploy from GitHub → select your repo

3. Railway auto-detects Node.js and runs `npm start`

4. **Add a Volume** (critical for persistence):
   - In your Railway project → click your service → Storage → Add Volume
   - Mount path: `/data`
   - This keeps your database across deploys

5. **Set environment variables** (Railway dashboard → Variables):
   ```
   JWT_SECRET   =  <run: openssl rand -hex 32>
   DB_PATH      =  /data/calories.db
   NODE_ENV     =  production
   ```

6. Redeploy — your app is live on a `*.railway.app` URL.

7. (Optional) Add a custom domain under Settings → Domains.

---

### Option B — Render (free tier available)

Render has a permanently free web service tier, but with one catch:
**the filesystem resets on every deploy** — so SQLite data is lost on each deploy.

**Two ways to solve this on Render:**

#### Option B1 — Render Disk ($1/month add-on)
Cheapest fix. Adds a persistent disk to your free web service.

1. Push code to GitHub
2. https://render.com → New → Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. After creation, go to your service → Disks → Add Disk
   - Mount path: `/data`
   - Size: 1 GB (minimum — more than enough)
6. Set environment variables:
   ```
   JWT_SECRET   =  <your secret>
   DB_PATH      =  /data/calories.db
   NODE_ENV     =  production
   ```

#### Option B2 — Render free + Supabase free PostgreSQL (truly $0)
More complex but completely free long-term. Requires replacing SQLite with the `pg` package.
See the PostgreSQL migration note at the bottom of this README if you want to go this route.

**Note on Render free tier**: the service spins down after 15 minutes of inactivity.
The first request after sleep takes ~30 seconds. Fine for personal use; use Render Starter
($7/month) or Railway if you want it always-on.

---

### Option C — Fly.io (free tier with persistent volumes)

Fly.io offers generous free allowances including persistent storage. Slightly more CLI-heavy.

1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
2. `fly auth signup`
3. In your project directory:
   ```bash
   fly launch        # follow prompts, pick a region close to you
   fly volumes create kcal_data --size 1  # 1 GB persistent volume
   ```
4. Edit the generated `fly.toml` to mount the volume:
   ```toml
   [mounts]
     source      = "kcal_data"
     destination = "/data"
   ```
5. Set secrets:
   ```bash
   fly secrets set JWT_SECRET="your-secret-here"
   fly secrets set DB_PATH="/data/calories.db"
   ```
6. `fly deploy`

---

## Security checklist before going live

- [ ] Set a strong `JWT_SECRET` (at least 32 random characters)
- [ ] Enable HTTPS (all three platforms above handle this automatically)
- [ ] Back up `calories.db` periodically (Render/Railway let you download volumes)
- [ ] Consider enabling 2FA on your hosting account

---

## Environment variables reference

| Variable     | Required | Default                  | Notes                                      |
|-------------|----------|---------------------------|--------------------------------------------|
| `JWT_SECRET` | Yes in prod | (insecure default) | Use `openssl rand -hex 32` to generate     |
| `DB_PATH`    | No       | `./data/calories.db`      | Point to your mounted volume in production |
| `PORT`       | No       | `3000`                    | Set automatically by all hosting platforms |
| `NODE_ENV`   | No       | (none)                    | Set to `production` on hosting platforms   |

---

## PostgreSQL migration (optional)

If you want to use Supabase/Neon/any PostgreSQL instead of SQLite:

1. `npm install pg` and remove `better-sqlite3`
2. Replace the `better-sqlite3` database calls with `pg` Pool queries
3. The SQL schema in `server.js` is standard SQL and will work on PostgreSQL with minor changes
   (remove `AUTOINCREMENT` → use `SERIAL` or `GENERATED ALWAYS AS IDENTITY`)
4. Set `DATABASE_URL` to your PostgreSQL connection string

This is a reasonable path if you outgrow SQLite or want to use Render's free PostgreSQL tier.
