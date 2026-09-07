import { paginateFilterLogEvents } from '@aws-sdk/client-cloudwatch-logs';
import { classify, isTerminal, describe, MilogError } from '../util/errors.js';
import { ui } from '../util/out.js';

export const sleep = (ms, signal) => new Promise((resolve) => {
  if (ms <= 0) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** 동시 실행 상한이 있는 map. fn 은 절대 reject 하지 않아야 한다. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 관측된 수집 지연의 대략적인 상위 분위수. */
function rollingQuantile(q = 0.99, size = 256) {
  const buf = [];
  return {
    push(v) { buf.push(v); if (buf.length > size) buf.shift(); },
    value() {
      if (!buf.length) return null;
      const s = [...buf].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * q))];
    },
  };
}

const LOOKBACK_MIN = 2_000;
const LOOKBACK_MAX = 120_000;
const SEEN_MAX = 50_000;

function nextLookback(st, cfg) {
  if (cfg.lookbackMs !== 'auto') return Math.max(0, Number(cfg.lookbackMs) || 0);
  const observed = st.lagP99.value() ?? 0;
  return Math.min(LOOKBACK_MAX, Math.max(LOOKBACK_MIN, Math.ceil(observed * 2)));
}

function pruneSeen(st, lookback) {
  if (st.seen.size < 1_000) return;
  const floor = Math.max(st.cursor, st.scannedTo) - lookback - 5_000;
  for (const [id, ts] of st.seen) if (ts < floor) st.seen.delete(id);
  if (st.seen.size > SEEN_MAX) {
    const entries = [...st.seen].sort((a, b) => a[1] - b[1]).slice(Math.floor(SEEN_MAX / 2));
    st.seen = new Map(entries);
    if (!st.warnedSeen) {
      st.warnedSeen = true;
      ui.warn(`  ${st.group}: 중복 제거 버퍼가 커서 절반을 비웠습니다 (--lookback 을 줄이세요).`);
    }
  }
}

/**
 * FilterLogEvents 폴링.
 *
 * 커서 알고리즘은 옛 PowerShell 판을 그대로 옮겼다. 커서를 마지막 타임스탬프에 두고
 * '그 ms 의 eventId 집합' 만 기억한다. +1ms 로 건너뛰면 같은 ms 에 있던 다른 이벤트가
 * 영구히 사라진다 — startTime 은 inclusive 이고 타임스탬프는 ms 단위라 한 ms 에 여러
 * 이벤트가 흔하다.
 *
 * 여기에 두 가지를 더했다:
 *   1) nextToken 을 끝까지 따라간다. FilterLogEvents 는 매치 0건인 페이지를
 *      nextToken 과 함께 돌려주기 때문에, 안 따라가면 희소한 필터 매치를 놓친다
 *      (옛 판의 실제 버그 — 실측 재현됨).
 *   2) 커서보다 뒤에서 다시 훑는 lookback. startTime 은 이벤트 시각 기준이라,
 *      늦게 수집된 이벤트는 커서가 이미 지나가서 조용히 유실됐다.
 */
export async function* pollLogEvents({
  client, groups, filterPattern, startMs, cfg, counters, signal, onGroupDropped,
}) {
  const state = new Map(groups.map((g) => [g, {
    group: g,
    cursor: startMs,
    seen: new Map(),
    lagP99: rollingQuantile(0.99, 512),
    strikes: 0,
    alive: true,
    warnedSeen: false,
    // 첫 조회에서는 '늦게 도착' 판정을 하지 않는다. 시작 경계 앞쪽 lookback 구간의
    // 정상 이벤트가 전부 지연 도착으로 오인된다.
    primed: false,
    // '여기까지는 이미 훑었다' 지점. 커서만 쓰면 조용한 그룹에서 창이 계속 넓어져
    // 같은 이벤트를 매 틱 다시 받는다 (커서는 마지막 이벤트에 멈춰 있으므로).
    scannedTo: startMs,
    // 틱 상한에 걸려 중간에 끊었을 때 이어받을 자리.
    //
    // 커서만으로는 그 자리로 못 돌아온다 — 한 ms 에 이벤트가 몰려 페이지를 가득
    // 채우면 그 페이지의 maxTs 가 커서를 넘지 못해, 다음 틱이 똑같은 창으로
    // 똑같은 첫 페이지를 받고 영구히 멈춘다 (하루 조회가 6천 건에서 정지하던 원인).
    nextToken: null,
    tokenFrom: startMs,  // 그 토큰을 만든 요청의 startTime. 파라미터가 같아야 토큰이 유효하다
    advanced: false,     // 이 틱에 조금이라도 나아갔는가 (정지 감지용)
  }]));

  // 과거 구간 조회는 사용자가 준 끝 시각을 지킨다. 예전엔 무조건 Date.now() 라
  // --until 이 조용히 무시됐다 (dry-run 은 지킨다고 말하면서).
  const endTime = cfg.follow ? undefined : (cfg.endMs ?? Date.now());
  let capHit = false;
  const dropped = new Map();

  const drop = (g, reason) => {
    const st = state.get(g);
    if (!st.alive) return;
    st.alive = false;
    dropped.set(g, reason);
    onGroupDropped?.(g, reason);
  };

  async function fetchGroup(g) {
    const st = state.get(g);
    if (!st.alive) return [];

    const lookback = nextLookback(st, cfg);
    const out = [];
    let maxTs = -1;
    let pages = 0;
    let scanned = 0;
    let localCap = false;
    const queryEnd = endTime ?? Date.now();
    const cursorBefore = st.cursor;

    // 지난 틱을 상한 때문에 끊었으면 그 자리에서 이어받는다. 토큰은 **같은 요청
    // 파라미터**에서만 유효하므로 startTime 도 그때 값을 그대로 쓴다.
    const resuming = st.nextToken != null;
    // 이어받는 게 아니면, 이미 훑은 지점에서 lookback 만큼만 물러난다.
    // 그 앞은 본 적이 있거나 없던 구간이다.
    const from = resuming
      ? st.tokenFrom
      : Math.max(0, Math.max(st.cursor, st.scannedTo) - lookback);

    try {
      const pager = paginateFilterLogEvents(
        // pageSize 는 '한 번에 돌려줄 최대 건수' 다. 필요한 양이 적으면 줄여야
        // 200건 보여주려고 한 페이지(최대 1 MB)를 통째로 받는 일이 없다.
        { client, pageSize: cfg.pageSize ?? 10_000, ...(resuming && { startingToken: st.nextToken }) },
        {
          logGroupName: g,
          startTime: from,
          ...(endTime !== undefined && { endTime }),
          ...(filterPattern && { filterPattern }),
        },
      );

      for await (const page of pager) {
        for (const e of page.events ?? []) {
          scanned += 1;
          if (e.timestamp > maxTs) maxTs = e.timestamp;
          if (typeof e.ingestionTime === 'number') {
            st.lagP99.push(Math.max(0, e.ingestionTime - e.timestamp));
          }
          if (st.seen.has(e.eventId)) { counters.redundant += 1; continue; }
          st.seen.set(e.eventId, e.timestamp);
          out.push({
            group: g,
            timestamp: e.timestamp,
            eventId: e.eventId,
            message: e.message,
            logStreamName: e.logStreamName,
            ingestionTime: e.ingestionTime,
            late: cfg.follow && st.primed && e.timestamp < st.cursor,
          });
        }
        pages += 1;
        if (pages >= cfg.maxPagesPerTick || scanned >= cfg.maxEventsPerTick) {
          capHit = true;
          localCap = true;
          st.nextToken = page.nextToken ?? null;
          st.tokenFrom = from;
          break;
        }
        if (signal.aborted) break;
      }
      // 끝까지 훑었으면 이어받을 자리가 없다.
      if (!localCap) st.nextToken = null;

      st.strikes = 0;
      // API 가 돌려준 집합으로만 커서를 옮긴다. 필터링 뒤 집합으로 계산하면
      // 전부 중복인 틱에서 maxTs 가 -1 이 되어 커서가 망가진다.
      if (maxTs >= 0 && maxTs > st.cursor) st.cursor = maxTs;
      // 페이지 상한에 걸려 중간에 끊었으면 끝까지 훑은 게 아니다 — 표시를 옮기지 않는다.
      if (!localCap) st.scannedTo = Math.max(st.scannedTo, queryEnd);
      st.primed = true;
      pruneSeen(st, lookback);
      st.advanced = out.length > 0 || st.nextToken != null || st.cursor > cursorBefore;
    } catch (err) {
      // 토큰은 요청 파라미터에 묶여 있다 — 실패한 뒤에도 들고 있으면 같은 자리에서
      // 계속 넘어진다. 커서 기반으로 되돌려 복구한다.
      st.nextToken = null;
      st.advanced = out.length > 0;
      handleGroupError(g, st, err);
    }
    return out;
  }

  /**
   * 그룹이 전부 떨어져 나갔으면 '결과 없음' 이 아니라 실패다.
   * 잘못된 필터 패턴이 조용히 exit 0 으로 끝나면 스크립트가 속는다.
   */
  function assertNotAllDropped() {
    if (dropped.size > 0 && dropped.size === groups.length) {
      throw new MilogError(`모든 로그 그룹 조회에 실패했습니다 (${groups.length}개).`, {
        hint: [...dropped.values()][0],
        exitCode: 2,
      });
    }
  }

  function handleGroupError(g, st, err) {
    const cls = classify(err);
    if (cls === 'auth') throw err; // 위에서 재인증 후 재개한다

    const d = describe(err, { group: g });
    if (isTerminal(cls)) {
      ui.error(`  ${d.text}`);
      if (d.hint) ui.dim(`    ${d.hint}`);
      drop(g, d.text);
      return;
    }
    st.strikes += 1;
    if (st.strikes >= 5) {
      ui.error(`  ${g}: 연속 ${st.strikes}회 실패로 이 그룹을 중단합니다 — ${d.text}`);
      drop(g, d.text);
      return;
    }
    ui.warn(`  ${g}: ${d.text} (재시도 ${st.strikes}/5)`);
  }

  for (;;) {
    if (signal.aborted) return;
    const live = groups.filter((g) => state.get(g).alive);
    if (live.length === 0) { assertNotAllDropped(); return; }

    capHit = false;
    const batches = await mapLimit(live, cfg.concurrency, fetchGroup);

    const merged = batches.flat().sort(
      (a, b) => a.timestamp - b.timestamp || String(a.eventId).localeCompare(String(b.eventId)),
    );
    // 이벤트 하나씩이 아니라 틱 단위로 넘긴다. span 은 끝날 때 기록되므로 자식이
    // 부모보다 먼저 오는데, 묶음으로 받아야 소비자가 조상을 먼저 훑어보고
    // 중첩 깊이를 제대로 매길 수 있다.
    if (merged.length) {
      counters.events += merged.length;
      yield merged;
    }

    // 단발 조회(follow 없음)에서도 확인해야 한다 — 아래 return 으로 바로 빠져나가므로
    // 루프 상단의 검사가 영영 돌지 않는다.
    assertNotAllDropped();
    if (signal.aborted) return;

    // 과거 구간 조회는 '한 덩어리로 다 모아서 한 번' 이 아니라 조각씩 이어서 낸다.
    // maxEventsPerTick 을 적당히 잡으면 소비자가 받는 대로 화면에 뿌릴 수 있고,
    // 다 훑었으면(상한에 안 걸렸으면) 거기서 끝난다.
    if (!cfg.follow) {
      if (!capHit) return;
      // 상한에 걸렸는데 어느 그룹도 나아가지 못했으면 더 받을 것이 없다 — 이어받을
      // 토큰도, 새 이벤트도, 커서 전진도 없는 상태다. 여기서 안 멈추면 같은 페이지를
      // 무한히 다시 받으며 "조회 중" 으로 남는다.
      if (live.every((g) => !state.get(g).advanced)) {
        ui.warn('  더 나아가지 못해 조회를 멈춥니다 — 구간을 좁혀 다시 조회해 보세요.');
        return;
      }
      continue;
    }

    // 따라잡는 중이면 쉬지 않고 바로 다음 페이지로 간다.
    if (!capHit) await sleep(cfg.intervalMs, signal);
    else ui.dim('  따라잡는 중…');
  }
}

export const pollDefaults = {
  intervalMs: 3000,
  concurrency: 5,
  follow: true,
  lookbackMs: 'auto',
  maxPagesPerTick: 20,
  maxEventsPerTick: 20_000,
};
