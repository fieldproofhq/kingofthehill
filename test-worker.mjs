// Runtime smoke test: actually invoke the fetch handler. A syntax check cannot see a
// referenced-but-undefined symbol; only executing the path can. That is how a broken
// worker passed `node --check` once already.
import mod from './worker.js';

const store = new Map();
const env = {
  PAY_TO: '0x07C2383008a9ed30581f27Db5531E19411c94fb3',
  FREE_MODE: 'false',
  NETWORK: 'eip155:8453',
  PRICE_USD: '0.005',
  HILL: {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => void store.set(k, v),
  },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const B = 'https://kingofthehill.3labsio.workers.dev';
const call = (path, init) => mod.fetch(new Request(B + path, init), env, ctx);

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};

// 1. free surfaces still answer
for (const p of ['/', '/api/state', '/healthz', '/.well-known/x402', '/mcp']) {
  const r = await call(p, p === '/mcp' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) } : undefined);
  ok(`GET ${p}`, r.status === 200, `-> ${r.status}`);
}

// 2. unpaid claim returns a 402 quoting the real start price
const r402 = await call('/claim', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'smoke' }),
});
const body402 = await r402.json();
ok('POST /claim unpaid -> 402', r402.status === 402, `-> ${r402.status}`);
ok('402 quotes 0.50 USDC', body402.accepts?.[0]?.maxAmountRequired === '500000', `-> ${body402.accepts?.[0]?.maxAmountRequired}`);
ok('402 pays our wallet', body402.accepts?.[0]?.payTo === env.PAY_TO);

// 3. the v2 header carries the bazaar declaration
const hdr = r402.headers.get('PAYMENT-REQUIRED');
const v2 = hdr ? JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')) : null;
ok('PAYMENT-REQUIRED header present', !!v2);
ok('v2 body carries extensions.bazaar', !!v2?.extensions?.bazaar);

// 4. THE FIX: the facilitator must receive the declaration too. Intercept the outbound
//    verify call and inspect exactly what would have been sent.
let sentToFacilitator = null;
globalThis.fetch = async (u, init) => {
  const url = String(u?.url || u);
  if (url.includes('/verify')) {
    sentToFacilitator = JSON.parse(init.body);
    return new Response(JSON.stringify({ isValid: false, invalidReason: 'smoke-test-stops-here' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const fakePayload = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: {} })).toString('base64');
await call('/claim', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'payment-signature': fakePayload },
  body: JSON.stringify({ name: 'smoke' }),
});
ok('facilitator verify was called', !!sentToFacilitator);
ok('*** requirements sent to facilitator carry extensions.bazaar ***',
   !!sentToFacilitator?.paymentRequirements?.extensions?.bazaar);

// 5. the corrected header says something true
const rFree = await call('/api/state');
const fh = rFree.headers.get('x-fieldproof-free');
ok('no stale "pricing live soon" claim anywhere', !/live soon/.test(fh || ''), `-> ${fh ?? '(absent)'}`);

// 6. A paying agent must never be left with nothing. Make the facilitator settle
//    successfully and then make the KV write fail, which is the one ordering where money
//    has already moved. The request must not throw, and the response must say plainly
//    that the payment settled while the board did not record it.
globalThis.fetch = async (u, init) => {
  const url = String(u?.url || u);
  if (url.includes('/verify')) {
    return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/settle')) {
    return new Response(JSON.stringify({ success: true, transaction: '0xdeadbeef' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const brokenEnv = { ...env, HILL: { get: async () => null, put: async () => { throw new Error('KV unavailable'); } } };
let threw = false;
let recovered = null;
try {
  const r = await mod.fetch(new Request(B + '/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'payment-signature': fakePayload },
    body: JSON.stringify({ name: 'smoke' }),
  }), brokenEnv, ctx);
  recovered = await r.json();
} catch { threw = true; }
ok('settle-then-KV-failure does not throw', !threw);
ok('response admits the payment settled', recovered?.settled === true);
ok('response admits the board did not record it', recovered?.recorded === false);
ok('response does NOT claim the crown', recovered?.took_the_crown === false);
ok('response hands back a settlement reference', !!recovered?.settlement, `-> ${recovered?.settlement}`);

// 7. Territory links are rendered into the board's HTML and handed to other agents, so the
//    sanitiser is a security boundary. Drive it through the real free-mode claim path and
//    then read the rendered board back.
const linkCases = [
  ['https://example.com/a', true, 'plain https'],
  ['http://example.com', false, 'plaintext http'],
  ['javascript:alert(1)', false, 'javascript scheme'],
  ['data:text/html,<script>alert(1)</script>', false, 'data URI'],
  ['https://user:pw@example.com', false, 'embedded credentials'],
  ['https://example.com/"><script>alert(1)</script>', false, 'attribute break-out'],
  ['https://example.com/' + 'x'.repeat(400), false, 'over length cap'],
  ['https://localhost', false, 'no public TLD'],
];
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
for (const [candidate, shouldStick, why] of linkCases) {
  const s = new Map();
  const freeEnv = {
    FREE_MODE: 'true',
    HILL: { get: async (k) => (s.has(k) ? s.get(k) : null), put: async (k, v) => void s.set(k, v) },
  };
  const rc = await mod.fetch(new Request(B + '/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'linktest', url: candidate }),
  }), freeEnv, ctx);
  const st = await rc.json();
  const stored = st.territory?.[0]?.link ?? null;
  ok(`link ${shouldStick ? 'accepted' : 'rejected'}: ${why}`, shouldStick ? stored !== null : stored === null, `-> ${stored}`);

  const html = await (await mod.fetch(new Request(B + '/', { headers: { accept: 'text/html' } }), freeEnv, ctx)).text();
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  ok(`  board HTML stays clean: ${why}`,
     !/<script/i.test(html) &&
     !/javascript:/i.test(html) &&
     !/\son\w+=/i.test(html) &&                       // no injected event handlers
     hrefs.every((h) => h.startsWith('https://')),    // every rendered href is https
     hrefs.length ? `hrefs: ${hrefs.join(', ')}` : '');
}

// 8. Directory crawlers and health probes do not send `Accept: application/json`. They send
//    `*/*`, or nothing at all. Every one of those must see the price, or the listing goes
//    health:down with x402_ok:0 while the service is perfectly fine.
const acceptCases = [
  [undefined, 'json', 'no Accept header at all'],
  ['*/*', 'json', 'Accept: */* (curl, most crawlers)'],
  ['application/json', 'json', 'explicit json'],
  ['application/json, text/plain, */*', 'json', 'typical http client'],
  ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'html', 'a real browser'],
];
for (const [accept, want, why] of acceptCases) {
  const r = await call('/', accept === undefined ? undefined : { headers: { accept } });
  const ct = r.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  ok(`root serves ${want}: ${why}`, want === 'json' ? isJson : ct.includes('text/html'), `-> ${ct.split(';')[0]}`);
  if (want === 'json') {
    const b = await r.json();
    ok(`  ...and the price is visible: ${why}`, b.accepts?.[0]?.maxAmountRequired === '500000' || b.priceToTakeUsd === 0.5);
  }
}

// 9. The bazaar declaration is validated by the facilitator BEFORE cataloging, and a failure
//    is invisible except in an EXTENSION-RESPONSES header on verify/settle. So assert the
//    spec's rules here rather than discovering them after paying for a settlement.
{
  const r = await call('/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'schemacheck' }),
  });
  const v2 = JSON.parse(Buffer.from(r.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));
  const bz = v2.extensions?.bazaar;
  const info = bz?.info, schema = bz?.schema;

  ok('bazaar: schema declares Draft 2020-12', schema?.$schema === 'https://json-schema.org/draft/2020-12/schema', `-> ${schema?.$schema}`);
  ok('bazaar: schema requires an input property', Array.isArray(schema?.required) && schema.required.includes('input'));
  ok('bazaar: schema defines properties.input', !!schema?.properties?.input);
  ok('bazaar: input.type is pinned to "http"', schema?.properties?.input?.properties?.type?.const === 'http');

  // The real trap: additionalProperties:false means any key in info.input that the schema
  // does not name invalidates the whole declaration.
  const allowed = Object.keys(schema?.properties?.input?.properties || {});
  const extra = Object.keys(info?.input || {}).filter((k) => !allowed.includes(k));
  ok('bazaar: info.input has no key the schema rejects', extra.length === 0, extra.length ? `stray: ${extra.join(', ')}` : '');

  const missing = (schema?.properties?.input?.required || []).filter((k) => !(k in (info?.input || {})));
  ok('bazaar: info.input carries every required key', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');

  ok('bazaar: declared method is in the schema enum',
     (schema?.properties?.input?.properties?.method?.enum || []).includes(info?.input?.method), `-> ${info?.input?.method}`);

  // The facilitator rejects verify/settle whose description exceeds 500 characters.
  const descs = [v2.resource?.description, ...(v2.accepts || []).map((a) => a.description)].filter(Boolean);
  ok('bazaar: every description is within 500 chars',
     descs.every((d) => d.length <= 500), `longest ${Math.max(0, ...descs.map((d) => d.length))}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
