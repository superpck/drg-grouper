export type GrouperInput = {
  hcode: string;
  an: string;
  pdx: string;
  sdx?: string[];
  proc?: string[];
  sex?: 1 | 2;
  age?: number;
  ageDay?: number;
  admWt?: number;
  discht?: number;
  dateAdm?: string;
  timeAdm?: string;
  dateDsc?: string;
  timeDsc?: string;
  leaveDays?: number;
  los?: number;
  drg?: string;
};

export type TraceStep = {
  step: string;
  status: 'ok' | 'warn' | 'error' | 'info';
  details: Record<string, unknown>;
};

export type WarningCode = {
  code: number;
  name: string;
  description: string;
};

export type GrouperOutput = {
  hcode: string;
  an: string;
  drg: string;
  drgDescription: string;
  mdc: string;
  dc: string;
  rw: number;
  adjrw: number;
  cmi: number;
  wtlos: number;
  ot: number;
  rw0day: number;
  los: number;
  warningCodeSum: number;
  warnings: WarningCode[];
  trace: TraceStep[];
};
