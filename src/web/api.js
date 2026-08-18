import { discoverProfiles, resolvePrefix } from '../aws/profiles.js';
import { createLogsClient } from '../aws/client.js';
import { pollLogEvents, pollDefaults } from '../aws/poll.js';
import { buildIR } from '../filter/dsl.js';
import { compilePattern, compilePredicate, explainResidual } from '../filter/compile.js';
import { normalize } from '../model/event.js';
import { assignDepths, orderByTrace, makeDepthResolver } from '../model/depth.js';
import { buildTraceTree } from '../model/trace.js';
import { fetchEvents } from '../query.js';
import { resolveWindow, parseSince } from '../args/time.js';
import { MAX_GROUPS } from '../config.js';
import { loadSettings, saveSettings } from '../state/settings.js';
import { stateDir } from '../state/paths.js';
import { buildWebContext, buildBase } from './context.js';
import { MilogError } from '../util/errors.js';


/** 브라우저에 보낼 때 body/raw 는 뺀다 — 같은 내용이 두 번 실린다. */
const slim = (ev) => {
  const { body, raw, ...rest } = ev;
  return rest;
};

const csv = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** 쿼리스트링 → DSL 값. CLI 의 플래그와 같은 이름을 쓴다. */
function dslFrom(q) {
  const v = {};
  if (q.get('error') === '1') v.error = true;
  if (q.get('grep')) v.grep = [q.get('grep')];
  if (q.get('trace')) v.trace = q.get('trace');
  if (q.get('filter')) v.filter = q.get('filter');
  return v;
}

async function ctxFrom(q) {
  return buildWebContext({
    profileName: q.get('profile'),
    region: q.get('region') || undefined,
    groupNames: csv(q.get('groups')),
    refresh: q.get('refresh') === '1',
  });
}

export const routes = {
  /** 부팅 정보 — 화면이 서버와 같은 임계값·상한을 쓰도록 내려준다. */
  async '/api/bootstrap'() {
    const { profiles } = await discoverProfiles({ prefix: resolvePrefix(undefined) });
    return {
      profiles: profiles.map((p) => ({ name: p.name, region: p.region, label: p.label })),
      maxGroups: MAX_GROUPS,
      // 설정은 여기 한 번에 실어 보낸다 — 따로 부르면 왕복만 는다.
      settings: await loadSettings(),
      // 설정이 어디 저장되는지 보여준다 — 브라우저가 아니라 여기라는 걸 알아야
      // 다른 포트로 다시 띄워도 남아 있는 이유가 설명된다.
      stateDir: stateDir(),
    };
  },

  /**
   * 설정 저장. 라우터가 메서드를 구분하지 않고 핸들러는 쿼리스트링만 받으므로
   * 그 형태를 그대로 따른다 — 이거 하나 때문에 본문 파서를 들일 이유가 없다.
   * 토큰이 쿠키가 아니라 URL 에 있어 교차 출처에서 흉내 낼 수 없고,
   * Host 검증·CORS 차단이 이미 걸려 있다.
   */
  async '/api/settings'(q) {
    const patch = {};
    for (const [k, v] of q.entries()) if (k !== 't') patch[k] = v;
    return { settings: await saveSettings(patch) };
  },

  async '/api/groups'(q) {
    const base = await buildBase({
      profileName: q.get('profile'),
      region: q.get('region') || undefined,
      refresh: q.get('refresh') === '1',
    });
    return { groups: base.allGroups, cached: base.cached, at: base.at, region: base.region };
  },

  async '/api/search'(q) {
    const ctx = await ctxFrom(q);
    const values = { ...dslFrom(q), since: q.get('since') || '1h', until: q.get('until') || undefined };
    const ir = buildIR(values);
    const { startMs, endMs } = resolveWindow(values);
    const limit = Math.min(Number(q.get('limit') ?? 1000) || 1000, 20_000);

    const { events, pattern, truncated } = await fetchEvents({ ctx, ir, startMs, endMs, limit, values, signal: q.signal });
    assignDepths(events);
    const ordered = q.get('tree') === '0' ? events : orderByTrace(events);

    const { residual } = values.filter ? { residual: [] } : compilePattern(ir);
    return {
      events: ordered.map(slim),
      truncated,
      limit,
      pattern: pattern ?? null,
      residual: explainResidual(residual),
      usage: ctx.counters,
    };
  },

  async '/api/trace'(q) {
    const traceId = q.get('trace');
    if (!traceId || !/^[0-9a-f]{6,32}$/i.test(traceId)) {
      throw new MilogError(`trace_id 형식이 아닙니다: ${traceId ?? ''}`, { exitCode: 400 });
    }
    const ctx = await ctxFrom(q);
    const values = { trace: traceId, since: q.get('since') || '1h' };
    const ir = buildIR(values);
    const { startMs, endMs } = resolveWindow(values);

    const { events } = await fetchEvents({ ctx, ir, startMs, endMs, limit: 10_000, values, signal: q.signal });
    if (!events.length) return { found: false, traceId };

    const tree = buildTraceTree(events);
    const distinct = [...new Set(events.map((e) => e.traceId).filter(Boolean))];

    // 트리를 그대로 직렬화하면 ev.body 가 통째로 실린다. 필요한 것만 추린다.
    const pack = (n) => ({
      id: n.id,
      parentId: n.parentId,
      orphan: n.orphan,
      cycle: n.cycle,
      dupes: n.dupes.length,
      ev: slim(n.ev),
      logs: n.logs.map(slim),
      children: n.children.map(pack),
    });

    return {
      found: true,
      traceId,
      distinct,
      t0: tree.t0,
      t1: tree.t1,
      totalSpans: tree.totalSpans,
      orphanCount: tree.orphanCount,
      callerTraces: tree.callerTraces,
      unattached: tree.unattached.map(slim),
      roots: tree.roots.map(pack),
      usage: ctx.counters,
    };
  },
};

/**
 * SSE 스트림. 실시간(`follow=1`)과 과거 구간(`follow=0`) 둘 다 이 경로를 쓴다.
 *
 * 과거 구간도 스트리밍으로 흘리므로 **건수 상한이 필요 없다** — 받는 대로 화면에 쌓이고,
 * 사용자가 언제든 중지할 수 있다. 조용히 잘라 놓고 "이게 전부" 로 오해하게 두는 것보다 낫다.
 *
 * 탭을 닫으면 signal 이 abort 되어 폴링이 즉시 멈춘다 — 이게 없으면 브라우저를 닫아도
 * 서버가 CloudWatch 를 계속 긁는다. CLI 의 --max-minutes 안전장치에 해당하는 장치다.
 */
export async function streamTail(q, sse) {
  const ctx = await buildWebContext({
    profileName: q.get('profile'),
    region: q.get('region') || undefined,
    groupNames: csv(q.get('groups')),
  });
  ctx.client = createLogsClient({
    region: ctx.region, profile: ctx.profile.name, credentials: ctx.provider,
    mode: 'poll', counters: ctx.counters,
  });

  const values = dslFrom(q);
  const ir = buildIR(values);
  const { pattern, residual } = values.filter
    ? { pattern: values.filter, residual: [] }
    : compilePattern(ir);
  const predicate = compilePredicate(residual);
  const follow = q.get('follow') !== '0';
  // 과거 구간은 끝 시각도 지켜야 한다 — resolveWindow 가 두 값을 함께 검증한다.
  const { startMs, endMs } = follow
    ? { startMs: parseSince(q.get('since') || '5m'), endMs: undefined }
    : resolveWindow({ since: q.get('since') || '1h', until: q.get('until') || undefined });

  sse.send('meta', {
    pattern: pattern ?? null,
    residual: explainResidual(residual),
    groups: ctx.groupNames,
    follow,
    startMs,
    endMs: endMs ?? null,
  });

  const depths = makeDepthResolver();
  const interval = Math.max(1, Number(q.get('interval') ?? 3) || 3);
  const usageTimer = setInterval(() => sse.send('usage', ctx.counters), 1000);

  try {
    const iter = pollLogEvents({
      client: ctx.client,
      groups: ctx.groupNames,
      filterPattern: pattern,
      startMs,
      cfg: {
        ...pollDefaults,
        intervalMs: interval * 1000,
        follow,
        // 과거 구간은 조각씩 이어서 보낸다 — 한 번에 다 모으면 화면이 끝까지 빈다.
        ...(follow ? {} : { endMs, maxEventsPerTick: 500, maxPagesPerTick: 500 }),
      },
      counters: ctx.counters,
      signal: q.signal,
      onGroupDropped: (g, reason) => sse.send('notice', { level: 'error', text: `${g} 제외됨 — ${reason}` }),
    });

    for await (const batch of iter) {
      const evs = batch.map((raw) => normalize(raw));
      for (const ev of evs) depths.note(ev);
      const ordered = q.get('tree') === '0' ? evs : orderByTrace(evs);

      const out = [];
      for (const ev of ordered) {
        if (!predicate(ev)) continue;
        ev.depth = depths.depthOf(ev);
        ev.parentMissing = depths.parentMissing(ev);
        out.push(slim(ev));
      }
      if (out.length) sse.send('events', out);
    }
    if (!follow) {
      // 마지막 사용량은 done 보다 **먼저** 보낸다. 클라이언트는 done 에서 스트림을
      // 닫으므로, done 뒤에 보내면 영영 도착하지 않아 푸터가 옛 숫자로 남는다.
      sse.send('usage', ctx.counters);
      sse.send('done', { events: ctx.counters.events });
    }
  } finally {
    clearInterval(usageTimer);
    sse.send('usage', ctx.counters);
  }
}
