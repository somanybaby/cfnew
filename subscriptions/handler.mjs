import { LABELS_KEY, boundedText, renameBase64, renameClash, renameLoon, selectFormat,
  validateMeasurements } from './rename.mjs';

// Keep the upstream proxy core byte-for-byte unchanged. Only these exact routes
// are intercepted, and WebSocket/XHTTP traffic always reaches the original core.
export function withSubscriptions(coreHandler, fetchUpstream = fetch) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.headers.get('upgrade')) return coreHandler.fetch(request, env, ctx);
      const match = url.pathname.match(/^\/([0-9a-f-]{36})\/(sub|api\/exit-labels)$/i);
      const queryRoute = url.pathname === '/sub' && url.searchParams.has('uuid');
      if (!match && !queryRoute) return coreHandler.fetch(request, env, ctx);
      const userId = match?.[1] || url.searchParams.get('uuid');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId))
        return new Response('Not Found', { status: 404 });
      const authUrl = new URL('/' + userId.toLowerCase() + '/api/config', url);
      const auth = await coreHandler.fetch(new Request(authUrl), env, ctx);
      if (!auth.ok) return new Response('Not Found', { status: 404 });
      const config = JSON.parse(await boundedText(auth, 1048576));
      if (config.uuid?.toLowerCase() !== userId.toLowerCase()) return new Response('Not Found', { status: 404 });
      const kv = env.C || env.c;
      const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff' };
      try {
        if (match?.[2] === 'api/exit-labels') {
          if (!kv) return Response.json({ error: 'KV required' }, { status: 503, headers });
          if (request.method === 'GET') {
            const labels = await kv.get(LABELS_KEY, 'json');
            return Response.json(labels || { version: 1, nodes: {} }, { headers });
          }
          if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
          if (!request.headers.get('content-type')?.startsWith('application/json'))
            return new Response('JSON required', { status: 415, headers });
          let labels;
          try { labels = validateMeasurements(JSON.parse(await boundedText(new Response(request.body), 262144))); }
          catch { return new Response('Invalid measurements', { status: 400, headers }); }
          await kv.put(LABELS_KEY, JSON.stringify(labels));
          return Response.json({ success: true, measuredNodes: Object.keys(labels.nodes).length }, { headers });
        }
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers });
        const format = selectFormat(request);
        if (!format) return new Response('Supported targets: base64, clash, loon', { status: 400, headers });
        // The same public panel used before; clients cannot choose an upstream URL.
        const upstream = new URL('https://cfnew.xy.kg/sub');
        upstream.searchParams.set('host', url.hostname);
        upstream.searchParams.set('uuid', config.uuid);
        upstream.searchParams.set('target', format);
        const response = await fetchUpstream(upstream, { redirect: 'error', signal: AbortSignal.timeout(25000) });
        if (!response.ok) return new Response('Subscription source unavailable; retain your previous subscription.',
          { status: 502, headers });
        const text = await boundedText(response, 2097152);
        const labels = kv ? await kv.get(LABELS_KEY, 'json') : null;
        const rename = { base64: renameBase64, clash: renameClash, loon: renameLoon }[format];
        const result = rename(text, url.hostname, labels);
        return new Response(request.method === 'HEAD' ? null : result, { headers: { ...headers,
          'Content-Type': format === 'clash' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8',
          'Profile-Update-Interval': '6', 'X-Exit-Labels-Measured-At': labels?.measuredAt || 'unmeasured' } });
      } catch {
        // Do not expose credentials, upstream URLs, or internal exception text.
        return new Response('Subscription processing failed; retain your previous subscription.', { status: 502, headers });
      }
    },
  };
}
