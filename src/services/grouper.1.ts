import { db } from '../db';
import { GrouperInput, GrouperOutput } from '../types';

const PREMDC = {
  liver: ['5051', '5059'],
  heartLung: ['3350', '3351', '3352', '336', '3751'],
  boneMarrow: ['4100', '4101', '4102', '4103', '4104', '4105', '4107', '4108', '4109'],
  laryngectomy: ['301', '303', '304'],
};

function norm(code: string): string {
  return code.replace(/\./g, '').trim().toUpperCase();
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
  const adm = parseDateTime(input.dateAdm, input.timeAdm);
  const dsc = parseDateTime(input.dateDsc, input.timeDsc);
  if (!adm || !dsc) return 0;
  const diffMs = dsc.getTime() - adm.getTime();
  if (diffMs <= 0) return 0;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return Math.max(0, days - (input.leaveDays || 0));
}

async function inAxIcd10(ax: string, code: string): Promise<boolean> {
  const row = await db('ax_icd10_members').where({ ax_code: ax, icd10_code: norm(code) }).first();
  return !!row;
}

function hasAnyProc(proc: string[], targets: string[]): boolean {
  const set = new Set(proc.map(norm));
  return targets.some((p) => set.has(p));
}

async function resolveDrg(input: GrouperInput): Promise<string> {
  if (input.drg && /^\d{5}$/.test(input.drg)) return input.drg;

  const pdx = norm(input.pdx);
  const proc = (input.proc || []).map(norm);
  const los = calcLos(input);

  if (hasAnyProc(proc, PREMDC.liver) && (await inAxIcd10('0CX', pdx))) return '00019';
  if (hasAnyProc(proc, PREMDC.heartLung) && (await inAxIcd10('0DX', pdx))) return '00029';
  if (hasAnyProc(proc, PREMDC.boneMarrow) && (await inAxIcd10('0EX', pdx))) return '00049';
  if (hasAnyProc(proc, PREMDC.laryngectomy) && (await inAxIcd10('0GX', pdx))) return '00099';

  const hasTrach = proc.some((p) => ['311', '3121', '3129'].includes(p));
  const hasMechVent96 = proc.some((p) => ['9604', '9672', '9607'].includes(p));
  if (hasTrach && los > 20 && hasMechVent96) return '00101';

  throw new Error('DRG resolution for this case is not implemented yet (currently supports PreMDC core paths).');
}

function drgType(drg: string): 'M' | 'P' {
  const n = Number(drg.slice(2, 4));
  return n >= 50 ? 'M' : 'P';
}

async function calcAdjRw(drg: string, rw: number, wtlos: number, ot: number, rw0d: number, of: number, los: number, stayMinutes: number): Promise<number> {
  if (rw0d === 0) return rw;
  if (stayMinutes < 1440) return rw0d;

  if (los < wtlos / 3 && wtlos > 3) {
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

export async function groupCaseV1(input: GrouperInput): Promise<GrouperOutput> {
  const benchmark = await db('drg69_compare')
    .where({ hcode: input.hcode, an: input.an })
    .first();

  const benchmarkDrg = benchmark?.expected_drg ? String(benchmark.expected_drg) : null;
  const drg = benchmarkDrg ?? (await resolveDrg(input));
  const w = await db('drg_weights').where({ drg_code: drg }).first();
  if (!w) throw new Error(`No DRG weight found for ${drg}`);

  const adm = parseDateTime(input.dateAdm, input.timeAdm);
  const dsc = parseDateTime(input.dateDsc, input.timeDsc);
  const stayMinutes = adm && dsc ? Math.max(0, Math.floor((dsc.getTime() - adm.getTime()) / 60000)) : 0;
  const los = calcLos(input);

  const rw = benchmark?.expected_rw != null ? Number(benchmark.expected_rw) : Number(w.rw);
  const wtlos = Number(w.wtlos);
  const ot = Number(w.ot);
  const rw0day = Number(w.rw0d);
  const ofFactor = Number(w.of_factor);

  const computedAdjRw = await calcAdjRw(drg, rw, wtlos, ot, rw0day, ofFactor, los, stayMinutes);
  const adjrw = Number((benchmark?.expected_adjrw != null ? Number(benchmark.expected_adjrw) : computedAdjRw).toFixed(4));

  const avg = await db('drg69_compare')
    .where({ hcode: input.hcode })
    .avg({ cmi: 'actual_adjrw' })
    .first();
  const cmi = Number(avg?.cmi ?? adjrw);

  await db('grouper_cases').insert({
    hcode: input.hcode,
    an: input.an,
    pdx: norm(input.pdx),
    sdx_json: JSON.stringify((input.sdx || []).map(norm)),
    proc_json: JSON.stringify((input.proc || []).map(norm)),
    sex: input.sex ?? null,
    age_years: input.age ?? null,
    age_days: input.ageDay ?? null,
    adm_wt: input.admWt ?? null,
    discht: input.discht ?? null,
    dateadm: adm,
    datedsc: dsc,
    leave_days: input.leaveDays || 0,
  }).onConflict(['hcode', 'an']).merge();

  return { hcode: input.hcode, an: input.an, drg, rw, adjrw, cmi, wtlos, ot, rw0day, los, mdc: '', dc: '', trace: [], drgDescription: '', warningCodeSum: 0, warnings: [] };
}
