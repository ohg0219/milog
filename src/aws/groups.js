import { paginateDescribeLogGroups } from '@aws-sdk/client-cloudwatch-logs';
import { statePath, safeName, readJson, writeJsonAtomic } from '../state/paths.js';

const CACHE_VERSION = 2;
const TTL_MS = 12 * 60 * 60 * 1000;

const cacheFile = (profile, region) =>
  statePath(`loggroups-${safeName(profile)}-${region}.json`);

/**
 * 로그 그룹 목록. 12시간 캐시.
 *
 * 캐시에 이름만 담던 걸 객체로 넓혔다:
 *   logGroupClass  → Live Tail 은 STANDARD 에서만 되므로, 과금 세션을 열기 전에 걸러야 한다
 *   retentionInDays → --since 가 보존기간을 넘으면 "왜 0건이지" 대신 이유를 말해줄 수 있다
 * 버전이 다르면 캐시 미스로 처리해 옛 string[] 캐시가 파서를 깨뜨리지 않게 한다.
 */
export async function listLogGroups(client, { profile, region, refresh = false } = {}) {
  const file = cacheFile(profile, region);

  if (!refresh) {
    const cached = await readJson(file);
    if (cached?.version === CACHE_VERSION && Date.now() - cached.at < TTL_MS && Array.isArray(cached.groups)) {
      return { groups: cached.groups, cached: true, at: cached.at };
    }
  }

  const groups = [];
  // 페이지네이션 필수 — SDK 에는 CLI 같은 암묵적 auto-pagination 이 없다.
  for await (const page of paginateDescribeLogGroups({ client }, { limit: 50 })) {
    for (const g of page.logGroups ?? []) {
      groups.push({
        name: g.logGroupName,
        class: g.logGroupClass ?? 'STANDARD',
        retentionDays: g.retentionInDays ?? null,
        storedBytes: g.storedBytes ?? 0,
        // logGroupArn 은 끝에 ':*' 가 없는 형태다. StartLiveTail 은 ':*' 로 끝나는 ARN 을
        // 거부하므로 이걸 그대로 쓴다 — 손으로 조립할 필요도, 계정 ID 를 따로 알아낼
        // 필요도 없어진다.
        arn: g.logGroupArn ?? String(g.arn ?? '').replace(/:\*$/, ''),
      });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  await writeJsonAtomic(file, { version: CACHE_VERSION, at: Date.now(), profile, region, groups });
  return { groups, cached: false, at: Date.now() };
}

export async function invalidateGroupCache(profile, region) {
  await writeJsonAtomic(cacheFile(profile, region), { version: 0, at: 0, groups: [] });
}

/**
 * 공백으로 나눈 토큰을 '전부' 포함하는 항목만 남긴다 (AND, 대소문자 무시).
 * 옛 Find-ByFragment 를 그대로 옮긴 것 — 실제로 쓰기 좋은 검색이라 유지한다.
 */
export function findByFragment(items, query, key = (x) => x) {
  const tokens = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((it) => {
    const hay = String(key(it)).toLowerCase();
    return tokens.every((t) => hay.includes(t.toLowerCase()));
  });
}

/** '1,3' / '1-3' / '1 3 5' 혼용 → 1-based 인덱스. 중복 제거, 순서 유지. */
export function parseSelection(input, max) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(input ?? '').split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(chunk);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a < 1 || b < 1 || a > max || b > max) throw new Error(`범위를 벗어났습니다: ${chunk} (1-${max})`);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (!seen.has(i)) { seen.add(i); out.push(i); }
      }
      continue;
    }
    if (!/^\d+$/.test(chunk)) throw new Error(`숫자가 아닙니다: ${chunk}`);
    const n = Number(chunk);
    if (n < 1 || n > max) throw new Error(`범위를 벗어났습니다: ${n} (1-${max})`);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** -g 값을 실제 그룹 이름으로. 정확 일치 우선, 부분일치 1개면 자동 선택. */
export function resolveGroupNames(requested, groups) {
  const names = groups.map((g) => g.name);
  const resolved = [];
  const ambiguous = [];

  for (const raw of requested) {
    const q = String(raw).trim();
    if (!q) continue;
    if (names.includes(q)) { resolved.push(q); continue; }

    const hits = findByFragment(names, q);
    if (hits.length === 1) resolved.push(hits[0]);
    else if (hits.length === 0) ambiguous.push({ query: q, hits: [] });
    else ambiguous.push({ query: q, hits });
  }
  return { resolved: [...new Set(resolved)], ambiguous };
}
