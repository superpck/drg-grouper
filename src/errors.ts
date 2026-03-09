export class DrgStandardError extends Error {
  readonly errorCode: number;
  readonly errorName: string;
  readonly description: string;

  constructor(errorCode: number, errorName: string, description: string) {
    super(description);
    this.name = 'DrgStandardError';
    this.errorCode = errorCode;
    this.errorName = errorName;
    this.description = description;
  }
}

export const DRG_ERROR = {
  NO_PDX: { code: 1, name: 'ERROR_1', description: 'No principal diagnosis' },
  INVALID_PDX: { code: 2, name: 'ERROR_2', description: 'Invalid principal diagnosis' },
  UNACCEPTABLE_PDX: { code: 3, name: 'ERROR_3', description: 'Unacceptable principal diagnosis' },
  PDX_SEX_CONFLICT: { code: 5, name: 'ERROR_5', description: 'Principal diagnosis not valid for sex' },
} as const;

export const DRG_WARNING = {
  SDX_INVALID_OR_DUPLICATE: {
    code: 1,
    name: 'WARNING_1',
    description: 'SDx ใช้ไม่ได้ หรือซ้ำกับ PDx หรือ ซ้ำกันเอง หรือขัดแย้งเพศ/อายุ',
  },
  PROC_INVALID_OR_DUPLICATE: {
    code: 8,
    name: 'WARNING_8',
    description: 'Proc ใช้ไม่ได้ หรือ ซ้ำกันเอง',
  },
} as const;
