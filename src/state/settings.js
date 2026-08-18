import { statePath, readJson, writeJsonAtomic } from './paths.js';
import { slowThresholds, appPackages } from '../config.js';

const FILE = () => statePath('settings.json');
const VERSION = 1;

/**
 * 개인 설정.
 *
 * **브라우저가 아니라 여기에 저장한다.** `--port` 기본값이 0(빈 포트 자동)이라 실행할 때마다
 * origin 이 바뀌고, localStorage 는 origin 단위라 재시작하면 통째로 사라진다.
 *
 * 우선순위: **저장값 > 환경변수 > 내장 기본값.**
 * 환경변수를 쓰던 사람은 그대로 동작하고(첫 화면의 기본값이 된다), 화면에서 한 번
 * 바꾸면 그때부터 저장값이 이긴다.
 */

/** 화면이 건드릴 수 있는 값과, 받아들일 수 있는 범위. 범위 밖은 조용히 무시한다. */
const FIELDS = {
  theme: { of: ['system', 'light', 'dark'] },
  fontSize: { min: 10, max: 20 },
  appPackages: { text: true },       // 콤마 구분
  slowWarn: { min: 1, max: 600_000 },
  slowBad: { min: 1, max: 600_000 },
  tailMaxMinutes: { min: 0, max: 720 },   // 0 = 무제한
  intervalSec: { min: 1, max: 60 },
};

/** 환경변수·내장값으로 만든 바닥. 저장된 게 없으면 이게 그대로 화면에 뜬다. */
function base() {
  const slow = slowThresholds();
  return {
    theme: 'system',
    fontSize: 13,
    appPackages: appPackages().join(','),
    slowWarn: slow.warn,
    slowBad: slow.bad,
    tailMaxMinutes: 60,
    intervalSec: 3,
  };
}

/** 값 하나를 검사해 받아들일 수 있으면 정규화해서, 아니면 undefined 를 돌려준다. */
function clean(key, raw) {
  const f = FIELDS[key];
  if (!f || raw == null || raw === '') return undefined;
  if (f.of) return f.of.includes(raw) ? raw : undefined;
  if (f.text) {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean).join(',');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < f.min || n > f.max) return undefined;
  return Math.round(n);
}

/** 화면에서 온 값 중 쓸 수 있는 것만 추린다. */
export function sanitize(input = {}) {
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    // appPackages 는 '비움' 이 유효한 값이다 — 강조를 끄는 유일한 방법이라 별도로 받는다.
    if (key === 'appPackages' && input[key] === '') { out[key] = ''; continue; }
    const v = clean(key, input[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * 환경변수 위에 저장값을 얹은 최종 설정.
 * 설정 파일이 깨졌으면 readJson 이 null 을 주므로 바닥값으로 뜬다 — 도구가 죽지 않는다.
 */
export async function loadSettings() {
  const saved = await readJson(FILE());
  const ok = saved?.version === VERSION ? sanitize(saved) : {};
  const merged = { ...base(), ...ok };
  // 주의·느림이 뒤집히면 색 판정이 무의미해진다. 조용히 바로잡는다.
  if (merged.slowWarn > merged.slowBad) merged.slowWarn = merged.slowBad;
  return merged;
}

export async function saveSettings(input) {
  const merged = { ...(await loadSettings()), ...sanitize(input) };
  if (merged.slowWarn > merged.slowBad) merged.slowWarn = merged.slowBad;
  await writeJsonAtomic(FILE(), { version: VERSION, at: Date.now(), ...merged });
  return merged;
}

export const settingsPath = FILE;
