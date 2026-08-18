# 배포 절차

> 이 문서는 배포하는 사람만 읽는다. `package.json` 의 `files` 에 없으므로 패키지에 안 실린다.

## 0. 처음 한 번

**npm 계정이 필요하다** (무료). <https://www.npmjs.com/signup> 에서 만든다.

```bash
npm login          # 브라우저가 열린다
npm whoami         # 계정명 — src/update.js 의 EXPECTED_MAINTAINER 와 같아야 한다
```

### 2FA 는 **필수**다 (권장이 아니다)

2FA 없이 `npm publish` 하면 이렇게 막힌다:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/milog
npm error 403 Two-factor authentication or granular access token with
npm error 403 bypass 2fa enabled is required to publish packages.
```

npm 이 배포에 2FA 를 의무화했다. 마침 이 패키지에는 특히 중요한 장치이기도 하다 —
설치되면 사람들의 PC 에서 AWS 자격증명으로 로그를 읽고, **자동 업데이트로 새 코드를
스스로 설치한다.** 계정이 털리면 그게 그대로 공격 경로가 된다.

**사람이 직접 올릴 때 (권장)** — 인증 앱(Google Authenticator, 1Password 등)으로 TOTP 를 켠다.
<https://www.npmjs.com/settings/~/tfa> 에서 QR 을 찍는 게 가장 쉽다. CLI 로도 된다:

```bash
npm profile enable-2fa auth-and-writes   # QR·복구코드가 나오므로 대화형 터미널에서
```

켠 뒤에는 배포할 때 6자리 코드를 묻는다. 미리 줄 수도 있다:

```bash
npm publish --otp=123456
```

**CI 에서 올릴 때** — 사람이 코드를 칠 수 없으므로 *granular access token* 에
"Bypass 2FA" 를 켜서 발급하고 `NPM_TOKEN` 으로 쓴다. 지금은 필요 없다.

> 복구 코드는 반드시 따로 보관할 것. 인증 앱을 잃으면 계정도, 이 패키지도 못 건드린다.

## 1. 저장소 — GitHub Actions 가 배포한다

`main` 에 push 하면 테스트가 돌고, **`package.json` 의 version 이 레지스트리에 없을 때만**
배포된다. 평소 커밋은 테스트만 돌고 조용하다.

```bash
# 평소
git push                              # 테스트만

# 배포할 때
npm version patch --no-git-tag-version
git commit -am "release 1.0.3" && git push    # CI 가 감지해서 배포
```

**커밋마다 배포하지 않는 이유** — 이 패키지는 설치된 PC 에서 스스로 새 버전을 깐다.
커밋 하나가 그대로 동료들 기계에 설치되므로, 배포는 사람이 version 을 올리는
의도적인 행위일 때만 일어나야 한다.

### Trusted Publishing 설정 (처음 한 번, npmjs.com 에서)

토큰을 GitHub secret 에 넣지 않는다. OIDC 로 CI 가 그때그때 짧은 토큰을 받는다.

<https://www.npmjs.com/package/@ohg0219/milog/access> → **Trusted Publisher** 에서:

| 항목 | 값 |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `ohg0219` |
| Repository | `milog` |
| Workflow filename | `ci.yml` |
| Environment | (비움) |

설정 후에는 "Require two-factor authentication and disallow tokens" 를 켜 두면
사람이 손으로 올리는 경로까지 막혀 더 안전하다.

## 2. 손으로 올릴 때 (CI 를 안 쓸 경우)

```bash
npm test
npm pack --dry-run     # 올라갈 파일 확인 — test/·PUBLISHING.md 는 없어야 한다
npm publish --otp=123456
```

2FA 가 `auth-and-writes` 로 켜져 있어 **OTP 없이는 거부된다**(E403 / EOTP).
이 셸은 표준입력이 없어 프롬프트를 못 받으므로 `--otp` 로 넘겨야 한다.

**스코프 패키지는 기본이 비공개**라 그냥 올리면 유료 플랜을 요구한다.
`package.json` 의 `publishConfig.access: "public"` 이 그걸 대신한다.

> **왜 스코프인가** — 처음엔 `milog` 로 가려 했지만 npm 이 거절했다:
> `Package name too similar to existing package mi-log`. 이름이 비어 있어도(404)
> 기존 패키지와 비슷하면 막는다. 유사도는 미리 조회할 방법이 없어 publish 해봐야 안다.

## 3. 버전

**버전 번호는 소모품이다.** npm 은 한 번 쓴 `@ohg0219/milog@X.Y.Z` 를 영원히 재사용하지
못하게 한다 (unpublish 해도 마찬가지).

게시자 확인(`src/update.js` 의 `EXPECTED_MAINTAINER`)은 `ohg0219` 로 채워져 있다.
소유자를 넘기거나 공동 관리자를 추가하면 이 값도 같이 고쳐야 자동 업데이트가 계속 돈다.

## 4. 동료에게

```bash
npm i -g @ohg0219/milog
milog
```

안 되면 `milog doctor`.

> 이미 **1.0.1 이하**를 쓰던 사람은 한 번은 직접 위 명령을 쳐야 한다.
> 그 버전들의 자동 업데이트가 고장나 있어(Ctrl+C 로 끝나는 웹 서버에서 실행되지 않음)
> 스스로 1.0.2 를 못 받는다. 1.0.2 부터는 시작할 때마다 확인한다.

## 5. ⚠️ 내릴 때는 `npm deprecate`, `npm unpublish` 가 아니다

npm 정책(<https://docs.npmjs.com/policies/unpublish>) 상:

- 게시 후 72시간이 지나면 **주간 다운로드 300 미만 + 단독 소유자 + 의존 패키지 없음**
  일 때만 unpublish 된다. 소규모 사내 도구는 이 조건을 대체로 충족하므로 **실제로 지워진다.**
- 전체를 지워도 **`@ohg0219` 스코프는 계정에 영구히 묶여 있어 남이 못 가져간다.**
  스코프로 간 덕에 이름 탈취 위험은 사라졌다 — 그래도 지우면 쓰던 사람은 깨진다.

그래서 내릴 일이 생기면 지우지 말고 이렇게 한다:

```bash
npm deprecate @ohg0219/milog "더 이상 관리하지 않습니다"
```

쓰던 사람이 안 깨지고, 경고 문구로 상황도 전달된다.

`src/update.js` 의 게시자 확인은 **공동 관리자 추가·소유권 이전**을 잡는 장치로 남는다.
스코프 덕에 '남이 이름을 선점하는' 경로는 애초에 없다.

## 6. 이후 배포

`npm version patch` → commit → push. CI 가 알아서 올린다.
동료들은 다음 `milog` 실행 때 자동으로 받는다 (시작 전에 확인·설치).
