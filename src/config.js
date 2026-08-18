/**
 * 화면과 서버가 함께 보는 설정. 환경 변수는 전부 여기서만 읽는다 —
 * 흩어져 있으면 "이 값이 어디서 오는지" 를 코드 전체에서 찾아야 한다.
 */

/** 한 번에 고를 수 있는 로그 그룹 수. 늘리면 폴링 요청이 그만큼 늘어난다. */
export const MAX_GROUPS = 10;

/** 소요시간 색 임계. 목록과 trace 트리가 같은 값을 쓰도록 한곳에서 읽는다. */
export const slowThresholds = () => ({
  warn: Number(process.env.MILOG_SLOW_WARN_MS ?? 200),
  bad: Number(process.env.MILOG_SLOW_MS ?? 1000),
});

/**
 * 스택 트레이스에서 밝게 강조할 패키지 접두사.
 *
 * 기본은 **빈 값 = 강조 안 함**이다. 남의 프레임워크 프레임까지 전부 같은 밝기로 나오면
 * 어디가 내 코드인지 안 보이지만, 그렇다고 특정 조직의 패키지 이름을 기본값으로 박아 두면
 * 다른 사람에게는 의미 없는 규칙이 조용히 적용된다. 쓰는 사람이 자기 걸 지정한다.
 *
 *   MILOG_APP_PACKAGES=com.acme,org.acme
 *
 * 부분 문자열 판정이라 `com.acme` 하나로 `com.acme.web`·`com.acme.batch` 가 함께 잡힌다.
 */
export const appPackages = () =>
  String(process.env.MILOG_APP_PACKAGES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
