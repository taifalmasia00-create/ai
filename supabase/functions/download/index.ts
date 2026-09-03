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

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeFileName(name: string | null | undefined): string {
  const base = (name || 'result').replace(/\.[^./\\]+$/, '');
  const cleaned = base.replace(/["\\]/g, '').trim() || 'result';
  return `${cleaned}.xlsx`;
}

function applyResultsToWorkbook(
  fileBase64: string,
  sheetNameHint: string | null,
  headers: string[],
  results: Record<string, string>,
): string {
  const workbook = XLSX.read(fileBase64, { type: 'base64' });
  const sheetName = sheetNameHint && workbook.Sheets[sheetNameHint] ? sheetNameHint : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) throw new Error('الشيت غير موجود في الملف');

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headerRow = range.s.r;

  const colIndexByHeader = new Map<string, number>();
  headers.forEach((h, idx) => colIndexByHeader.set(h, range.s.c + idx));

  let maxCol = range.e.c;
  let maxRow = range.e.r;

  for (const [key, value] of Object.entries(results)) {
    const sepIdx = key.indexOf(':');
    if (sepIdx === -1) continue;
    const rowIndex = parseInt(key.slice(0, sepIdx), 10);
    const columnName = key.slice(sepIdx + 1);
    if (Number.isNaN(rowIndex) || !columnName) continue;

    let colIdx = colIndexByHeader.get(columnName);
    if (colIdx === undefined) {
      maxCol += 1;
      colIdx = maxCol;
      colIndexByHeader.set(columnName, colIdx);
      const headerAddr = XLSX.utils.encode_cell({ r: headerRow, c: colIdx });
      sheet[headerAddr] = { t: 's', v: columnName };
    }

    const r = headerRow + 1 + rowIndex;
    const addr = XLSX.utils.encode_cell({ r, c: colIdx });
    sheet[addr] = { t: 's', v: value };

    if (r > maxRow) maxRow = r;
  }

  if (maxCol > range.e.c || maxRow > range.e.r) {
    range.e.c = maxCol;
    range.e.r = maxRow;
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }

  return XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (!(await checkAuth(req))) {
    return jsonResponse({ error: 'لازم تسجل دخول الأول' }, 401);
  }

  try {
    const url = new URL(req.url);
    const jobId = url.searchParams.get('jobId');
    if (!jobId) return jsonResponse({ error: 'jobId مفقود' }, 400);

    const supabase = getAdminClient();
    const { data: job, error } = await supabase
      .from('jobs')
      .select('status, original_file_b64, original_filename, sheet_name, headers')
      .eq('id', jobId)
      .maybeSingle();

    if (error) throw error;
    if (!job || job.status !== 'done') {
      return jsonResponse({ error: 'الملف لسه مش جاهز أو انتهت صلاحيته' }, 400);
    }
    if (!job.original_file_b64) {
      return jsonResponse({ error: 'الملف غير موجود' }, 404);
    }

    // بنجيب كل النتايج من job_results (جدول منفصل) كـ JSONB مجمّع، بدل
    // عمود results القديم في صف الوظيفة.
    const { data: results, error: resultsErr } = await supabase.rpc('get_job_results', {
      p_job_id: jobId,
    });
    if (resultsErr) throw resultsErr;

    const resultBase64 = applyResultsToWorkbook(
      job.original_file_b64,
      job.sheet_name || null,
      job.headers || [],
      (results as Record<string, string>) || {},
    );
    const bytes = base64ToBytes(resultBase64);

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${safeFileName(job.original_filename)}"`,
      },
    });
  } catch (e) {
    return jsonResponse({ error: 'فشل تجهيز الملف: ' + String(e?.message || e) }, 500);
  }
});
