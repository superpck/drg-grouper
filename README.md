# ระบบค้นหากลุ่มวินิจฉัยโรคร่วม (DRG Finding) รองรับ DRG TGRP v.6.3.5

Node.js + TypeScript service and UI for Thai DRG grouping experiments.

> ⚠️ **คำเตือน**  
> ระบบนี้เป็นเพียงการค้นหาเบื้องต้น ซึ่งอาจจะไม่ถูกต้องตามการค้นหาของ สำนักพัฒนากลุ่มโรคร่วมไทย (สรท.) Thai CaseMix Centre (TCMC)  
> กรุณาตรวจสอบรายละเอียดจากแหล่งทางการที่: https://www.tcmc.or.th/

## Features
- DRG grouping API (`POST /drg-grouper`)
- DRG Seeker web UI (`GET /`)
- Code-name lookup API for UI (`POST /code-lookup`)
- Validation for PDx/SDx/Proc with standard DRG warning/error mapping

## Tech stack
- Node.js, Express, TypeScript
- MySQL (via `knex` + `mysql2`)
- Vanilla HTML/CSS/JS for UI

## Prerequisites
- Node.js 22+
- MySQL with DRG data loaded (default in this project uses `drg_finding` at `127.0.0.1:3306`)

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

## การใช้งาน UI (DRG Seeker)
1. เปิดเซิร์ฟเวอร์ด้วย `npm run dev` หรือ `npm start`
2. เปิดเบราว์เซอร์ที่ `http://localhost:3000/`
3. กรอกข้อมูลหลักของเคส เช่น `HCODE`, `AN`, `PDx`, `SDx`, `Proc`, อายุ/เพศ และวันเวลา admit/discharge
4. เมื่อแก้ไข `PDx/SDx/Proc` ระบบจะแสดงชื่อ code อัตโนมัติจากฐานข้อมูล
5. กด **Analyze DRG** เพื่อดูผลลัพธ์สรุป, ขั้นตอนการวิเคราะห์ (trace), และ raw request/response

## Main endpoints
- `GET /health` — health check
- `POST /drg-grouper` — main grouper (v2)
- `POST /drg-grouper/1` — legacy grouper (v1)
- `POST /code-lookup` — resolve PDx/SDx names from `lib_dx`, Proc names from `lib_proc`

## Notes
- Default app port: `3000`
- DB connection config is read from environment variables in `src/config.ts`
- UI is served from `public/`
- ดูประวัติการเปลี่ยนแปลงที่ `CHANGELOG.md`
