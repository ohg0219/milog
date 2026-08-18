import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 공개 레지스트리에 올라가는 패키지다. 조직 고유 이름이 하나라도 섞여 들어가면
 * 되돌릴 수 없다 — npm 은 같은 package@version 을 영원히 재사용하지 못하게 한다.
 * 배포 대상(package.json 의 files)만 훑는다.
 */
// awsapps 는 `<조직>.awsapps.com` 같은 플레이스홀더로 문서에 정당하게 나온다.
// 실제 하위 도메인이 박힌 경우(\w+.awsapps.com)만 잡는다.
const FORBIDDEN = /mibank|mitravel|travelj|\w\.awsapps\.com|EEProject|간편계산|만료갱신/i;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

test('배포 대상에 조직 고유 문구가 없다', async () => {
  const hits = [];
  const scan = async (file) => {
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (FORBIDDEN.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  };

  for (const dir of ['src', 'bin']) {
    for await (const f of walk(path.join(ROOT, dir))) await scan(f);
  }
  for (const f of ['README.md', 'package.json']) await scan(path.join(ROOT, f));

  assert.deepEqual(hits, [], `조직 고유 문구 발견:\n${hits.join('\n')}`);
});

test('package.json 이 공개 배포 가능한 상태다', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.private, 'private: true 이면 npm publish 가 거부된다');
  assert.ok(pkg.license, 'license 가 없으면 publish 시 경고가 나고 법적으로 모호하다');
  assert.ok(Array.isArray(pkg.files) && pkg.files.length, 'files 화이트리스트가 있어야 불필요한 파일이 안 실린다');
  assert.ok(pkg.bin?.milog, 'bin 매핑이 있어야 전역 설치 후 milog 로 실행된다');
  assert.ok(pkg.engines?.node, 'engines.node 로 최소 버전을 알려야 한다');
});
