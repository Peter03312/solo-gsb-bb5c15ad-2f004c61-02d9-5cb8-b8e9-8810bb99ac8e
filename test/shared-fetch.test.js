import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { planSharedFetch } from '../src/shared-fetch.js';

const app = buildApp();
const url = '/shared-fetch-plan';

function sharedFetch(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

const baseLimits = { maxFetchBytes: 1000, maxGapBytes: 0 };

test('single client demand is split into capped fetches', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [{ id: 'a', ranges: [{ start: 0, end: 999 }] }],
    maxFetchBytes: 400,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.fetchesCount, 3);
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end, f.bytes, f.rangeHeader]),
    [
      [0, 399, 400, 'bytes=0-399'],
      [400, 799, 400, 'bytes=400-799'],
      [800, 999, 200, 'bytes=800-999'],
    ],
  );
  assert.deepEqual(body.fetches.map((f) => f.index), [1, 2, 3]);
  assert.equal(body.bytes.demand, 1000);
  assert.equal(body.bytes.fetched, 1000);
  assert.equal(body.bytes.extra, 0);
  assert.deepEqual(
    body.clients[0].coverage.map((c) => [c.fetchIndex, c.ranges, c.bytes]),
    [
      [1, [{ start: 0, end: 399 }], 400],
      [2, [{ start: 400, end: 799 }], 400],
      [3, [{ start: 800, end: 999 }], 200],
    ],
  );
  assert.equal(body.clients[0].servedBytes, 1000);
  assert.equal(body.clients[0].missingBytes, 0);
});

test('overlapping and adjacent demands across clients are deduplicated', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 99 }, { start: 50, end: 149 }] },
      { id: 'b', ranges: [{ start: 100, end: 199 }] },
    ],
    ...baseLimits,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[0, 199]]);
  assert.equal(body.bytes.demand, 200);
  assert.equal(body.bytes.fetched, 200);
  assert.equal(body.bytes.extra, 0);
  // Client a is served [0,149] by the single fetch; client b gets [100,199].
  assert.deepEqual(body.clients[0].coverage[0].ranges, [{ start: 0, end: 149 }]);
  assert.equal(body.clients[0].requestedBytes, 150);
  assert.deepEqual(body.clients[1].coverage[0].ranges, [{ start: 100, end: 199 }]);
  assert.equal(body.clients[1].requestedBytes, 100);
});

test('a gap no wider than maxGapBytes is bridged and counted as extra bytes', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 150 }] },
      { id: 'b', ranges: [{ start: 160, end: 400 }] },
    ],
    maxFetchBytes: 500,
    maxGapBytes: 20,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end, f.bytes]), [[0, 400, 401]]);
  assert.equal(body.fetches[0].demandBytes, 392);
  assert.equal(body.fetches[0].extraBytes, 9);
  assert.equal(body.bytes.demand, 392);
  assert.equal(body.bytes.fetched, 401);
  assert.equal(body.bytes.extra, 9);
});

test('a gap wider than maxGapBytes is not bridged', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 150 }] },
      { id: 'b', ranges: [{ start: 160, end: 400 }] },
    ],
    maxFetchBytes: 500,
    maxGapBytes: 8,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 150],
      [160, 400],
    ],
  );
  assert.equal(body.bytes.extra, 0);
});

test('a gap is never bridged when the merged fetch would exceed the cap', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 299 }] },
      { id: 'b', ranges: [{ start: 305, end: 604 }] },
    ],
    maxFetchBytes: 300,
    maxGapBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // 300 + 5 gap + 300 = 605 > 300, so even the first merge into the running
  // fetch is rejected; both demands are already exactly one chunk each.
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 299],
      [305, 604],
    ],
  );
});

test('split tail coalesces with the next demand across a small gap', async () => {
  // a needs 450 bytes -> chunks [0,299] and [300,449]; b starts at 455, so
  // the gap between the tail chunk and b is 5 bytes (450..454).
  const build = (bEnd) =>
    sharedFetch({
      size: 1000,
      clients: [
        { id: 'a', ranges: [{ start: 0, end: 449 }] },
        { id: 'b', ranges: [{ start: 455, end: bEnd }] },
      ],
      maxFetchBytes: 300,
      maxGapBytes: 10,
    });

  // b asks for 250 bytes: 150 tail + 5 gap + 250 = 405 > 300, no bridge.
  const res = await build(704);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 299],
      [300, 449],
      [455, 704],
    ],
  );

  // b asks for 90 bytes: 150 + 5 + 90 = 245 <= 300, the tail bridges.
  const res2 = await build(544);
  const body2 = res2.json();
  assert.deepEqual(
    body2.fetches.map((f) => [f.start, f.end]),
    [
      [0, 299],
      [300, 544],
    ],
  );
  assert.equal(body2.fetches[1].demandBytes, 240);
  assert.equal(body2.fetches[1].extraBytes, 5);
  assert.equal(body2.bytes.extra, 5);
});

test('left-to-right greedy coalescing does not back-merge', async () => {
  // chunks [0,99](100) gap10 [110,309](200) gap10 [320,419](100); cap 300.
  // First running fetch [0,99] merges the 200 chunk -> [0,309] (310 > 300) so
  // it does NOT merge; running becomes [110,309], then the 100 chunk bridges:
  // 200+10+100=310 > 300 -> no merge either.
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 99 }] },
      { id: 'b', ranges: [{ start: 110, end: 309 }] },
      { id: 'c', ranges: [{ start: 320, end: 419 }] },
    ],
    maxFetchBytes: 300,
    maxGapBytes: 10,
  });
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 99],
      [110, 309],
      [320, 419],
    ],
  );

  // Cap 310: [0,99] and [110,309] bridge into [0,309] (310). The last pair
  // [110,309] and [320,419] would only be 310 on their own, but against the
  // now-running [0,309] the span is 420 > 310; the planner never back-tracks,
  // so the last fetch stays separate even though it is only 10 bytes after
  // the running fetch's covered demand.
  const res2 = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 99 }] },
      { id: 'b', ranges: [{ start: 110, end: 309 }] },
      { id: 'c', ranges: [{ start: 320, end: 419 }] },
    ],
    maxFetchBytes: 310,
    maxGapBytes: 10,
  });
  const body2 = res2.json();
  assert.deepEqual(
    body2.fetches.map((f) => [f.start, f.end]),
    [
      [0, 309],
      [320, 419],
    ],
  );
});

test('one fetch covering disjoint demand records separate coverage segments', async () => {
  // One fetch [0,320] bridges a 20-byte gap; client b needs bytes on both
  // sides of the gap, so its coverage inside the fetch is two segments.
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 150 }] },
      { id: 'b', ranges: [{ start: 100, end: 200 }, { start: 300, end: 320 }] },
    ],
    maxFetchBytes: 500,
    maxGapBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[0, 320]]);
  const b = body.clients.find((c) => c.id === 'b');
  assert.deepEqual(b.coverage[0].ranges, [
    { start: 100, end: 200 },
    { start: 300, end: 320 },
  ]);
  assert.equal(b.coverage[0].bytes, 122);
  assert.equal(b.requestedBytes, 122);
  assert.equal(b.servedBytes, 122);
  assert.equal(b.missingBytes, 0);
});

test('fetches are ascending and mutually disjoint', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'c', ranges: [{ start: 900, end: 999 }] },
      { id: 'b', ranges: [{ start: 400, end: 400 }] },
      { id: 'a', ranges: [{ start: 0, end: 9 }, { start: 5, end: 20 }] },
    ],
    maxFetchBytes: 50,
    maxGapBytes: 0,
  });
  const body = res.json();
  const spans = body.fetches.map((f) => [f.start, f.end]);
  assert.deepEqual(spans, [[0, 20], [400, 400], [900, 949], [950, 999]]);
  for (let i = 1; i < spans.length; i += 1) assert.ok(spans[i][0] > spans[i - 1][1]);
});

test('per-client duplicate, nested and overlapping ranges are merged', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 99 }, { start: 0, end: 99 }, { start: 50, end: 60 }] },
    ],
    ...baseLimits,
  });
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[0, 99]]);
  assert.equal(body.clients[0].requestedBytes, 100);
  assert.equal(body.bytes.demand, 100);
});

test('client with empty ranges is reported as fully missing nothing', async () => {
  const res = await sharedFetch({
    size: 1000,
    clients: [
      { id: 'idle', ranges: [] },
      { id: 'busy', ranges: [{ start: 0, end: 9 }] },
    ],
    ...baseLimits,
  });
  const body = res.json();
  assert.equal(body.clientsCount, 2);
  const idle = body.clients.find((c) => c.id === 'idle');
  assert.deepEqual(idle, { id: 'idle', requestedBytes: 0, servedBytes: 0, missingBytes: 0, coverage: [] });
});

test('empty resource yields an empty plan', async () => {
  const res = await sharedFetch({ size: 0, clients: [], maxFetchBytes: 100, maxGapBytes: 0 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.fetchesCount, 0);
  assert.deepEqual(body.fetches, []);
  assert.deepEqual(body.clients, []);
  assert.deepEqual(body.bytes, { demand: 0, fetched: 0, extra: 0, resource: 0 });
});

test('no clients on a non-empty resource yields an empty plan', async () => {
  const res = await sharedFetch({ size: 1000, clients: [], maxFetchBytes: 100, maxGapBytes: 5 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches, []);
  assert.equal(body.bytes.demand, 0);
  assert.equal(body.bytes.fetched, 0);
  assert.equal(body.bytes.extra, 0);
});

test('large offsets stay within safe-integer precision', async () => {
  const size = Number.MAX_SAFE_INTEGER;
  const res = await sharedFetch({
    size,
    clients: [
      { id: 'a', ranges: [{ start: size - 2, end: size - 1 }] },
    ],
    maxFetchBytes: 1,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [size - 2, size - 2],
      [size - 1, size - 1],
    ],
  );
  assert.equal(body.bytes.demand, 2);
  assert.equal(body.bytes.fetched, 2);
});

test('single-byte fetch and rangeHeader values are usable Range header values', async () => {
  const res = await sharedFetch({
    size: 5,
    clients: [{ id: 'a', ranges: [{ start: 3, end: 3 }] }],
    maxFetchBytes: 1,
    maxGapBytes: 0,
  });
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => f.rangeHeader), ['bytes=3-3']);
});

test('byte accounting identities hold across mixed overlap and gaps', async () => {
  const res = await sharedFetch({
    size: 10000,
    clients: [
      { id: 'a', ranges: [{ start: 0, end: 999 }, { start: 5000, end: 5499 }] },
      { id: 'b', ranges: [{ start: 900, end: 2499 }, { start: 5500, end: 5505 }] },
      { id: 'c', ranges: [{ start: 2400, end: 3000 }] },
      { id: 'd', ranges: [] },
    ],
    maxFetchBytes: 1200,
    maxGapBytes: 30,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // Adjacent demand merges fully: [0,3000] splits at 1200/1200/601 and the
  // adjacent [5000,5505] is one fetch; no interior gaps remain here.
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end, f.bytes]),
    [
      [0, 1199, 1200],
      [1200, 2399, 1200],
      [2400, 3000, 601],
      [5000, 5505, 506],
    ],
  );

  // Fetches are ascending, mutually disjoint and capped.
  for (let i = 0; i < body.fetches.length; i += 1) {
    const f = body.fetches[i];
    assert.ok(f.bytes <= 1200, `fetch ${f.index} exceeds cap`);
    assert.equal(f.rangeHeader, `bytes=${f.start}-${f.end}`);
    assert.equal(f.bytes, f.demandBytes + f.extraBytes);
    if (i > 0) {
      const prev = body.fetches[i - 1];
      assert.ok(f.start > prev.end, 'fetches must be disjoint and ascending');
    }
  }

  // fetched = demand + extra, and per-fetch extra sums to the plan extra.
  assert.equal(body.bytes.fetched, body.fetches.reduce((s, f) => s + f.bytes, 0));
  assert.equal(
    body.bytes.extra,
    body.fetches.reduce((s, f) => s + f.extraBytes, 0),
  );
  assert.equal(body.bytes.fetched, body.bytes.demand + body.bytes.extra);

  // Every requested byte is served exactly once per client, coverage fetch
  // indexes reference real fetches, and client served totals reconcile.
  for (const client of body.clients) {
    let covered = 0;
    for (const entry of client.coverage) {
      assert.ok(body.fetches.some((f) => f.index === entry.fetchIndex));
      for (let i = 1; i < entry.ranges.length; i += 1) {
        assert.ok(entry.ranges[i].start > entry.ranges[i - 1].end);
      }
      covered += entry.bytes;
    }
    assert.equal(covered, client.servedBytes);
    assert.equal(client.servedBytes + client.missingBytes, client.requestedBytes);
  }
});

test('non-integer, negative or oversized size is rejected', async () => {
  for (const size of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1, null]) {
    const res = await sharedFetch({ size, clients: [], ...baseLimits });
    assert.equal(res.statusCode, 400, `expected 400 for size=${size}`);
  }
});

test('maxFetchBytes must be a positive safe integer', async () => {
  for (const maxFetchBytes of [0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await sharedFetch({ size: 100, clients: [], maxFetchBytes, maxGapBytes: 0 });
    assert.equal(res.statusCode, 400, `expected 400 for maxFetchBytes=${maxFetchBytes}`);
  }
});

test('maxGapBytes must be a non-negative safe integer', async () => {
  for (const maxGapBytes of [-1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await sharedFetch({ size: 100, clients: [], maxFetchBytes: 10, maxGapBytes });
    assert.equal(res.statusCode, 400, `expected 400 for maxGapBytes=${maxGapBytes}`);
  }
  // Zero is valid.
  const res = await sharedFetch({ size: 100, clients: [], maxFetchBytes: 10, maxGapBytes: 0 });
  assert.equal(res.statusCode, 200);
});

test('clients must be an array of client objects', async () => {
  for (const clients of [null, {}, 'x', [null], [1], [{ id: 'a' }], [{ ranges: [] }],
    [{ id: 'a', ranges: [], extra: 1 }]]) {
    const res = await sharedFetch({ size: 100, clients, ...baseLimits });
    assert.equal(res.statusCode, 400, `expected 400 for clients=${JSON.stringify(clients)}`);
  }
});

test('duplicate client ids are rejected with a semantic error code', async () => {
  const dup = await sharedFetch({
    size: 100,
    clients: [
      { id: 'a', ranges: [] },
      { id: 'a', ranges: [] },
    ],
    ...baseLimits,
  });
  assert.equal(dup.statusCode, 400);
  assert.equal(dup.json().code, 'DUPLICATE_CLIENT_ID');
});

test('empty, whitespace-only or CR/LF-bearing client ids are rejected', async () => {
  for (const id of ['', '   ', '\t', 'a\nb']) {
    const res = await sharedFetch({ size: 100, clients: [{ id, ranges: [] }], ...baseLimits });
    assert.equal(res.statusCode, 400, `expected 400 for id=${JSON.stringify(id)}`);
  }
});

test('ranges must be an array of interval objects', async () => {
  for (const ranges of [null, {}, '0-9', [null], [1], [{ start: 0 }],
    [{ start: 0, end: 9, extra: 1 }]]) {
    const res = await sharedFetch({ size: 100, clients: [{ id: 'a', ranges }], ...baseLimits });
    assert.equal(res.statusCode, 400, `expected 400 for ranges=${JSON.stringify(ranges)}`);
  }
});

test('range boundaries must be non-negative safe integers', async () => {
  for (const range of [
    { start: -1, end: 9 },
    { start: 0, end: -1 },
    { start: 0.5, end: 9 },
    { start: 0, end: 9.5 },
    { start: '0', end: 9 },
    { start: null, end: 9 },
  ]) {
    const res = await sharedFetch({ size: 100, clients: [{ id: 'a', ranges: [range] }], ...baseLimits });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(range)}`);
  }
});

test('inverted ranges are rejected', async () => {
  const res = await sharedFetch({
    size: 100,
    clients: [{ id: 'a', ranges: [{ start: 50, end: 10 }] }],
    ...baseLimits,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CLIENT_RANGE');
});

test('ranges reaching past the resource end are rejected', async () => {
  const res = await sharedFetch({
    size: 100,
    clients: [{ id: 'a', ranges: [{ start: 90, end: 100 }] }],
    ...baseLimits,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CLIENT_RANGE_OUT_OF_BOUNDS');
});

test('any demanded range is out of bounds on an empty resource', async () => {
  const res = await sharedFetch({
    size: 0,
    clients: [{ id: 'a', ranges: [{ start: 0, end: 0 }] }],
    ...baseLimits,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CLIENT_RANGE_OUT_OF_BOUNDS');
});

test('missing required fields are rejected by schema validation', async () => {
  for (const payload of [
    {},
    { size: 100 },
    { size: 100, clients: [] },
    { size: 100, clients: [], maxFetchBytes: 10 },
  ]) {
    const res = await sharedFetch(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('unknown top-level fields are rejected by the strict validator', async () => {
  const res = await sharedFetch({
    size: 100,
    clients: [],
    maxFetchBytes: 10,
    maxGapBytes: 0,
    surprise: 1,
  });
  assert.equal(res.statusCode, 400);
});

test('error responses carry the shared error shape', async () => {
  const res = await sharedFetch({
    size: 100,
    clients: [{ id: 'a', ranges: [{ start: 5, end: 1 }] }],
    ...baseLimits,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, 'Bad Request');
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
});

test('existing endpoints are unaffected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/resume-plan',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 1000, completed: [], chunkBytes: 400, limit: 10 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().requestsCount, 3);
});

// The HTTP route delegates structural/type rejection to Fastify's strict
// validator; the planner's own codes are exercised by calling it directly.
test('planner reports typed codes for invalid scalar parameters', () => {
  assert.equal(planSharedFetch({ size: -1, clients: [], maxFetchBytes: 1, maxGapBytes: 0 }).code, 'INVALID_SIZE');
  assert.equal(
    planSharedFetch({ size: 1, clients: [], maxFetchBytes: 0, maxGapBytes: 0 }).code,
    'INVALID_MAX_FETCH_BYTES',
  );
  assert.equal(
    planSharedFetch({ size: 1, clients: [], maxFetchBytes: 1, maxGapBytes: -1 }).code,
    'INVALID_MAX_GAP_BYTES',
  );
});

test('planner reports typed codes for malformed client payloads', () => {
  const opts = (clients) => ({ size: 100, clients, maxFetchBytes: 10, maxGapBytes: 0 });
  assert.equal(planSharedFetch(opts(null)).code, 'INVALID_CLIENTS');
  assert.equal(planSharedFetch(opts([null])).code, 'INVALID_CLIENT');
  assert.equal(planSharedFetch(opts([{ id: '', ranges: [] }])).code, 'INVALID_CLIENT_ID');
  assert.equal(planSharedFetch(opts([{ id: 'a', ranges: null }])).code, 'INVALID_CLIENT_RANGES');
  assert.equal(
    planSharedFetch(opts([{ id: 'a', ranges: [null] }])).code,
    'INVALID_CLIENT_RANGE',
  );
  assert.equal(
    planSharedFetch(opts([{ id: 'a', ranges: [{ start: 'a', end: 9 }] }])).code,
    'INVALID_CLIENT_RANGE',
  );
});
