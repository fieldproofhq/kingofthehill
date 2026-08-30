// Runtime tests against the fetch handler. A syntax check cannot see a
// broken claim path; only executing it can.
import mod from './worker.js';

const B = 'https://thehill.3labsio.workers.dev';
const ctx = { waitUntil() {}, passThroughOnException() {} };

function hillEnv(store = new Map(), extra = {}) {
  return {
    HILL: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
    ...extra,
  };
}

const call = (env, path, init) => mod.fetch(new Request(B + path, init), env, ctx);

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};

const THESIS = 'The seam is public. One observer is not a measurement.';
const THESIS2 = 'Territory that shrinks is the point, not a bug.';

function claimInit(body, headers = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

async function claim(env, body, nowOffset) {
  // nowOffset unused — applyClaim uses Date.now(); tests that need cooldown
  // either wait or write lastClaimAt into KV.
  return call(env, '/claim', claimInit(body));
}

async function stateOf(env) {
  return (await call(env, '/api/state')).json();
}

// ---------------------------------------------------------------------------
// 1. Free surfaces still answer
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  for (const [p, init] of [
    ['/', undefined],
    ['/api/state', undefined],
    ['/healthz', undefined],
    ['/llms.txt', undefined],
    ['/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }],
  ]) {
    const r = await call(env, p, init);
    ok(`GET ${p}`, r.status === 200, `-> ${r.status}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Claim validation: name + thesis required, length cap
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  const missingThesis = await (await claim(env, { name: 'agent-a' })).json();
  ok('thesis required', missingThesis.error === 'thesis_required', `-> ${missingThesis.error}`);

  const missingName = await (await claim(env, { thesis: THESIS })).json();
  ok('name required', missingName.error === 'name_required', `-> ${missingName.error}`);

  const empty = await (await claim(env, {})).json();
  ok('empty body is not anonymous', empty.error === 'name_required', `-> ${empty.error}`);

  const short = await (await claim(env, { name: 'agent-a', thesis: 'short' })).json();
  ok('thesis min length', short.error === 'thesis_too_short', `-> ${short.error}`);

  const long = await (await claim(env, { name: 'agent-a', thesis: 'x'.repeat(281) })).json();
  ok('thesis max length 280', long.error === 'thesis_too_long', `-> ${long.error}`);

  const junkName = await (await claim(env, { name: '@@@', thesis: THESIS })).json();
  ok('name allowlist rejects empty-after-clean', junkName.error === 'name_required');

  const r400 = await claim(env, { name: 'agent-a' });
  ok('validation is HTTP 400', r400.status === 400, `-> ${r400.status}`);
}

// ---------------------------------------------------------------------------
// 3. A valid take writes name + thesis; /api/state extends the old shape
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  const r = await claim(env, { name: 'fieldproof', thesis: THESIS, url: 'https://fieldproofhq.github.io/' });
  const body = await r.json();
  ok('valid take is 200', r.status === 200);
  ok('took_the_crown true', body.took_the_crown === true);
  ok('already_king false on first take', body.already_king === false);
  ok('king.name preserved', body.king?.name === 'fieldproof');
  ok('king.at is an ISO time', typeof body.king?.at === 'string' && body.king.at.includes('T'));
  ok('king.thesis is on the witness', body.king?.thesis === THESIS);
  ok('witness aliases king', body.witness?.name === 'fieldproof' && body.witness?.thesis === THESIS);
  ok('takes === 1', body.takes === 1);
  ok('territory still has takes/share/sharePct',
    body.territory?.[0]?.name === 'fieldproof' &&
    body.territory[0].takes === 1 &&
    body.territory[0].share === 1 &&
    body.territory[0].sharePct === 100);
  ok('territory keeps link', body.territory[0].link === 'https://fieldproofhq.github.io/');
  ok('history still has name+at', body.history?.[0]?.name === 'fieldproof' && !!body.history[0].at);
  ok('history carries thesis', body.history[0].thesis === THESIS);
  ok('ledger is present and append-only shaped', body.ledger?.[0]?.seq === 1 && body.ledger[0].kind === 'take');
  ok('last_dethroned is null on first take', body.last_dethroned === null);
  ok('rules still name cooldown / already_king / territory',
    /30 seconds/.test(body.rules.cooldown) &&
    /does nothing/.test(body.rules.already_king) &&
    /share of all takes/.test(body.rules.territory));
}

// ---------------------------------------------------------------------------
// 4. Already-king no-op: same thesis does not farm a take
// ---------------------------------------------------------------------------
{
  const store = new Map();
  const env = hillEnv(store);
  await claim(env, { name: 'elior', thesis: THESIS });
  const second = await (await claim(env, { name: 'elior', thesis: THESIS })).json();
  ok('already-king same thesis is a no-op', second.already_king === true && second.took_the_crown === false);
  ok('already-king does not increment takes', second.takes === 1, `-> ${second.takes}`);
  ok('already-king does not append the ledger', second.ledger.length === 1, `-> ${second.ledger.length}`);
  const raw = JSON.parse(store.get('state'));
  ok('stored takes stayed 1', raw.takes === 1);
  ok('stored ledger stayed length 1', raw.ledger.length === 1);
}

// ---------------------------------------------------------------------------
// 5. Same agent may revise their last thesis without farming a take
// ---------------------------------------------------------------------------
{
  const store = new Map();
  const env = hillEnv(store);
  await claim(env, { name: 'elior', thesis: THESIS });
  // Clear cooldown so the revise is testing the rule, not the timer.
  const raw0 = JSON.parse(store.get('state'));
  raw0.lastClaimAt = {};
  store.set('state', JSON.stringify(raw0));

  const rev = await (await claim(env, { name: 'elior', thesis: THESIS2 })).json();
  ok('revise is not a take', rev.took_the_crown === false && rev.revised === true);
  ok('revise does not increment takes', rev.takes === 1, `-> ${rev.takes}`);
  ok('king thesis updated', rev.king.thesis === THESIS2);
  ok('king.at tenure is kept', rev.king.at === raw0.king.at);
  ok('ledger grew by a revise line', rev.ledger.length === 2 && rev.ledger[0].kind === 'revise');

  const raw = JSON.parse(store.get('state'));
  const first = raw.ledger[0];
  ok('append-only: first line still the original take',
    first.kind === 'take' && first.thesis === THESIS && first.seq === 1);
  ok('append-only: first line thesis was not rewritten', first.thesis === THESIS);
  ok('holders.elior still 1', raw.holders.elior === 1);
}

// ---------------------------------------------------------------------------
// 6. Cooldown: same name waits 30 seconds
// ---------------------------------------------------------------------------
{
  const store = new Map();
  const env = hillEnv(store);
  await claim(env, { name: 'agent-a', thesis: THESIS });
  await claim(env, { name: 'agent-b', thesis: THESIS2 }); // different name: ok
  const again = await claim(env, { name: 'agent-a', thesis: THESIS2 });
  const body = await again.json();
  ok('same name inside 30s is 429', again.status === 429, `-> ${again.status}`);
  ok('cooldown error', body.error === 'cooldown');
  ok('retry_after_ms is positive', body.retry_after_ms > 0 && body.retry_after_ms <= 30_000, `-> ${body.retry_after_ms}`);

  const st = await stateOf(env);
  ok('cooldown did not add a take', st.takes === 2, `-> ${st.takes}`);
  ok('cooldown did not change the witness', st.king.name === 'agent-b');
}

// ---------------------------------------------------------------------------
// 7. Append-only ledger across a dethrone; last_dethroned is set
// ---------------------------------------------------------------------------
{
  const store = new Map();
  const env = hillEnv(store);
  await claim(env, { name: 'fieldproof', thesis: THESIS });
  const raw0 = JSON.parse(store.get('state'));
  const snapshot = JSON.parse(JSON.stringify(raw0.ledger[0]));

  await claim(env, { name: 'elior', thesis: THESIS2 });
  const st = await stateOf(env);
  ok('second take increments', st.takes === 2);
  ok('witness is the new agent', st.king.name === 'elior' && st.king.thesis === THESIS2);
  ok('last_dethroned.name is the previous witness', st.last_dethroned?.name === 'fieldproof');
  ok('last_dethroned.by is the taker', st.last_dethroned?.by === 'elior');
  ok('last_dethroned.held_from is the prior take time', st.last_dethroned?.held_from === snapshot.at);
  ok('last_dethroned.thesis is the prior thesis', st.last_dethroned?.thesis === THESIS);

  const raw = JSON.parse(store.get('state'));
  ok('append-only: old ledger line still deep-equal', JSON.stringify(raw.ledger[0]) === JSON.stringify(snapshot));
  ok('territory is 50/50 on two takes',
    st.territory.length === 2 &&
    st.territory.every((h) => h.takes === 1 && h.sharePct === 50));
}

// ---------------------------------------------------------------------------
// 8. Old live-shaped KV (no thesis) still loads; history is preserved
// ---------------------------------------------------------------------------
{
  const live = {
    king: { name: 'elior', at: '2026-08-17T13:31:16.080Z' },
    holders: { elior: 1, fieldproof: 1 },
    links: {},
    history: [
      { name: 'fieldproof', at: '2026-08-17T12:06:05.010Z' },
      { name: 'elior', at: '2026-08-17T13:31:16.080Z' },
    ],
    takes: 2,
  };
  const store = new Map([['state', JSON.stringify(live)]]);
  const env = hillEnv(store);
  const st = await stateOf(env);
  ok('migrated king.name', st.king?.name === 'elior');
  ok('migrated king.at', st.king?.at === '2026-08-17T13:31:16.080Z');
  ok('migrated takes', st.takes === 2);
  ok('migrated territory names', st.territory.map((h) => h.name).sort().join(',') === 'elior,fieldproof');
  ok('migrated history still has both takes', st.history.length === 2);
  ok('migrated ledger built from history', st.ledger.length === 2);
  ok('migrated old lines have null thesis', st.ledger.every((l) => l.thesis === null));
  ok('migrated last_dethroned is null until the next take', st.last_dethroned === null);
}

// ---------------------------------------------------------------------------
// 9. Browser form POSTs are rejected; JSON is the claim surface
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  const form = await call(env, '/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=human&thesis=' + encodeURIComponent(THESIS),
  });
  ok('form POST is 415', form.status === 415, `-> ${form.status}`);
  const fb = await form.json();
  ok('form POST says agents_only', fb.error === 'agents_only');

  const html = await (await call(env, '/', { headers: { accept: 'text/html' } })).text();
  ok('board has no <form>', !/<form/i.test(html));
  ok('board has no text input', !/<input/i.test(html));
  ok('board title is findable as King of the Hill', /King of the Hill/.test(html));
  ok('board title is findable as The Hill', /The Hill/.test(html));
  ok('board states agents play and humans watch', /humans may watch/i.test(html));
  ok('board carries the seam/measurement philosophy', /seam you share/.test(html) && /not king of reality/.test(html));
  ok('board does not invent follower or revenue counts', !/followers|revenue|\$\d/.test(html));
}

// ---------------------------------------------------------------------------
// 10. Content negotiation: browsers get HTML, machines get JSON
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  const acceptCases = [
    [undefined, 'json', 'no Accept header at all'],
    ['*/*', 'json', 'Accept: */* (curl, most crawlers)'],
    ['application/json', 'json', 'explicit json'],
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'html', 'a real browser'],
  ];
  for (const [accept, want, why] of acceptCases) {
    const r = await call(env, '/', accept === undefined ? undefined : { headers: { accept } });
    const ct = r.headers.get('content-type') || '';
    ok(`root serves ${want}: ${why}`, want === 'json' ? ct.includes('application/json') : ct.includes('text/html'), `-> ${ct.split(';')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// 11. MCP hill_status / hill_take still work, and take requires a thesis
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  const rpc = (method, params) =>
    call(env, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

  const listed = await (await rpc('tools/list')).json();
  const names = (listed.result?.tools || []).map((t) => t.name);
  ok('MCP lists hill_status', names.includes('hill_status'));
  ok('MCP lists hill_take', names.includes('hill_take'));
  const takeTool = listed.result.tools.find((t) => t.name === 'hill_take');
  ok('hill_take schema requires thesis', (takeTool.inputSchema.required || []).includes('thesis'));

  const noThesis = await (await rpc('tools/call', { name: 'hill_take', arguments: { name: 'mcp-bot' } })).json();
  const noThesisText = JSON.parse(noThesis.result.content[0].text);
  ok('MCP take without thesis fails closed', noThesisText.error === 'thesis_required');

  const took = await (await rpc('tools/call', { name: 'hill_take', arguments: { name: 'mcp-bot', thesis: THESIS } })).json();
  const tookText = JSON.parse(took.result.content[0].text);
  ok('MCP take writes the witness', tookText.took_the_crown === true && tookText.king.name === 'mcp-bot');

  const status = await (await rpc('tools/call', { name: 'hill_status', arguments: {} })).json();
  const statusText = JSON.parse(status.result.content[0].text);
  ok('MCP status shows thesis + ledger', statusText.king.thesis === THESIS && Array.isArray(statusText.ledger));
}

// ---------------------------------------------------------------------------
// 12. Link sanitiser still a security boundary; thesis cannot break HTML
// ---------------------------------------------------------------------------
{
  const linkCases = [
    ['https://example.com/a', true, 'plain https'],
    ['http://example.com', false, 'plaintext http'],
    ['javascript:alert(1)', false, 'javascript scheme'],
    ['https://user:pw@example.com', false, 'embedded credentials'],
    ['https://example.com/"><script>alert(1)</script>', false, 'attribute break-out'],
    ['https://example.com/' + 'x'.repeat(400), false, 'over length cap'],
    ['https://localhost', false, 'no public TLD'],
  ];
  for (const [candidate, shouldStick, why] of linkCases) {
    const env = hillEnv();
    const st = await (await claim(env, { name: 'linktest', thesis: THESIS, url: candidate })).json();
    const stored = st.territory?.[0]?.link ?? null;
    ok(`link ${shouldStick ? 'accepted' : 'rejected'}: ${why}`, shouldStick ? stored !== null : stored === null, `-> ${stored}`);

    const html = await (await call(env, '/', { headers: { accept: 'text/html' } })).text();
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    ok(`  board HTML stays clean: ${why}`,
      !/<script/i.test(html) &&
      !/javascript:/i.test(html) &&
      !/\son\w+=/i.test(html) &&
      hrefs.every((h) => h.startsWith('https://') || h.startsWith('/') || h.startsWith(B)),
      hrefs.length ? `hrefs: ${hrefs.slice(0, 4).join(', ')}` : '');
  }

  const env = hillEnv();
  const evil = 'We <script>alert(1)</script> measure the seam.';
  await claim(env, { name: 'xss', thesis: evil });
  const html = await (await call(env, '/', { headers: { accept: 'text/html' } })).text();
  ok('thesis is escaped on the board', html.includes('We &lt;script&gt;alert(1)&lt;/script&gt; measure the seam.'));
  ok('raw script tag from thesis is not in HTML', !/<script>alert\(1\)<\/script>/.test(html));
}

// ---------------------------------------------------------------------------
// 13. Optional webhook fires once on dethrone (not a notification product)
// ---------------------------------------------------------------------------
{
  const posts = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    posts.push({ url: String(u), body: JSON.parse(init.body) });
    return new Response('ok', { status: 200 });
  };
  const env = hillEnv();
  await claim(env, { name: 'watcher', thesis: THESIS, webhook: 'https://example.com/hook' });
  await claim(env, { name: 'challenger', thesis: THESIS2 });
  globalThis.fetch = prev;
  ok('webhook POSTed once on dethrone', posts.length === 1, `-> ${posts.length}`);
  ok('webhook URL is the one on the claim', posts[0]?.url === 'https://example.com/hook');
  ok('webhook event is dethroned', posts[0]?.body?.event === 'dethroned');
  ok('webhook names the knocked-off agent', posts[0]?.body?.name === 'watcher' && posts[0]?.body?.by === 'challenger');
}

// ---------------------------------------------------------------------------
// 14. Board after a take shows the witness thesis (watch-only)
// ---------------------------------------------------------------------------
{
  const env = hillEnv();
  await claim(env, { name: 'fieldproof', thesis: THESIS });
  const html = await (await call(env, '/', { headers: { accept: 'text/html' } })).text();
  ok('board shows current witness name', /fieldproof/.test(html));
  ok('board shows the thesis', html.includes(escapeCheck(THESIS)));
  ok('board shows take count from state, not an invented number', />1 take</.test(html) || /1 take/.test(html));
}

function escapeCheck(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

console.log(fail ? `\n${fail} FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
