# Changelog

## 1.0.0-beta (subVersion: 2026-03-09-1)

**Description (from package.json):**  
ระบบค้นหากลุ่มวินิจฉัยโรคร่วม (DRG Finding) รองรับ DRG v.6.3.5

### Added
- DRG Seeker UI สำหรับกรอกข้อมูลเคสและวิเคราะห์ DRG ผ่านหน้าเว็บ
- API `POST /code-lookup` สำหรับแสดงชื่อ PDx/SDx จาก `lib_dx` และ Proc จาก `lib_proc`
- เอกสาร `README.md`, `LICENSE`, และปรับ `algorithm.md` สำหรับ public GitHub

### Changed
- ปรับ validation ของ Proc ให้ตรวจจาก `lib_proc`
- เพิ่มรองรับ Proc with extension (`proc+ext` เช่น `9604+11`) โดยตรวจร่วมกับ `lib_proc_dc`
- ปรับ UI ให้แสดงชื่อ code แบบ on-change และล้างผลลัพธ์เดิมก่อน Analyze

### Notes
- รูปแบบเวอร์ชันอ้างอิงตาม `package.json` (`version` + `subVersion`)
