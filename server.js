/**
 * PowerPoint Online Pictures — WebView2 Demo Server
 *
 * Runs a local proxy that:
 *   1. Serves index.html at http://localhost:3000
 *   2. Accepts GET /proxy?url=<encoded-url>
 *      — fetches the remote page server-side (no CORS, no X-Frame-Options)
 *      — strips X-Frame-Options and Content-Security-Policy response headers
 *      — rewrites all href/src/action/url() values to route through the proxy
 *        so navigation inside the iframe keeps working
 *      — returns the result so the browser renders it inside the iframe
 *
 * Zero npm dependencies — only Node built-ins.
 *
 * Usage:
 *   node server.js
 *   open http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────
   "LAST KNOWN GOOD" BASE URL TRACKING
   Some pages (Google included) call history.replaceState to scrub query
   params from the visible address bar shortly after load. Since the
   browser's Referer header on later requests reflects that *scrubbed*
   URL, not the original /proxy?url=... we served, our usual
   Referer-based recovery can come up empty.
   As a fallback, we remember the last successfully proxied target URL
   per client (keyed by a lightweight cookie) and use it to resolve
   later bare/malformed relative requests when Referer recovery fails.
   In-memory only — resets on server restart, which is fine for a demo.
───────────────────────────────────── */
const lastGoodBase = new Map();   // sessionId -> last successfully fetched absolute URL

function getSessionId(req) {
  const cookie = req.headers['cookie'] || '';
  const match = cookie.match(/(?:^|;\s*)pptsid=([a-z0-9]+)/i);
  return match ? match[1] : null;
}

function makeSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ─────────────────────────────────────
   FETCH  (follows redirects, no deps)
───────────────────────────────────── */
function fetchRemote(targetUrl, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > 6) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) { return reject(new Error(`Invalid URL: ${targetUrl}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',       // keep it simple — no gzip
        'Cache-Control':   'no-cache',
        'Pragma':          'no-cache',
      },
    };

    const req = lib.request(options, (res) => {
      // Follow 3xx redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // discard body
        const next = new URL(res.headers.location, targetUrl).href;
        return fetchRemote(next, redirectDepth + 1).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data',  chunk => chunks.push(chunk));
      res.on('end',   ()    => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });

    req.setTimeout(14000, () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

/* ─────────────────────────────────────
   HTML REWRITER
   Routes all navigable attributes through /proxy?url=
   so clicks, form submits, and sub-resource loads
   all stay inside the iframe.
───────────────────────────────────── */
function rewriteHtml(html, baseUrl) {
  // ── Rewrite element attributes: href, src, action, data-src, poster, srcset ──
  html = html.replace(
    /(\s(?:href|src|action|data-src|poster)=)(["'])([^"']*)(["'])/gi,
    (match, attr, q1, val, q2) => {
      const v = val.trim();
      if (!v
        || v.startsWith('#')
        || v.startsWith('javascript:')
        || v.startsWith('data:')
        || v.startsWith('mailto:')
        || v.startsWith('blob:')
        || v.startsWith('/proxy?')
      ) return match;

      try {
        const abs = new URL(v, baseUrl).href;
        return `${attr}${q1}/proxy?url=${encodeURIComponent(abs)}${q2}`;
      } catch { return match; }
    }
  );

  // ── Rewrite CSS url() inside style attributes and <style> blocks ──
  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, q, val) => {
    const v = val.trim();
    if (!v || v.startsWith('data:') || v.startsWith('/proxy?')) return match;
    try {
      const abs = new URL(v, baseUrl).href;
      return `url('/proxy?url=${encodeURIComponent(abs)}')`;
    } catch { return match; }
  });

  // ── Rewrite <meta http-equiv="refresh" content="0;url=..."> ──
  html = html.replace(
    /(<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=)([^"';>]+)/gi,
    (match, prefix, refreshUrl) => {
      try {
        const abs = new URL(refreshUrl.trim(), baseUrl).href;
        return `${prefix}/proxy?url=${encodeURIComponent(abs)}`;
      } catch { return match; }
    }
  );

  // ── Strip frame-blocking and referrer-suppressing meta tags ──
  html = html
    .replace(/<meta[^>]*http-equiv=["']?x-frame-options["']?[^>]*>/gi, '')
    .replace(/<meta[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<meta[^>]*name=["']?referrer["']?[^>]*>/gi, '');

  // ── Inject a small script that intercepts JS-driven navigation ──
  // v3: v2 left history.pushState/replaceState unpatched to avoid
  // breaking Google's internal state tracking — but that meant Google's
  // OWN replaceState calls (which it uses to scrub query params from the
  // visible address bar after load) overwrite location.href with a bare,
  // queryless URL. Any later relative request resolves against THAT
  // broken base instead of the real proxied target, producing 502s on
  // a no-leading-slash request like "search?q=cat" resolving to
  // "/search?q=cat" or worse, plain "proxy?q=cat".
  //
  // Fix: track the real target URL in a dedicated variable set once at
  // render time (server-side, so it can't be touched by the page's own
  // JS), and resolve all our intercepted navigation against THAT instead
  // of the live, mutable location.href. history.pushState/replaceState
  // remain fully unpatched so Google's internal logic still works.
  const interceptScript = `
<script>
(function(){
  var _proxyBase = '/proxy?url=';
  var _realBase = ${JSON.stringify(baseUrl)};   // fixed at render time, immune to in-page replaceState

  function toProxied(v) {
    try { return _proxyBase + encodeURIComponent(new URL(v, _realBase).href); }
    catch(e) { return v; }
  }

  try {
    var origAssign = window.location.assign.bind(window.location);
    window.location.assign = function(url) { origAssign(toProxied(url)); };
  } catch(e) {}
  try {
    var origReplace = window.location.replace.bind(window.location);
    window.location.replace = function(url) { origReplace(toProxied(url)); };
  } catch(e) {}

  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('/proxy?')
        || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    e.preventDefault();
    window.location.href = toProxied(href);
  }, true);

  // Also catch form submits (Google's search box submits via JS-built
  // requests, but some forms still use a plain submit event)
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || !form.action) return;
    var action = form.getAttribute('action') || '';
    if (action.startsWith('/proxy?')) return; // already proxied by server-side rewrite
    e.preventDefault();
    var fd = new FormData(form);
    var params = new URLSearchParams();
    for (var pair of fd.entries()) params.append(pair[0], pair[1]);
    var target = action || _realBase;
    var full = target + (target.includes('?') ? '&' : '?') + params.toString();
    window.location.href = toProxied(full);
  }, true);

  // history.pushState/replaceState remain UNPATCHED — Google's internal
  // tab/view-state logic depends on reading back exactly what it wrote.
  // The address bar may show a scrubbed/SPA-internal URL during in-page
  // navigation; our own request recovery no longer depends on it because
  // it's anchored to _realBase above, not location.href.
})();
</script>`;

  // Insert intercept script as early as possible in <head>
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>' + interceptScript);
  } else if (html.match(/<head\s/i)) {
    html = html.replace(/<head(\s[^>]*)>/i, (m) => m + interceptScript);
  } else {
    html = interceptScript + html;
  }

  return html;
}

/* ─────────────────────────────────────
   HEADERS TO STRIP FROM PROXY RESPONSE
───────────────────────────────────── */
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'strict-transport-security',
  'referrer-policy',      // the target site may set its own no-referrer
                          // policy, which would suppress the Referer
                          // header our /proxy recovery logic relies on
  'permissions-policy',
  'transfer-encoding',   // we re-encode as a simple response
  'content-encoding',    // we decoded via identity
  'connection',
  'keep-alive',
]);

/* ─────────────────────────────────────
   HTTP SERVER
───────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  // Only handle GET
  if (req.method !== 'GET') {
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  let reqUrl;
  try { reqUrl = new URL(req.url, `http://localhost:${PORT}`); }
  catch { res.writeHead(400); res.end('Bad request URL'); return; }

  // ── Session cookie (used only for lastGoodBase recovery fallback) ──
  let sessionId = getSessionId(req);
  let needsSetCookie = false;
  if (!sessionId) {
    sessionId = makeSessionId();
    needsSetCookie = true;
  }

  // ── Serve the demo page ──
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (needsSetCookie) headers['Set-Cookie'] = `pptsid=${sessionId}; Path=/; SameSite=Lax`;
      res.writeHead(200, headers);
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Cannot read index.html: ${e.message}\nMake sure index.html is in the same folder as server.js.`);
    }
    return;
  }

  // ── Proxy endpoint, OR any other path the browser requested directly ──
  // (the latter happens when a page's own JS makes a relative-path request
  //  like fetch("/search?q=cats") that our HTML rewriter never saw, since
  //  it only rewrites static href/src/action attributes — not JS calls)
  const isExplicitProxyCall = reqUrl.pathname === '/proxy';

  // Shared helper for both recovery tiers below. The browser's request
  // path is relative to OUR origin (e.g. "/proxy?q=cat" or "/search?q=x"),
  // but "/proxy" itself is an artifact of our own routing, not part of
  // the real target site's path structure. If we resolved it naively
  // against a base like "https://www.google.com/", we'd get the wrong
  // result "https://www.google.com/proxy?q=cat" instead of
  // "https://www.google.com/?q=cat". Strip a literal leading "/proxy"
  // segment (if present) before resolving so the math comes out right.
  function resolveAgainstBase(rawReqUrl, base) {
    const stripped = rawReqUrl.replace(/^\/proxy(?=[?\/]|$)/, '') || '/';
    return new URL(stripped, base).href;
  }

  if (isExplicitProxyCall || true) {
    let targetUrl = isExplicitProxyCall ? reqUrl.searchParams.get('url') : null;

    // Tier 1 recovery: resolve the bare relative request the browser made
    // against whatever page referred it here. The Referer header is sent
    // automatically by the browser and — since every page we serve was
    // itself loaded via /proxy?url=... — it lets us reconstruct the
    // real absolute URL the page actually intended to fetch. This works
    // UNLESS the referring page already scrubbed its own URL via
    // history.replaceState (Google does this after load), in which case
    // Referer itself reflects a scrubbed, queryless /proxy URL.
    if (!targetUrl) {
      const referer = req.headers['referer'] || req.headers['referrer'];
      let refererTarget = null;
      if (referer) {
        try {
          refererTarget = new URL(referer).searchParams.get('url');
        } catch { /* ignore malformed referer */ }
      }

      if (refererTarget) {
        try {
          targetUrl = resolveAgainstBase(req.url, refererTarget);
          console.log(`  ↺ recovered via Referer: ${req.url} → ${targetUrl}`);
        } catch { /* fall through to tier 2 */ }
      }
    }

    // Tier 2 recovery: Referer was missing or already scrubbed. Fall back
    // to the last successfully proxied base URL remembered for this
    // session (cookie), and resolve the bare relative request against it.
    if (!targetUrl && sessionId && lastGoodBase.has(sessionId)) {
      const fallbackBase = lastGoodBase.get(sessionId);
      try {
        targetUrl = resolveAgainstBase(req.url, fallbackBase);
        console.log(`  ↺ recovered via lastGoodBase: ${req.url} → ${targetUrl}`);
      } catch { /* fall through to the 400 below */ }
    }

    // If this wasn't even an explicit /proxy call and we couldn't recover
    // a target (no useful referer, no session history), it's a genuine
    // 404 — don't swallow unrelated requests (favicon.ico, etc) into
    // confusing proxy errors.
    if (!targetUrl && !isExplicitProxyCall) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }


    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#721c24;background:#f8d7da">
        <h3>Missing ?url= parameter</h3>
        <p>This page tried to navigate using JavaScript (not a plain link), and no
        <code>Referer</code> header was available to recover the intended destination.</p>
        <p style="font-size:12px;color:#856404;background:#fff3cd;padding:8px;border-radius:4px">
          This is a known limitation of regex-based link rewriting — some sites
          build requests dynamically in JS in ways a proxy can't always intercept.
        </p>
      </body></html>`);
      return;
    }

    // Basic safety — only allow http/https
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
      if (!['http:', 'https:'].includes(parsedTarget.protocol)) throw new Error();
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or disallowed URL'); return;
    }

    try {
      console.log(`  → proxy  ${targetUrl}`);
      const result = await fetchRemote(targetUrl);

      const contentType = (result.headers['content-type'] || 'application/octet-stream').toLowerCase();

      // Build clean response headers
      const outHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'X-Proxied-By': 'ppt-webview2-demo',
      };

      // Forward safe headers (exclude the blocked list)
      for (const [k, v] of Object.entries(result.headers)) {
        if (!STRIP_HEADERS.has(k.toLowerCase())) {
          outHeaders[k] = v;
        }
      }

      let body;
      if (contentType.includes('text/html')) {
        let html = result.body.toString('utf8');
        html = rewriteHtml(html, targetUrl);
        body = Buffer.from(html, 'utf8');
        outHeaders['Content-Type'] = 'text/html; charset=utf-8';
        outHeaders['Content-Length'] = String(body.length);

        // Remember this as the last successfully proxied HTML page for
        // this session — used as a Tier 2 recovery fallback when a later
        // bare relative request can't be resolved via Referer (e.g. the
        // page already scrubbed its own URL with history.replaceState).
        if (sessionId && result.status >= 200 && result.status < 300) {
          lastGoodBase.set(sessionId, targetUrl);
        }
      } else {
        body = result.body;
        outHeaders['Content-Length'] = String(body.length);
      }

      if (needsSetCookie) {
        outHeaders['Set-Cookie'] = `pptsid=${sessionId}; Path=/; SameSite=Lax`;
      }

      res.writeHead(result.status, outHeaders);
      res.end(body);

    } catch (e) {
      console.error(`  ✗ proxy error for ${targetUrl}:`, e.message);
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#721c24;background:#f8d7da">
        <h3>Proxy fetch failed</h3>
        <p><strong>URL:</strong> ${targetUrl}</p>
        <p><strong>Error:</strong> ${e.message}</p>
        <p style="font-size:12px;color:#856404;background:#fff3cd;padding:8px;border-radius:4px">
          Some sites block server-side fetches too (Cloudflare, bot detection, etc).
          Try a different URL.
        </p>
      </body></html>`);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`    Either stop the other process or change PORT at the top of server.js\n`);
  } else {
    console.error('Server error:', e);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log(`  │   PowerPoint Online Pictures Demo         │`);
  console.log(`  │   http://localhost:${PORT}                    │`);
  console.log('  ├──────────────────────────────────────────┤');
  console.log('  │   Proxy: X-Frame-Options stripped ✓       │');
  console.log('  │   Proxy: CSP headers stripped ✓           │');
  console.log('  │   Proxy: Links rewritten for navigation ✓ │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('');
});
