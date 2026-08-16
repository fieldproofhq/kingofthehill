const USDC = {
  'eip155:8453': { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' } },
  'eip155:84532': { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', extra: { name: 'USDC', version: '2' } },
};

const CDP_FACILITATOR = 'https://api.cdp.coinbase.com/platform/v2/x402';
const TESTNET_FACILITATOR = 'https://x402.org/facilitator';

function b64encode(obj) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
}
function b64decode(str) {
  try {
    const bytes = Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cfg(env) {
  const payTo = env.PAY_TO || null;
  const free = env.FREE_MODE !== undefined ? env.FREE_MODE !== 'false' : !payTo;
  const network = env.NETWORK || 'eip155:8453';
  const priceUsd = env.PRICE_USD || '0.005';
  const amount = String(Math.round(parseFloat(priceUsd) * 1e6)); // USDC 6 decimals
  const hasCdp = !!(env.CDP_KEY_ID && env.CDP_KEY_SECRET);
  const facilitator = env.FACILITATOR_URL || (hasCdp ? CDP_FACILITATOR : TESTNET_FACILITATOR);
  return { payTo, free, network, priceUsd, amount, facilitator, hasCdp };
}

function pricedCfg(c, priceUsd, quoteDescription) {
  const price = String(priceUsd);
  const amount = String(Math.round(Number(price) * 1e6));
  return { ...c, priceUsd: price, amount, quoteDescription };
}

function sponsorCfg(c) {
  return pricedCfg(
    c,
    GOAL_USD,
    'One 42 USDC payment on Base that meets Fieldproof first-$42 external-income bar. The $0.005 self-test is excluded. Self-pays do not count.'
  );
}

/** v1 network names vs v2 CAIP-2 ids — the facilitator rejects mixed schemas. */
const V1_NETWORK = { 'eip155:8453': 'base', 'eip155:84532': 'base-sepolia' };

/** x402 v1 requirements: network NAME, maxAmountRequired, resource/description/mimeType required. */
function paymentRequirementsV1(c, url) {
  const token = USDC[c.network] || USDC['eip155:8453'];
  return {
    scheme: 'exact',
    network: V1_NETWORK[c.network] || 'base',
    maxAmountRequired: c.amount,
    resource: url,
    // The 402 is the only thing most callers will ever read. It should answer "why would
    // I pay this?" without a second request.
    description:
      c.quoteDescription ||
      ('Deterministic allow / require_approval / deny verdict for a proposed agent action. ' +
        'Same input always yields the same verdict, with the matched rule and rationale returned so it is auditable. ' +
        'Evaluate before paying — GET /v1/example and GET /v1/policies are free and hide nothing.'),
    mimeType: 'application/json',
    payTo: c.payTo,
    maxTimeoutSeconds: 60,
    asset: token.asset,
    extra: token.extra,
  };
}

/** x402 v2 requirements: CAIP-2 network, amount; NO resource/description/mimeType here. */
function paymentRequirementsV2(c) {
  const token = USDC[c.network] || USDC['eip155:8453'];
  return {
    scheme: 'exact',
    network: c.network,
    amount: c.amount,
    asset: token.asset,
    payTo: c.payTo,
    maxTimeoutSeconds: 60,
    extra: token.extra,
  };
}

const SELF_TEST_USD = 0.005;
const GOAL_USD = 42;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPCS = ['https://mainnet.base.org', 'https://base.publicnode.com', 'https://1rpc.io/base'];

async function cdpJwt(env, method, urlStr) {
  const u = new URL(urlStr);
  const keyId = env.CDP_KEY_ID;
  const secret = Uint8Array.from(atob(env.CDP_KEY_SECRET), (c) => c.charCodeAt(0));
  const seed = secret.slice(0, 32); // CDP Ed25519 secret = 64 bytes (seed || pub)
  // Wrap raw seed in PKCS8 DER for WebCrypto import:
  const pkcs8Prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix), pkcs8.set(seed, pkcs8Prefix.length);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyId, nonce };
  const claims = {
    iss: 'cdp',
    sub: keyId,
    aud: ['cdp_service'],
    nbf: now,
    exp: now + 120,
    uri: `${method} ${u.host}${u.pathname}`,
  };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function facilitatorCall(env, c, endpoint, body) {
  const url = `${c.facilitator}/${endpoint}`;
  const headers = { 'content-type': 'application/json' };
  if (c.facilitator.startsWith(CDP_FACILITATOR.slice(0, 30)) && c.hasCdp) {
    headers.authorization = `Bearer ${await cdpJwt(env, 'POST', url)}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON facilitator error */
  }

  // The ONLY place the facilitator says whether our bazaar declaration was accepted is this
  // header, base64 JSON keyed by extension name: { bazaar: { status, rejectedReason } }.
  // Discarding it is why a malformed declaration can sit rejected for days while every other
  // signal reads healthy — the payment settles, nothing errors, and the resource is simply
  // never cataloged. Read it, and surface it.
  let extensions = null;
  const raw = res.headers.get('EXTENSION-RESPONSES');
  if (raw) {
    try {
      extensions = JSON.parse(atob(raw));
    } catch {
      extensions = { parseError: raw.slice(0, 200) };
    }
    console.log('EXTENSION-RESPONSES', endpoint, JSON.stringify(extensions));
  }
  return { status: res.status, json, extensions };
}

/* ------------------------------- HTTP layer -------------------------------- */

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-payment, payment-signature',
    'access-control-expose-headers': 'payment-required, payment-response, x-payment-response, x-fieldproof-free',
  };
}


function json(code, obj, extraHeaders = {}, free = false) {
  const headers = { 'content-type': 'application/json', ...corsHeaders(), ...extraHeaders };
  // Say only what is true: this particular response cost nothing. The old wording claimed
  // "x402 pricing live soon" and kept saying it after pricing went live, which told agents
  // the paid path did not work yet. It did.
  if (free) headers['x-fieldproof-free'] = 'true; this response is free - the crown is priced live at POST /claim';
  return new Response(JSON.stringify(obj, null, 2), { status: code, headers });
}

/** Bazaar/discovery declaration for the hill. Must ride on the requirements sent to the
 *  facilitator too, not only on this buyer-facing body — that was the bug that kept
 *  policy-gate out of the CDP Bazaar for six days (x402-foundation/x402#2112). */
function hillExtension(origin, priceUsd) {
  return {
    bazaar: {
      info: {
        input: {
          type: 'http',
          method: 'POST',
          bodyType: 'json',
          // `body`, not `bodyFields`. The spec's schema sets additionalProperties:false on
          // input, so an unrecognised key makes the whole declaration fail validation.
          body: { name: 'your-handle', url: 'https://example.com' },
        },
        output: {
          type: 'json',
          example: {
            took_the_crown: true,
            name: 'your-handle',
            paidUsd: priceUsd,
            priceToTakeUsd: Math.round(priceUsd * PRICE_RATIO * 100) / 100,
          },
        },
      },
      // This schema validates `info`, NOT the request body. It previously described the
      // {name, url} POST fields, which is a different object entirely — so it defined no
      // `input` property, and the spec requires facilitators to validate `info` against it
      // before cataloging. A declaration shaped like that is rejected, and the rejection is
      // only visible in the EXTENSION-RESPONSES header on verify/settle.
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
              bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
              body: { type: 'object' },
              queryParams: { type: 'object', additionalProperties: { type: 'string' } },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              example: { type: 'object' },
            },
            required: ['type'],
          },
        },
        required: ['input'],
      },
    },
  };
}

function paymentRequired402(c, url, origin, errMsg) {
  const price = Number(c.priceUsd);
  const v2 = {
    x402Version: 2,
    error: errMsg || 'PAYMENT-SIGNATURE header is required',
    resource: {
      url,
      description:
        'Take the crown at King of the Hill for $' + price.toFixed(2) +
        '. The price rises 1.5x for the next challenger, and your share of the board equals your share of everything ever paid.',
      mimeType: 'application/json',
      serviceName: 'King of the Hill',
      tags: ['game', 'auction', 'agents', 'x402'],
    },
    accepts: [paymentRequirementsV2(c)],
    extensions: hillExtension(origin, price),
  };
  const v1Body = { x402Version: 1, error: v2.error, accepts: [paymentRequirementsV1(c, url)] };
  return new Response(JSON.stringify(v1Body, null, 2), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': b64encode(v2),
      ...corsHeaders(),
    },
  });
}

/* ========================================================================
 * KING OF THE HILL — one crown, a rising price, and territory by ratio.
 *
 * Take the crown by paying the current price. The price then rises, so the
 * next challenger pays more than you did. Your share of the canvas is your
 * share of everything ever paid — not fixed pixels-for-dollars, so it
 * re-normalises as money arrives.
 *
 * Built on the same x402 machinery as policy-gate: one payment
 * implementation, two products. The 402 quotes the CURRENT price because we
 * generate the challenge ourselves.
 * ===================================================================== */

const START_PRICE_USD = 0.5;
const PRICE_RATIO = 1.5;      // each successful take raises the bar 50%
const MAX_NAME = 32;
const HISTORY_KEEP = 50;

/** Fresh state, built per call. This was a shared `const EMPTY_STATE` object spread with
 *  `{...EMPTY_STATE}` — a SHALLOW copy, so every caller got the same `holders`, `links` and
 *  `history` references. Before anything was ever written to KV, two requests in one isolate
 *  would mutate each other's board, and the pollution outlived the request because the module
 *  constant itself was being mutated. Nested objects must be constructed, not spread. */
function emptyState() {
  return {
    king: null,
    priceUsd: START_PRICE_USD,
    totalUsd: 0,
    holders: {},
    links: {},
    history: [],
    takes: 0,
  };
};

async function loadState(env) {
  if (!env.HILL) return emptyState();
  const raw = await env.HILL.get('state');
  if (!raw) return emptyState();
  try {
    return { ...emptyState(), ...JSON.parse(raw) };
  } catch {
    return emptyState();
  }
}

async function saveState(env, state) {
  if (env.HILL) await env.HILL.put('state', JSON.stringify(state));
}

function cleanName(input) {
  // Allowlist, not denylist: this string is rendered into HTML on the board.
  const s = String(input ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').trim();
  if (!s) return 'anonymous';
  return s.slice(0, MAX_NAME);
}

function nextPrice(current) {
  return Math.round(current * PRICE_RATIO * 100) / 100;
}

/** Territory by ratio: your share of the canvas is your share of all spend. */
/** Optional link for a holder's territory. This string gets rendered into the board's HTML
 *  and handed to other agents, so it is validated by allowlist rather than cleaned by
 *  substitution: https only, no credentials, no quotes or angle brackets, length capped.
 *  Anything that does not parse cleanly becomes null — a missing link is a far better
 *  outcome than an attacker-controlled one. */
function cleanUrl(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 200) return null;
  if (/["'<>\\\s]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
  return u.href.slice(0, 200);
}

function territory(state) {
  const total = state.totalUsd || 0;
  const links = state.links || {};
  return Object.entries(state.holders)
    .map(([name, paid]) => ({
      name,
      link: links[name] || null,
      paidUsd: Math.round(paid * 100) / 100,
      share: total > 0 ? paid / total : 0,
      sharePct: total > 0 ? Math.round((paid / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.paidUsd - a.paidUsd);
}

function publicState(state) {
  return {
    king: state.king,
    priceToTakeUsd: state.priceUsd,
    totalRaisedUsd: Math.round(state.totalUsd * 100) / 100,
    takes: state.takes,
    territory: territory(state),
    history: state.history.slice(-10).reverse(),
    // The HTML board warned humans that territory re-normalises and the machine-readable
    // rules did not, which meant a browsing person was told something an agent buyer was
    // not. Same disclosure, same words, whoever is reading.
    rules: {
      take: 'POST /claim with {"name":"you"} and an x402 payment of the current price',
      escalation: `each take multiplies the next price by ${PRICE_RATIO}`,
      territory: 'your share of the canvas equals your share of all money ever paid',
      dilution:
        'that share is a ratio, not a holding: it shrinks every time anyone else pays, ' +
        'and it is not reserved, guaranteed, or restorable',
      no_refund:
        'money paid is not returned. There is no payout, resale, dividend, or claim on the ' +
        'pot, and later takes do not pay earlier holders. You are buying a place on a board',
      links: 'an optional https url in the body points your territory somewhere; rendered nofollow',
    },
  };
}

function board(state, origin) {
  const t = territory(state);
  const king = state.king;
  const TOTAL_TILES = 400; // 20x20
  const tiles = [];
  let assigned = 0;
  t.forEach((h, i) => {
    const n = Math.max(h.paidUsd > 0 ? 1 : 0, Math.round(h.share * TOTAL_TILES));
    for (let k = 0; k < n && assigned < TOTAL_TILES; k++, assigned++) tiles.push(i);
  });
  while (assigned < TOTAL_TILES) { tiles.push(-1); assigned++; }

  const hue = (i) => (i < 0 ? '#171b22' : 'hsl(' + ((i * 67) % 360) + ' 70% 55%)');
  const cells = tiles.map((i) => '<i style="background:' + hue(i) + '"></i>').join('');
  // h.name is allowlisted to [A-Za-z0-9 ._-] and h.link is rejected outright if it contains
  // quotes or angle brackets, so neither can break out of the attribute or the text node.
  const label = (h) =>
    h.link
      ? '<a href="' + h.link + '" rel="nofollow noopener ugc" target="_blank">' + h.name + '</a>'
      : h.name;
  const rows = t.map((h, i) =>
    '<tr><td><b style="color:' + hue(i) + '">&#9632;</b> ' + label(h) + '</td><td>$' +
    h.paidUsd.toFixed(2) + '</td><td>' + h.sharePct + '%</td></tr>'
  ).join('') || '<tr><td colspan="3">nobody yet &mdash; the hill is empty</td></tr>';

  const kingLine = king
    ? '<b>' + king.name + '</b> <span style="opacity:.6">since ' +
      new Date(king.at).toISOString().slice(0, 16).replace('T', ' ') + 'Z</span>'
    : '<b>nobody</b>';

  const curl = [
    'curl -s -X POST ' + origin + '/claim \\',
    "  -H 'content-type: application/json' \\",
    '  -d \'{"name":"your-handle"}\'',
    '# -> 402 with x402 payment instructions for the current price',
  ].join('\n');

  return '<!doctype html><meta charset=utf-8><title>King of the Hill</title>' +
'<meta name=viewport content="width=device-width,initial-scale=1">' +
'<style>' +
':root{color-scheme:dark}' +
'body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;background:#0b0d10;color:#e8eaed}' +
'h1{font-size:1.6rem;margin:0 0 .2rem}.sub{opacity:.7;margin:0 0 1.4rem}' +
'.crown{border:1px solid #2a2f3a;border-radius:10px;padding:1rem 1.2rem;margin:0 0 1.2rem;background:#12151b}' +
'.price{font-size:2rem;font-weight:700;letter-spacing:-.02em}' +
'#grid{display:grid;grid-template-columns:repeat(20,1fr);gap:2px;margin:1.2rem 0}' +
'#grid i{aspect-ratio:1;border-radius:2px;display:block}' +
'table{width:100%;border-collapse:collapse;margin:.6rem 0 1.4rem}' +
'td{padding:.35rem .2rem;border-bottom:1px solid #1e222b}' +
'pre{background:#12151b;border:1px solid #222733;border-radius:8px;padding:.9rem;overflow-x:auto}' +
'a{color:#7cc4ff}' +
'</style>' +
'<h1>&#128081; King of the Hill</h1>' +
'<p class=sub>One crown. A rising price. Territory by ratio.</p>' +
'<div class=crown><div>current king &mdash; ' + kingLine + '</div>' +
'<div class=price>$' + state.priceUsd.toFixed(2) +
' <span style="font-size:.9rem;font-weight:400;opacity:.7">to take it</span></div>' +
'<div style="opacity:.7;margin-top:.4rem">$' + (Math.round(state.totalUsd * 100) / 100).toFixed(2) +
' raised across ' + state.takes + ' take' + (state.takes === 1 ? '' : 's') + '</div></div>' +
'<div id=grid>' + cells + '</div>' +
'<table>' + rows + '</table>' +
'<p>Your share of the canvas is your share of <em>everything ever paid</em>, so it re-normalises every time someone else buys in. Taking the crown raises the price ' + PRICE_RATIO + '&times; for whoever comes next.</p>' +
'<pre>' + curl.replace(/</g, '&lt;') + '</pre>' +
'<p style="opacity:.7">Paid in USDC on Base via <a href="https://x402.org">x402</a>. ' +
'State: <a href="' + origin + '/api/state">/api/state</a> &middot; ' +
'<a href="' + origin + '/.well-known/x402">discovery</a> &middot; built by ' +
'<a href="https://x.com/FieldProofAI">@FieldProofAI</a>, an AI-run business. Every dollar here is public and on-chain.</p>';
}

async function crown(env, state, name, paidUsd, link = null) {
  const at = new Date().toISOString();
  state.king = { name, at, paidUsd, link };
  if (!state.links) state.links = {};
  // A later take overwrites the earlier link for the same handle; paying again is the only
  // way to change where your territory points.
  if (link) state.links[name] = link;
  state.holders[name] = (state.holders[name] || 0) + paidUsd;
  state.totalUsd += paidUsd;
  state.takes += 1;
  state.history.push({ name, paidUsd, at });
  if (state.history.length > HISTORY_KEEP) state.history = state.history.slice(-HISTORY_KEEP);
  state.priceUsd = nextPrice(paidUsd);
  await saveState(env, state);
  return state;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = cfg(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method === 'GET' && url.pathname === '/healthz') return json(200, { ok: true }, {}, true);

    const state = await loadState(env);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      // Content-negotiate. Humans get the board; machines get structured state including
      // the live price and accepts block.
      //
      // This resolves a real tension found in the directories: register the ORIGIN and the
      // health probe passes (200) but the crawler cannot see any price, because the origin
      // served HTML. Register the deep PAID path and the price is visible but a 402 GET
      // reads as a dead service. Negotiating gives both from one URL.
      // Machine-readable is the DEFAULT; HTML requires asking for it. Browsers always name
      // text/html explicitly, but crawlers and health probes send `*/*` or no Accept at all.
      // The old rule required `application/json` to be named, so those probes got the board,
      // saw no price, and recorded x402_ok:0 — which is precisely why the agent-tools listing
      // sat at health:down while the service was fine.
      const accept = request.headers.get('accept') || '';
      const wantsJson = !accept.includes('text/html');
      if (wantsJson) {
        const priced = pricedCfg(c, state.priceUsd, 'Take the crown');
        return json(200, {
          ...publicState(state),
          claim: { url: url.origin + '/claim', method: 'POST', body: { name: 'your-handle' } },
          priceUsd: state.priceUsd,
          currency: 'USDC',
          network: c.network,
          accepts: c.free ? [] : [paymentRequirementsV1(priced, url.origin + '/claim')],
          discovery: url.origin + '/.well-known/x402',
        }, {}, true);
      }
      return new Response(board(state, url.origin), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }

    // MCP (Streamable HTTP). An agent browsing a registry can read the board for free and
    // take the crown by paying — the game is playable from inside a tool client, which is
    // where agents already are.
    if (url.pathname === '/mcp') {
      if (request.method === 'GET') {
        return json(200, { transport: 'streamable-http', protocol: 'mcp', tools: ['hill_status', 'hill_take'] }, {}, true);
      }
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, {}, true);

      let rpc;
      try { rpc = JSON.parse((await request.text()) || '{}'); }
      catch { return json(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, {}, true); }
      const reply = (result) => json(200, { jsonrpc: '2.0', id: rpc.id ?? null, result }, {}, true);
      const fail = (code, message) => json(200, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code, message } }, {}, true);

      const TOOLS = [
        {
          name: 'hill_status',
          description: 'Free. Who holds the crown, what it costs to take it right now, how much has been raised, and each holder\'s share of the board.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'hill_take',
          description:
            'Take the crown at the current price, paid in USDC on Base via x402. The price rises 1.5x for the next challenger, ' +
            'and your territory is your share of everything ever paid — a ratio that SHRINKS every time anyone else pays. ' +
            'Money paid is not returned: no payout, resale, dividend or claim on the pot, and later takes do not pay earlier ' +
            'holders. You are buying a place on a board. Returns payment instructions when unpaid.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Display name for the board, max 32 chars' },
              url: {
                type: 'string',
                description:
                  'Optional https link your territory points at, max 200 chars, rendered nofollow. Paying again is the only way to change it.',
              },
            },
          },
        },
      ];

      switch (rpc.method) {
        case 'initialize':
          return reply({
            protocolVersion: typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'king-of-the-hill', version: '1.0' },
            instructions:
              'One crown, a rising price, territory by ratio. hill_status is free; hill_take costs the current price and raises it 1.5x for whoever comes next.',
          });
        case 'notifications/initialized':
          return new Response(null, { status: 202, headers: corsHeaders() });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call': {
          const text = (obj) => reply({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
          if (rpc.params?.name === 'hill_status') return text(publicState(state));
          if (rpc.params?.name === 'hill_take') {
            const nm = cleanName(rpc.params?.arguments?.name);
            // Forward the link. The schema advertises `url`, so dropping it here would make it
            // a parameter that exists only in documentation.
            const lnk = cleanUrl(rpc.params?.arguments?.url);
            if (c.free) {
              const out = await crown(env, state, nm, state.priceUsd, lnk);
              return text({ took_the_crown: true, name: nm, ...publicState(out) });
            }
            const priced = pricedCfg(c, state.priceUsd, 'Take the crown as ' + nm);
            return text({
              payment_required: true,
              price_usd: state.priceUsd,
              endpoint: url.origin + '/claim',
              accepts: [paymentRequirementsV1(priced, url.origin + '/claim')],
              how: 'POST /claim with {"name":"..."} and an X-PAYMENT header (x402). hill_status is free.',
            });
          }
          return fail(-32602, `Unknown tool: ${rpc.params?.name}`);
        }
        default:
          return fail(-32601, `Method not found: ${rpc.method}`);
      }
    }

    // Domain proof for the official MCP registry (public key half only).
    if (request.method === 'GET' && url.pathname === '/.well-known/mcp-registry-auth') {
      return new Response('v=MCPv1; k=ed25519; p=' + (env.MCP_REGISTRY_PUBKEY || ''), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders() },
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return json(200, publicState(state), {}, true);
    }

    // Domain-ownership proof for 402index.io. This is the SHA-256 hash of a verification
    // token, not the token — the hash is public by design and the token is in no file.
    if (request.method === 'GET' && url.pathname === '/.well-known/402index-verify.txt') {
      return new Response('e0555be30fa7a28ba9f1c2863e510464dae57c74035276209f6aa3d4ea4be669', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders() },
      });
    }

    // Discovery manifest. Crawlers look here first — learned the hard way today.
    if (request.method === 'GET' && url.pathname === '/.well-known/x402') {
      const priced = pricedCfg(c, state.priceUsd, 'Take the crown');
      return json(200, {
        x402Version: 2,
        serviceName: 'King of the Hill',
        description: 'Pay the current price to take the crown. The price rises each take. Territory is proportional to total spend.',
        tags: ['game', 'x402', 'agents', 'auction'],
        resources: [{
          url: url.origin + '/claim',
          method: 'POST',
          mimeType: 'application/json',
          description: 'Take the crown at the current price',
          accepts: c.free ? [] : [paymentRequirementsV2(priced)],
          dynamicPricing: true,
          currentPriceUsd: state.priceUsd,
        }],
        state: url.origin + '/api/state',
      }, {}, true);
    }

    // GET on the paid route documents it and returns 200: a non-2xx GET reads as a dead
    // service to directory health probes.
    if (request.method === 'GET' && url.pathname === '/claim') {
      const priced = pricedCfg(c, state.priceUsd, 'Take the crown');
      return json(200, {
        endpoint: url.origin + '/claim',
        method: 'POST',
        body: { name: 'your-handle' },
        currentPriceUsd: state.priceUsd,
        accepts: c.free ? [] : [paymentRequirementsV1(priced, url.origin + '/claim')],
        note: 'POST without payment returns 402 with signing instructions for the current price.',
      }, {}, true);
    }

    if (request.method === 'POST' && url.pathname === '/claim') {
      let body = {};
      try { body = JSON.parse((await request.text()) || '{}'); } catch { /* name is optional */ }
      const name = cleanName(body.name);
      const link = cleanUrl(body.url ?? body.link);
      const priced = pricedCfg(c, state.priceUsd, 'Take the crown as ' + name);

      if (c.free) {
        const out = await crown(env, state, name, state.priceUsd, link);
        return json(200, { free: true, took_the_crown: true, name, ...publicState(out) }, {}, true);
      }

      const payHeader = request.headers.get('payment-signature') || request.headers.get('x-payment');
      if (!payHeader) return paymentRequired402(priced, url.href, url.origin);

      const payload = b64decode(payHeader);
      if (!payload) return paymentRequired402(priced, url.href, url.origin, 'malformed payment header');

      const ver = payload.x402Version === 2 ? 2 : 1;
      const reqs = ver === 2 ? paymentRequirementsV2(priced) : paymentRequirementsV1(priced, url.href);
      // The declaration has to ride on the requirements the FACILITATOR sees, not only on the
      // buyer-facing 402 body. Attaching it in exactly one place is the bug that kept
      // policy-gate out of the CDP Bazaar for six days; same machinery, so same fix here.
      reqs.extensions = hillExtension(url.origin, Number(priced.priceUsd));
      const verifyBody = { x402Version: ver, paymentPayload: payload, paymentRequirements: reqs };

      const verify = await facilitatorCall(env, priced, 'verify', verifyBody);
      if (!verify.json || verify.json.isValid !== true) {
        const res402 = paymentRequired402(priced, url.href, url.origin,
          'payment verification failed: ' + (verify.json && verify.json.invalidReason ? verify.json.invalidReason : 'facilitator ' + verify.status));
        // Echo the facilitator's verdict on our discovery declaration. A rejected declaration
        // is otherwise invisible from outside, and this makes it observable without needing a
        // settlement to find out.
        if (verify.extensions) {
          const out = new Response(res402.body, res402);
          out.headers.set('x-bazaar-status', JSON.stringify(verify.extensions).slice(0, 400));
          return out;
        }
        return res402;
      }

      const settle = await facilitatorCall(env, priced, 'settle', verifyBody);
      if (!settle.json || settle.json.success !== true) {
        return paymentRequired402(priced, url.href, url.origin,
          'settlement failed: ' + (settle.json && settle.json.errorReason ? settle.json.errorReason : 'facilitator ' + settle.status));
      }

      const paid = state.priceUsd;
      const receipt = settle.json.transaction || settle.json.txHash || settle.json.payer || null;

      // Money has moved by this line. If recording the take then fails, the one thing we must
      // not do is throw a 500 and leave a paying agent with nothing and no evidence — that is
      // the "paid and received nothing" failure, and it would be entirely our bug. Hand back
      // the settlement reference and say plainly which half succeeded.
      try {
        const out = await crown(env, state, name, paid, link);
        return json(200, { took_the_crown: true, name, paidUsd: paid, settlement: receipt, ...publicState(out) });
      } catch (err) {
        return json(200, {
          took_the_crown: false,
          settled: true,
          recorded: false,
          name,
          paidUsd: paid,
          settlement: receipt,
          error: 'payment settled, but the board failed to record it',
          what_to_do:
            'Keep this settlement reference. Open an issue at ' +
            'https://github.com/fieldproofhq/kingofthehill/issues with it and the crown will be applied by hand.',
        });
      }
    }

    return json(404, { error: 'not_found', try: ['GET /', 'GET /api/state', 'POST /claim'] }, {}, true);
  },
};
