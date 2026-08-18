import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 상태·캐시 디렉터리. Windows 는 기존 %LOCALAPPDATA%\milog 를 그대로 유지해
 * 예전 캐시와 경로가 어긋나지 않게 한다.
 */
export function stateDir() {
  if (process.env.MILOG_STATE_DIR) return process.env.MILOG_STATE_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'milog');
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'milog');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'), 'milog');
}

export const statePath = (name) => path.join(stateDir(), name);

/** 프로필 이름을 파일명으로 쓸 수 있게 (기존 규칙 유지). */
export const safeName = (s) => String(s).replace(/[^\w.\-]/g, '_');

/**
 * 원자적 쓰기. Ctrl+C 가 정상 종료 경로인 도구라, 잘린 파일이 남으면
 * 다음 실행의 --last 가 통째로 깨진다.
 */
export async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** 없거나 깨진 파일은 조용히 null. 캐시/상태는 항상 버려도 되는 값이다. */
export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function removeFile(file) {
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}
