# Tables used by `src/services/grouper.ts`

## Read tables (SELECT)

| Table | Usage in `grouper.ts` |
| --- | --- |
| `lib_dx` | map SDx/PDx เพื่อใช้ `dclmain`/`pdc` ในการ resolve DRG |
| `dcl_values` | โหลดค่า DCL ตาม DC และ DX เพื่อคำนวณ PCL |
| `cc_exclusion_rules` | ตัด DCL contributor ที่ถูก exclude ตามกฎ CC exclusion |
| `drg_definitions` | map จาก DC + PCL ไปหา DRG code ปลายทาง |
| `dc_definitions` | ใช้ lookup DC ของ MDC (medical partition / fallback) |
| `ax_icd10_members` | ตรวจว่า PDx อยู่ใน AX group ที่ใช้ตัดสิน PREMDC rule (`inAxIcd10`) |
| `premdc_proc_groups` | โหลด mapping กลุ่มหัตถการ PREMDC (`liver`, `heartLung`, `boneMarrow`, `laryngectomy`) |
| `lib_proc` | โหลดรายการรหัสหัตถการหลักเพื่อ validate PROC |
| `lib_proc_dc` | โหลดรายการรหัสหัตถการส่วนขยาย และ map PROC -> PDC |
| `mdc_icd10_to_pdc` | lookup mapping ICD10 ไป PDC สำหรับกำหนด DC |
| `adjrw_coefficients` | โหลดค่าสัมประสิทธิ์สำหรับคำนวณ AdjRW เมื่อ LOS เกิน OT |
| `valid_dx` | ตรวจความถูกต้องของ PDx และ SDx |
| `appendix_a4_sex_conflict` | ตรวจ conflict ระหว่างเพศกับ PDx/SDx |
| `appendix_a3_age_conflict` | ตรวจ conflict ระหว่างอายุ (days) กับ SDx |
| `drg_weights` | โหลดข้อมูลน้ำหนัก DRG (`rw`, `wtlos`, `ot`, `rw0d`, `of_factor`, `description`) |
