-- فنكشن مساعدة بتضيف "دفعة" من الصفوف على وظيفة موجودة، بدل ما نضطر نبعت
-- كل الصفوف (ممكن تكون آلاف) في استعلام إدراج واحد ضخم بياخد وقت طويل
-- وممكن يوصل لحد "statement timeout".

create or replace function append_job_rows(p_job_id uuid, p_chunk jsonb)
returns void
language sql
as $$
  update jobs
  set rows = coalesce(rows, '[]'::jsonb) || p_chunk
  where id = p_job_id;
$$;
