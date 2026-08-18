import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';

export function makeCounters() {
  return { requests: 0, bytes: 0, events: 0, redundant: 0, byOp: Object.create(null), estimated: false };
}

/**
 * 응답 크기를 wire 의 content-length 로 센다. 없으면 본문 길이로 근사하고
 * estimated 를 세워 요약에 '근사치' 라고 밝힌다.
 */
function attachCostMiddleware(client, counters) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      counters.requests += 1;
      counters.byOp[context.commandName] = (counters.byOp[context.commandName] ?? 0) + 1;
      const result = await next(args);
      const len = Number(result.response?.headers?.['content-length']);
      if (Number.isFinite(len)) {
        counters.bytes += len;
      } else {
        counters.estimated = true;
        try {
          counters.bytes += Buffer.byteLength(JSON.stringify(result.output ?? {}), 'utf8');
        } catch { /* 순환 참조 등 — 무시 */ }
      }
      return result;
    },
    { name: 'milogCost', step: 'deserialize', priority: 'low', override: true },
  );
}

/**
 * mode:
 *   'poll'     폴링 — adaptive 재시도. ap-northeast-2 의 FilterLogEvents 는 10 TPS 라
 *              10그룹 × 1초면 정확히 천장에 닿는다. 클라이언트측 토큰 버킷이 필요하다.
 *   'livetail' 스트리밍 — requestTimeout 0. 기본 20초면 조용한 스트림을 끊어버린다.
 *   'oneshot'  단발 조회 — 첫 요청 지연이 그대로 체감되므로 standard.
 */
export function createLogsClient({ region, profile, credentials, mode = 'oneshot', counters }) {
  const client = new CloudWatchLogsClient({
    region,
    profile,
    credentials,
    maxAttempts: mode === 'poll' ? 5 : 3,
    retryMode: mode === 'poll' ? 'adaptive' : 'standard',
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: mode === 'livetail' ? 0 : 20_000,
    },
  });
  if (counters) attachCostMiddleware(client, counters);
  return client;
}

/** 계정·리전당 TPS 천장 아래로 요청을 고르게 편다. */
export function tokenBucket(ratePerSec = 8) {
  let tokens = ratePerSec;
  let last = Date.now();
  return async function take() {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(ratePerSec, tokens + ((now - last) / 1000) * ratePerSec);
      last = now;
      if (tokens >= 1) { tokens -= 1; return; }
      await new Promise((r) => setTimeout(r, Math.ceil((1 - tokens) / ratePerSec * 1000)));
    }
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function usageSummary(counters, elapsedMs) {
  const parts = [
    `요청 ${counters.requests.toLocaleString()}회`,
    `이벤트 ${counters.events.toLocaleString()}건`,
    `수신 ${counters.estimated ? '약 ' : ''}${formatBytes(counters.bytes)}`,
  ];
  if (counters.redundant > 0) {
    parts.push(`재조회 ${(counters.redundant / Math.max(1, counters.events)).toFixed(1)}×`);
  }
  const head = Number.isFinite(elapsedMs) ? `${formatDuration(elapsedMs)} 동안 ` : '';
  return `  ${head}${parts.join(' · ')}`;
}
