// Shared origin-fetch planner.
//
// Several clients request the same resource in parallel. Each client states
// the closed byte intervals it needs; the planner coalesces the demand across
// clients and produces a shared list of Range fetches to send to the origin:
//
//   1. Merge every client's overlapping or adjacent intervals, then split the
//      merged demand into candidates no longer than `maxFetchBytes` each.
//   2. Walk the candidates left to right and merge a candidate into the
//      running fetch only when the gap between them is at most `maxGapBytes`
//      and the combined fetch would not exceed `maxFetchBytes`.
//
// Output fetches are ascending, mutually disjoint closed intervals and carry
// a ready-to-use Range header value. The response also records, per client,
// which bytes of each planned fetch serve that client, plus the byte
// accounting for deduplicated demand, bytes actually fetched and extra bytes.

export const MAX_CLIENTS = 1000;
export const MAX_RANGES_PER_CLIENT = 10000;
export const MAX_CLIENT_ID_LENGTH = 255;

/**
 * Plan the shared origin fetches for parallel client demand.
 *
 * @returns a result object with `statusCode` 200 carrying the fetch plan,
 *          or a 400 result describing the first validation failure.
 */
export function planSharedFetch(options) {
  const { size, clients, maxFetchBytes, maxGapBytes } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxFetchBytes) || maxFetchBytes < 1) {
    return fail('INVALID_MAX_FETCH_BYTES', 'maxFetchBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxGapBytes) || maxGapBytes < 0) {
    return fail('INVALID_MAX_GAP_BYTES', 'maxGapBytes must be a non-negative safe integer');
  }
  if (!Array.isArray(clients)) {
    return fail('INVALID_CLIENTS', 'clients must be an array of {id, ranges} entries');
  }
  if (clients.length > MAX_CLIENTS) {
    return fail(
      'TOO_MANY_CLIENTS',
      `clients carries ${clients.length} entries; at most ${MAX_CLIENTS} are allowed`,
    );
  }

  const seenIds = new Set();
  // Per-client merged intervals, kept in the clients' input order.
  const clientIntervals = [];

  for (let i = 0; i < clients.length; i += 1) {
    const client = clients[i];
    if (client === null || typeof client !== 'object' || Array.isArray(client)) {
      return fail('INVALID_CLIENT', `clients[${i}] must be an object with id and ranges`);
    }
    const { id, ranges } = client;

    if (typeof id !== 'string' || id.trim().length === 0 || /[\r\n]/.test(id)) {
      return fail(
        'INVALID_CLIENT_ID',
        `clients[${i}].id must be a non-empty, header-safe string`,
      );
    }
    if (id.length > MAX_CLIENT_ID_LENGTH) {
      return fail(
        'INVALID_CLIENT_ID',
        `clients[${i}].id exceeds the ${MAX_CLIENT_ID_LENGTH}-byte limit`,
      );
    }
    if (seenIds.has(id)) {
      return fail('DUPLICATE_CLIENT_ID', `duplicate client id '${id}'`);
    }
    seenIds.add(id);

    if (!Array.isArray(ranges)) {
      return fail('INVALID_CLIENT_RANGES', `clients[${i}].ranges must be an array of {start, end} intervals`);
    }
    if (ranges.length > MAX_RANGES_PER_CLIENT) {
      return fail(
        'TOO_MANY_CLIENT_RANGES',
        `clients[${i}].ranges carries ${ranges.length} intervals; at most ${MAX_RANGES_PER_CLIENT} are allowed`,
      );
    }

    for (let j = 0; j < ranges.length; j += 1) {
      const range = ranges[j];
      const where = `clients[${i}].ranges[${j}]`;
      if (range === null || typeof range !== 'object' || Array.isArray(range)) {
        return fail('INVALID_CLIENT_RANGE', `${where} must be an object with start and end`);
      }
      const { start, end } = range;
      if (!Number.isSafeInteger(start) || start < 0) {
        return fail('INVALID_CLIENT_RANGE', `${where}.start must be a non-negative safe integer`);
      }
      if (!Number.isSafeInteger(end) || end < 0) {
        return fail('INVALID_CLIENT_RANGE', `${where}.end must be a non-negative safe integer`);
      }
      if (start > end) {
        return fail('INVALID_CLIENT_RANGE', `${where} has start ${start} after end ${end}`);
      }
      if (end >= size) {
        return fail(
          'CLIENT_RANGE_OUT_OF_BOUNDS',
          `${where} end ${end} lies outside the ${size}-byte resource`,
        );
      }
    }

    clientIntervals.push({ id, intervals: mergeIntervals(ranges) });
  }

  // Union of every client's merged demand: overlapping or adjacent needs are
  // coalesced across client boundaries before chunking.
  const demand = mergeIntervals(
    clientIntervals.flatMap((entry) => entry.intervals),
  );

  const demandBytes = demand.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);

  // Step 1: split each merged demand interval into maxFetchBytes-sized chunks.
  const chunks = [];
  for (const interval of demand) {
    for (let start = interval.start; start <= interval.end; start += maxFetchBytes) {
      const end = Math.min(start + maxFetchBytes - 1, interval.end);
      chunks.push({ start, end });
    }
  }

  // Step 2: left-to-right coalescing across gaps. Two chunks from the same
  // demand interval were cut adjacent to one another (gap 0), but their
  // combined length exceeds maxFetchBytes by construction, so the length guard
  // below keeps them apart; only gap-bridging merges can succeed.
  const fetchSpans = [];
  for (const chunk of chunks) {
    const last = fetchSpans[fetchSpans.length - 1];
    const gap = last ? chunk.start - last.end - 1 : Infinity;
    const mergedLength = last ? chunk.end - last.start + 1 : Infinity;
    if (last && gap <= maxGapBytes && mergedLength <= maxFetchBytes) {
      last.end = chunk.end;
    } else {
      fetchSpans.push({ start: chunk.start, end: chunk.end });
    }
  }

  const fetches = fetchSpans.map((span, index) => ({
    index: index + 1,
    start: span.start,
    end: span.end,
    bytes: span.end - span.start + 1,
    rangeHeader: `bytes=${span.start}-${span.end}`,
  }));

  // Bytes of the deduplicated demand that each fetch actually covers. The
  // remaining fetch bytes are gap fill (extraFetchBytes below).
  for (const fetch of fetches) {
    let demandCovered = 0;
    for (const interval of demand) {
      const start = Math.max(fetch.start, interval.start);
      const end = Math.min(fetch.end, interval.end);
      if (start <= end) demandCovered += end - start + 1;
    }
    fetch.demandBytes = demandCovered;
    fetch.extraBytes = fetch.bytes - demandCovered;
  }

  // Per-client accounting: intersect every fetch with that client's merged
  // demand, emitting the covered closed interval(s).
  const clientsReport = clientIntervals.map(({ id, intervals }) => {
    const requestedBytes = intervals.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);
    const coverage = [];
    let servedBytes = 0;
    for (const fetch of fetches) {
      const segments = [];
      for (const interval of intervals) {
        const start = Math.max(fetch.start, interval.start);
        const end = Math.min(fetch.end, interval.end);
        if (start <= end) segments.push({ start, end });
      }
      if (segments.length > 0) {
        const bytes = segments.reduce((sum, segment) => sum + (segment.end - segment.start + 1), 0);
        servedBytes += bytes;
        coverage.push({ fetchIndex: fetch.index, ranges: segments, bytes });
      }
    }
    return {
      id,
      requestedBytes,
      servedBytes,
      missingBytes: requestedBytes - servedBytes,
      coverage,
    };
  });

  const fetchBytes = fetches.reduce((sum, fetch) => sum + fetch.bytes, 0);
  const extraFetchBytes = fetchBytes - demandBytes;

  return {
    statusCode: 200,
    resource: { size },
    limits: { maxFetchBytes, maxGapBytes },
    clientsCount: clientsReport.length,
    fetchesCount: fetches.length,
    fetches,
    clients: clientsReport,
    bytes: {
      demand: demandBytes,
      fetched: fetchBytes,
      extra: extraFetchBytes,
      resource: size,
    },
  };
}

/**
 * Sort intervals by start offset and merge overlapping or adjacent ones
 * ([0-9] and [10-19] are adjacent: no byte sits between them).
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
