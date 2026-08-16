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

console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
