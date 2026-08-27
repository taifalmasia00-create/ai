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

// بيحول نص base64 لـ bytes خام عشان نرجعه زي ما هو كملف
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
      .select('status, original_file_b64, original_filename')
      .eq('id', jobId)
      .maybeSingle();

    if (error) throw error;
    if (!job || job.status !== 'done') {
      return jsonResponse({ error: 'الملف لسه مش جاهز أو انتهت صلاحيته' }, 400);
    }
    if (!job.original_file_b64) {
      return jsonResponse({ error: 'الملف غير موجود' }, 404);
    }

    // ده بالظبط نفس الملف اللي رفعه المستخدم، بعد ما اتعدّلت فيه خلايا
    // أعمدة الهدف بس — مش ملف جديد اتبنى من الصفر، فبنية الملف الأصلية
    // (باقي الشيتات، التنسيق، الدمج، المعادلات...) فضلت زي ما هي.
    const bytes = base64ToBytes(job.original_file_b64);

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
