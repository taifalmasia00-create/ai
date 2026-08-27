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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const APP_PASSWORD = Deno.env.get('APP_PASSWORD') || '';

    // لو مفيش كلمة سر متظبطة، الموقع مفتوح لأي حد
    if (!APP_PASSWORD) {
      return jsonResponse({ ok: true, token: null });
    }

    const body = await req.json().catch(() => ({}));
    const password = body?.password;

    if (password !== APP_PASSWORD) {
      return jsonResponse({ error: 'كلمة السر غلط' }, 401);
    }

    const token = crypto.randomUUID();
    const expires_at = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // ١٢ ساعة

    const supabase = getAdminClient();
    const { error } = await supabase.from('sessions').insert({ token, expires_at });
    if (error) throw error;

    return jsonResponse({ ok: true, token });
  } catch (e) {
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
});
