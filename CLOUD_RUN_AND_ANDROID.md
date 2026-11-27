# FUN TARGET — Cloud Run and Android build notes

## Important architecture note

This project is not a static website. It has an Express API, a WebSocket game
engine, and a SQLite database. The browser and Android app must connect to the
same deployed HTTPS origin (WebSocket upgrades use `wss://` automatically).

The included Cloud Run container builds the Vite frontend and runs the API and
WebSocket server together. It is a **test deployment configuration**, not yet a
production-safe data architecture: SQLite files and in-memory game state are
not durable across Cloud Run instance replacement/restarts. Cloud Run's local
filesystem is ephemeral. Do not use it for real customer records or real-money
play. Before production, migrate SQLite to Cloud SQL for PostgreSQL and move
round/game state that must survive restarts into that shared database; also
review the game and applicable local laws. Keep this project virtual-points
only unless separately cleared for the intended jurisdiction.

## Deploy test version to Cloud Run

Prerequisites: a Google Cloud project with billing enabled, Cloud Run and
Artifact Registry APIs enabled, `gcloud` installed and authenticated, and a
configured project/region.

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud run deploy fun-target \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --port 8080 \
  --min 1 \
  --max 1 \
  --no-cpu-throttling \
  --set-env-vars NODE_ENV=production
```

After deployment, copy the HTTPS Service URL from the command output. The
single-instance setting is intentional for this prototype because the game
engine is currently in memory. It does not make SQLite durable across restarts.
Set strong `SESSION_SECRET` (at least 32 random characters) and `ADMIN_PASSCODE`
using Secret Manager before exposing an admin account. Set `DATA_DIR` to a mounted
persistent volume only after configuring a storage backend appropriate for SQLite;
do not mount a Cloud Storage FUSE bucket as a SQLite database volume. Do not commit secrets.

## Android APK wrapper

Install dependencies, then set the real Cloud Run URL and generate/sync the
native Android project:

```bash
npm install
npm run build
# Linux/macOS:
CAPACITOR_SERVER_URL=https://YOUR-CLOUD-RUN-URL npx cap add android
CAPACITOR_SERVER_URL=https://YOUR-CLOUD-RUN-URL npx cap sync android
npx cap open android
```

In Android Studio choose **Build > Generate App Bundles or APKs > Generate APKs**.
The debug APK is under `android/app/build/outputs/apk/debug/`. For release,
create/sign a release keystore and use **Generate Signed Bundle / APK**.

The Android app points to the same Cloud Run origin, so `/api/*` requests and
`/ws` WebSocket live updates work against the backend. Re-run `npx cap sync
android` whenever the app configuration or native dependencies change.

## Local smoke test

```bash
npm install
npm run build
npm start
```

Open `http://localhost:8080/api/health`; expected response is JSON with `ok`
set to `true`. Then open the root URL in a browser and verify registration,
login, live round updates, and owner controls.
