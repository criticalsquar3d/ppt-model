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
  // Catches location.href = "..." and window.location = "..." assignments
  const interceptScript = `
<script>
(function(){
  var _proxyBase = '/proxy?url=';
  function wrap(loc) {
    var orig = Object.getOwnPropertyDescriptor(loc, 'href') ||
               Object.getOwnPropertyDescriptor(Object.getPrototypeOf(loc), 'href');
    if (!orig || !orig.set) return;
    Object.defineProperty(loc, 'href', {
      get: orig.get,
      set: function(v) {
        try {
          var abs = new URL(v, location.href).href;
          orig.set.call(this, _proxyBase + encodeURIComponent(abs));
        } catch(e) { orig.set.call(this, v); }
      }
    });
  }
  try { wrap(window.location); } catch(e){}
  // Patch pushState / replaceState so SPAs stay proxied
  ['pushState','replaceState'].forEach(function(fn){
    var orig = history[fn];
    history[fn] = function(state, title, url) {
      if (url && !url.startsWith('/proxy?') && !url.startsWith('#')) {
        try {
          var abs = new URL(url, location.href).href;
          url = _proxyBase + encodeURIComponent(abs);
        } catch(e){}
      }
      return orig.call(this, state, title, url);
    };
  });
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

  // ── Serve the demo page ──
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  if (isExplicitProxyCall || true) {
    let targetUrl = isExplicitProxyCall ? reqUrl.searchParams.get('url') : null;

    // Recovery path: resolve the bare relative request the browser made
    // against whatever page referred it here. The Referer header is sent
    // automatically by the browser and — since every page we serve was
    // itself loaded via /proxy?url=... — it lets us reconstruct the
    // real absolute URL the page actually intended to fetch.
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
          targetUrl = new URL(req.url, refererTarget).href;
          console.log(`  ↺ recovered via Referer: ${req.url} → ${targetUrl}`);
        } catch { /* fall through to the 400 below */ }
      }
    }

    // If this wasn't even an explicit /proxy call and we couldn't recover
    // a target (no useful referer), it's a genuine 404 — don't swallow
    // unrelated requests (favicon.ico, etc) into confusing proxy errors.
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
      } else {
        body = result.body;
        outHeaders['Content-Length'] = String(body.length);
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
