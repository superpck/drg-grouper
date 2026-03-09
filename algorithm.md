# Thai DRG v6.3.x Grouper Algorithm (Public Overview)

เอกสารนี้เป็นสรุปแนวทาง implementation ของโปรเจกต์ เพื่อใช้อธิบาย logic ให้ผู้อ่านบน public GitHub

เอกสารอ้างอิงที่ใช้:
- เล่ม 1 (หลักเกณฑ์, validation, Appendix A-H)
- เล่ม 2 (PreMDC + MDC 01-25 + AX 99)
- ภาคผนวก F1 ตอน 1-4 (DCL table)
- ภาคผนวก F2 (CC Exclusion Lists)

---

## 1) Input ที่ต้องใช้

อย่างน้อยต้องมีข้อมูล:
- `PDx` 1 รหัส
- `SDx[]` 0-12 รหัส
- `Proc[]` 0-20 รหัส
- `Sex` (1=ชาย, 2=หญิง)
- `Age`, `AgeDay` (หรือคำนวณจาก DOB + DateAdm)
- `AdmWt` (สำคัญในทารก < 28 วัน)
- `DateAdm/TimeAdm`, `DateDsc/TimeDsc`, `LeaveDay`
- `DischargeType`

---

## 2) Data validation และ preprocessing

ทำก่อนการจัดกลุ่มเสมอ:

1. ตรวจ PDx
   - Normalize เป็น uppercase ก่อนทุกขั้นตอน
   - ไม่มี PDx -> `error=1 (ERROR_1)`
   - PDx ไม่พบใน `valid_dx` (มาจาก Appendix E) -> `error=3 (ERROR_3 Unacceptable principal diagnosis)`
   - PDx conflict อายุ/เพศ -> error ตามตาราง (เช่น 4,5,7)

2. ตรวจ Age / LOS / AdmWt
   - อายุใช้ไม่ได้ -> `DRG=26539`, `error=6`
   - LOS คำนวณไม่ได้หรือ <0 -> `DRG=26509`, `error=9`
   - ทารก <28 วันแต่ไม่มี/invalid AdmWt -> `DRG=26509`, `error=10`

3. ตรวจ SDx/Proc
    - SDx ถูก normalize เป็น uppercase
    - SDx ที่ไม่พบใน `valid_dx`, ซ้ำกับ PDx, ซ้ำกันเอง, หรือขัดแย้งเพศ/อายุ จะถูกตัดทิ้ง
    - หากมีกรณีข้างต้นอย่างน้อย 1 รายการ ให้คืน `WARNING_1`  
      (`code=1`, `name=WARNING_1`, `description=SDx ใช้ไม่ได้ หรือซ้ำกับ PDx หรือ ซ้ำกันเอง`)
    - Proc ที่ไม่พบในชุดรหัสที่ยอมรับได้ หรือซ้ำกันเอง จะถูกตัดทิ้ง
    - รองรับรหัส Proc แบบมี extension (`proc+ext` เช่น `9604+11`)
      - base proc ตรวจจาก `lib_proc`
      - extended proc ตรวจจาก `lib_proc_dc.proc`
    - หากมี Proc invalid/duplicate อย่างน้อย 1 รายการ ให้คืน `WARNING_8`  
      (`code=8`, `name=WARNING_8`, `description=Proc ใช้ไม่ได้ หรือ ซ้ำกันเอง`)
    - warning เป็นผลรวมรหัส (ไม่นับซ้ำรหัสเดิม)

4. Dagger/Asterisk substitution (Appendix A1)
   - ถ้าเข้าเงื่อนไขคู่รหัส ให้สลับ PDx/SDx1 ตามตารางก่อน grouper

> ถ้ามีหลาย error พร้อมกัน ให้ใช้ error code ต่ำสุดที่เจอในกลุ่ม error ที่ต้องหยุด

**ชุดข้อมูลที่ใช้ในขั้นตอนนี้**
- `valid_dx` (รายการ diagnosis code ที่ยอมรับได้)
- `lib_proc` (รายการ base procedure code ที่ยอมรับได้)
- `lib_proc_dc` (mapping proc->dc ที่รวมรหัสแบบ extension)
- `appendix_a2_unacceptable_pdx` (Unacceptable PDx)
- `appendix_a3_age_conflict` (age conflict)
- `appendix_a4_sex_conflict` (sex conflict; ใช้รหัสเพศ 1/2)
- `appendix_a1_dagger_asterisk_substitution` (สลับ dagger/asterisk)
- `drg_error_codes`, `drg_warning_codes` (ข้อความ error/warning มาตรฐาน)

**หมายเหตุ `valid_dx` (implementation ปัจจุบัน)**
- สร้างจาก Appendix E เล่ม 1 โดย parse จาก `appendix_e_lines` (รองรับหน้าที่มี 6 sector แล้วในชั้น extract)
- โครงสร้าง: `valid_dx(code, mdc)` และใช้ PK `(code, mdc)` เพราะ 1 code อาจมีได้หลาย MDC
- ในขั้น validation ใช้ `code` เพื่อตรวจว่า PDx/SDx เป็น diagnosis ที่ยอมรับได้ก่อนจัดกลุ่ม
- ยังไม่ใช้ `mdc` ใน `valid_dx` เพื่อบังคับ MDC สุดท้าย (MDC ยังมาจาก rule engine/fallback ของ grouper)

---

## 3) หา MDC ตามลำดับบังคับ

ต้องตรวจตามลำดับนี้เท่านั้น:

`PreMDC -> MDC24 -> MDC25 -> MDC15 -> MDC01-23`

1. **PreMDC**
   - ตรวจ transplant/tracheostomy/trach status ตาม AX/PDC ของ PreMDC
2. **MDC24**
   - Multiple Significant Trauma ตามเงื่อนไข PDx + SDx/Proc หลาย body-site category
3. **MDC25**
   - PDx กลุ่ม HIV disease
4. **MDC15**
   - อายุ < 28 วัน
5. **MDC01-23**
   - ใช้ PDx assignment ของแต่ละ MDC
6. **Fallback ปัจจุบันใน implementation**
   - ถ้าไม่เข้า PreMDC rule จะใช้ reference-assisted matching เพื่อหา DRG ที่ใกล้เคียงที่สุด
   - สำหรับ production ที่ต้องการ deterministic behavior ควรผูกกฎ MDC/DC เต็มรูปแบบจากชุดข้อมูลมาตรฐาน

**ชุดข้อมูลที่ใช้ในขั้นตอนนี้**
- `mdc_definitions` (ลำดับและหมวด MDC)
- `pdc_definitions` (คีย์ PDC ที่ผูกกับ MDC)
- `mdc_icd10_to_pdc` (map PDx -> PDC ใน MDC)
- `mdc_icd9proc_to_pdc` (map Proc -> PDC ใน MDC)
- `ax_definitions`, `ax_icd10_members`, `ax_icd9proc_members` (เงื่อนไข AX ของ PreMDC/MDC24/MDC25)
- `appendix_d_lines`, `appendix_e_lines` (กติกาย้าย MDC / PDx assignment ที่ยังใช้จาก raw appendix)

---

## 4) หา DC ใน MDC ที่เลือกได้

1. หา `PDC` จาก Proc/PDx ตาม assignment table ของ MDC นั้น
2. ถ้ามีหลาย PDC ให้เลือกตาม **hierarchy** ใน diagram ของ MDC
3. ประเมินเงื่อนไขใน `DC definition`:
   - เงื่อนไข AX
   - อายุ
   - discharge type
   - เงื่อนไขร่วม PDx/SDx/Proc อื่น ๆ
4. กรณี **Unrelated OR Procedure** หรือเงื่อนไขย้าย MDC:
   - ดำเนินตาม Appendix D และกติกา MDC-specific (เช่น 18/23/25)

ผลลัพธ์ขั้นนี้คือ `DC`

**ตารางที่ใช้ในขั้นตอนนี้**
- `dc_definitions` (รายการ DC)
- `dc_rules` (เงื่อนไข DC)
- `mdc_icd10_to_pdc`, `mdc_icd9proc_to_pdc` (เลือก PDC)
- `ax_icd10_members`, `ax_icd9proc_members` (เงื่อนไข AX)
- `appendix_b_lines`, `appendix_c_lines`, `appendix_d_lines` (OR-proc / proc combination / unrelated OR raw rules)

---

## 5) หา PCL ด้วย DCL + Recursive Exclusion

ทำหลังได้ DC แล้ว:

1. หา DCL ของแต่ละ PDx/SDx จาก `(dx_code, dc_code)` ใน F1
   - ไม่พบค่า = `DCL=0`
2. คัดเฉพาะ DCL>0 แล้วเรียง:
   - DCL มาก -> น้อย
   - ถ้า DCL เท่ากัน เรียงรหัสจาก Z -> A
3. ทำ Recursive Exclusion (F2):
   - ใช้รหัสซ้ายสุดเป็น anchor
   - ถ้า anchor อยู่ใน exclusion list ของรหัสทางขวา ให้รหัสขวานั้น DCL=0
   - เลื่อนไป anchor ถัดไปจนสุด
4. คำนวณ PCL จาก DCL ที่เหลือด้วยสูตรใน Appendix F (r=0.82)
5. ปัดเศษเป็นจำนวนเต็ม และ cap ที่ 9

ผลลัพธ์ขั้นนี้คือ `PCL`

**ตารางที่ใช้ในขั้นตอนนี้**
- `dcl_values` (ค่า DCL ต่อ `(dx_code, dc_code)`)
- `dcl_alias_codes` (รหัสที่ใช้ค่า DCL ตามรหัสอื่น)
- `cc_exclusion_rules` (Recursive Exclusion จาก F2)
- `appendix_f1_part1_lines` ... `appendix_f1_part4_lines` (raw trace ของ DCL table)
- `appendix_f2_lines` (raw trace ของ CC exclusion)

---

## 6) หา DRG จาก DC + PCL

อ้างอิง DRG definition (เล่ม 2):
- ถ้า DC ไม่แยกความซับซ้อน -> DRG ลงท้าย `9`
- ถ้า DC แยก -> เลือก DRG ตามช่วง `PCL min/max` ของ DC นั้น

ผลลัพธ์ขั้นนี้คือ `DRG`

**ตารางที่ใช้ในขั้นตอนนี้**
- `drg_definitions` (map DC + ช่วง PCL ไป DRG)

---

## 7) หา RW, WtLOS, OT, RW0d, OF

ดึงจาก Appendix G ตาม `DRG`:
- `RW`
- `WtLOS`
- `OT`
- `RW0d`
- `OF`

คำนวณ LOS:
- `LOS = (DateDscTime - DateAdmTime) - LeaveDay`

**ตารางที่ใช้ในขั้นตอนนี้**
- `drg_weights` (RW/WtLOS/OT/RW0d/OF)

---

## 8) คำนวณ AdjRW (Appendix H)

### 8.1 กรณี LOS ต่ำกว่าเกณฑ์

1. ถ้า `RW0d = 0` -> `AdjRW = RW`
2. ถ้า stay < 24 ชั่วโมง -> `AdjRW = RW0d`
3. ถ้า stay >= 24 ชั่วโมง และ `LOS < WtLOS/3` และ `WtLOS > 3`:

`AdjRW = RW0d + LOS*(RW - RW0d)/CEILING(WtLOS/3)`

### 8.2 กรณี LOS สูงกว่าเกณฑ์ (`LOS > OT`)

เลือกชุดค่าสัมประสิทธิ์ตามชนิด DRG:
- M1: DRG medical, RW 0.0000-0.6999 -> b12=0.0770, b23=0.0480
- M2: DRG medical, RW 0.7000-100 -> b12=0.1212, b23=0.0743
- P1: DRG procedure, RW 0.0000-1.9999 -> b12=0.0904, b23=0.0584
- P2: DRG procedure, RW 2.0000-100 -> b12=0.1580, b23=0.1268

สูตร:
- ถ้า `LOS <= 2*OT`  
  `AdjRW = RW + OF*b12*(LOS - OT)`
- ถ้า `2*OT < LOS <= 3*OT`  
  `AdjRW = RW + OF*b12*OT + OF*b23*(LOS - 2*OT)`
- ถ้า `LOS > 3*OT`  
  `AdjRW = RW + OF*OT*(b12 + b23)`

### 8.3 กรณีปกติ

ถ้าไม่เข้า low/high rule -> `AdjRW = RW`

**ตารางที่ใช้ในขั้นตอนนี้**
- `adjrw_coefficients` (ชุด M1/M2/P1/P2 สำหรับ b12,b23)
- `drg_weights` (RW/WtLOS/OT/RW0d/OF)

---

## 9) ผลลัพธ์ที่ต้องคืนจาก grouper

- `MDC`, `DC`, `DRG`
- `DRG Description`
- `PCL`
- `RW`, `AdjRW`
- `WtLOS`, `OT`, `RW0d`
- `error_code`, `warning_code_sum`, `warnings[]`

สำหรับงานตรวจสอบ:
- เทียบกับชุดข้อมูลอ้างอิงที่องค์กรใช้งาน
- เก็บผลเปรียบเทียบแยกจาก flow บริการหลัก เพื่อป้องกัน data leakage

**ชุดข้อมูลที่ใช้ในขั้นตอนนี้**
- `grouper_cases` (input ที่รับเข้า)
- `grouper_results` (ผลคำนวณ DRG/AdjRW)
- `drg69_compare` (ตัวอย่างตารางผลเทียบ expected vs actual)

---

## 10) Pseudocode ภาพรวม

```text
validate_and_normalize(case)
if fatal_error: return ungroupable_drg

apply_dagger_asterisk_substitution(case)

mdc = resolve_mdc_in_order(case, [PreMDC, 24, 25, 15, 01..23])
dc  = resolve_dc_with_mdc_rules(case, mdc)

dcl_list = lookup_dcl(case.pdx + case.sdx, dc)
dcl_list = recursive_exclusion(dcl_list, f2_rules)
pcl = calc_pcl(dcl_list)

drg = map_dc_pcl_to_drg(dc, pcl)
rw, wtlos, ot, rw0d, of = lookup_drg_weight(drg)
los = calc_los(case)
adjrw = calc_adjrw(los, rw, wtlos, ot, rw0d, of, drg_type(drg))

return result(mdc, dc, drg, pcl, rw, adjrw, wtlos, ot, rw0d, errors, warnings)
```
