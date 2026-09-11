# Stock Tracker

Portfolio tracking for PSX equities, mutual funds and international holdings.
React + Vite frontend; a Node service on the home server does quote fetching,
FX, the asset universe and KTrade contract-note imports.

## Where things live, and how they ship

Two halves, two completely separate deployment paths. Confusing them is how a
fix gets written, tested, committed — and never actually goes live.

### Frontend — this repo

Everything here is frontend: `src/`, `public/`, `index.html`, the Vite and
Vercel config.

- Worked on locally, on the dev machine.
- Committed and pushed to `main` on GitHub.
- **Vercel watches `main` and deploys from it.** Pushing is the deploy.

A frontend change is not live until it is pushed.

### Backend — the home server only

The Node API does not live here and is not in version control. It lives at
`~/Docker/stock-api` on the home server, is a service in
`~/Docker/docker-compose.yml`, and is edited in place over SSH.

A backend change is not live until the container is rebuilt. Pushing to GitHub
does nothing for it — there is nothing here to push.

**Do not add backend code to this repo.** `/backend/` is in `.gitignore` for
that reason. It was tracked here until September 2026, which meant one service
with two copies and nothing keeping them in step.

## Working on the backend

The SSH address, paths and commands are in **`CLAUDE.local.md`**, gitignored
because this repo is public. It loads automatically alongside this file. If it
is missing — fresh clone, different machine — ask rather than guessing.

The Dockerfile `COPY`s the source in, so a change needs a rebuild, not a
restart:

```bash
cd ~/Docker && docker compose up -d --build stock-api
```

`~/Docker/stock-api/data` is a mounted volume holding the asset universe and
price caches. It survives rebuilds — and it is worth knowing it exists before
blaming the code for stale prices.

Gmail credentials for the KTrade importer are in `~/Docker/stock-api/.env`,
never in source control.

## This repo

```bash
npm run dev
npx vite build
```

- The repo is **public**. No secrets, tokens, internal addresses or
  server-side config in committed files.
- The frontend reads the backend over HTTPS through the home server's reverse
  proxy — see `CLAUDE.local.md` for the hostname and routing.
- There is a fair amount of scratch still tracked at the repo root
  (`modal_*.txt`, `restored_*.jsx`, `scratch/`, loose `test_*.js` and `*.py`).
  Some of it is not even from this project. Worth clearing out; left alone so
  far only because none of it is a deployment hazard.
