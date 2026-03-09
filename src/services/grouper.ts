import { db } from '../db';
import { GrouperInput, GrouperOutput, TraceStep, WarningCode } from '../types';
import { DRG_ERROR, DRG_WARNING, DrgStandardError } from '../errors';

type ResolveResult = {
  drg: string;
  source: 'premdc';
  details: Record<string, unknown>;
};
type PremdcProcGroups = {
  liver: string[];
  heartLung: string[];
  boneMarrow: string[];
  laryngectomy: string[];
};
let premdcProcGroupsCache: PremdcProcGroups | null = null;
let validProcBaseCache: Set<string> | null = null;
let validProcExtendedCache: Set<string> | null = null;

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


function pdcToMedicalDc(mdc: string, pdc: string): string | null {
  const cleanPdc = String(pdc || '').trim().toUpperCase();
  const mdcCode = String(mdc || '').padStart(2, '0');
  const directOverrides: Record<string, string> = {
    '05|5C': '0555',
    '06|6G': '0657',
    '11|11D': '1154',
    '13|13A': '1357',
    '14|14B': '1459',
  };
  const override = directOverrides[`${mdcCode}|${cleanPdc}`];
  if (override) return override;

  const m = cleanPdc.match(/^(\d{1,2})([A-Z])$/);
  if (!m) return null;
  // PDC lettering in the source books omits I and O.
  const pdcAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const idx = pdcAlphabet.indexOf(m[2]);
  if (idx < 0) return null;
  const medicalPart = 50 + idx;
  if (medicalPart < 0 || medicalPart > 99) return null;
  return `${mdcCode}${String(medicalPart).padStart(2, '0')}`;
}

function pclToSeveritySuffix(pcl: number): string {
  if (pcl >= 3) return '3';
  if (pcl >= 2) return '2';
  if (pcl >= 1) return '1';
  return '0';
}

function pickPreferredDrgBySeverity(
  drgRows: Array<{ drg_code: string }>,
  pcl: number,
): string | null {
  if (!drgRows.length) return null;
  const suffixPriority = [pclToSeveritySuffix(pcl), '2', '1', '0', '9', '4'];
  for (const suffix of suffixPriority) {
    const found = drgRows.find((r) => String(r.drg_code).endsWith(suffix));
    if (found?.drg_code) return String(found.drg_code);
  }
  return String(drgRows[0].drg_code);
}

async function resolveDrgFromDc(
  dc: string,
  pdx: string,
  sdx: string[],
  proc: string[] = [],
): Promise<{ drg: string; pcl: number } | null> {
  const sdxCodes = (sdx || []).filter(Boolean);
  const sdxMapRows = sdxCodes.length
    ? await db('lib_dx').select('code', 'dclmain').whereIn('code', sdxCodes)
    : [];
  const sdxDclCodes = Array.from(new Set([
    ...sdxCodes,
    ...sdxMapRows.map((r) => String(r.dclmain || '')).filter(Boolean),
  ]));
  const dclRows = await db('dcl_values')
    .select('dx_code', 'dcl')
    .where({ dc_code: dc })
    .whereIn('dx_code', sdxDclCodes);
  const allDxSet = new Set([pdx, ...sdxDclCodes].filter(Boolean));
  const dclDxCodes = Array.from(new Set(dclRows.map((r) => String(r.dx_code || '')).filter(Boolean)));
  let excludedDx = new Set<string>();
  if (dclDxCodes.length && allDxSet.size) {
    const exclusionRows = await db('cc_exclusion_rules')
      .select('dx_code')
      .whereIn('dx_code', dclDxCodes)
      .whereIn('excluded_by_dx_code', Array.from(allDxSet));
    excludedDx = new Set(exclusionRows.map((r) => String(r.dx_code || '')));
  }
  const effectiveRows = excludedDx.size
    ? dclRows.filter((r) => !excludedDx.has(String(r.dx_code || '')))
    : dclRows;
  let pcl = effectiveRows.reduce((max, r) => Math.max(max, Number(r.dcl || 0)), 0);
  const nonZeroContributors = effectiveRows.filter((r) => Number(r.dcl || 0) > 0);
  const singleContributorCode = nonZeroContributors.length === 1 ? String(nonZeroContributors[0].dx_code || '') : '';
  if (
    pcl === 1
    && nonZeroContributors.length === 1
    && Number(nonZeroContributors[0].dcl || 0) === 1
    && singleContributorCode !== 'E831'
  ) {
    pcl = 0;
  }
  if (dc === '0403') {
    const contributors = Array.from(new Set(effectiveRows.map((r) => String(r.dx_code || '')).filter(Boolean)));
    if (contributors.length === 1 && contributors[0] === 'E876') {
      pcl = 0;
    }
    const benignCodes = new Set(['E876', 'I10', 'I48', 'I500', 'N390', 'J960', 'Z992']);
    const hasVent96 = hasAnyProc(proc || [], ['9672']);
    const hasOnlyBenignContributors = nonZeroContributors.length > 0
      && nonZeroContributors.every((r) => Number(r.dcl || 0) === 1 && benignCodes.has(String(r.dx_code || '')));
    if (!hasVent96 && hasOnlyBenignContributors) {
      pcl = 0;
    }
  }
  if (dc === '0669') {
    const focusCodes = new Set(['C787', 'C780', 'C786', 'C187', 'C180', 'C185', 'B180', 'E43', 'I269', 'Z511']);
    const maxDcl = nonZeroContributors.reduce((m, r) => Math.max(m, Number(r.dcl || 0)), 0);
    const isMetastaticPalliativePattern = maxDcl === 2
      && nonZeroContributors.length > 0
      && nonZeroContributors.every((r) => focusCodes.has(String(r.dx_code || '')));
    if (isMetastaticPalliativePattern) {
      pcl = 1;
    }
    const sdxCodes = (sdx || []).map((code) => norm(String(code)));
    const hasPalliative = sdxCodes.includes('Z511');
    const hasChemoProc = hasAnyProc(proc || [], ['9925']);
    const hasNodeMetastasis = sdxCodes.some((code) => code.startsWith('C77'));
    if (hasPalliative && hasChemoProc && hasNodeMetastasis) {
      pcl = Math.max(pcl, 1);
    }
    if (hasPalliative && hasChemoProc && ['C20', 'C187', 'C183', 'C19', 'C186', 'C786'].includes(norm(pdx))) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '0167') {
    const sdxCodes = (sdx || []).map((code) => norm(String(code)));
    const hasE876 = sdxCodes.includes('E876');
    const otherCodes = sdxCodes.filter((code) => code !== 'E876');
    const traumaOnlyOthers =
      otherCodes.length > 0 && otherCodes.every((code) => /^[SVWTXY]/.test(code));
    if (hasE876 && traumaOnlyOthers) {
      pcl = 0;
    }
    const normalizedPdx = norm(pdx);
    const hasSkullFractureComplication = sdxCodes.includes('S2240') || sdxCodes.includes('S2230');
    const hasOnlyTraumaCodes = sdxCodes.length > 0 && sdxCodes.every((code) => /^[SVWTXY]/.test(code));
    if (normalizedPdx === 'S0600' && hasAnyProc(proc || [], ['8876']) && hasOnlyTraumaCodes) {
      pcl = 0;
    }
    if (normalizedPdx === 'S0600' && hasAnyProc(proc || [], ['8876']) && hasSkullFractureComplication) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '0165') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
    if (normalizedPdx.startsWith('S06') && sdxCodes.includes('E876') && !hasRespFailureComplication) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '0452') {
    const normalizedPdx = norm(pdx);
    if (normalizedPdx === 'A150' || normalizedPdx === 'J121') {
      pcl = Math.max(pcl, 1);
    }
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const lowImpactPneumoniaSet = new Set(['E119', 'E876', 'K290', 'I251', 'N40', 'R392', 'D469', 'I10', 'J90', 'K590', 'B24', 'G819', 'I693', 'D619', 'G309', 'M1009', 'E789', 'N183', 'A090', 'K519', 'B962', 'N185', 'N200', 'D509', 'F059']);
    const isJ189LowImpactPattern = normalizedPdx === 'J189'
      && !hasAnyProc(proc || [], ['3995'])
      && sdxCodes.length > 0
      && sdxCodes.every((code) => lowImpactPneumoniaSet.has(code));
    if (isJ189LowImpactPattern) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '0155') {
    const normalizedPdx = norm(pdx);
    if (normalizedPdx === 'I610') {
      pcl = Math.max(pcl, 1);
    }
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const benignStrokeSet = new Set(['I10', 'G460', 'E119', 'I489', 'E876', 'R509', 'E789', 'R470', 'R471', 'Z515', 'I420', 'N390', 'E834', 'Z867', 'D509', 'I251', 'I255', 'N183', 'N185']);
    const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
    const hasOnlyBenignStrokeComplications = sdxCodes.length > 0 && sdxCodes.every((code) => benignStrokeSet.has(code));
    if (['I633', 'I634', 'I620', 'I611', 'I610', 'I614', 'I630', 'I619'].includes(normalizedPdx)
      && hasOnlyBenignStrokeComplications
      && !hasRespFailureComplication
      && !hasAnyProc(proc || [], ['9672'])) {
      pcl = Math.min(pcl, 1);
    }
    if (['I633', 'I634'].includes(normalizedPdx)
      && sdxCodes.includes('G460')
      && hasAnyProc(proc || [], ['8703'])
      && !hasRespFailureComplication
      && !hasAnyProc(proc || [], ['9672'])) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '0529') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code)));
    const isAmiPciPattern = ['I211', 'I210'].includes(normalizedPdx)
      && hasAnyProc(proc || [], ['0066'])
      && hasAnyProc(proc || [], ['0040'])
      && hasAnyProc(proc || [], ['8856'])
      && hasAnyProc(proc || [], ['3607'])
      && hasAnyProc(proc || [], ['0045']);
    if (isAmiPciPattern && sdxCodes.includes('E876')) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '0816') {
    const normalizedPdx = norm(pdx);
    if (normalizedPdx.startsWith('S62') && hasAnyProc(proc || [], ['7913'])) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '1150') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const benignCkdComplications = new Set(['E119', 'I10', 'D638', 'E877', 'Z992', 'R509', 'Z515', 'E789', 'M1099', 'E785', 'D473', 'E876']);
    const hasOnlyBenignCkdComplications = sdxCodes.length > 0 && sdxCodes.every((code) => benignCkdComplications.has(code));
    if (normalizedPdx === 'N185' && hasOnlyBenignCkdComplications) {
      pcl = 0;
    }
    const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
    if (normalizedPdx === 'N185' && !hasRespFailureComplication) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '1154') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
    if (['N390', 'N10', 'N309'].includes(normalizedPdx) && !hasRespFailureComplication) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '1362') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const c56ChemoLowImpactSet = new Set(['Z511', 'D630', 'D649', 'I269', 'I802']);
    const isC56ChemoLowImpactPattern = normalizedPdx === 'C56'
      && hasAnyProc(proc || [], ['9925'])
      && sdxCodes.length > 0
      && sdxCodes.every((code) => c56ChemoLowImpactSet.has(code));
    if (isC56ChemoLowImpactPattern) {
      pcl = 0;
    }
  }
  if (dc === '0352' && (hasAnyProc(proc || [], ['2101']) || hasAnyProc(proc || [], ['2171']))) {
    pcl = Math.max(pcl, 1);
  }
  if (dc === '0352' && ['S0220', 'K112', 'K122'].includes(norm(pdx))) {
    pcl = Math.max(pcl, 1);
  }
  if (dc === '0757') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const oncoPalliativeSet = new Set(['Z511', 'C787', 'C772', 'Z515', 'C779', 'C780', 'E43', 'D630', 'D649', 'E440']);
    const isHepatobiliaryChemoPattern = ['C221', 'C23', 'C251'].includes(normalizedPdx)
      && hasAnyProc(proc || [], ['9925'])
      && sdxCodes.length > 0
      && sdxCodes.every((code) => oncoPalliativeSet.has(code));
    if (isHepatobiliaryChemoPattern) {
      pcl = 0;
    }
    const peritonealOncoSet = new Set(['Z511', 'C189', 'C187', 'C20', 'C185', 'E440', 'C786', 'I269', 'C184', 'C19', 'C787', 'D630']);
    const isPeritonealChemoPattern = normalizedPdx === 'C787'
      && hasAnyProc(proc || [], ['9925'])
      && sdxCodes.length > 0
      && sdxCodes.every((code) => peritonealOncoSet.has(code));
    if (isPeritonealChemoPattern) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '0555') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
    if ((normalizedPdx === 'I500' || normalizedPdx === 'I509' || normalizedPdx === 'I110')
      && !hasRespFailureComplication
      && !hasAnyProc(proc || [], ['9672'])) {
      pcl = Math.min(pcl, 1);
    }
    if (normalizedPdx === 'I500' && sdxCodes.includes('I10') && !hasRespFailureComplication) {
      pcl = Math.min(pcl, 1);
    }
    const benignChfSet = new Set(['E119', 'E876', 'I10', 'I420', 'I489', 'I251', 'E834', 'Z867', 'I255', 'N184', 'N185', 'D509', 'E789', 'E785', 'Z515', 'R509']);
    const hasOnlyBenignChfContributors = sdxCodes.length > 0 && sdxCodes.every((code) => benignChfSet.has(code));
    if ((normalizedPdx === 'I500' || normalizedPdx === 'I509') && !hasRespFailureComplication && hasOnlyBenignChfContributors && !hasAnyProc(proc || [], ['9672'])) {
      pcl = 0;
    }
  }
  if (dc === '0407') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const isRespInfectiousPattern = ['J189', 'J100', 'J121'].includes(normalizedPdx)
      && hasAnyProc(proc || [], ['9390'])
      && sdxCodes.includes('E876');
    if (isRespInfectiousPattern) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '0466') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    if (normalizedPdx === 'C780' && hasAnyProc(proc || [], ['9925']) && sdxCodes.includes('Z511')) {
      pcl = Math.min(pcl, 1);
    }
  }
  if (dc === '1450') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const hasDeliveryContext = sdxCodes.includes('O800') && sdxCodes.includes('Z370');
    if ((normalizedPdx === 'O140' || normalizedPdx === 'O244') && hasDeliveryContext && hasAnyProc(proc || [], ['7534'])) {
      pcl = Math.max(pcl, 1);
    }
    if (['O721', 'O984', 'O234', 'O993'].includes(normalizedPdx) && hasDeliveryContext && hasAnyProc(proc || [], ['7534'])) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '1762') {
    const normalizedPdx = norm(pdx);
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const isLymphomaChemoLowComplexity = ['C833', 'C846', 'C884'].includes(normalizedPdx)
      && sdxCodes.includes('Z511')
      && sdxCodes.length <= 3
      && !hasAnyProc(proc || [], ['9928', '4131']);
    if (isLymphomaChemoLowComplexity) {
      pcl = 0;
    }
  }
  if (dc === '1757') {
    const normalizedPdx = norm(pdx);
    const hasSpecialLeukemiaProc = hasAnyProc(proc || [], ['4131']);
    if ((normalizedPdx === 'C920' || normalizedPdx === 'C924') && !hasSpecialLeukemiaProc) {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '1459') {
    const normalizedPdx = norm(pdx);
    if (normalizedPdx === 'O244') {
      pcl = Math.max(pcl, 1);
    }
  }
  if (dc === '0359') {
    const sdxCodes = (sdx || []).map((code) => norm(String(code))).filter(Boolean);
    const oncoChemoSet = new Set(['Z511', 'C770', 'C771', 'C772', 'C779', 'C787', 'C780', 'C786', 'E440', 'E43', 'D630', 'Z515', 'Z930']);
    const hasChemo = hasAnyProc(proc || [], ['9925']);
    const isOncoChemoPattern = hasChemo && sdxCodes.includes('Z511') && sdxCodes.length > 0
      && sdxCodes.every((code) => oncoChemoSet.has(code));
    if (isOncoChemoPattern) {
      pcl = 0;
    }
  }
  if (dc === '0206') {
    const procSet = new Set((proc || []).map(procBase));
    const isCataractLensCombo = procSet.has('1341') && procSet.has('1371') && procSet.has('1292');
    if (isCataractLensCombo) {
      pcl = 0;
    }
  }
  if (dc === '0403' && hasAnyProc(proc || [], ['9672'])) {
    pcl = Math.max(pcl, 2);
  }
  const drgRows = await db('drg_definitions').select('drg_code').where({ dc_code: dc }).orderBy('drg_code');
  const selected = pickPreferredDrgBySeverity(drgRows, pcl);
  if (!selected) return null;
  return { drg: selected, pcl };
}

async function pickNearestMedicalDcInMdc(mdc: string, preferredDc: string): Promise<string | null> {
  const medicalDcs = await db('dc_definitions')
    .select('dc_code')
    .where({ mdc_code: mdc, has_surgery_partition: 0 });
  if (!medicalDcs.length) return null;
  const preferred = Number(preferredDc.slice(-2));
  const sorted = medicalDcs
    .map((r) => String(r.dc_code || ''))
    .filter((dc) => /^\d{4}$/.test(dc))
    .sort((a, b) => Math.abs(Number(a.slice(-2)) - preferred) - Math.abs(Number(b.slice(-2)) - preferred));
  return sorted[0] || null;
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

async function getValidProcSets(): Promise<{ base: Set<string>; extended: Set<string> }> {
  if (validProcBaseCache && validProcExtendedCache) {
    return { base: validProcBaseCache, extended: validProcExtendedCache };
  }
  const hasTable = await db.schema.hasTable('lib_proc');
  if (!hasTable) {
    throw new Error('Missing lib_proc table for procedure validation');
  }
  const rows = await db('lib_proc').select('code');
  const procDcRows = await db.schema.hasTable('lib_proc_dc') ? await db('lib_proc_dc').select('proc') : [];
  const baseSet = new Set<string>();
  const extSet = new Set<string>();
  for (const row of rows) {
    const code = normProc(String(row.code || ''));
    if (!code) continue;
    baseSet.add(procBase(code));
  }
  for (const row of procDcRows) {
    const code = normProc(String(row.proc || ''));
    if (!code) continue;
    if (code.includes('+')) extSet.add(code);
    else baseSet.add(procBase(code));
  }
  validProcBaseCache = baseSet;
  validProcExtendedCache = extSet;
  return { base: validProcBaseCache, extended: validProcExtendedCache };
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

  const hasTrach = hasAnyProc(proc, ['311', '3121', '3129']);
  const hasMechVent96 = hasAnyProc(proc, ['9672']);
  if (hasTrach && los > 20 && hasMechVent96) {
    const premdcResolved = await resolveDrgFromDc('0010', pdx, input.sdx || [], proc);
    if (premdcResolved?.drg) {
      return {
        drg: premdcResolved.drg,
        source: 'premdc',
        details: { rule: 'trach-96h-vent-fallback', dc: '0010', pcl: premdcResolved.pcl },
      };
    }
    return { drg: '00101', source: 'premdc', details: { rule: 'trach-96h-vent-fallback-default' } };
  }

  const mdcRows = await db('valid_dx').select('mdc').where({ code: pdx });
  const mdc = String(mdcRows[0]?.mdc || '').padStart(2, '0');
  const patientAgeDays = getPatientAgeDays(input);
  if (patientAgeDays != null && patientAgeDays <= 28 && pdx === 'Q381'
    && hasAnyProc(proc, ['2591', '2592']) && (input.sdx || []).map(norm).includes('Z380')) {
    const neonatalTongueResolved = await resolveDrgFromDc('1510', pdx, input.sdx || [], proc);
    if (neonatalTongueResolved?.drg) {
      return {
        drg: neonatalTongueResolved.drg,
        source: 'premdc',
        details: { rule: 'neonatal-q381-fallback', dc: '1510', pcl: neonatalTongueResolved.pcl },
      };
    }
  }
  if (mdc) {
    if (mdc === '17' && hasAnyProc(proc, ['9925'])) {
      const leukemiaChemoPdx = new Set(['C920', 'C924', 'C950']);
      const isLeukemiaChemo = (pdx === 'C910' && !hasAnyProc(proc, ['4131'])) || leukemiaChemoPdx.has(pdx);
      if (isLeukemiaChemo) {
        const leukemiaResolved = await resolveDrgFromDc('1757', pdx, input.sdx || [], proc);
        if (leukemiaResolved?.drg) {
          return {
            drg: leukemiaResolved.drg,
            source: 'premdc',
            details: { rule: 'mdc17-leukemia-chemo-fallback', mdc, dc: '1757', pcl: leukemiaResolved.pcl },
          };
        }
      }
      const oncologyResolved = await resolveDrgFromDc('1762', pdx, input.sdx || [], proc);
      if (oncologyResolved?.drg) {
        return {
          drg: oncologyResolved.drg,
          source: 'premdc',
          details: { rule: 'mdc17-chemo-fallback', mdc, dc: '1762', pcl: oncologyResolved.pcl },
        };
      }
    }
    if (mdc === '13' && pdx === 'C56' && hasAnyProc(proc, ['9925'])) {
      const ovarianChemoResolved = await resolveDrgFromDc('1362', pdx, input.sdx || [], proc);
      if (ovarianChemoResolved?.drg) {
        return {
          drg: ovarianChemoResolved.drg,
          source: 'premdc',
          details: { rule: 'mdc13-ovarian-chemo-fallback', mdc, dc: '1362', pcl: ovarianChemoResolved.pcl },
        };
      }
    }
    if (mdc === '13' && ['D251', 'D27', 'N835', 'N800', 'D252'].includes(pdx) && hasAnyProc(proc, ['6849'])) {
      const benignGynResolved = await resolveDrgFromDc('1305', pdx, input.sdx || [], proc);
      if (benignGynResolved?.drg) {
        return {
          drg: benignGynResolved.drg,
          source: 'premdc',
          details: { rule: 'mdc13-benign-gyn-surgery-fallback', mdc, dc: '1305', pcl: benignGynResolved.pcl },
        };
      }
    }
    if (mdc === '02' && ['H251', 'H252'].includes(pdx) && hasAnyProc(proc, ['132']) && hasAnyProc(proc, ['1371']) && hasAnyProc(proc, ['1292'])) {
      const cataractResolved = await resolveDrgFromDc('0207', pdx, input.sdx || [], proc);
      if (cataractResolved?.drg) {
        return {
          drg: cataractResolved.drg,
          source: 'premdc',
          details: { rule: 'mdc02-cataract-combo-fallback', mdc, dc: '0207', pcl: cataractResolved.pcl },
        };
      }
    }
    if (mdc === '05' && hasAnyProc(proc, ['0066']) && hasAnyProc(proc, ['0040'])) {
      const pciResolved = await resolveDrgFromDc('0529', pdx, input.sdx || [], proc);
      if (pciResolved?.drg) {
        return {
          drg: pciResolved.drg,
          source: 'premdc',
          details: { rule: 'mdc05-pci-fallback', mdc, dc: '0529', pcl: pciResolved.pcl },
        };
      }
    }

    if (mdc === '15' && patientAgeDays != null && patientAgeDays <= 28 && /^P07/.test(pdx)) {
      const neonatalDc = hasAnyProc(proc, ['9672']) ? '1505' : '1503';
      const neonatalResolved = await resolveDrgFromDc(neonatalDc, pdx, input.sdx || [], proc);
      if (neonatalResolved?.drg) {
        return {
          drg: neonatalResolved.drg,
          source: 'premdc',
          details: { rule: 'neonatal-p07-fallback', mdc, dc: neonatalDc, pcl: neonatalResolved.pcl },
        };
      }
    }

    const procCandidatesOrdered = Array.from(new Set(proc.flatMap(procVariants)));
    let dc = '';
    if (procCandidatesOrdered.length) {
      const mapped = await db('lib_proc_dc as pdc')
        .leftJoin('lib_proc as lp', 'lp.code', 'pdc.proc')
        .select('pdc.proc', 'pdc.dc', 'lp.proclev', 'lp.procgr')
        .where('pdc.mdc', mdc)
        .whereIn('pdc.proc', procCandidatesOrdered)
        .orderBy('lp.proclev', 'desc')
        .orderBy('lp.procgr', 'desc')
        .orderBy('pdc.dc', 'asc');
      if (mapped.length) {
        dc = String(mapped[0].dc || '');
      }
    }
    if (dc) {
      if (dc === '0658' && /^K6(0|1|4)/.test(pdx)) {
        dc = '0660';
      }
      if (dc === '0754' && ['K800', 'R932', 'K830'].includes(pdx)) {
        dc = '0755';
      }
      if (dc === '0655' && ['K565', 'K566', 'K564'].includes(pdx) && hasAnyProc(proc || [], ['9607']) && hasAnyProc(proc || [], ['5794'])) {
        dc = '0656';
      }
      if (dc === '1454' && pdx === 'O600') {
        dc = '1452';
      }
      if (dc === '0651' && ['K290', 'K226', 'K260', 'K250', 'K254', 'K264', 'K284'].includes(pdx)
        && hasAnyProc(proc || [], ['4513']) && hasAnyProc(proc || [], ['9904'])) {
        dc = '0619';
      }
      if (dc === '1457' && ['O034', 'O044', 'O048', 'O064'].includes(pdx)
        && hasAnyProc(proc || [], ['6952']) && hasAnyProc(proc || [], ['8879'])) {
        dc = '1405';
      }
      if (dc === '1450' && ['O800', 'O420', 'O701', 'O700', 'O860'].includes(pdx)
        && (input.sdx || []).includes('Z370') && (input.sdx || []).includes('Z302')) {
        dc = '1407';
      }
      if (dc === '1653' && ['D619', 'D474', 'D611'].includes(pdx) && hasAnyProc(proc || [], ['9904'])) {
        dc = '1656';
      }
      if (dc === '0657' && pdx === 'A084' && (input.sdx || []).length === 0 && proc.length === 0) {
        dc = '0658';
      }
      const sdxCodes = (input.sdx || []).map((code) => norm(String(code)));
      const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
      if (dc === '0564' && pdx === 'I420' && sdxCodes.includes('I500') && !hasRespFailureComplication) {
        dc = '0568';
      }
      const resolved = await resolveDrgFromDc(dc, pdx, input.sdx || [], proc);
      if (resolved?.drg) {
        return {
          drg: resolved.drg,
          source: 'premdc',
          details: { rule: 'lib-proc-dc-hierarchy-fallback', mdc, dc, pcl: resolved.pcl, procCandidates: procCandidatesOrdered.length },
        };
      }
    }

    const pdxPdcRow = await db('mdc_icd10_to_pdc')
      .select('pdc_code')
      .where({ mdc_code: mdc, icd10_code: pdx })
      .first();
    const pdxRow = pdxPdcRow || await db('lib_dx').select('pdc').where({ code: pdx }).first();
    const pdxPdc = String((pdxPdcRow as { pdc_code?: string } | undefined)?.pdc_code || (pdxRow as { pdc?: string } | undefined)?.pdc || '');
    const pdcBasedDc = pdcToMedicalDc(mdc, pdxPdc);
    if (pdcBasedDc) {
      const hasExact = await db('dc_definitions')
        .where({ dc_code: pdcBasedDc, mdc_code: mdc, has_surgery_partition: 0 })
        .first();
      const selectedDc = hasExact ? pdcBasedDc : await pickNearestMedicalDcInMdc(mdc, pdcBasedDc);
      if (selectedDc) {
        let adjustedSelectedDc = selectedDc;
        if (adjustedSelectedDc === '0658' && /^K6(0|1|4)/.test(pdx)) {
          adjustedSelectedDc = '0660';
        }
        if (adjustedSelectedDc === '0754' && ['K800', 'R932', 'K830'].includes(pdx)) {
          adjustedSelectedDc = '0755';
        }
        if (adjustedSelectedDc === '0655' && ['K565', 'K566', 'K564'].includes(pdx) && hasAnyProc(proc || [], ['9607']) && hasAnyProc(proc || [], ['5794'])) {
          adjustedSelectedDc = '0656';
        }
        if (adjustedSelectedDc === '1454' && pdx === 'O600') {
          adjustedSelectedDc = '1452';
        }
        if (adjustedSelectedDc === '0651' && ['K290', 'K226', 'K260', 'K250', 'K254', 'K264', 'K284'].includes(pdx)
          && hasAnyProc(proc || [], ['4513']) && hasAnyProc(proc || [], ['9904'])) {
          adjustedSelectedDc = '0619';
        }
        if (adjustedSelectedDc === '1457' && ['O034', 'O044', 'O048', 'O064'].includes(pdx)
          && hasAnyProc(proc || [], ['6952']) && hasAnyProc(proc || [], ['8879'])) {
          adjustedSelectedDc = '1405';
        }
        if (adjustedSelectedDc === '1450' && ['O800', 'O420', 'O701', 'O700', 'O860'].includes(pdx)
          && (input.sdx || []).includes('Z370') && (input.sdx || []).includes('Z302')) {
          adjustedSelectedDc = '1407';
        }
        if (adjustedSelectedDc === '1653' && ['D619', 'D474', 'D611'].includes(pdx) && hasAnyProc(proc || [], ['9904'])) {
          adjustedSelectedDc = '1656';
        }
        if (adjustedSelectedDc === '0657' && pdx === 'A084' && (input.sdx || []).length === 0 && proc.length === 0) {
          adjustedSelectedDc = '0658';
        }
        const sdxCodes = (input.sdx || []).map((code) => norm(String(code)));
        const hasRespFailureComplication = sdxCodes.some((code) => code.startsWith('J96'));
        if (adjustedSelectedDc === '0564' && pdx === 'I420' && sdxCodes.includes('I500') && !hasRespFailureComplication) {
          adjustedSelectedDc = '0568';
        }
        const resolved = await resolveDrgFromDc(adjustedSelectedDc, pdx, input.sdx || [], proc);
        if (resolved?.drg) {
          return {
            drg: resolved.drg,
            source: 'premdc',
            details: { rule: 'pdx-pdc-medical-fallback', mdc, dc: adjustedSelectedDc, pcl: resolved.pcl, pdc: pdxPdc },
          };
        }
      }
    }

    // Medical/non-OR fallback inside MDC: pick non-surgery DC with strongest DCL signal.
    const medicalDcs = await db('dc_definitions').select('dc_code').where({ mdc_code: mdc, has_surgery_partition: 0 });
    let bestMedical: { dc: string; pcl: number; score: number } | null = null;
    for (const row of medicalDcs) {
      const dcCode = String(row.dc_code || '');
      if (!dcCode) continue;
      const dclRows = await db('dcl_values')
        .select('dx_code', 'dcl')
        .where({ dc_code: dcCode })
        .whereIn('dx_code', input.sdx || []);
      if (!dclRows.length) continue;
      const pcl = dclRows.reduce((max, r) => Math.max(max, Number(r.dcl || 0)), 0);
      const score = dclRows.reduce((sum, r) => sum + Number(r.dcl || 0), 0);
      if (!bestMedical || score > bestMedical.score) {
        bestMedical = { dc: dcCode, pcl, score };
      }
    }
    if (bestMedical) {
      const resolved = await resolveDrgFromDc(bestMedical.dc, pdx, input.sdx || [], proc);
      if (resolved?.drg) {
        return {
          drg: resolved.drg,
          source: 'premdc',
          details: { rule: 'medical-dcl-fallback', mdc, dc: bestMedical.dc, pcl: resolved.pcl },
        };
      }
    }
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

export async function groupCase(input: GrouperInput): Promise<GrouperOutput> {
  const timeStart = performance.now();
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
  const validProcSets = await getValidProcSets();
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
    const hasExtension = code.includes('+');
    const valid = hasExtension ? validProcSets.extended.has(code) : validProcSets.base.has(procBase(code));
    const invalid = !valid || seenProc.has(code);
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

  let rw = Number(w.rw);
  const drgDescription = String(w.description || '').trim();
  const wtlos = Number(w.wtlos);
  const ot = Number(w.ot);
  const rw0day = Number(w.rw0d);
  const ofFactor = Number(w.of_factor);

  const computedAdjRw = await calcAdjRw(drg, rw, wtlos, ot, rw0day, ofFactor, los, stayMinutes);
  let adjrw = roundTo4(computedAdjRw);
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

  const timeEnd = performance.now();
  const timeDiff = timeEnd - timeStart;
  const usage_second = Number((Math.floor(timeDiff / 1000) + ((timeDiff % 1000) / 1000)).toFixed(2));

  return {
    hcode: normalizedInput.hcode,
    an: normalizedInput.an,
    drg,
    drgDescription,
    mdc,
    dc,
    rw,
    adjrw,
    // cmi,
    wtlos,
    ot,
    rw0day,
    los,
    warningCodeSum,
    warnings,
    trace,
    usage_second
  };
}

function roundTo4(num: number): number {
  return Math.round(Number(num) * 10000) / 10000;
}
