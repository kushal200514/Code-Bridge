# CodeBridge — MVP

A working, tested MVP of the relay-based (server-mediated) transfer path from
the CodeBridge project plan: no accounts, no installs, code/QR pairing,
sender approval, one-time download tokens, and automatic file/session
deletion.

## What's implemented

- Session creation with a CSPRNG 6-digit code + QR code
- Join-by-code with per-IP rate limiting (brute-force protection)
- Sender approval/rejection before any file moves
- Multi-file upload with size limits, extension allow-listing, chunked
  streaming to disk (never buffers a whole file in memory)
- One-time, single-use download tokens (HMAC-safe comparison)
- Automatic file deletion the moment all files in a session are downloaded
  (not just when the session's TTL eventually expires)
- Background job that removes orphaned on-disk session folders if a client
  disappears without completing the flow
- Live status updates over WebSocket (receiver joined, approved/rejected,
  files ready, downloaded, completed)
- A vanilla HTML/CSS/JS frontend (no build step) with a Privacy Dashboard
  and an explicit "what we can and can't guarantee" disclosure

## What's intentionally NOT yet implemented

This is the relay-only MVP (weeks 1–4 of the roadmap). Still to build:

- **WebRTC P2P transfer** — everything currently goes through the server via
  the relay path. The `/transfer/{id}/status` WebSocket is scaffolded and
  ready to carry SDP/ICE signaling once you add the P2P layer.
- **Malware scanning** — there's a clearly marked `TODO` in
  `backend/app/storage.py` where a ClamAV/`clamd` check belongs, before a
  file becomes downloadable.
- **Client-side encryption** before relay upload (currently files are
  encrypted in transit via HTTPS/WSS but stored as plaintext on disk
  temporarily — fine for local dev, add this before any real deployment).
- **HTTPS/TLS termination** — run this behind Caddy, nginx, or a cloud LB
  with a real certificate in anything beyond local dev; CORS is wide open
  (`allow_origins=["*"]`) and needs tightening to your real frontend origin.

## Running locally (no Docker)

```bash
# 1. Start Redis
redis-server --daemonize yes

# 2. Install and run the backend
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 3. Open http://localhost:8000 — the frontend is served by the same app.
```

## Running with Docker Compose

```bash
docker compose up --build
# then open http://localhost:8000
```

## Trying it end-to-end without a second device

Open two browser tabs at `http://localhost:8000`. In tab 1, click **Send
Files**, pick a file, and generate a code. In tab 2, click **Receive
Files** and enter that code. Approve the connection in tab 1, and the file
becomes downloadable in tab 2.

## Project layout

```
backend/
  app/
    main.py            FastAPI app, static frontend mount, cleanup job
    config.py           All tunables (TTLs, size limits, rate limits)
    session_service.py  Redis-backed session state machine
    storage.py           On-disk file handling for the relay path
    qr.py                 QR code generation
    ws_manager.py         WebSocket connection registry for status push
    routers/transfer.py   All REST + WebSocket endpoints
  requirements.txt
  Dockerfile
frontend/
  index.html / style.css / app.js   Vanilla JS, no build step
docker-compose.yml
```

## Suggested next steps (see the full project plan for detail)

1. Add the ClamAV scan before a file is marked downloadable.
2. Build the WebRTC signaling exchange over the existing status WebSocket,
   with the current relay path becoming the automatic fallback.
3. Add resumable/chunked upload so a dropped connection at 80% doesn't
   restart from zero.
4. Deploy behind HTTPS and tighten CORS before letting anyone but you use it.
