-- بيغيّر طريقة شغل المعالجة عشان يبقى كل "خطوة" خفيفة جداً بدل ما تعيد فك
-- وبناء ملف الإكسيل كامل. ده اللي كان بيسبب "انقطاعات اتصال" متكررة حتى
-- مع نت سليم: كل process-step كان بيفتح الملف الأصلي كامل، يعدّل خلية،
-- ويحفظ الملف كامل تاني في قاعدة البيانات — عملية تقيلة بتتكرر مئات
-- المرات في الشغلانة الواحدة.
--
-- الطريقة الجديدة:
--   1) start-process بيفتح الملف مرة واحدة بس، وبيسحب منه بيانات الأعمدة
--      المصدر لكل صف، ويخزنها في source_data (حجمها صغير جداً مقارنة
--      بالملف الكامل، مجرد نصوص).
--   2) كل process-step بيقرا من source_data (مش من الملف نفسه)، وبيضيف
--      نتيجة واحدة صغيرة في results بدل ما يلمس الملف خالص.
--   3) download هو الوحيد اللي بيفتح الملف الأصلي — مرة واحدة بس، لما
--      المعالجة كلها تخلص — يطبّق كل النتائج المتجمعة دفعة واحدة، ويرجّع
--      الملف النهائي.

alter table jobs add column if not exists source_data jsonb;
alter table jobs add column if not exists results jsonb not null default '{}'::jsonb;

-- تحديث ذري لنتيجة واحدة جوه results (rowIndex:columnName -> value) من
-- غير ما نحتاج نقرا كل الـ JSON ونعيد كتابته من الكلاينت
create or replace function set_job_result(p_job_id uuid, p_key text, p_value text)
returns void
language sql
as $$
  update jobs
  set results = jsonb_set(coalesce(results, '{}'::jsonb), array[p_key], to_jsonb(p_value), true)
  where id = p_job_id;
$$;

-- ملحوظة: عمود original_file_b64 مبقاش بيتكتب فيه تاني بعد أول مرة (وقت
-- الرفع) — بيتقرا مرة واحدة بس وقت "تحميل الملف النهائي". فمفيش داعي نمسحه
-- أو نغيّره، بس الاستخدام بتاعه اتغيّر.
