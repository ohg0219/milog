import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveScope, registerTools } from '../mcp/tools.js';
import { version } from '../version.js';
import { newerVersion } from '../update.js';
import { ui } from '../util/out.js';

const INSTRUCTIONS = `CloudWatch 의 Log4j2 JSON + OpenTelemetry 로그를 읽습니다. 읽기 전용입니다.
보통 find_errors 로 무엇이 터졌는지 보고, 거기 나온 trace_id 로 get_trace 를 불러 원인을 좁힙니다.
자격증명이 만료됐다는 오류가 오면 사용자에게 안내된 aws sso login 명령을 실행하라고 알려 주세요.`;

/**
 * stdio MCP 서버.
 *
 * stdout 은 JSON-RPC 전용이다 — 한 줄이라도 다른 걸 쓰면 클라이언트가 연결을 끊는다.
 * 진단은 전부 stderr(ui) 로만 나간다.
 */
export async function mcp(values, { signal }) {
  const scope = await resolveScope(values);

  // 기동을 막지 않게 뒤에서 확인한다. 실패는 조용히 — 로그를 보러 온 사람에게 npm 이 안 된다고 떠들 이유가 없다.
  scope.update = newerVersion()
    .then((n) => {
      if (n) ui.warn(`  milog 새 버전 ${n.latest} 이 있습니다 (지금 ${n.current}) — npm i -g @ohg0219/milog@latest`);
      return n;
    })
    .catch(() => null);

  const server = new McpServer({ name: 'milog', version: await version() }, { instructions: INSTRUCTIONS });
  registerTools(server, scope);

  await server.connect(new StdioServerTransport());
  ui.dim(`  milog mcp — ${scope.profile ?? '프로필 미고정'}${scope.groups.length ? ` · ${scope.groups.join(', ')}` : ''}`);

  // 클라이언트가 stdin 을 닫거나 Ctrl+C 가 오면 끝난다.
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
    server.server.onclose = resolve;
    process.stdin.once('end', resolve);
  });
  await server.close().catch(() => {});
  return 0;
}
