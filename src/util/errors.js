/** 사용법 오류 — exit 2. */
export class UsageError extends Error {
  constructor(message, command) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

/** 이미 사람이 읽을 수 있게 다듬은 오류 — 스택을 숨긴다. */
export class MilogError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(message);
    this.name = 'MilogError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/**
 * SSO/자격증명 만료 판정.
 *
 * 클래스명으로 판정하면 안 된다 — token-providers 가 던진 TokenProviderError 를
 * resolveSSOCredentials 가 CredentialsProviderError 로 다시 포장해서 올려보낸다.
 * 게다가 그 클래스는 패키지를 두 번 옮겼다(@smithy/property-provider → @smithy/core/config).
 * 그래서 메시지 마커로 보고, 마커가 안 맞으면 tryNextLink === false 를 폴백으로 쓴다.
 */
const SSO_EXPIRY_MARKERS = [
  'To refresh this SSO session run', // 따옴표 유무 두 변형을 모두 덮는 접두사
  'SSO session associated with this profile has expired',
  'SSO session associated with this profile is invalid',
  'Token is expired',
  'was not found or is invalid',
  'UnauthorizedException',
  'ExpiredTokenException',
  'InvalidGrantException',
];

export function isSsoExpiry(err) {
  if (!err) return false;
  const name = err.name ?? '';
  if (name === 'ExpiredTokenException' || name === 'ExpiredToken') return true;
  if (name === 'UnrecognizedClientException') return true;
  const msg = String(err.message ?? '');
  if (SSO_EXPIRY_MARKERS.some((m) => msg.includes(m))) return true;
  // 마커가 안 맞아도, 더 시도할 공급자가 없는 자격증명 오류면 재인증 말고 할 일이 없다.
  return (name === 'CredentialsProviderError' || name === 'TokenProviderError')
    && err.tryNextLink === false;
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);

/**
 * 오류를 처리 방식이 같은 몇 개 부류로 나눈다.
 * auth / permission / notfound / badinput / throttle / transient / network /
 * session-timeout / unknown
 */
export function classify(err) {
  if (isSsoExpiry(err)) return 'auth';
  switch (err?.name) {
    case 'AccessDeniedException': return 'permission';
    case 'ResourceNotFoundException': return 'notfound';
    case 'InvalidParameterException':
    case 'MalformedQueryException':
    case 'ValidationException':
    case 'InvalidOperationException': return 'badinput';
    case 'ThrottlingException':
    case 'LimitExceededException':
    case 'ServiceQuotaExceededException': return 'throttle';
    case 'ServiceUnavailableException':
    case 'InternalServerException':
    case 'SessionStreamingException': return 'transient';
    case 'SessionTimeoutException': return 'session-timeout';
    case 'TimeoutError': return 'network';
    default: break;
  }
  if (NETWORK_CODES.has(err?.code)) return 'network';
  if ((err?.$metadata?.httpStatusCode ?? 0) >= 500) return 'transient';
  return 'unknown';
}

/** 재시도해도 결과가 달라지지 않는 부류. 재시도하면 할당량만 태운다. */
export const isTerminal = (cls) =>
  cls === 'permission' || cls === 'notfound' || cls === 'badinput';

/** 부류별 한국어 안내. context 로 그룹명·패턴 등을 끼워 넣는다. */
export function describe(err, ctx = {}) {
  const cls = classify(err);
  const msg = String(err?.message ?? err ?? '');
  const rid = err?.$metadata?.requestId;

  switch (cls) {
    case 'auth':
      return {
        cls,
        text: '자격증명이 만료되었습니다.',
        hint: ctx.ssoSession
          ? `aws sso login --sso-session ${ctx.ssoSession}`
          : `aws sso login --profile ${ctx.profile ?? '<프로필>'}`,
      };
    case 'permission':
      return {
        cls,
        text: `권한이 없습니다${ctx.group ? `: ${ctx.group}` : ''}`,
        hint: `프로필 ${ctx.profile ?? '?'} 에 logs:FilterLogEvents / logs:StartQuery 권한이 필요합니다.`,
      };
    case 'notfound':
      return {
        cls,
        text: `로그 그룹을 찾을 수 없습니다${ctx.group ? `: ${ctx.group}` : ''}`,
        hint: '이름이 바뀌었을 수 있습니다 — milog groups --refresh 로 목록을 갱신하세요.',
      };
    case 'badinput':
      return {
        cls,
        text: `요청이 거부되었습니다: ${msg}`,
        hint: ctx.pattern
          ? `보낸 패턴: ${ctx.pattern}`
          : '필터 예시: { $.level = "ERROR" } / { $.span.duration_ms > 100 }',
      };
    case 'throttle':
      return {
        cls,
        text: '요청이 제한되었습니다 (FilterLogEvents 는 계정·리전당 10 TPS).',
        hint: '--interval 을 늘리거나 그룹 수를 줄이세요.',
      };
    case 'transient':
      return { cls, text: `AWS 응답이 일시적으로 실패했습니다: ${err?.name ?? 'unknown'}` };
    case 'network':
      return {
        cls,
        text: `네트워크 연결에 실패했습니다 (${err?.code ?? err?.name}).`,
        hint: 'VPN·프록시를 확인하세요. Live Tail 은 stream-logs.<region>.amazonaws.com 을 씁니다.',
      };
    case 'session-timeout':
      return { cls, text: 'Live Tail 세션이 3시간 한도에 도달했습니다.' };
    default:
      return {
        cls,
        text: `예상치 못한 오류: ${err?.name ?? 'Error'}: ${msg}`,
        hint: rid ? `requestId: ${rid}` : 'MILOG_DEBUG=1 로 다시 실행하면 스택을 볼 수 있습니다.',
      };
  }
}
