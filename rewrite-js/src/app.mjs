import { Fault, json, jsonBody, encoder, same } from './common.mjs';
import { load, patch, save, normalize, preferredAPI, IMPLEMENTATION, CORE_VERSION } from './settings.mjs';
import { websocket, xhttp } from './streams.mjs';
import { subscription, labelsAPI } from './subscription.mjs';

const safeEqual = (a, b) => same(encoder.encode(a), encoder.encode(b));
function entryPath(value) {
  if (!value) return ''; return '/' + value.replace(/^\/+|\/+$/g, '');
}
export function createApp(connect, fetcher = fetch) {
  return {
    async fetch(request, env, ctx) {
      try {
        const url = new URL(request.url);
        if (url.pathname === '/' && request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('hello', { headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
        const state = await load(env);
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (request.method !== 'GET') throw new Fault('method_not_allowed', 405);
          return websocket(request, state, ctx, connect, fetcher);
        }
        let path; try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; } catch { throw new Fault('invalid_path'); }
        const entries = ['/' + state.uuid, entryPath(state.config.d)].filter(Boolean);
        let suffix = null;
        for (const entry of entries) {
          if (safeEqual(path, entry)) { suffix = ''; break; }
          if (path.startsWith(entry + '/') && safeEqual(path.slice(0, entry.length), entry)) { suffix = path.slice(entry.length); break; }
        }
        const xpaths = [...entries, '/' + state.uuid.slice(0, 8), entryPath(state.config.tp)];
        if (request.method === 'POST' && state.config.ex === 'yes' && xpaths.some(p => p && safeEqual(path, p))) return await xhttp(request, state, ctx, connect, fetcher);
        const querySub = path === '/sub' && safeEqual(url.searchParams.get('uuid') || '', state.uuid);
        if (querySub || suffix === '/sub') {
          if (request.method !== 'GET') throw new Fault('method_not_allowed', 405);
          return await subscription(request, state, fetcher);
        }
        if (suffix === null) throw new Fault('not_found', 404);
        if (suffix === '/api/config') {
          if (request.method === 'POST') {
            const next = patch(state.saved, await jsonBody(request)); await save(state, next);
            return json({ success: true, ...normalize(env, next), kvEnabled: !!state.kv, implementation: IMPLEMENTATION });
          }
          if (request.method !== 'GET') throw new Fault('method_not_allowed', 405);
          return json({ ...state.config, uuid: state.uuid, kvEnabled: !!state.kv, coreVersion: CORE_VERSION, implementation: IMPLEMENTATION });
        }
        if (suffix === '/api/preferred-ips') return await preferredAPI(request, state);
        if (suffix === '/api/exit-labels') return await labelsAPI(request, state);
        if (request.method !== 'GET') throw new Fault('method_not_allowed', 405);
        if (suffix === '/region') return json({ region: 'dynamic', actualExit: null, configuredRegion: state.config.wk, fallback: state.config.p || null });
        if (suffix === '/test-api') return json({ success: true, implementation: IMPLEMENTATION });
        if (suffix === '') return json({ implementation: IMPLEMENTATION, kvEnabled: !!state.kv, subscription: 'Append /sub?target=clash, loon or base64', exitLabels: 'Measured records are required; /region does not detect egress.' });
        throw new Fault('not_found', 404);
      } catch (error) {
        // Never log URLs, identities, proxy credentials, subscription bodies or exception text.
        if (!(error instanceof Fault)) console.error(JSON.stringify({ event: 'request_failed', code: 'internal_error' }));
        return json({ success: false, error: error instanceof Fault ? error.code : 'internal_error' }, error instanceof Fault ? error.status : 500);
      }
    }
  };
}
