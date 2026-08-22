// Supabase Edge Function: ai-proxy
// 作用：在服务器端转发 AI 请求，规避浏览器跨域(CORS)限制。
// 部署：Supabase 后台 → Edge Functions → New Function → 名称填 ai-proxy → 粘贴本文件 → Deploy
// 说明：本函数不存储任何密钥，密钥由前端随每次请求传入；函数返回自带 CORS 头，浏览器可跨域调用。
// 前端调用：POST https://<PROJECT_REF>.supabase.co/functions/v1/ai-proxy
//   请求头：apikey: <anon>, Authorization: Bearer <anon>, Content-Type: application/json
//   请求体：{ "endpoint": "https://.../chat/completions", "apiKey": "sk-xxx", "model": "glm-5.1", "messages": [...] }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const body = await req.json();
    const endpoint: string = body.endpoint || "";
    const apiKey: string = body.apiKey || "";
    const model: string = body.model || "glm-5.1";
    const messages = body.messages || [];

    if (!endpoint || !apiKey) {
      return new Response(
        JSON.stringify({ error: "缺少 endpoint 或 apiKey" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const upstream = endpoint.endsWith("/chat/completions")
      ? endpoint
      : endpoint.replace(/\/+$/, "") + "/chat/completions";

    const upstreamResp = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({ model, messages }),
    });

    const data = await upstreamResp.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
