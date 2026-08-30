-- بيحل مشكلة إضافية: process-step كان (بعد تحديث 0006) بيسحب مصفوفة
-- source_data كاملة (نص كل صفوف الملف) من قاعدة البيانات في كل خطوة،
-- مع إنه مستخدم بس عنصر واحد منها. مع ملفات كبيرة (آلاف الصفوف)، ده حجم
-- بيانات بيتنقل ويتفكّ (JSON parse) في كل نداء من مئات النداءات المتكررة،
-- وده كان بيقدر يوصل بموارد الفنكشن (CPU/Memory) لحدها الأقصى ويطلع
-- خطأ 546.
--
-- الحل: دالة SQL بترجع نص الصف المطلوب بس، بحث مباشر بالفهرس جوه
-- Postgres، من غير ما نسحب المصفوفة كاملة للفنكشن أبداً.

create or replace function get_job_source_text(p_job_id uuid, p_row_index int)
returns text
language sql
stable
as $$
  select source_data->>p_row_index from jobs where id = p_job_id;
$$;
