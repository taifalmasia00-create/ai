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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (!(await checkAuth(req))) {
    return jsonResponse({ error: 'لازم تسجل دخول الأول' }, 401);
  }

  try {
    // الحد بالميجابايت لحجم ملف الإكسيل الأصلي (قبل ما يتحول base64).
    // تقدر تتحكم فيه من Secret اسمه MAX_FILE_SIZE_MB لو عايز رقم مختلف.
    const MAX_FILE_SIZE_MB = parseInt(Deno.env.get('MAX_FILE_SIZE_MB') || '8', 10);

    const body = await req.json().catch(() => ({}));
    const fileBase64: unknown = body?.fileBase64;
    const fileName: string = typeof body?.fileName === 'string' ? body.fileName : 'ملف.xlsx';

    if (typeof fileBase64 !== 'string' || !fileBase64) {
      return jsonResponse({ error: 'لم يتم إرسال ملف صحيح' }, 400);
    }

    const approxBytes = Math.floor((fileBase64.length * 3) / 4);
    if (approxBytes > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return jsonResponse(
        { error: `حجم الملف أكبر من الحد المسموح (${MAX_FILE_SIZE_MB} ميجا)` },
        400,
      );
    }

    // بنفتح نفس الملف اللي هيتخزن بالظبط عشان نستخرج منه أسماء الأعمدة
    // وعدد الصفوف — كده الأعمدة اللي هتظهر للمستخدم مضمون إنها نفس أعمدة
    // الملف الحقيقي اللي هنعدل عليه بعدين (مش نسخة منفصلة اتبنت من JSON).
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBase64, { type: 'base64' });
    } catch (parseErr) {
      return jsonResponse({ error: 'تعذر قراءة ملف الإكسيل، تأكد إنه ملف .xlsx أو .xls سليم' }, 400);
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : null;
    if (!sheet || !sheet['!ref']) {
      return jsonResponse({ error: 'الملف فارغ أو مفيش شيت فيه بيانات' }, 400);
    }

    const range = XLSX.utils.decode_range(sheet['!ref']);
    const headerRow = range.s.r;

    const headers: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: headerRow, c });
      const cell = sheet[addr];
      const v = cell && cell.v !== undefined && cell.v !== null ? String(cell.v).trim() : '';
      headers.push(v || `عمود ${c - range.s.c + 1}`);
    }

    const rowCount = range.e.r - headerRow;
    if (rowCount <= 0) {
      return jsonResponse({ error: 'الملف فيه صف عناوين بس من غير بيانات' }, 400);
    }

    // معاينة أول ٥ صفوف بس عشان تتعرض للمستخدم، مش بتتخزن في قاعدة البيانات
    const preview: Record<string, unknown>[] = [];
    for (let r = headerRow + 1; r <= Math.min(headerRow + 5, range.e.r); r++) {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, idx) => {
        const addr = XLSX.utils.encode_cell({ r, c: range.s.c + idx });
        const cell = sheet[addr];
        obj[h] = cell && cell.v !== undefined ? cell.v : '';
      });
      preview.push(obj);
    }

    const supabase = getAdminClient();
    const { data: created, error: createErr } = await supabase
      .from('jobs')
      .insert({
        status: 'uploaded',
        headers,
        rows: [],
        total: 0,
        processed: 0,
        sheet_name: sheetName,
        row_count: rowCount,
        original_file_b64: fileBase64,
        original_filename: fileName,
      })
      .select('id')
      .single();

    if (createErr) throw createErr;

    return jsonResponse({
      jobId: created.id,
      headers,
      rowCount,
      preview,
    });
  } catch (e) {
    return jsonResponse({ error: 'فشل رفع الملف: ' + String(e?.message || e) }, 500);
  }
});
