# ระบบค้นหากลุ่มวินิจฉัยโรคร่วม (DRG Finding)

Node.js + TypeScript service and UI for Thai DRG grouping experiments.

## Features
- DRG grouping API (`/drg-grouper`)
- DRG Seeker web UI (`/`)
- Code-name lookup API for UI (`/code-lookup`)
- Validation for PDx/SDx/Proc with standard DRG warning/error mapping

## Tech stack
- Node.js, Express, TypeScript
- MySQL (via `knex` + `mysql2`)
- Vanilla HTML/CSS/JS for UI

## Prerequisites
- Node.js 20+
- MySQL with DRG data loaded (default in this project uses `drg_finding` at `127.0.0.1:3336`)

## Install
```bash
npm install
```

## Run (dev)
```bash
npm run dev
```

## Build + run (prod)
```bash
npm run build
npm start
```

## Main endpoints
- `GET /health` — health check
- `POST /drg-grouper` — main grouper (v2)
- `POST /drg-grouper/1` — legacy grouper (v1)
- `POST /code-lookup` — resolve PDx/SDx names from `lib_dx`, Proc names from `lib_proc`

## Notes
- Default app port: `3000`
- DB connection config is read from environment variables in `src/config.ts`
- UI is served from `public/`

