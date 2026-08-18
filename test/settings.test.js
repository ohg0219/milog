import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 설정 파일은 상태 디렉터리에 있다. 테스트마다 새 디렉터리를 주고 모듈을 새로 읽는다. */
async function fresh() {
  process.env.MILOG_STATE_DIR = await mkdtemp(path.join(tmpdir(), 'milog-set-'));
  return import(`../src/state/settings.js?${Math.random()}`);
}

test('저장한 값이 그대로 돌아온다', async () => {
  const s = await fresh();
  await s.saveSettings({ theme: 'dark', fontSize: '15', tailMaxMinutes: '120' });
  const got = await s.loadSettings();
  assert.equal(got.theme, 'dark');
  assert.equal(got.fontSize, 15, '문자열로 와도 숫자로 저장돼야 한다');
  assert.equal(got.tailMaxMinutes, 120);
});

/**
 * 브라우저가 아니라 서버에 저장하는 이유가 이것이다 — --port 기본값이 0 이라
 * 실행할 때마다 origin 이 바뀌고, localStorage 였다면 여기서 전부 사라진다.
 */
test('설정은 포트·세션과 무관하게 파일에 남는다', async () => {
  const s = await fresh();
  await s.saveSettings({ fontSize: '14' });
  const raw = JSON.parse(await readFile(s.settingsPath(), 'utf8'));
  assert.equal(raw.fontSize, 14);
  assert.ok(raw.version >= 1 && raw.at > 0, '버전·시각이 함께 남아야 한다');
});

/** 우선순위: 저장값 > 환경변수 > 내장 기본값 */
test('저장 전에는 환경변수가, 저장 후에는 저장값이 이긴다', async () => {
  const orig = process.env.MILOG_SLOW_MS;
  process.env.MILOG_SLOW_MS = '5000';
  try {
    const s = await fresh();
    assert.equal((await s.loadSettings()).slowBad, 5000, '저장 전엔 환경변수가 기본값');
    await s.saveSettings({ slowBad: '800' });
    assert.equal((await s.loadSettings()).slowBad, 800, '저장 후엔 저장값이 이긴다');
  } finally {
    if (orig === undefined) delete process.env.MILOG_SLOW_MS; else process.env.MILOG_SLOW_MS = orig;
  }
});

/** 값 하나가 이상하다고 도구가 죽으면 안 된다 — 조용히 무시하고 나머지는 살린다. */
test('범위 밖·모르는 값은 무시한다', async () => {
  const s = await fresh();
  assert.deepEqual(s.sanitize({ theme: 'neon', fontSize: 999, intervalSec: 0, 짱: 1 }), {});
  await s.saveSettings({ fontSize: '99', theme: 'light' });
  const got = await s.loadSettings();
  assert.equal(got.fontSize, 13, '범위 밖은 기본값 유지');
  assert.equal(got.theme, 'light', '옆의 정상 값은 저장돼야 한다');
});

/** 주의 > 느림 이면 색 판정이 무의미해진다. */
test('주의가 느림보다 크면 바로잡는다', async () => {
  const s = await fresh();
  await s.saveSettings({ slowWarn: '3000', slowBad: '1000' });
  const got = await s.loadSettings();
  assert.ok(got.slowWarn <= got.slowBad, `주의(${got.slowWarn}) 가 느림(${got.slowBad}) 보다 크다`);
});

/** 강조를 끄는 유일한 방법이 빈 값이라, 빈 문자열은 '설정 안 함' 이 아니라 유효한 값이다. */
test('내 코드 패키지는 비울 수 있다', async () => {
  const s = await fresh();
  await s.saveSettings({ appPackages: 'com.acme, org.acme' });
  assert.equal((await s.loadSettings()).appPackages, 'com.acme,org.acme');
  await s.saveSettings({ appPackages: '' });
  assert.equal((await s.loadSettings()).appPackages, '', '빈 값으로 되돌릴 수 있어야 한다');
});

/** 파일이 깨져도 도구는 떠야 한다. */
test('설정 파일이 망가지면 기본값으로 뜬다', async () => {
  const s = await fresh();
  await writeFile(s.settingsPath(), '{ 이건 JSON 이 아니다', 'utf8');
  const got = await s.loadSettings();
  assert.equal(got.theme, 'system');
  assert.equal(got.fontSize, 13);
});
