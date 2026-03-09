import express from 'express';
import { z } from 'zod';
import path from 'node:path';
import cors from 'cors';
import { config } from './config';
import { groupCase } from './services/grouper';
import { groupCaseV1 } from './services/grouper.1';
import { DrgStandardError } from './errors';
import { db } from './db';

const app = express();
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.resolve(process.cwd(), 'public')));

function upperCode(code: string): string {
  return code.trim().toUpperCase();
}

const bodySchema = z.object({
  hcode: z.string().min(1),
  an: z.string().min(1),
  pdx: z.string().min(1),
  sdx: z.array(z.string()).optional().default([]),
  proc: z.array(z.string()).optional().default([]),
  sex: z.union([z.literal(1), z.literal(2)]).optional(),
  age: z.number().int().nonnegative().optional(),
  ageDay: z.number().int().nonnegative().optional(),
  admWt: z.number().nonnegative().optional(),
  discht: z.number().int().optional(),
  dateAdm: z.string().optional(),
  timeAdm: z.string().optional(),
  dateDsc: z.string().optional(),
  timeDsc: z.string().optional(),
  leaveDays: z.number().int().nonnegative().optional(),
  los: z.number().int().nonnegative().optional(),
  drg: z.string().regex(/^\d{5}$/).optional(),
  source: z.enum(['ui', 'api']).optional().default('api'),
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.sendFile(path.resolve(process.cwd(), 'public/index.html')));

const codeLookupSchema = z.object({
  pdx: z.string().optional().default(''),
  sdx: z.array(z.string()).optional().default([]),
  proc: z.array(z.string()).optional().default([]),
});

app.post('/code-lookup', async (req, res) => {
  try {
    const parsed = codeLookupSchema.parse(req.body);
    const pdx = upperCode(parsed.pdx || '');
    const sdx = parsed.sdx.map(upperCode).filter(Boolean);
    const proc = parsed.proc.map((code) => code.replace(/\./g, '').trim().toUpperCase()).filter(Boolean);
    const procBase = (code: string) => code.split('+')[0];

    const dxCodes = Array.from(new Set([pdx, ...sdx].filter(Boolean)));
    const procCodes = Array.from(new Set(proc));
    const procLookupCodes = Array.from(new Set(procCodes.flatMap((code) => [code, procBase(code)])));

    const dxRows = dxCodes.length
      ? await db('lib_dx').select('code', 'description').whereIn('code', dxCodes)
      : [];
    const procRows = procLookupCodes.length
      ? await db('lib_proc').select('code', db.raw('`desc` as description')).whereIn('code', procLookupCodes)
      : [];

    const dxMap = Object.fromEntries(dxRows.map((r) => [String(r.code), String(r.description || '')]));
    const procMap = Object.fromEntries(procRows.map((r) => [String(r.code), String(r.description || '')]));

    res.json({
      ok: true,
      data: {
        pdx: pdx ? { code: pdx, name: dxMap[pdx] || null } : null,
        sdx: sdx.map((code) => ({ code, name: dxMap[code] || null })),
        proc: proc.map((code) => ({ code, name: procMap[code] || procMap[procBase(code)] || null })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ ok: false, error: message });
  }
});

async function grouperHandler(req: express.Request, res: express.Response, version: '1' | '2' = '2'): Promise<void> {
  try {
    const parsed = bodySchema.parse(req.body);
    const payload = {
      ...parsed,
      pdx: upperCode(parsed.pdx),
      sdx: parsed.sdx.map(upperCode),
    };
    let result;
    if (version === '1') {
      result = await groupCaseV1(payload);
    } else {
      result = await groupCase(payload);
    }
    res.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof DrgStandardError) {
      res.status(400).json({
        ok: false,
        error_code: error.errorCode,
        error_name: error.errorName,
        error_description: error.description,
      });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(400).json({ ok: false, error: message });
  }
}

// app.post('/drg-grouper', grouperHandler);
// app.post('/grouper', grouperHandler);

app.post('/drg-grouper', (req, res) => grouperHandler(req, res, '2'));
app.post('/drg-grouper/1', (req, res) => grouperHandler(req, res, '1'));
app.post('/grouper', (req, res) => grouperHandler(req, res, '2'));
app.post('/grouper/1', (req, res) => grouperHandler(req, res, '1'));

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`DRG API listening on :${config.port}`);
});
