import { UsageError } from '../util/errors.js';

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * '30s' '10m' '2h' '1d' '1w' | 'today' | ISO-8601 → epoch ms.
 * 단위는 하나만 받는다 (옛 판과 동일 — '1h30m' 은 거부).
 */
export function parseSince(spec, now = Date.now()) {
  const s = String(spec ?? '').trim();
  if (!s) throw new UsageError('시간 값이 비어 있습니다.');

  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (s === 'now') return now;

  const rel = /^(\d+)([smhdw])$/.exec(s);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new UsageError(`날짜를 해석할 수 없습니다: ${s}`);
    return t;
  }
  throw new UsageError(
    `시간 형식이 잘못됐습니다: ${s}`,
  );
}

export function resolveWindow({ since, until }, now = Date.now()) {
  const endMs = until ? parseSince(until, now) : now;
  const startMs = parseSince(since, now);
  if (startMs >= endMs) throw new UsageError('--since 가 --until 보다 뒤입니다.');
  return { startMs, endMs };
}

export const spansMidnight = (startMs, endMs) =>
  new Date(startMs).toDateString() !== new Date(endMs).toDateString();
