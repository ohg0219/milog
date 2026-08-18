import { parseArgs } from 'node:util';
import { COMMANDS, ALIASES, GLOBAL, toParseArgsOptions } from './spec.js';
import { UsageError } from '../util/errors.js';

/** 편집 거리 — 오타 제안용. */
function distance(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}

const suggest = (word, candidates) => {
  const hit = candidates
    .map((c) => [c, distance(word, c)])
    .filter(([, d]) => d <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a[1] - b[1])[0];
  return hit ? hit[0] : null;
};

/** camelCase 로도 읽을 수 있게 하고, 타입을 맞춘다. */
function coerce(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = v;
    const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== k) out[camel] = v;
  }
  const num = (k) => {
    if (out[k] == null) return;
    const n = Number(out[k]);
    if (!Number.isFinite(n)) throw new UsageError(`--${k} 는 숫자여야 합니다: ${out[k]}`);
    out[k] = n;
  };
  for (const k of ['port', 'idleMinutes']) num(k);
  return out;
}

export function dispatch(argv) {
  // 명령을 안 적으면 웹을 띄운다 — 이게 이 도구의 기본 동작이다.
  let name = 'web';
  let rest = argv;
  let explicitCommand = false;

  const head = argv[0];
  if (head && !head.startsWith('-')) {
    const resolved = ALIASES[head] ?? head;
    if (COMMANDS[resolved]) {
      name = resolved;
      rest = argv.slice(1);
      explicitCommand = true;
    } else {
      // 서브커맨드처럼 생겼는데 없는 이름이면, 오타인지 위치 인자인지 구분해준다.
      const s = suggest(head, [...Object.keys(COMMANDS), ...Object.keys(ALIASES)]);
      if (s) throw new UsageError(`알 수 없는 명령: ${head} — 혹시 '${s}'?`);
    }
  }

  const cmd = COMMANDS[name];
  const spec = { ...GLOBAL, ...cmd.opts };

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: toParseArgsOptions(spec),
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch (e) {
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const m = /'?--?([\w-]+)'?/.exec(e.message);
      const s = m ? suggest(m[1], Object.keys(spec)) : null;
      throw new UsageError(s ? `${e.message}\n  혹시 --${s}?` : e.message, name);
    }
    throw new UsageError(e.message, name);
  }

  const values = coerce({ ...cmd.defaults, ...parsed.values });
  return { name, values, positionals: parsed.positionals, spec, explicitCommand };
}
