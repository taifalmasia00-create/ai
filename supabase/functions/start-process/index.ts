const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-app-token',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

function getAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

async function checkAuth(req: Request): Promise<boolean> {
  const APP_PASSWORD = Deno.env.get('APP_PASSWORD') || '';
  if (!APP_PASSWORD) return true;

  const token = req.headers.get('x-app-token');
  if (!token) return false;

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('sessions')
    .select('token, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error || !data) return false;
  if (new Date(data.expires_at).getTime() < Date.now()) return false;
  return true;
}

const MAX_INSTRUCTION_LENGTH = 20000; // نفس الحد الموجود في الواجهة (maxlength)
const MAX_TARGETS = 6;

// بتفتح نفس الملف الأصلي **مرة واحدة بس** هنا، وتستخرج نص الأعمدة المصدر
// لكل صف وتحطه في مصفوفة نصوص بسيطة (سطر واحد لكل صف). ده اللي بيسمح لـ
// process-step إنه يبقى "خفيف" ويقرا نص الصف من قاعدة البيانات بدل ما يفتح
// ملف الإكسيل بتاعي كل مرة.
//
// ملحوظة مهمة: الدالة دي كانت ناقصة قبل كده — كان في استدعاء لدالة
// get_job_source_text في process-step من غير ما حد يملأ source_data
// أصلاً، فكانت كل خطوة بترجع "إعدادات المعالجة ناقصة" ومفيش أي معالجة
// بتحصل فعلياً.
function buildSourceData(fileBase64: string, headers: string[], sourceColumns: string[]): string[] {
  const workbook = XLSX.read(fileBase64, { type: 'base64' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) throw new Error('الملف فارغ أو مفيش شيت فيه بيانات');

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headerRow = range.s.r;

  // خريطة اسم العمود -> رقم العمود، بنفس ترتيب headers اللي اتحسبت وقت الرفع
  const colIndexByHeader = new Map<string, number>();
  headers.forEach((h, idx) => colIndexByHeader.set(h, range.s.c + idx));

  const rows: string[] = [];
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const parts: string[] = [];
    for (const col of sourceColumns) {
      const c = colIndexByHeader.get(col);
      if (c === undefined) continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      const v = cell && cell.v !== undefined && cell.v !== null ? String(cell.v) : '';
      parts.push(`${col}: ${v}`);
    }
    rows.push(parts.join('\n'));
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (!(await checkAuth(req))) {
    return jsonResponse({ error: 'لازم تسجل دخول الأول' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { jobId, sourceColumns, targets } = body || {};

    if (!jobId || typeof jobId !== 'string') {
      return jsonResponse({ error: 'jobId مفقود أو غير صحيح' }, 400);
    }

    if (
      !Array.isArray(sourceColumns) ||
      sourceColumns.length === 0 ||
      !sourceColumns.every((c: unknown) => typeof c === 'string' && c.trim())
    ) {
      return jsonResponse({ error: 'لازم تحدد عمود مصدر واحد على الأقل' }, 400);
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      return jsonResponse({ error: 'لازم تحدد عمود هدف واحد على الأقل' }, 400);
    }
    if (targets.length > MAX_TARGETS) {
      return jsonResponse({ error: `أقصى عدد أعمدة هدف مسموح بيه ${MAX_TARGETS}` }, 400);
    }

    const cleanTargets: { column: string; instruction: string }[] = [];
    for (const t of targets) {
      if (!t || typeof t.column !== 'string' || typeof t.instruction !== 'string') {
        return jsonResponse({ error: 'كل عمود هدف لازم يكون له اسم وتعليمات' }, 400);
      }
      const column = t.column.trim();
      const instruction = t.instruction.trim();
      if (!column || !instruction) {
        return jsonResponse({ error: 'كل عمود هدف لازم يكون له اسم وتعليمات' }, 400);
      }
      if (instruction.length > MAX_INSTRUCTION_LENGTH) {
        return jsonResponse(
          { error: `تعليمات عمود "${column}" طويلة جداً (أقصى حد ${MAX_INSTRUCTION_LENGTH} حرف)` },
          400,
        );
      }
      cleanTargets.push({ column, instruction });
    }

    const targetCols = cleanTargets.map((t) => t.column);
    if (new Set(targetCols).size !== targetCols.length) {
      return jsonResponse({ error: 'في عمود هدف مكرر أكتر من مرة، خليه اسم مختلف' }, 400);
    }

    const cleanSourceColumns = sourceColumns.map((c: string) => c.trim());

    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
    if (!GEMINI_API_KEY) {
      return jsonResponse({ error: 'مفتاح Gemini API غير موجود (سيرفر)' }, 500);
    }

    const supabase = getAdminClient();
    const { data: job, error: fetchErr } = await supabase
      .from('jobs')
      .select('id, status, headers, row_count, original_file_b64')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!job) {
      return jsonResponse({ error: 'الوظيفة غير موجودة أو انتهت صلاحيتها، ارفع الملف تاني' }, 404);
    }
    if (job.status === 'processing') {
      return jsonResponse({ error: 'الوظيفة دي شغالة بالفعل، استنى لحد ما تخلص' }, 409);
    }
    if (!job.original_file_b64) {
      return jsonResponse({ error: 'الملف الأصلي مش موجود مع الوظيفة دي، ارفع الملف تاني' }, 400);
    }

    const headers: string[] = job.headers || [];
    for (const c of cleanSourceColumns) {
      if (!headers.includes(c)) {
        return jsonResponse({ error: `العمود المصدر "${c}" مش موجود في الملف` }, 400);
      }
    }

    const rowCount = job.row_count || 0;
    const total = rowCount * cleanTargets.length;

    let sourceData: string[];
    try {
      sourceData = buildSourceData(job.original_file_b64, headers, cleanSourceColumns);
    } catch (e) {
      return jsonResponse({ error: 'تعذر قراءة بيانات الأعمدة المصدر من الملف: ' + String(e?.message || e) }, 500);
    }

    const { error: updateErr } = await supabase
      .from('jobs')
      .update({
        source_columns: cleanSourceColumns,
        targets: cleanTargets,
        source_data: sourceData,
        results: {},
        status: 'processing',
        processed: 0,
        total,
        error: null,
        last_processed_at: null,
        // شغلانة جديدة تبدأ دايماً بمفتاح السيرفر الافتراضي؛ أي مفتاح بديل
        // اتحط في شغلانة سابقة (لو حصل) بيتصفّر هنا.
        api_key_override: null,
      })
      .eq('id', jobId);

    if (updateErr) throw updateErr;

    return jsonResponse({ started: true, total });
  } catch (e) {
    return jsonResponse({ error: 'فشل بدء المعالجة: ' + String(e?.message || e) }, 500);
  }
});
