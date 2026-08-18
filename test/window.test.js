import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { parseSince, resolveWindow } from '../src/args/time.js';
import { fetchEvents } from '../src/query.js';
import { makeCounters } from '../src/aws/client.js';

/**
 * 나가는 요청만 가로채는 클라이언트.
 * 페이지네이터가 `instanceof CloudWatchLogsClient` 를 검사하므로 진짜 클라이언트를 쓰고,
 * 미들웨어에서 HTTP 로 못 나가게 막는다.
 */
function stubClient(sent) {
  const client = new CloudWatchLogsClient({
    region: 'ap-northeast-2',
    credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
  });
  client.middlewareStack.add(
    (_next) => async (args) => {
      sent.push(args.input);
      return { output: { events: [], $metadata: {} }, response: { headers: {} } };
    },
    { step: 'initialize', priority: 'low', name: 'stub', override: true },
  );
  return client;
}

const NOW = Date.parse('2026-08-14T15:00:00+09:00');

test('상대 시간과 ISO 날짜를 모두 받는다', () => {
  assert.equal(parseSince('1h', NOW), NOW - 3_600_000);
  assert.equal(parseSince('2026-08-14T09:00:00+09:00'), Date.parse('2026-08-14T09:00:00+09:00'));
  assert.equal(parseSince('2026-08-14'), Date.parse('2026-08-14'));
});

test('--until 이 없으면 끝은 현재', () => {
  const { startMs, endMs } = resolveWindow({ since: '1h' }, NOW);
  assert.equal(endMs, NOW);
  assert.equal(startMs, NOW - 3_600_000);
});

test('시작이 끝보다 뒤면 거부한다', () => {
  assert.throws(() => resolveWindow({ since: '1h', until: '2h' }, NOW), /뒤입니다/);
});

/**
 * --until 이 조회에 실제로 반영되는지.
 *
 * 예전엔 poll.js 가 endTime 을 무조건 Date.now() 로 잡아서 --until 이 **조용히 무시**됐다.
 * dry-run 은 지킨다고 말하면서 실제로는 현재까지 긁어왔다 — 화면과 동작이 달랐다.
 * 이 테스트는 endMs 가 FilterLogEvents 요청까지 흘러가는지를 본다.
 */
test('--until 이 FilterLogEvents 요청의 endTime 으로 전달된다', async () => {
  const sent = [];
  const client = stubClient(sent);

  const startMs = Date.parse('2026-08-14T09:00:00+09:00');
  const endMs = Date.parse('2026-08-14T10:00:00+09:00');

  await fetchEvents({
    ctx: { client, groupNames: ['/app/x'], counters: makeCounters() },
    ir: [],
    startMs,
    endMs,
    limit: 10,
    values: {},
    signal: new AbortController().signal,
  });

  assert.ok(sent.length > 0, '요청이 나가야 한다');
  assert.equal(sent[0].endTime, endMs, 'endTime 이 --until 값이어야 한다');
  assert.ok(sent[0].startTime <= startMs, 'startTime 은 시작 시각 이하(lookback 포함)');
});

test('--until 이 없으면 endTime 은 현재 근처', async () => {
  const sent = [];
  const client = stubClient(sent);
  const before = Date.now();

  await fetchEvents({
    ctx: { client, groupNames: ['/app/x'], counters: makeCounters() },
    ir: [],
    startMs: before - 60_000,
    limit: 10,
    values: {},
    signal: new AbortController().signal,
  });

  assert.ok(sent[0].endTime >= before, 'endTime 이 현재 이상이어야 한다');
});
