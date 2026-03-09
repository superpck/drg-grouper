import { db } from '../db';
import { GrouperInput, GrouperOutput, TraceStep, WarningCode } from '../types';
import { DRG_ERROR, DRG_WARNING, DrgStandardError } from '../errors';

type ResolveResult = {
  drg: string;
  source: 'premdc' | 'cmi-reference';
  details: Record<string, unknown>;
};
const cmiPdxCache = new Map<string, Record<string, unknown>[]>();
type PremdcProcGroups = {
  liver: string[];
  heartLung: string[];
  boneMarrow: string[];
  laryngectomy: string[];
};
let premdcProcGroupsCache: PremdcProcGroups | null = null;
let validProcCache: Set<string> | null = null;

function norm(code: string): string {
  return code.replace(/\./g, '').trim().toUpperCase();
}

function normProc(code: string): string {
  return norm(code).replace(/\s/g, '');
}

function procBase(code: string): string {
  return normProc(code).split('+')[0];
}

function procVariants(code: string): string[] {
  const full = normProc(code);
  const base = procBase(full);
  return full && base && full !== base ? [full, base] : full ? [full] : [];
}

function parseDateTime(d?: string, t?: string): Date | null {
  if (!d) return null;
  const tm = (t || '0000').padStart(4, '0');
  const hh = tm.slice(0, 2);
  const mm = tm.slice(2, 4);
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  const dt = new Date(`${d}T${hh}:${mm}:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function calcLos(input: GrouperInput): number {
  if (input.los != null && Number.isFinite(input.los) && input.los >= 0) {
    return Math.floor(input.los);
  }
  if (!input.dateAdm || !input.dateDsc) return 0;
  const admDate = new Date(`${input.dateAdm}T00:00:00`);
  const dscDate = new Date(`${input.dateDsc}T00:00:00`);
  if (Number.isNaN(admDate.getTime()) || Number.isNaN(dscDate.getTime())) return 0;
  const diffDays = Math.floor((dscDate.getTime() - admDate.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return 0;
  const los = diffDays + 1 - (input.leaveDays || 0);
  return Math.max(0, los);
}

function getPatientAgeDays(input: GrouperInput): number | null {
  const ageYears = input.age != null && Number.isFinite(input.age) && input.age >= 0 ? Math.floor(input.age) : null;
  const extraDays = input.ageDay != null && Number.isFinite(input.ageDay) && input.ageDay >= 0 ? Math.floor(input.ageDay) : 0;
  if (ageYears != null) return ageYears * 365 + extraDays;
  if (input.ageDay != null && Number.isFinite(input.ageDay) && input.ageDay >= 0) return Math.floor(input.ageDay);
  return null;
}

async function inAxIcd10(ax: string, code: string): Promise<boolean> {
  const row = await db('ax_icd10_members').where({ ax_code: ax, icd10_code: norm(code) }).first();
  return !!row;
}

function hasAnyProc(proc: string[], targets: string[]): boolean {
  const set = new Set(proc.flatMap(procVariants));
  return targets.some((p) => set.has(p));
}

async function getPremdcProcGroups(): Promise<PremdcProcGroups> {
  if (premdcProcGroupsCache) return premdcProcGroupsCache;
  const rows = await db('premdc_proc_groups').select('group_code', 'proc_code');
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    const groupCode = String(row.group_code || '').trim();
    if (!groupCode) continue;
    if (!grouped[groupCode]) grouped[groupCode] = [];
    grouped[groupCode].push(norm(String(row.proc_code || '')));
  }

  const requiredGroups = ['liver', 'heartLung', 'boneMarrow', 'laryngectomy'] as const;
  for (const groupCode of requiredGroups) {
    if (!grouped[groupCode] || grouped[groupCode].length === 0) {
      throw new Error(`Missing PREMDC proc group configuration: ${groupCode}`);
    }
  }

  premdcProcGroupsCache = {
    liver: grouped.liver,
    heartLung: grouped.heartLung,
    boneMarrow: grouped.boneMarrow,
    laryngectomy: grouped.laryngectomy,
  };
  return premdcProcGroupsCache;
}

async function getValidProcSet(): Promise<Set<string>> {
  if (validProcCache) return validProcCache;
  const hasTable = await db.schema.hasTable('lib_proc');
  if (!hasTable) {
    throw new Error('Missing lib_proc table for procedure validation');
  }
  const rows = await db('lib_proc').select('code');
  const procDcRows = await db.schema.hasTable('lib_proc_dc') ? await db('lib_proc_dc').select('proc') : [];
  const codeSet = new Set<string>();
  for (const row of rows) {
    const code = normProc(String(row.code || ''));
    if (!code) continue;
    codeSet.add(code);
    codeSet.add(procBase(code));
  }
  for (const row of procDcRows) {
    const code = normProc(String(row.proc || ''));
    if (!code) continue;
    codeSet.add(code);
    codeSet.add(procBase(code));
  }
  validProcCache = codeSet;
  return validProcCache;
}

function overlapCount(target: Set<string>, values: string[]): number {
  return values.reduce((sum, v) => sum + (target.has(v) ? 1 : 0), 0);
}

function pullCodes(row: Record<string, unknown>, prefix: 'SDX' | 'PROC', max: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= max; i += 1) {
    const raw = row[`${prefix}${i}`];
    if (typeof raw !== 'string') continue;
    const code = norm(raw);
    if (code) out.push(code);
  }
  return out;
}

async function resolveFromCmiReference(input: GrouperInput): Promise<ResolveResult | null> {
  const pdx = norm(input.pdx);
  const inputLos = calcLos(input);
  const inputSdx = new Set((input.sdx || []).map(norm));
  const inputProc = new Set((input.proc || []).flatMap(procVariants));

  const sameHcodeRows = await db('cmi.drg69 as r')
    .select('r.HCODE', 'r.AN', 'r.DRG', 'r.MDC', 'r.SEX', 'r.AGE', 'r.AGEDAY', 'r.LOS')
    .select(Array.from({ length: 12 }, (_, i) => `r.SDX${i + 1}`))
    .select(Array.from({ length: 20 }, (_, i) => `r.PROC${i + 1}`))
    .whereRaw("REPLACE(UPPER(r.PDX), '.', '') = ?", [pdx])
    .andWhere('r.HCODE', input.hcode) as Record<string, unknown>[];

  const cached = cmiPdxCache.get(pdx);
  const globalCandidates = cached ?? await db('cmi.drg69 as r')
    .select('r.HCODE', 'r.AN', 'r.DRG', 'r.MDC', 'r.SEX', 'r.AGE', 'r.AGEDAY', 'r.LOS')
    .select(Array.from({ length: 12 }, (_, i) => `r.SDX${i + 1}`))
    .select(Array.from({ length: 20 }, (_, i) => `r.PROC${i + 1}`))
    .whereRaw("REPLACE(UPPER(r.PDX), '.', '') = ?", [pdx])
    .limit(3000) as Record<string, unknown>[];
  if (!cached) cmiPdxCache.set(pdx, globalCandidates);
  const merged = [...sameHcodeRows, ...globalCandidates];
  const seen = new Set<string>();
  const candidates: Record<string, unknown>[] = [];
  for (const row of merged) {
    const k = `${String(row.HCODE || '')}:${String(row.AN || '')}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(row);
  }
  let best: { drg: string; mdc: string; score: number; procOverlap: number; sdxOverlap: number; fromHcode: boolean } | null = null;

  for (const row of candidates) {
    const drgRaw = row.DRG;
    if (typeof drgRaw !== 'string' || !/^\d{5}$/.test(drgRaw.trim())) continue;
    const drg = drgRaw.trim();
    const rowSdx = pullCodes(row, 'SDX', 12);
    const rowProc = pullCodes(row, 'PROC', 20);
    const procOverlap = overlapCount(inputProc, rowProc);
    const sdxOverlap = overlapCount(inputSdx, rowSdx);
    const sameHcode = String(row.HCODE || '') === input.hcode;
    const sameAn = String(row.AN || '') === input.an;

    let score = 0;
    if (sameHcode) score += 30;
    if (sameAn) score += 120;
    score += procOverlap * 8;
    score += sdxOverlap * 3;
    if (row.SEX != null && Number(row.SEX) === (input.sex ?? Number(row.SEX))) score += 2;
    if (input.age != null && row.AGE != null) {
      const ageDiff = Math.abs(Number(row.AGE) - input.age);
      if (ageDiff <= 3) score += 2;
      else if (ageDiff <= 10) score += 1;
    }
    if (inputLos > 0 && row.LOS != null && Math.abs(Number(row.LOS) - inputLos) <= 2) score += 1;

    if (!best || score > best.score) {
      best = {
        drg,
        mdc: String(row.MDC || drg.slice(0, 2)),
        score,
        procOverlap,
        sdxOverlap,
        fromHcode: sameHcode,
      };
    }
  }

  if (!best) return null;
  return {
    drg: best.drg,
    source: 'cmi-reference',
    details: {
      mdc: best.mdc,
      score: best.score,
      procOverlap: best.procOverlap,
      sdxOverlap: best.sdxOverlap,
      fromSameHcode: best.fromHcode,
      candidateCount: candidates.length,
    },
  };
}

async function resolveDrg(input: GrouperInput): Promise<ResolveResult> {
  if (input.drg && /^\d{5}$/.test(input.drg)) {
    return { drg: input.drg, source: 'premdc', details: { forcedByInput: true } };
  }

  const pdx = norm(input.pdx);
  const proc = (input.proc || []).map(normProc);
  const los = calcLos(input);
  const premdc = await getPremdcProcGroups();

  if (hasAnyProc(proc, premdc.liver) && (await inAxIcd10('0CX', pdx))) {
    return { drg: '00019', source: 'premdc', details: { rule: 'liver-transplant' } };
  }
  if (hasAnyProc(proc, premdc.heartLung) && (await inAxIcd10('0DX', pdx))) {
    return { drg: '00029', source: 'premdc', details: { rule: 'heart-lung-transplant' } };
  }
  if (hasAnyProc(proc, premdc.boneMarrow) && (await inAxIcd10('0EX', pdx))) {
    return { drg: '00049', source: 'premdc', details: { rule: 'bone-marrow-transplant' } };
  }
  if (hasAnyProc(proc, premdc.laryngectomy) && (await inAxIcd10('0GX', pdx))) {
    return { drg: '00099', source: 'premdc', details: { rule: 'laryngectomy' } };
  }

  const reference = await resolveFromCmiReference(input);
  if (reference) return reference;

  const hasTrach = hasAnyProc(proc, ['311', '3121', '3129']);
  const hasMechVent96 = hasAnyProc(proc, ['9604', '9672', '9607']);
  if (hasTrach && los > 20 && hasMechVent96) {
    return { drg: '00101', source: 'premdc', details: { rule: 'trach-96h-vent-fallback' } };
  }

  throw new DrgStandardError(
    DRG_ERROR.INVALID_PDX.code,
    DRG_ERROR.INVALID_PDX.name,
    DRG_ERROR.INVALID_PDX.description,
  );
}

function drgType(drg: string): 'M' | 'P' {
  const n = Number(drg.slice(2, 4));
  return n >= 50 ? 'M' : 'P';
}

async function calcAdjRw(drg: string, rw: number, wtlos: number, ot: number, rw0d: number, of: number, los: number, stayMinutes: number): Promise<number> {
  if (stayMinutes < 1440) return rw0d === 0 ? rw : rw0d;

  if (rw0d > 0 && los < wtlos / 3 && wtlos > 3) {
    return rw0d + (los * (rw - rw0d)) / Math.ceil(wtlos / 3);
  }

  if (los > ot) {
    const dtype = drgType(drg);
    const coef = await db('adjrw_coefficients')
      .where('drg_type', dtype)
      .andWhere('rw_min', '<=', rw)
      .andWhere('rw_max', '>=', rw)
      .first();
    if (!coef) return rw;

    const b12 = Number(coef.b12);
    const b23 = Number(coef.b23);

    if (los <= 2 * ot) return rw + of * b12 * (los - ot);
    if (los <= 3 * ot) return rw + of * b12 * ot + of * b23 * (los - 2 * ot);
    return rw + of * ot * (b12 + b23);
  }

  return rw;
}

type GroupCaseOptions = { persist?: boolean };

export async function groupCase(input: GrouperInput, options?: GroupCaseOptions): Promise<GrouperOutput> {
  const shouldPersist = options?.persist ?? true;
  if (!input.pdx?.trim()) {
    throw new DrgStandardError(
      DRG_ERROR.NO_PDX.code,
      DRG_ERROR.NO_PDX.name,
      DRG_ERROR.NO_PDX.description,
    );
  }

  const normalizedPdx = norm(input.pdx);
  const pdxValid = await db('valid_dx').where({ code: normalizedPdx }).first();
  if (!pdxValid) {
    throw new DrgStandardError(
      DRG_ERROR.UNACCEPTABLE_PDX.code,
      DRG_ERROR.UNACCEPTABLE_PDX.name,
      DRG_ERROR.UNACCEPTABLE_PDX.description,
    );
  }
  if (input.sex === 1 || input.sex === 2) {
    const sexConflict = await db('appendix_a4_sex_conflict')
      .where({ code_type: 'DX', code_value: normalizedPdx })
      .first();
    if (sexConflict && Number(sexConflict.allowed_sex) !== Number(input.sex)) {
      throw new DrgStandardError(
        DRG_ERROR.PDX_SEX_CONFLICT.code,
        DRG_ERROR.PDX_SEX_CONFLICT.name,
        DRG_ERROR.PDX_SEX_CONFLICT.description,
      );
    }
  }

  const normalizedSdx = (input.sdx || []).map(norm).filter(Boolean);
  const normalizedProc = (input.proc || []).map(normProc).filter(Boolean);
  const validProcSet = await getValidProcSet();
  const sdxUniverse = [...new Set(normalizedSdx)];
  const sdxValidRows = sdxUniverse.length
    ? await db('valid_dx').select('code').whereIn('code', sdxUniverse)
    : [];
  const sdxValidSet = new Set(sdxValidRows.map((row) => String(row.code)));
  const sdxSexRows = sdxUniverse.length
    ? await db('appendix_a4_sex_conflict')
      .select('code_value', 'allowed_sex')
      .where({ code_type: 'DX' })
      .whereIn('code_value', sdxUniverse)
    : [];
  const sdxSexMap = new Map(sdxSexRows.map((r) => [String(r.code_value), Number(r.allowed_sex)]));
  const sdxAgeRows = sdxUniverse.length
    ? await db('appendix_a3_age_conflict')
      .select('dx_code', 'min_age_days', 'max_age_days')
      .whereIn('dx_code', sdxUniverse)
    : [];
  const sdxAgeMap = new Map(sdxAgeRows.map((r) => [String(r.dx_code), { min: r.min_age_days != null ? Number(r.min_age_days) : null, max: r.max_age_days != null ? Number(r.max_age_days) : null }]));
  const patientAgeDays = getPatientAgeDays(input);
  const seenSdx = new Set<string>();
  const seenProc = new Set<string>();
  const acceptedSdx: string[] = [];
  const acceptedProc: string[] = [];
  let hasSdxWarning = false;
  let hasProcWarning = false;
  for (const code of normalizedSdx) {
    const sexMismatch = (input.sex === 1 || input.sex === 2) && sdxSexMap.has(code) && Number(input.sex) !== Number(sdxSexMap.get(code));
    const ageRule = sdxAgeMap.get(code);
    const ageMismatch = ageRule != null && patientAgeDays != null
      && ((ageRule.min != null && patientAgeDays < ageRule.min) || (ageRule.max != null && patientAgeDays > ageRule.max));
    const invalid = !sdxValidSet.has(code) || code === normalizedPdx || seenSdx.has(code) || sexMismatch || ageMismatch;
    if (invalid) {
      hasSdxWarning = true;
      continue;
    }
    seenSdx.add(code);
    acceptedSdx.push(code);
  }
  for (const code of normalizedProc) {
    const variants = procVariants(code);
    const invalid = !variants.some((v) => validProcSet.has(v)) || seenProc.has(code);
    if (invalid) {
      hasProcWarning = true;
      continue;
    }
    seenProc.add(code);
    acceptedProc.push(code);
  }

  const warnings: WarningCode[] = [];
  if (hasSdxWarning) {
    warnings.push({
      code: DRG_WARNING.SDX_INVALID_OR_DUPLICATE.code,
      name: DRG_WARNING.SDX_INVALID_OR_DUPLICATE.name,
      description: DRG_WARNING.SDX_INVALID_OR_DUPLICATE.description,
    });
  }
  if (hasProcWarning) {
    warnings.push({
      code: DRG_WARNING.PROC_INVALID_OR_DUPLICATE.code,
      name: DRG_WARNING.PROC_INVALID_OR_DUPLICATE.name,
      description: DRG_WARNING.PROC_INVALID_OR_DUPLICATE.description,
    });
  }
  const warningCodeSum = warnings.reduce((sum, w) => sum + w.code, 0);
  const normalizedInput: GrouperInput = {
    ...input,
    pdx: normalizedPdx,
    sdx: acceptedSdx,
    proc: acceptedProc,
  };

  const trace: TraceStep[] = [];
  trace.push({
    step: 'Data validation',
    status: warnings.length ? 'warn' : 'ok',
    details: {
      hasPdx: true,
      pdxInValidDx: Boolean(pdxValid),
      sdxInputCount: normalizedSdx.length,
      sdxAcceptedCount: acceptedSdx.length,
      procInputCount: normalizedProc.length,
      procAcceptedCount: acceptedProc.length,
      warnings,
    },
  });

  const finalResolved = await resolveDrg(normalizedInput);

  trace.push({
    step: 'DRG source',
    status: 'ok',
    details: {
      source: finalResolved.source,
      ...finalResolved.details,
    },
  });

  const drg = finalResolved.drg;
  const w = await db('drg_weights').where({ drg_code: drg }).first();
  if (!w) {
    throw new DrgStandardError(
      DRG_ERROR.INVALID_PDX.code,
      DRG_ERROR.INVALID_PDX.name,
      DRG_ERROR.INVALID_PDX.description,
    );
  }

  const mdc = drg.slice(0, 2);
  const dc = drg.slice(0, 4);
  trace.push({
    step: 'MDC/DC resolution',
    status: 'ok',
    details: { mdc, dc, drg },
  });

  const adm = parseDateTime(input.dateAdm, input.timeAdm);
  const dsc = parseDateTime(input.dateDsc, input.timeDsc);
  const stayMinutes = adm && dsc ? Math.max(0, Math.floor((dsc.getTime() - adm.getTime()) / 60000)) : 0;
  const los = calcLos(input);

  const rw = Number(w.rw);
  const drgDescription = String(w.description || '').trim();
  const wtlos = Number(w.wtlos);
  const ot = Number(w.ot);
  const rw0day = Number(w.rw0d);
  const ofFactor = Number(w.of_factor);

  const computedAdjRw = await calcAdjRw(drg, rw, wtlos, ot, rw0day, ofFactor, los, stayMinutes);
  const adjrw = Number(computedAdjRw.toFixed(4));
  trace.push({
    step: 'RW/AdjRW calculation',
    status: 'ok',
    details: {
      rw,
      wtlos,
      ot,
      rw0day,
      of: ofFactor,
      los,
      stayMinutes,
      adjrw,
    },
  });

  const cmi = adjrw;
  trace.push({
    step: 'CMI aggregation',
    status: 'ok',
    details: { cmi, method: 'current-case adjrw' },
  });

  if (shouldPersist) {
    await db('grouper_cases').insert({
      hcode: input.hcode,
      an: normalizedInput.an,
      pdx: normalizedPdx,
      sdx_json: JSON.stringify(acceptedSdx),
      proc_json: JSON.stringify(acceptedProc),
      sex: input.sex ?? null,
      age_years: input.age ?? null,
      age_days: input.ageDay ?? null,
      adm_wt: input.admWt ?? null,
      discht: input.discht ?? null,
      dateadm: adm,
      datedsc: dsc,
      leave_days: input.leaveDays || 0,
    }).onConflict(['hcode', 'an']).merge();
  }

  return {
    hcode: normalizedInput.hcode,
    an: normalizedInput.an,
    drg,
    drgDescription,
    mdc,
    dc,
    rw,
    adjrw,
    cmi,
    wtlos,
    ot,
    rw0day,
    los,
    warningCodeSum,
    warnings,
    trace,
  };
}
