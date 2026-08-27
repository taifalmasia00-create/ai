-- تعديل جدول jobs عشان يدعم:
-- 1) أكتر من عمود مصدر وأكتر من عمود هدف (بدل عمود واحد بس)
-- 2) توقف حقيقي عند حد استخدام Gemini بدل ما يكمل غلط

alter table jobs add column if not exists source_columns jsonb;
alter table jobs add column if not exists targets jsonb;

-- الأعمدة القديمة بقت مش مستخدمة، تقدر تمسحها بأمان
alter table jobs drop column if exists source_column;
alter table jobs drop column if exists target_column;
alter table jobs drop column if exists instruction;

-- تأكيد إن total ليها قيمة افتراضية سليمة
alter table jobs alter column total set default 0;
