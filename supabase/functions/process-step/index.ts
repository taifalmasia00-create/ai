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

const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash-lite';
const MIN_DELAY_MS = parseInt(Deno.env.get('MIN_DELAY_MS') || '4200', 10);
const MAX_API_KEY_LENGTH = 200;

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('لم يرجع الـ AI أي نص');
  return text.trim();
}

async function callGeminiWithRetry(prompt: string, apiKey: string, maxRetries = 2): Promise<string> {
  let delay = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callGemini(prompt, apiKey);
    } catch (err) {
      const isRateLimit = String(err?.message || err).includes('429');
      if (attempt === maxRetries || !isRateLimit) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw new Error('فشلت كل المحاولات');
}

function isRateLimitError(err: unknown) {
  return String((err as any)?.message || err).includes('429');
}

function statusResponse(job: any, extra: Record<string, unknown> = {}) {
  const etaSeconds =
    job.status === 'processing' ? Math.max(0, job.total - job.processed) * (MIN_DELAY_MS / 1000) : 0;
  return jsonResponse({
    status: job.status,
    total: job.total,
    processed: job.processed,
    error: job.error,
    etaSeconds,
    pollAfterMs: MIN_DELAY_MS,
    usingCustomKey: !!job.api_key_override,
    ...extra,
  });
}

// بيدور على عمود بالاسم ده في صف العناوين، وبيرجع رقم العمود (index) لو لقاه
function findColIndex(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  headerRow: number,
  name: string,
): number {
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRow, c });
    const cell = sheet[addr];
    const v = cell && cell.v !== undefined && cell.v !== null ? String(cell.v).trim() : '';
    if (v === name) return c;
  }
  return -1;
}

// بيرجع رقم عمود الهدف؛ لو مش موجود أصلاً في الملف بيضيفه كعمود جديد في
// آخر الشيت (وبيوسّع range الشيت عشان يشمله)
function ensureColIndex(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  headerRow: number,
  name: string,
): number {
  const existing = findColIndex(sheet, range, headerRow, name);
  if (existing !== -1) return existing;

  const newCol = range.e.c + 1;
  const headerAddr = XLSX.utils.encode_cell({ r: headerRow, c: newCol });
  sheet[headerAddr] = { t: 's', v: name };
  range.e.c = newCol;
  sheet['!ref'] = XLSX.utils.encode_range(range);
  return newCol;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (!(await checkAuth(req))) {
    return jsonResponse({ error: 'لازم تسجل دخول الأول' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { jobId, apiKey } = body || {};
    if (!jobId || typeof jobId !== 'string') {
      return jsonResponse({ error: 'jobId مفقود أو غير صحيح' }, 400);
    }

    const supabase = getAdminClient();
    const { data: job, error: fetchErr } = await supabase
      .from('jobs')
      .select(
        'id, status, total, processed, error, last_processed_at, source_columns, targets, api_key_override, original_file_b64',
      )
      .eq('id', jobId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!job) return jsonResponse({ error: 'الوظيفة غير موجودة' }, 404);

    // لو المستخدم بعت مفتاح Gemini جديد (مثلاً بعد ما مفتاح السيرفر خلّص
    // سماحيته)، نحفظه على الوظيفة عشان يُستخدم من الخطوة دي وكل الخطوات
    // الجاية بدل ما نضطر نوقف المعالجة أو نعيد رفع الملف.
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const trimmedKey = apiKey.trim().slice(0, MAX_API_KEY_LENGTH);
      const { error: keyErr } = await supabase
        .from('jobs')
        .update({ api_key_override: trimmedKey })
        .eq('id', jobId);
      if (keyErr) throw keyErr;
      job.api_key_override = trimmedKey;
    }

    // خلصت أو فشلت بالفعل - رجّع الحالة الحالية من غير أي شغل
    if (job.status === 'done' || job.status === 'error') {
      return statusResponse(job);
    }

    if (job.status !== 'processing') {
      return jsonResponse({ error: 'لازم تبدأ المعالجة الأول' }, 400);
    }

    // شبكة أمان: احترام المهلة بين كل طلب وطلب حتى لو الكلاينت داس بسرعة أو فتح أكتر من تاب
    if (job.last_processed_at) {
      const elapsed = Date.now() - new Date(job.last_processed_at).getTime();
      if (elapsed < MIN_DELAY_MS) {
        return statusResponse(job);
      }
    }

    const sourceColumns: string[] = job.source_columns || [];
    const targets: { column: string; instruction: string }[] = job.targets || [];
    if (sourceColumns.length === 0 || targets.length === 0) {
      return jsonResponse({ error: 'إعدادات المعالجة ناقصة، ابدأ التشغيل تاني' }, 400);
    }
    if (!job.original_file_b64) {
      return jsonResponse({ error: 'الملف الأصلي مفقود، ابدأ التشغيل تاني' }, 400);
    }

    const effectiveApiKey: string = job.api_key_override || Deno.env.get('GEMINI_API_KEY') || '';
    if (!effectiveApiKey) {
      return jsonResponse({ error: 'مفيش مفتاح Gemini API متاح، ضيف واحد وحاول تاني' }, 500);
    }

    const i = job.processed;

    if (i >= job.total) {
      const { error: doneErr } = await supabase.from('jobs').update({ status: 'done' }).eq('id', jobId);
      if (doneErr) throw doneErr;
      job.status = 'done';
      return statusResponse(job);
    }

    // بنفتح نفس الملف الأصلي (مش نبني ملف جديد) عشان نعدّل خلية واحدة فيه
    const workbook = XLSX.read(job.original_file_b64, { type: 'base64' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const headerRow = range.s.r;

    const targetsCount = targets.length;
    const rowIndex = Math.floor(i / targetsCount); // 0-based بين صفوف البيانات (من غير صف العناوين)
    const target = targets[i % targetsCount];
    const sheetRow = headerRow + 1 + rowIndex;

    const sourceText = sourceColumns
      .map((c) => {
        const colIdx = findColIndex(sheet, range, headerRow, c);
        if (colIdx === -1) return `${c}: `;
        const addr = XLSX.utils.encode_cell({ r: sheetRow, c: colIdx });
        const cell = sheet[addr];
        const v = cell && cell.v !== undefined && cell.v !== null ? cell.v : '';
        return `${c}: ${v}`;
      })
      .join('\n');

    const prompt = `أنت خبير سيو (SEO) ومحتوى تسويقي.
التعليمات: ${target.instruction}

بيانات المنتج الأصلية:
${sourceText}

اكتب فقط النتيجة النهائية المطلوبة بدون أي شرح أو مقدمات أو علامات اقتباس.`;

    let quotaPaused = false;
    let resultValue: string | null = null;
    try {
      resultValue = await callGeminiWithRetry(prompt, effectiveApiKey);
    } catch (err) {
      if (isRateLimitError(err)) {
        quotaPaused = true;
      } else {
        resultValue = '⚠️ فشل المعالجة: ' + String((err as any)?.message || err);
      }
    }

    // لو وقفنا بسبب حد الاستخدام: منزودش processed ومنلمسش الملف خالص، بس
    // نحدّث وقت آخر محاولة عشان نحترم المهلة، ونرجّع للفرونت إند إشارة
    // واضحة إنه محتاج يستنى ويدوس استكمل، أو يحط مفتاح Gemini API تاني.
    if (quotaPaused) {
      const { error: pauseErr } = await supabase
        .from('jobs')
        .update({ last_processed_at: new Date().toISOString() })
        .eq('id', jobId);
      if (pauseErr) throw pauseErr;

      return statusResponse(job, {
        paused: true,
        message: job.api_key_override
          ? 'المفتاح الحالي وصل لحد الطلبات المجانية المسموح بيها من Gemini. استنى شوية ودوس استكمل، أو حط مفتاح Gemini API تاني عشان تكمل فوراً.'
          : 'وصلت لحد الطلبات المجانية المسموح بيها من Gemini دلوقتي. استنى شوية ودوس استكمل، أو حط مفتاح Gemini API تاني عشان تكمل فوراً من غير ما تستنى.',
      });
    }

    // بنكتب النتيجة في خلية عمود الهدف نفسه جوه نفس الملف الأصلي (بنضيف
    // العمود ده لو مش موجود أصلاً)، بدل ما نجمّع البيانات في مكان منفصل
    // ونبني ملف جديد بيها آخر الشغل.
    const targetColIdx = ensureColIndex(sheet, range, headerRow, target.column);
    const cellAddr = XLSX.utils.encode_cell({ r: sheetRow, c: targetColIdx });
    sheet[cellAddr] = { t: 's', v: resultValue ?? '' };

    const updatedFileB64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });

    const processed = i + 1;
    const newStatus = processed >= job.total ? 'done' : 'processing';

    const { error: updateErr } = await supabase
      .from('jobs')
      .update({
        original_file_b64: updatedFileB64,
        processed,
        status: newStatus,
        last_processed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (updateErr) throw updateErr;

    job.processed = processed;
    job.status = newStatus;
    return statusResponse(job);
  } catch (e) {
    return jsonResponse({ error: 'خطأ أثناء المعالجة: ' + String(e?.message || e) }, 500);
  }
});
