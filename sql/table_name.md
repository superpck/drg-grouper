# Tables used by `src/services/grouper.ts`

## Read tables (SELECT)

| Table | Usage in `grouper.ts` |
| --- | --- |
| `ax_icd10_members` | ตรวจว่า PDx อยู่ใน AX group ที่ใช้ตัดสิน PREMDC rule (`inAxIcd10`) |
| `premdc_proc_groups` | โหลด mapping กลุ่มหัตถการ PREMDC (`liver`, `heartLung`, `boneMarrow`, `laryngectomy`) |
| `lib_proc` | โหลดรายการรหัสหัตถการหลักเพื่อ validate PROC |
| `lib_proc_dc` | โหลดรายการรหัสหัตถการส่วนขยาย (เช่นรหัสมี `+`) เพื่อ validate PROC |
| `adjrw_coefficients` | โหลดค่าสัมประสิทธิ์สำหรับคำนวณ AdjRW เมื่อ LOS เกิน OT |
| `valid_dx` | ตรวจความถูกต้องของ PDx และ SDx |
| `appendix_a4_sex_conflict` | ตรวจ conflict ระหว่างเพศกับ PDx/SDx |
| `appendix_a3_age_conflict` | ตรวจ conflict ระหว่างอายุ (days) กับ SDx |
| `drg_weights` | โหลดข้อมูลน้ำหนัก DRG (`rw`, `wtlos`, `ot`, `rw0d`, `of_factor`, `description`) |
