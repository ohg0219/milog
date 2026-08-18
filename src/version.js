import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 설치된 자기 버전. package.json 을 런타임에 읽으므로 배포본에서도 정확하다. */
export async function version() {
  const p = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(await readFile(p, 'utf8')).version;
}
