-- بيحل مشكلة 546 اللي بتحصل مع الملفات الكبيرة (~1000 صف فأكتر): تخزين
-- source_data و results كـ JSONB واحد كبير في صف الوظيفة كان بيتطلب من
-- Postgres إنه "يفكّ" (detoast) الـ blob كامل في كل نداء process-step، حتى
-- لو المطلوب عنصر واحد بس. التكلفة كانت بتكبر مع حجم الملف *وعدد النداءات*
-- مع بعض، فبتبقى تقريباً تربيعية (O(n²)) مع عدد الصفوف.
--
-- الحل: جدول صف واحد لكل عنصر، بحث بالفهرس (index) بدل فكّ بلوب كامل.

create table if not exists job_source_rows (
  job_id uuid not null references jobs(id) on delete cascade,
  row_index int not null,
  source_text text not null,
  primary key (job_id, row_index)
);
alter table job_source_rows enable row level security;

create table if not exists job_results (
  job_id uuid not null references jobs(id) on delete cascade,
  row_index int not null,
  column_name text not null,
  value text not null default '',
  primary key (job_id, row_index, column_name)
);
alter table job_results enable row level security;

-- بيملأ job_source_rows دفعة واحدة من مصفوفة نصوص (بيتنادى مرة واحدة بس
-- من start-process). بيمسح أي صفوف قديمة لنفس الوظيفة الأول (لو الوظيفة
-- دي بتتشغّل تاني).
create or replace function set_job_source_rows(p_job_id uuid, p_rows jsonb)
returns void
language sql
as $$
  delete from job_source_rows where job_id = p_job_id;
  insert into job_source_rows (job_id, row_index, source_text)
  select p_job_id, ord - 1, val
  from jsonb_array_elements_text(p_rows) with ordinality as t(val, ord);
$$;

-- نفس اسم وشكل الدالة القديمة (0007) عشان process-step ميحتاجش أي تعديل
-- في نداء get_job_source_text — بس دلوقتي بحث مفهرس بدل فكّ بلوب كامل.
create or replace function get_job_source_text(p_job_id uuid, p_row_index int)
returns text
language sql
stable
as $$
  select source_text from job_source_rows where job_id = p_job_id and row_index = p_row_index;
$$;

-- بديل set_job_result القديمة: upsert لصف واحد بدل jsonb_set على بلوب كبير
create or replace function set_job_result(p_job_id uuid, p_row_index int, p_column_name text, p_value text)
returns void
language sql
as $$
  insert into job_results (job_id, row_index, column_name, value)
  values (p_job_id, p_row_index, p_column_name, p_value)
  on conflict (job_id, row_index, column_name) do update set value = excluded.value;
$$;

-- بترجع كل نتايج الوظيفة كـ JSONB بنفس الشكل القديم ("rowIndex:columnName" -> value)
-- عشان applyResultsToWorkbook في download متحتاجش أي تعديل.
create or replace function get_job_results(p_job_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(row_index || ':' || column_name, value), '{}'::jsonb)
  from job_results where job_id = p_job_id;
$$;

-- ملحوظة: عمودي source_data و results في جدول jobs (من 0006) مبقوش
-- بيتكتب فيهم بيانات تاني بعد التعديل ده — سيبناهم زي ما هما، مش هيأثروا
-- على حاجة، ومفيش داعي نمسحهم.
