/**
 * 자체 완결 HTML 한 장. 외부 요청이 전혀 없다 (CSP 로도 막아 둔다).
 *
 * 렌더링 계약은 CLI 와 맞춘다:
 *   · tier 마커  ● wide · ↳ call · ⇡ 부모 미수집 · · narration · (평문은 마커 없음)
 *   · 들여쓰기 = span 중첩 깊이 (최대 8)
 *   · trace 색은 **처음 본 순서대로** 배정 (해시 아님 — 인접 요청이 안 겹치게)
 *   · trace 식별자는 뒤 12자리 (앞 8자리는 생성 시각이라 구분이 안 된다)
 *   · 소요시간 임계는 서버가 내려준 값(MILOG_SLOW_MS 등)을 그대로 쓴다
 */
export function renderPage(token) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>milog</title>
<!-- 탭 아이콘 (초승달). 파일로 두면 외부 요청이 생기므로(이 페이지는 요청이 0 이어야 한다)
     인라인 SVG 로 박는다. 이게 없으면 브라우저가 /favicon.ico 를 찾아가 404 를 받는다.
     viewBox 가 빠지면 300x150 캔버스 구석에 32px 로 박혀 뭉개진다 — 반드시 있어야 한다. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='.1' y1='0' x2='.9' y2='1'%3E%3Cstop offset='0' stop-color='%237aa2f7'/%3E%3Cstop offset='1' stop-color='%23bb9af7'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='9' fill='%23161922'/%3E%3Ccircle cx='15' cy='16' r='10.2' fill='url(%23g)'/%3E%3Ccircle cx='21.5' cy='11.5' r='8.6' fill='%23161922'/%3E%3C/svg%3E">
<style>
:root{
  --bg:#0f1115; --panel:#161922; --line:#232838; --fg:#d7dae3; --dim:#79809a;
  --accent:#7aa2f7; --warn:#e0af68; --bad:#f7768e; --ok:#9ece6a;
  /* 브라우저에 페이지 스킴을 알린다. 없으면 OS 가 다크일 때 캔버스·스크롤바·기본 폼이
     제멋대로 어두워져, 라이트 테마를 골라도 본문이 검게 남는다. */
  color-scheme: dark;
  --scroll:#545e80; --step:22px; --fs:13px;
  --mono:ui-monospace,"Cascadia Mono",Consolas,"D2Coding","Malgun Gothic",monospace;
}
/* 라이트 팔레트는 한 벌만 두고 두 군데서 쓴다 — 값을 두 번 적으면 반드시 어긋난다. */
@media (prefers-color-scheme:light){
  /* data-theme 이 있으면 사용자가 직접 고른 것이므로 OS 설정이 이겨선 안 된다. */
  :root:not([data-theme]){ color-scheme: light; --bg:#fbfbfd; --panel:#fff; --line:#e3e6ee; --fg:#1c1f2a; --dim:#6b7288;
         --accent:#2f5fd0; --warn:#a16207; --bad:#c02348; --ok:#3f7d20; --scroll:#b6bdd0; }
}
:root[data-theme="light"]{ color-scheme: light; --bg:#fbfbfd; --panel:#fff; --line:#e3e6ee; --fg:#1c1f2a; --dim:#6b7288;
       --accent:#2f5fd0; --warn:#a16207; --bad:#c02348; --ok:#3f7d20; --scroll:#b6bdd0; }
/* 다크는 :root 기본값 그대로다. OS 가 라이트일 때 위 미디어 쿼리를 이기려고 둔다. */
:root[data-theme="dark"]{ color-scheme: dark; --bg:#0f1115; --panel:#161922; --line:#232838; --fg:#d7dae3; --dim:#79809a;
       --accent:#7aa2f7; --warn:#e0af68; --bad:#f7768e; --ok:#9ece6a; --scroll:#545e80; }
*{box-sizing:border-box}
html{background:var(--bg)}
/* 스크롤바 — 기본 막대는 이 테마에서 혼자 하얗게 뜬다.
   너무 죽이면 지금 어디쯤인지 안 보이므로 쉬는 상태에서도 또렷하게 두고, 잡으면 강조한다.
   트랙을 투명하게 둬서 배경이 --bg 든 --panel 이든 그대로 비친다. */
*::-webkit-scrollbar{width:12px;height:12px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:var(--scroll);border:2px solid transparent;
  border-radius:6px;background-clip:padding-box}
*::-webkit-scrollbar-thumb:hover{background:var(--dim);background-clip:padding-box}
*::-webkit-scrollbar-thumb:active{background:var(--accent);background-clip:padding-box}
*::-webkit-scrollbar-corner{background:transparent}
/* Firefox 용. Chrome 은 scrollbar-color 가 있으면 위 ::-webkit- 규칙을 통째로 무시하므로
   webkit 을 모르는 브라우저에서만 적용한다. */
@supports not selector(::-webkit-scrollbar){
  *{scrollbar-width:thin;scrollbar-color:var(--scroll) transparent}
}
body{margin:0;background:var(--bg);color:var(--fg);font:var(--fs)/1.55 var(--mono);height:100vh;display:flex;flex-direction:column}
button,select,input{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 9px}
button{cursor:pointer}
button:hover{border-color:var(--accent)}
button.on{background:var(--accent);border-color:var(--accent);color:#0d1017}
header{border-bottom:1px solid var(--line);background:var(--panel);padding:7px 12px;display:flex;
       flex-direction:column;gap:7px;flex:none;position:relative;z-index:3}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1;min-width:120px}
.vr{width:1px;height:20px;background:var(--line);flex:none}
/* 소스 pill — '어느 프로필의 어느 그룹' 을 한 칸에 접어 둔다 */
#src,#cal{display:flex;gap:8px;align-items:center;white-space:nowrap;flex:none;background:var(--bg)}
#src .dim,#cal .dim{color:var(--dim)}
#src .sep{color:var(--line)}
#src b,#cal b{font-weight:600}
#src.open,#cal.open{border-color:var(--accent)}
/* 모드는 한 덩어리 — 지금 무엇을 보고 있는지가 한눈에 */
.seg{display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;flex:none}
.seg button{border:0;border-right:1px solid var(--line);border-radius:0;padding:5px 14px;white-space:nowrap;font-weight:600}
.seg button:last-child{border-right:0}
.seg button:hover{border-color:var(--line)}
.seg button.on{background:var(--accent);color:#0d1017}
#live{display:inline-flex;gap:7px;align-items:center;color:var(--ok);flex:none;white-space:nowrap}
#live i{width:7px;height:7px;border-radius:99px;background:var(--ok);flex:none}
/* 끝난 뒤에도 결과는 남긴다. 다만 '도는 중' 으로 보이면 안 되므로 초록을 거둔다. */
#live.done{color:var(--dim)}
#live.done i{background:var(--line)}
#live b{font-weight:600}
#live .n{color:var(--dim)}
/* 자동 정지가 얼마 안 남았을 때 — 갑자기 끊긴 것처럼 느끼지 않게 미리 알린다 */
#live .w{color:var(--warn);font-weight:600}
/* 도는 중 표시. 진행률(%)이 아니다 — CloudWatch 는 매치 0건 페이지에서 스캔 위치를
   알려주지 않아 드문 조건이면 %가 거짓말이 된다. 그래서 '움직인다'만 말한다.
   absolute 라 떴다 사라져도 헤더 높이가 안 밀린다. */
#prog{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;display:none}
#prog.on{display:block}
#prog i{position:absolute;top:0;bottom:0;width:26%;background:var(--accent);animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{left:-26%}100%{left:100%}}
#go{background:var(--ok);border-color:var(--ok);color:#0d1017;font-weight:600;padding:5px 16px;flex:none;white-space:nowrap}
#stop{flex:none;white-space:nowrap}
/* 자동 스크롤 — 글자는 그대로 두고 오른쪽 스위치로 켜고 끈다.
   버튼 전체가 색으로 채워지면 모드 버튼(.seg .on)과 헷갈린다. */
#follow{flex:none;white-space:nowrap;display:flex;gap:8px;align-items:center;color:var(--dim);background:var(--bg)}
#follow i{position:relative;width:30px;height:16px;border-radius:999px;background:var(--line);
          transition:background .15s ease;flex:none}
#follow i::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
                 background:var(--dim);transition:transform .15s ease,background .15s ease}
#follow.on{color:var(--fg)}
#follow.on i{background:var(--ok)}
#follow.on i::after{transform:translateX(14px);background:#0d1017}
/* 에러 모드는 무엇을 보고 있는지가 색으로 바로 보여야 한다 */
.seg button[data-mode="error"]{color:var(--bad)}
.seg button[data-mode="error"].on{background:var(--bad);color:#0d1017}
#hint{color:var(--dim);font-size:.92em}
/* CLI 처럼 한 줄에 한 이벤트. 넘치면 가로 스크롤 대신 … 로 줄인다 —
   전문은 trace_id 를 눌러 상세에서 본다. */
#log{flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 12px}
.ln{display:block;white-space:pre;overflow:hidden;text-overflow:ellipsis}
.ln:hover{background:rgba(122,162,247,.08)}
.t{color:var(--dim)}
.lv{display:inline-block;width:5ch}
.ERROR,.FATAL{color:var(--bad);font-weight:700}
.WARN{color:var(--warn)}
.DEBUG,.TRACE{color:var(--dim)}
.tr{cursor:pointer;text-decoration:underline dotted transparent}
.tr:hover{text-decoration-color:currentColor}
.mk{color:var(--accent)}
.mk.orphan{color:var(--warn)}
.mk.call,.mk.narr{color:var(--dim)}
.nm{font-weight:600}
.nm.call{font-weight:400;color:var(--dim)}
.lg{color:var(--accent);opacity:.8}
.d-fast{color:var(--dim)}
.d-warn{color:var(--warn)}
.d-bad{color:var(--bad);font-weight:700}
/* 속성 줄 (상세 패널 전용 — 목록에는 안 싣는다) */
.attr{color:var(--dim)}
.ex{color:var(--bad)}
.frame{color:var(--dim)}
.frame.app{color:var(--fg)}
.legacy{color:var(--fg)}
#panel{position:fixed;inset:0 0 0 auto;width:var(--pw,min(920px,92vw));background:var(--panel);border-left:1px solid var(--line);
       transform:translateX(100%);transition:transform .16s ease;display:flex;flex-direction:column;z-index:5}
#panel.open{transform:none;box-shadow:-16px 0 40px rgba(0,0,0,.35)}
#panel.resizing{transition:none;user-select:none}
/* 왼쪽 모서리를 끌어 폭을 바꾼다 */
#grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:6}
#grip:hover,#panel.resizing #grip{background:var(--accent);opacity:.5}
#panel header{border-bottom:1px solid var(--line)}
#tree{flex:1;overflow:auto;padding:10px 14px}
/* 소요·waterfall 은 고정 컬럼, 들여쓰기는 이름 칸에만 준다.
   행 전체를 margin-left 로 밀면 깊이가 깊어질수록 숫자 컬럼까지 따라 밀린다. */
.trow{display:grid;grid-template-columns:7ch 1fr;gap:10px;align-items:start;padding:1px 0}
.trow.wf{grid-template-columns:7ch 160px 1fr}
.dur{text-align:right;white-space:nowrap}
/* 들여쓰기만으로는 단계가 잘 안 보여서, 패딩 영역에 단계마다 세로 실선을 깐다.
   DOM 을 늘리지 않고 배경만으로 그린다. */
.nmcol{
  padding-left:calc(var(--d,0) * var(--step));min-width:0;word-break:break-word;
  background-image:repeating-linear-gradient(to right,var(--line) 0 1px,transparent 1px var(--step));
  background-size:calc(var(--d,0) * var(--step)) 100%;
  background-repeat:no-repeat;
}
.detail .nmcol{white-space:pre-wrap;color:var(--dim)}
/* 값 하나가 수천 자인 경우가 있다(세션 속성 덤프 등). 전부 펼치면 트리가 묻히므로
   기본은 세 줄만 보이고 클릭하면 펴진다 — 자르는 게 아니라 접는 것이다. */
.clip{display:block;max-height:3.4em;overflow:hidden;position:relative;cursor:zoom-in}
.clip.open{max-height:none;cursor:zoom-out}
.clip:not(.open)::after{content:'⋯ 더보기';position:absolute;right:0;bottom:0;
  padding-left:10px;background:var(--panel);color:var(--accent)}
.track{position:relative;height:9px;margin-top:5px;background:var(--line);border-radius:3px}
.track i{position:absolute;top:0;bottom:0;background:var(--accent);opacity:.65;border-radius:3px;min-width:2px}
.thead{color:var(--dim);border-bottom:1px solid var(--line);padding-bottom:4px;margin-bottom:6px}
/* 줄 전체를 눌러 하위를 접는다. 접힌 개수는 평소엔 숨기고 접었을 때만 보여준다. */
.trow.tog{cursor:pointer;border-radius:4px}
.trow.tog:hover{background:rgba(122,162,247,.10)}
.kidn{display:none;color:var(--dim)}
.grp.collapsed > .trow .kidn{display:inline}
.grp.collapsed > .kids{display:none}
/* 접으면 한 줄로 줄어들어야 한다 — 자식 span 뿐 아니라 자기 속성 줄도 같이 감춘다.
   안 그러면 접어도 부피가 거의 안 준다. */
.grp.collapsed > .trow.detail{display:none}
.msg{color:var(--dim);padding:10px 12px}
.err{color:var(--bad)}
/* ── 팝오버 (소스·날짜) ─────────────────────────────────────────────────── */
.pop{position:absolute;top:40px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
     box-shadow:0 18px 44px rgba(0,0,0,.55);display:none;overflow:hidden;z-index:9}
.pop.open{display:flex}
.pop .col{display:flex;flex-direction:column;min-width:0}
.pop .hd{padding:7px 10px;color:var(--dim);font-size:.92em;border-bottom:1px solid var(--line);
         display:flex;gap:8px;align-items:center}
.pop .ft{padding:7px 10px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center;
         color:var(--dim);font-size:.92em}
.pop .lst{overflow:auto;max-height:44vh}
.pop .spacer{flex:1}
.pop .it{display:flex;gap:8px;align-items:center;padding:5px 10px;cursor:pointer}
.pop .it:hover{background:rgba(122,162,247,.12)}
.pop .it .ck{width:1.4ch;color:var(--line);flex:none}
.pop .it.sel{color:var(--accent)}
.pop .it.sel .ck{color:var(--accent)}
.pop .it.cur{background:var(--accent);color:#0d1017}
.pop .it.cur .ck{color:#0d1017}
.pop .sub{padding:0 10px 5px 34px;font-size:.92em;color:var(--dim)}
.pop .it.cur+.sub{background:var(--accent);color:#0d1017;opacity:.75}
.pop .apply{background:var(--ok);border-color:var(--ok);color:#0d1017;font-weight:600}
#srcpop{left:12px;width:660px}
#srcpop .p{width:230px;border-right:1px solid var(--line)}
#srcpop .g{flex:1}
/* 날짜 팝오버 — 왼쪽 빠른선택, 오른쪽 달력. 의존성 없이 직접 그린다. */
#calpop{width:430px}
#calpop .r{width:120px;border-right:1px solid var(--line);padding:4px 0}
#calpop .r div{padding:5px 12px;cursor:pointer;white-space:nowrap}
#calpop .r div:hover{background:rgba(122,162,247,.12)}
#calpop .r div.on{background:var(--accent);color:#0d1017;font-weight:600}
#calpop .c{flex:1}
#calpop .nav{display:flex;align-items:center;padding:8px 12px 4px}
#calpop .nav button{background:none;border:0;color:var(--dim);padding:0 6px}
#calpop .nav button:hover{color:var(--fg)}
#calpop .nav b{flex:1;text-align:center}
#calpop .dow,#calpop .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center}
#calpop .dow{padding:0 10px;color:var(--dim);font-size:.92em}
#calpop .grid{padding:4px 10px 10px}
#calpop .grid span{padding:4px 0;cursor:pointer;border-radius:4px}
#calpop .grid span:hover{background:rgba(122,162,247,.12)}
#calpop .grid span.off{color:var(--line);cursor:default}
#calpop .grid span.off:hover{background:none}
#calpop .grid span.in{background:rgba(122,162,247,.18);border-radius:0}
#calpop .grid span.a{background:var(--accent);color:#0d1017;font-weight:600;border-radius:4px 0 0 4px}
#calpop .grid span.b{background:var(--accent);color:#0d1017;font-weight:600;border-radius:0 4px 4px 0}
#calpop .grid span.a.b{border-radius:4px}
/* 설정 팝오버 — 기존 .pop 골격을 그대로 쓰고 안쪽 배치만 더한다 */
#gear{flex:none;background:var(--bg);padding:5px 10px}
#gear.open{border-color:var(--accent)}
#setpop{right:12px;width:430px}
#setpop .s{flex:1}
#setpop .lst{padding:4px 0;max-height:none}
#setpop .grp{display:flex;gap:10px;align-items:center;padding:6px 12px}
#setpop .grp > span:first-child{flex:1;min-width:0}
#setpop .grp.col2{flex-direction:column;align-items:stretch;gap:5px}
#setpop .sep{padding:9px 12px 3px;color:var(--dim);font-size:.92em;border-top:1px solid var(--line);margin-top:5px}
#setpop .note{padding:2px 12px 8px;color:var(--dim);font-size:.92em}
#setpop .dim{color:var(--dim)}
#setpop input{background:var(--bg)}
#setpop input.num{width:7ch;text-align:right}
/* 팝오버 안의 세그먼트는 헤더 것보다 작다 */
.seg.sm{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;flex:none}
.seg.sm button{border:0;border-right:1px solid var(--line);border-radius:0;padding:3px 9px;
               background:var(--bg);white-space:nowrap}
.seg.sm button:last-child{border-right:0}
.seg.sm button:hover{border-color:var(--line)}
.seg.sm button.on{background:var(--accent);color:#0d1017;font-weight:600}
/* ── 타임라인 — 받은 이벤트만 센다. CloudWatch 요청이 늘지 않는다. ───────── */
#tl{border-top:1px solid var(--line);background:var(--panel);padding:6px 12px 4px;flex:none;
    display:none;flex-direction:column;gap:3px}
#tl.on{display:flex}
#tl .hd{display:flex;gap:10px;align-items:center;color:var(--dim);font-size:.92em}
#tl .hd .e{color:var(--bad)}
#tl .hd .s{color:var(--fg)}
#tl .hd button{background:none;border:0;padding:0 2px;color:var(--dim);font-size:.92em}
#tl .hd button:hover{color:var(--fg);border-color:transparent}
#bars{position:relative;height:44px;display:flex;align-items:flex-end;gap:2px;cursor:crosshair;user-select:none}
#bars i{flex:1;background:var(--accent);min-height:1px;pointer-events:none}
#bars i.err{background:var(--bad)}
#bars i.dim{background:var(--line)}
#bars .box{position:absolute;top:0;bottom:0;border:1px solid var(--accent);border-radius:3px;
           background:rgba(122,162,247,.12);pointer-events:none}
#bars .now{position:absolute;right:0;top:0;bottom:0;width:2px;background:var(--ok);pointer-events:none}
#tl .ax{display:flex;justify-content:space-between;color:var(--dim);font-size:.92em}
</style>
</head>
<body>
<header>
  <div class="row">
    <button id="src" title="프로필·로그 그룹 고르기">
      <span class="dim" id="srcP">프로필</span><span class="sep">›</span>
      <span id="srcG"><b>그룹 선택</b></span><span class="dim" id="srcC">▾</span>
    </button>
    <span class="vr"></span>
    <div class="seg">
      <button data-mode="tail">실시간</button>
      <button data-mode="error">에러</button>
      <button data-mode="grep" class="on">검색</button>
    </div>
    <button id="follow" class="on">자동 스크롤<i></i></button>
    <button id="cal" title="조회 기간">
      <span class="dim">날짜</span><b id="calT">—</b><span class="dim" id="calN"></span><span class="dim" id="calC">▾</span>
    </button>
    <button id="go">조회</button>
    <span id="live" style="display:none"><i></i><span id="liveT"></span></span>
    <button id="stop" style="display:none">중지</button>
    <span class="grow"></span>
    <span id="hint"></span>
    <button id="gear" title="설정">⚙</button>
  </div>
  <div class="row" id="cond">
    <input id="term" class="grow" placeholder="검색어 (비우면 그 구간 전체) — 원본 줄 전체에서, 한글 가능" autocomplete="off">
  </div>

  <div class="pop" id="srcpop">
    <div class="col p">
      <div class="hd"><span id="pcount">프로필</span></div>
      <div class="lst" id="plist"></div>
      <div class="spacer"></div>
      <div class="ft">프로필을 바꾸면 그룹 선택이 비워진다</div>
    </div>
    <div class="col g">
      <div class="hd"><input id="gq" class="grow" placeholder="로그 그룹 검색" autocomplete="off"><span id="gsel"></span></div>
      <div class="lst" id="glist"></div>
      <div class="spacer"></div>
      <div class="ft"><span class="grow" id="ghint"></span>
        <button id="refresh" title="로그 그룹 목록 캐시 새로고침">↻</button>
        <button id="sapply" class="apply">적용</button></div>
    </div>
  </div>

  <div class="pop" id="calpop">
    <div class="col r" id="crail">
      <div data-cal="today">오늘</div>
      <div data-cal="yday">어제</div>
      <div data-cal="2d">최근 2일</div>
      <div data-cal="7d">최근 7일</div>
      <div data-cal="week">이번 주</div>
    </div>
    <div class="col c">
      <div class="nav"><button data-mv="-1">‹</button><b id="cmon"></b><button data-mv="1">›</button></div>
      <div class="dow"><div>일</div><div>월</div><div>화</div><div>수</div><div>목</div><div>금</div><div>토</div></div>
      <div class="grid" id="cgrid"></div>
      <div class="ft"><span class="grow" id="csum"></span><button id="dapply" class="apply">적용</button></div>
    </div>
  </div>
  <div class="pop" id="setpop">
    <div class="col s">
      <div class="hd">설정</div>
      <div class="lst">
        <div class="grp"><span>테마</span>
          <span class="seg sm" id="s-theme">
            <button data-theme="system">시스템</button><button data-theme="light">라이트</button><button data-theme="dark">다크</button>
          </span>
        </div>
        <div class="grp"><span>글자 크기</span>
          <span class="seg sm" id="s-font">
            <button data-font="11">11</button><button data-font="12">12</button><button data-font="13">13</button><button data-font="14">14</button><button data-font="15">15</button>
          </span>
        </div>

        <div class="sep">읽기</div>
        <div class="grp col2"><span>스택에서 하이라이트할 패키지 리스트</span>
          <input id="s-pkg" placeholder="com.acme, org.acme — 콤마로 여러 개 (비우면 안 함)" autocomplete="off">
        </div>
        <div class="grp"><span>소요시간 색</span>
          <span class="row">
            <b class="d-warn">주의</b> <input id="s-warn" class="num" inputmode="numeric"> ms
            <span class="dim">·</span>
            <b class="d-bad">느림</b> <input id="s-bad" class="num" inputmode="numeric"> ms
          </span>
        </div>
        <div class="note">
          <span class="d-fast">58ms</span> 빠름 ·
          <span class="d-warn">412ms</span> 주의 ·
          <span class="d-bad">1204ms</span> 느림
        </div>

        <div class="sep">동작</div>
        <div class="grp"><span>실시간 자동 정지</span>
          <span class="seg sm" id="s-tail">
            <button data-tail="30">30분</button><button data-tail="60">60분</button><button data-tail="120">120분</button><button data-tail="0">안 함</button>
          </span>
        </div>
        <div class="grp"><span>폴링 간격</span>
          <span class="seg sm" id="s-int">
            <button data-int="3">3초</button><button data-int="5">5초</button><button data-int="10">10초</button>
          </span>
        </div>
        <div class="note">간격을 늘리면 CloudWatch 요청이 그만큼 줄어든다.</div>
      </div>
      <div class="ft"><span class="grow" id="s-where"></span><button id="s-close" class="apply">닫기</button></div>
    </div>
  </div>
  <div id="prog"><i></i></div>
</header>

<div id="log"><div class="msg">프로필과 로그 그룹을 고르고 조회하세요.</div></div>

<div id="tl">
  <div class="hd">
    <span id="tlU"></span><span class="e" id="tlE"></span><span id="tlN"></span>
    <span class="grow"></span>
    <span class="s" id="tlS"></span><button id="tlClr" style="display:none">선택 해제</button>
  </div>
  <div id="bars"></div>
  <div class="ax"><span id="ax1"></span><span id="ax2"></span><span id="ax3"></span><span id="ax4"></span><span id="ax5"></span></div>
</div>

<div id="panel"><div id="grip" title="끌어서 폭 조절"></div><header class="row"><b id="ptitle">trace</b><span class="grow"></span><button id="close">닫기</button></header><div id="tree"></div></div>

<script>
const T = ${JSON.stringify(token)};
const $ = (s) => document.querySelector(s);
const api = (p, params = {}) => {
  const u = new URL(p, location.origin);
  u.searchParams.set('t', T);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

let CFG = { slow: { warn: 200, bad: 1000 }, maxGroups: 10, appPackages: [] };
let SET = { theme: 'system', fontSize: 13, appPackages: '', slowWarn: 200, slowBad: 1000,
            tailMaxMinutes: 60, intervalSec: 3 };
let groups = [];      // 전체 목록
let picked = [];      // 선택된 이름
let profiles = [];    // bootstrap 결과
let profile = '';     // 고른 프로필 이름
// 'tail' 실시간 · 'grep' 검색어 · 'error' 에러·예외.
// 검색어와 에러를 **섞지 않는다.** CloudWatch 는 텍스트 패턴과 JSON 패턴을 한 요청에
// 못 섞어서, 둘을 합치면 검색어가 원본 줄 전체가 아니라 message/logger/span.name
// 세 필드만 훑는 좁은 검색으로 조용히 바뀐다 (trace_id 로 찾으면 0건이 나온다).
let mode = 'grep';
let es = null;        // EventSource
// 받은 이벤트를 들고 있는다 — 타임라인 집계와 구간 좁히기가 이걸 쓴다.
// 안 들고 있으면 구간을 고를 때마다 CloudWatch 를 다시 긁어야 한다.
let all = [];
let sel = null;       // 고른 구간 {a,b} (epoch ms) — 없으면 전체
let winA = 0, winB = 0;  // 타임라인이 덮는 구간
let tlTimer = null;
let runAt = 0;        // 조회 시작 시각 — 경과는 여기서 뺀다
let stoppedMs = 0;    // 멈춘 시각 — 끝난 뒤에도 '얼마나 걸렸나' 를 남기려면 필요하다
let runTimer = null;  // 0.25초마다 표시기를 다시 그린다
let usage = null;     // 마지막 usage SSE

// ── trace 색: 처음 본 순서대로. 해시가 아니라 순번이라 인접 요청이 안 겹친다. ──
const PALETTE = ['#7aa2f7','#bb9af7','#7dcfff','#9ece6a','#2ac3de','#c0caf5','#b4f9f8','#ff9e64',
                 '#a9b1d6','#41a6b5','#e0af68','#73daca','#9d7cd8','#449dab'];
// 배정표는 조회 한 판 동안 유지된다 — 구간을 좁혀 다시 그려도 색이 안 바뀌게.
const [traceColor, resetColors] = (() => {
  let seen = new Map(); let next = 0;
  return [
    (id) => {
      if (!id) return 'var(--dim)';
      if (!seen.has(id)) seen.set(id, next++);
      return PALETTE[seen.get(id) % PALETTE.length];
    },
    () => { seen = new Map(); next = 0; },
  ];
})();

const shortTrace = (id) => (id ? String(id).slice(-12) : '');
const fmtMs = (ms) => (!Number.isFinite(ms) ? '' : ms >= 10000 ? (ms/1000).toFixed(1)+'s' : ms+'ms');
const durClass = (ms) => {
  if (!Number.isFinite(ms)) return '';
  if (ms >= CFG.slow.bad) return 'd-bad';
  if (ms >= CFG.slow.warn) return 'd-warn';
  return ms < 50 ? 'd-fast' : '';
};
const timeText = (ev) => (ev.tsText && ev.tsText.length >= 23 ? ev.tsText.slice(11,23) : '');
const shortLogger = (f) => (f ? String(f).split('.').pop() : '');
const fmtVal = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
/**
 * OTel 표준 span.attributes 와 사용자 정의 속성을 한 벌로 합친다.
 *
 * 순서가 중요하다 — 한 줄에는 앞 3개만 보이는데, 표준 속성을 앞에 두면
 * thread.id 같은 잡음이 그 자리를 먹고 정작 도메인 신호인 사용자 정의 속성이 밀려난다.
 * 그래서 **사용자 정의를 먼저** 놓고, 같은 키면 그쪽 값이 이기게 한 번 더 덮는다
 * (첫 등장 위치는 유지되므로 순서는 그대로다).
 */
const mergeAttrs = (ev) => {
  const biz = ev.business ?? {};
  const merged = { ...biz, ...(ev.attributes ?? {}), ...biz };
  // 판정 기준은 **지우기 전에** 굳혀 둔다. 지우면서 다시 보면 db.system 을 지운 순간
  // 'DB span 이 아닌 것' 이 되어 뒤따르는 접속 정보가 살아남는다.
  const shape = {
    isDb: merged['db.statement'] != null || merged['db.system'] != null,
    hasStatement: merged['db.statement'] != null,
  };
  for (const k of Object.keys(merged)) {
    // 사용자가 직접 붙인 속성은 절대 숨기지 않는다 — 숨길 이유를 우리가 알 수 없다.
    if (k in biz) continue;
    if (restatesName(k, merged[k], ev.spanName) || isPlumbing(k, shape)) delete merged[k];
  }
  return merged;
};

/**
 * 볼 필요 없는 접속 배관인가.
 *
 * DB span 에는 매 쿼리마다 같은 접속 정보가 통째로 붙는다 — 호스트·포트·계정·스키마·드라이버.
 * 쿼리를 읽는 데 아무 도움이 안 되면서 좁은 자리를 먹고, db.connection_string 과
 * server.address 는 내부 엔드포인트를 화면에 그대로 띄운다(스크린샷으로 새어 나간다).
 * 정작 볼 것은 db.statement 하나다.
 *
 * server.* 는 DB span 에서만 숨긴다 — HTTP 호출 span 에서는 '어느 서비스가 죽었나' 라
 * 가장 중요한 값이다.
 */
function isPlumbing(key, { isDb, hasStatement }) {
  if (!isDb || key === 'db.statement') return false;
  if (!key.startsWith('db.') && !key.startsWith('server.')) return false;
  // 쿼리문이 없으면 연산·테이블이라도 남긴다 — 그마저 지우면 빈 줄이 된다.
  if (!hasStatement && (key === 'db.operation' || key === 'db.sql.table')) return false;
  return true;
}

/**
 * span 이름이 이미 말하고 있는 속성인가.
 *
 * OTel 계측이 붙이는 code.function/code.namespace 는 대개 span 이름을 그대로 다시 적는다 —
 * SchedulerService.findRenewNotiTarget 옆에 code.function=findRenewNotiTarget 이 또 붙는 식이라,
 * 한 줄에 세 개만 보이는 자리를 잡음이 먹는다. 다만 span 이름을 다르게 붙이는 경우도
 * 있으므로 **실제로 겹칠 때만** 숨긴다.
 */
function restatesName(key, value, spanName) {
  if (!spanName || typeof value !== 'string') return false;
  if (key === 'code.function') return spanName === value || spanName.endsWith('.' + value);
  if (key === 'code.namespace') {
    const cls = value.split('.').pop();
    return spanName === cls || spanName.startsWith(cls + '.');
  }
  return false;
}

/** '내 코드' 프레임인가. 설정이 비어 있으면 아무것도 강조하지 않는다. */
const isAppFrame = (f) => CFG.appPackages.some((p) => f.includes(p));


// ── 한 줄 렌더 — CLI 의 tier·깊이·색 규칙을 그대로 따른다 ──────────────────
function renderLine(ev) {
  if (ev.tier === 'legacy') {
    return '<div class="ln legacy">' + esc(ev.message) + '</div>';
  }
  const lvl = String(ev.level ?? '').toUpperCase();
  const col = traceColor(ev.traceId);
  const indent = '  '.repeat(Math.min(ev.depth ?? 0, 8));

  let mk = '', name = '', right = '';
  if (ev.tier === 'wide' || ev.tier === 'call') {
    const cls = ev.tier === 'call' ? (ev.parentMissing ? 'mk orphan' : 'mk call') : 'mk';
    mk = '<span class="'+cls+'">' + (ev.tier !== 'call' ? '● ' : ev.parentMissing ? '⇡ ' : '↳ ') + '</span>';
    name = '<span class="nm' + (ev.tier === 'call' ? ' call' : '') + '">' + esc(ev.spanName ?? '(이름 없음)') + '</span>';
    if (Number.isFinite(ev.durationMs)) right += '  <span class="' + durClass(ev.durationMs) + '">' + fmtMs(ev.durationMs) + '</span>';
    if (ev.status && ev.status !== 'UNSET') right += ' <span class="' + (ev.status === 'ERROR' ? 'ERROR' : '') + '">' + esc(ev.status) + '</span>';
  } else {
    mk = '<span class="mk narr">· </span>';
    name = '<span class="lg">' + esc(shortLogger(ev.logger)) + '</span>  ' + esc(String(ev.message ?? '').split('\\n')[0]);
  }

  // 속성은 목록에 안 싣는다. 여기는 훑는 화면이고, 세 개씩 잘라 붙여 봐야
  // 시간·이름·소요시간을 읽는 눈만 흐린다. 궁금하면 trace_id 를 눌러 상세에서 전부 본다.

  let out = '<div class="ln">'
    + '<span class="t">' + timeText(ev) + '</span> '
    + '<span class="lv ' + lvl + '">' + lvl.padEnd(5) + '</span> '
    + '<span class="tr" style="color:' + col + '" data-trace="' + esc(ev.traceId ?? '') + '">' + shortTrace(ev.traceId).padEnd(12) + '</span> '
    + indent + mk + name + right
    + '</div>';

  const ex = ev.spanException ?? ev.exception;
  if (ex) {
    out += '<div class="ln ex">      ✗ ' + esc(ex.className) + (ex.message ? ': ' + esc(ex.message) : '') + '</div>';
    const where = ex.first_app_frame ?? ex.thrown_at;
    if (where) out += '<div class="ln frame">        ' + esc(where) + '</div>';
  }
  return out;
}

// ── 로그 목록 ────────────────────────────────────────────────────────────
const LOG_MAX = 20000;
const logEl = $('#log');
function clearLog(msg) { logEl.innerHTML = msg ? '<div class="msg">'+esc(msg)+'</div>' : ''; }

const inSel = (ev) => !sel || (ev.ts >= sel.a && ev.ts < sel.b);

/** 구간이 바뀌었을 때만 통째로 다시 그린다 — 평소엔 아래 증분 렌더를 쓴다. */
function redraw() {
  const v = all.filter(inSel);
  logEl.innerHTML = v.length ? v.map(renderLine).join('') : '<div class="msg">이 구간에는 없습니다.</div>';
  drawTL();
}

function appendEvents(evs) {
  if (!evs.length) return;
  const atBottom = $('#follow').classList.contains('on');
  for (const ev of evs) all.push(ev);
  while (all.length > LOG_MAX) all.shift();
  drawTL();
  drawRunState();
  // 구간을 골라 둔 동안은 목록을 건드리지 않는다 — 보고 있던 게 밀려나면 안 된다.
  if (sel) return;
  logEl.insertAdjacentHTML('beforeend', evs.map(renderLine).join(''));
  while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

const fmtBytes = (n) => (n < 1024*1024 ? (n/1024).toFixed(0)+' KB' : (n/1048576).toFixed(1)+' MB');
/** 경과. 분 단위를 넘으면 '5분 12초' 로 — 초만 세면 큰 수가 읽히지 않는다. */
const fmtElapsed = (ms) => {
  const s = ms / 1000;
  return s < 60 ? s.toFixed(1) + '초'
    : Math.floor(s / 60) + '분 ' + String(Math.floor(s % 60)).padStart(2, '0') + '초';
};
/** 남은 시간 — 시계처럼 mm:ss 로. 자동 정지까지 얼마나 남았는지 한눈에 읽혀야 한다. */
const fmtCountdown = (ms) => {
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
function setUsage(u) {
  if (!u) return;
  usage = u;
  drawRunState();
}

// ── 설정 ────────────────────────────────────────────────────────────────
// 서버의 상태 디렉터리에 저장한다. localStorage 였다면 포트가 매번 바뀌어(--port 0)
// 재시작마다 사라진다.

/** 값을 화면에 반영한다. 저장은 따로 — 부팅 때는 저장할 게 없다. */
function applySettings(next) {
  SET = { ...SET, ...next };
  // 테마: 속성이 없으면 OS 를 따르고, 있으면 그게 이긴다 (CSS 쪽에서 :not([data-theme]) 로 가둬 뒀다)
  const root = document.documentElement;
  if (SET.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', SET.theme);
  root.style.setProperty('--fs', SET.fontSize + 'px');

  CFG.slow = { warn: SET.slowWarn, bad: SET.slowBad };
  CFG.appPackages = String(SET.appPackages || '').split(',').map((x) => x.trim()).filter(Boolean);
  drawSettings();
}

/** 팝오버의 현재 선택 상태를 그린다. */
function drawSettings() {
  const mark = (sel, attr, val) => {
    for (const b of document.querySelectorAll(sel + ' button')) {
      b.classList.toggle('on', b.dataset[attr] === String(val));
    }
  };
  mark('#s-theme', 'theme', SET.theme);
  mark('#s-font', 'font', SET.fontSize);
  mark('#s-tail', 'tail', SET.tailMaxMinutes);
  mark('#s-int', 'int', SET.intervalSec);
  // 입력 중인 칸은 건드리지 않는다 — 타이핑하는 값이 되돌아가면 못 쓴다.
  if (document.activeElement !== $('#s-pkg')) $('#s-pkg').value = SET.appPackages ?? '';
  if (document.activeElement !== $('#s-warn')) $('#s-warn').value = SET.slowWarn;
  if (document.activeElement !== $('#s-bad')) $('#s-bad').value = SET.slowBad;
}

/**
 * 바꾼 값을 저장한다. 화면에는 먼저 반영하고(기다릴 이유가 없다) 서버 응답으로 맞춘다 —
 * 서버가 범위 밖 값을 되돌릴 수 있으므로 응답이 최종이다.
 */
async function saveSettings(patch) {
  applySettings(patch);
  const repaint = 'slowWarn' in patch || 'slowBad' in patch || 'appPackages' in patch;
  try {
    const r = await fetch(api('/api/settings', patch));
    const d = await r.json();
    if (r.ok && d.settings) applySettings(d.settings);
  } catch { /* 저장 실패해도 이번 세션에는 적용돼 있다 */ }
  // 색 기준·강조 패키지가 바뀌면 이미 그려진 줄도 다시 칠해야 한다.
  // 안 그러면 새 줄만 새 기준이라 화면이 섞인다.
  if (repaint) {
    redraw();
    if ($('#panel').classList.contains('open') && openTraceId) openTrace(openTraceId);
  }
}

function openSet(on) {
  $('#setpop').classList.toggle('open', on);
  $('#gear').classList.toggle('open', on);
  if (on) { openPop(false); openCal(false); drawSettings(); }
}

// ── 소스 (프로필 · 로그 그룹) ────────────────────────────────────────────
// CLI 마법사와 같은 순서다 — 왼쪽에서 프로필, 오른쪽에서 그룹.
function findByFragment(items, q) {  // CLI 의 findByFragment 와 같은 AND 규칙
  const toks = String(q||'').trim().split(/\\s+/).filter(Boolean);
  if (!toks.length) return items;
  return items.filter((it) => toks.every((t) => it.toLowerCase().includes(t.toLowerCase())));
}
function drawSource() {
  $('#srcP').textContent = profile || '프로필';
  $('#srcG').innerHTML = picked.length
    ? '<b>' + esc(picked[0].split('/').pop()) + '</b>'
      + (picked.length > 1 ? ' <span class="dim">+' + (picked.length - 1) + '</span>' : '')
    : '<b>그룹 선택</b>';
}
function drawProfiles() {
  $('#pcount').textContent = '프로필 ' + profiles.length + '개';
  $('#plist').innerHTML = profiles.map((p) =>
    '<div class="it' + (p.name === profile ? ' cur' : '') + '" data-prof="' + esc(p.name) + '">'
    + '<span class="ck">' + (p.name === profile ? '✓' : '·') + '</span><span>' + esc(p.name) + '</span></div>'
    + (p.label ? '<div class="sub">' + esc(p.label) + '</div>' : '')).join('');
}
function drawGroups() {
  const hits = findByFragment(groups.map((g) => g.name), $('#gq').value).slice(0, 60);
  $('#gsel').textContent = picked.length + ' / ' + CFG.maxGroups;
  $('#ghint').textContent = groups.length + '개 중 ' + hits.length + '개 일치';
  $('#glist').innerHTML = hits.map((n) =>
    '<div class="it' + (picked.includes(n) ? ' sel' : '') + '" data-tog="' + esc(n) + '">'
    + '<span class="ck">' + (picked.includes(n) ? '✓' : '·') + '</span><span>' + esc(n) + '</span></div>').join('')
    || '<div class="msg">일치하는 그룹이 없습니다.</div>';
}
function openPop(on) {
  $('#srcpop').classList.toggle('open', on);
  $('#src').classList.toggle('open', on);
  $('#srcC').textContent = on ? '▴' : '▾';
  if (on) { openCal(false); drawProfiles(); drawGroups(); $('#gq').focus(); }
}

// ── 기간 — 날짜 단위 (00:00:00 ~ 23:59:59) ───────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
// 서버의 parseSince 는 맨 날짜('2026-08-13')를 **UTC 자정**으로 읽는다.
// 오프셋을 붙여야 로컬 자정이 된다 — 안 붙이면 9시간이 통째로 밀린다.
const offset = (() => {
  const m = -new Date().getTimezoneOffset();
  return (m >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(m)/60)) + ':' + pad(Math.abs(m)%60);
})();
const dayStart = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
const md = (d) => pad(d.getMonth()+1) + '-' + pad(d.getDate());
const dayCount = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86400000) + 1;

let dFrom = null, dTo = null;        // 확정된 범위
let calA = null, calB = null, calM = null;  // 팝오버에서 고르는 중인 범위 · 보이는 달

function preset(k) {
  const t = dayStart(new Date());
  if (k === 'today') return [t, t];
  if (k === 'yday') return [addD(t,-1), addD(t,-1)];
  if (k === '2d') return [addD(t,-1), t];
  if (k === '7d') return [addD(t,-6), t];
  return [addD(t, -t.getDay()), t];   // 이번 주 (일요일 시작)
}
function drawDate() {
  const n = dayCount(dFrom, dTo);
  $('#calT').textContent = ymd(dFrom) + (n > 1 ? ' ~ ' + md(dTo) : '');
  $('#calN').textContent = n > 1 ? n + '일' : '';
}
function drawCal() {
  $('#cmon').textContent = calM.getFullYear() + '-' + pad(calM.getMonth()+1);
  const y = calM.getFullYear(), m = calM.getMonth();
  const lead = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const today = dayStart(new Date());
  const a = calA, b = calB ?? calA;

  let h = '<span class="off"></span>'.repeat(lead);
  for (let d = 1; d <= days; d++) {
    const cur = new Date(y, m, d);
    // 미래는 고를 수 없다 — 로그가 있을 리 없는 구간을 조회해 봐야 0건이다.
    if (cur > today) { h += '<span class="off">' + d + '</span>'; continue; }
    const cls = a && cur >= a && cur <= b
      ? [+cur === +a ? 'a' : '', +cur === +b ? 'b' : '', +cur !== +a && +cur !== +b ? 'in' : ''].filter(Boolean).join(' ')
      : '';
    h += '<span class="' + cls + '" data-d="' + ymd(cur) + '">' + d + '</span>';
  }
  $('#cgrid').innerHTML = h;
  $('#csum').textContent = a ? ymd(a) + ' 00:00:00 ~ ' + ymd(b) + ' 23:59:59' : '날짜를 고르세요';
  for (const el of document.querySelectorAll('#crail div')) {
    const [pa, pb] = preset(el.dataset.cal);
    el.classList.toggle('on', !!a && +pa === +a && +pb === +b);
  }
}
function openCal(on) {
  $('#calpop').classList.toggle('open', on);
  $('#cal').classList.toggle('open', on);
  $('#calC').textContent = on ? '▴' : '▾';
  if (!on) return;
  openPop(false);
  calA = dFrom; calB = dTo;
  calM = new Date(dTo.getFullYear(), dTo.getMonth(), 1);
  $('#calpop').style.left = $('#cal').offsetLeft + 'px';
  drawCal();
}

// ── 타임라인 — 받은 이벤트를 세는 것뿐이다. 추가 요청이 없다. ────────────
const TAIL_SPAN = 900_000;   // 최근 15분
const TAIL_UNIT = 30_000;    // 30초 버킷
// 실시간을 이만큼 돌리면 멈추고 계속할지 묻는다. CLI 의 --max-minutes(기본 60분) 와 같은
// 안전장치다 — 탭 전환으로 안 끊는 대신, '켜둔 채 잊기' 는 이쪽에서 막는다.
// 0 이면 무제한. 무제한은 Infinity 로 두면 비교·표시가 자연히 꺼진다.
const tailMaxMs = () => (SET.tailMaxMinutes > 0 ? SET.tailMaxMinutes * 60_000 : Infinity);
// 눈금이 딱 떨어지는 단위만 쓴다 — '1시간 7분 단위' 같은 건 읽을 수가 없다.
const UNITS = [[30_000,'30초'],[60_000,'1분'],[300_000,'5분'],[600_000,'10분'],[1_800_000,'30분'],
               [3_600_000,'1시간'],[10_800_000,'3시간'],[21_600_000,'6시간'],[86_400_000,'1일']];
const pickUnit = (span) => UNITS.find(([ms]) => span / ms <= 80) ?? UNITS[UNITS.length - 1];

/** 서버 --error 와 같은 기준(src/filter/dsl.js). 레벨만 보면 span 실패를 놓친다. */
const isErr = (ev) => {
  const l = String(ev.level ?? '').toUpperCase();
  return l === 'ERROR' || l === 'FATAL' || ev.status === 'ERROR' || !!ev.exception || !!ev.spanException;
};
const tlAt = (ms, withDate = true) => {
  const d = new Date(ms);
  return (withDate ? md(d) + ' ' : '') + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const tlUnit = () => (mode === 'tail' ? [TAIL_UNIT, '30초'] : pickUnit(Math.max(1, winB - winA)));

function drawTL() {
  const live = mode === 'tail';
  if (live) { winB = Date.now(); winA = winB - TAIL_SPAN; }
  const span = Math.max(1, winB - winA);
  const [unit, uname] = tlUnit();
  const n = Math.max(1, Math.ceil(span / unit));
  const buckets = Array.from({ length: n }, () => ({ n: 0, e: 0 }));

  let total = 0, errs = 0, picked_ = 0;
  for (const ev of all) {
    if (!Number.isFinite(ev.ts)) continue;   // 안내 줄 등은 세지 않는다
    total += 1;
    const bad = isErr(ev);
    if (bad) errs += 1;
    if (inSel(ev)) picked_ += 1;
    const i = Math.floor((ev.ts - winA) / unit);
    if (i < 0 || i >= n) continue;
    buckets[i].n += 1;
    if (bad) buckets[i].e += 1;
  }

  const max = Math.max(1, ...buckets.map((b) => b.n));
  const hit = (i) => !sel || (winA + (i+1)*unit > sel.a && winA + i*unit < sel.b);
  let h = buckets.map((b, i) =>
    '<i class="' + (!hit(i) ? 'dim' : b.e ? 'err' : '') + '" style="height:'
    + (b.n ? Math.max(4, (b.n / max) * 100).toFixed(1) : 0) + '%"></i>').join('');
  if (sel) {
    const l = Math.max(0, ((sel.a - winA) / span) * 100);
    const r = Math.max(0, ((winB - sel.b) / span) * 100);
    h += '<div class="box" style="left:' + l.toFixed(2) + '%;right:' + r.toFixed(2) + '%"></div>';
  }
  if (live) h += '<div class="now" title="지금"></div>';
  $('#bars').innerHTML = h;

  // 무엇을 센 막대인지 적는다. 검색어를 걸었으면 전체 트래픽이 아니라 일치한 것의 분포다.
  const what = mode === 'error' ? '에러·예외만'
    : $('#term').value ? '검색어 일치' : '전체';
  $('#tlU').textContent = live
    ? '실시간 · ' + uname + ' 단위 · 최근 15분'
    : '타임라인 · ' + uname + ' 단위 · ' + what;
  $('#tlE').textContent = errs ? '에러 ' + errs.toLocaleString() : '';
  $('#tlN').textContent = total.toLocaleString() + '건';
  // 끝의 날짜는 시작과 다를 때만 붙인다 — '23:00 ~ 00:00' 은 어느 날인지 알 수 없다.
  const sameDay = sel && new Date(sel.a).toDateString() === new Date(sel.b).toDateString();
  $('#tlS').textContent = sel
    ? '선택 ' + tlAt(sel.a) + ' ~ ' + tlAt(sel.b, !sameDay) + ' · ' + picked_.toLocaleString() + '건' : '';
  $('#tlClr').style.display = sel ? '' : 'none';

  const withDate = span > 43_200_000;
  for (let k = 0; k < 5; k++) {
    const t = winA + (span * k) / 4;
    $('#ax' + (k+1)).textContent = live
      ? (k === 4 ? '지금' : '-' + Math.round((winB - t) / 60000) + '분')
      : tlAt(t, withDate);
  }
}

// ── 조회 ─────────────────────────────────────────────────────────────────
function params() {
  return {
    profile,
    groups: picked.join(','),
    since: ymd(dFrom) + 'T00:00:00' + offset,
    until: ymd(dTo) + 'T23:59:59' + offset,
    // 모드마다 조건이 하나뿐이다 — 서버로 나가는 패턴도 한 갈래로만 컴파일된다.
    error: mode === 'error' ? '1' : '',
    grep: mode === 'grep' ? $('#term').value : '',
  };
}

/** 모드에 따라 보이는 칸이 바뀐다. 조작부는 전부 왼쪽에 모아 둔다. */
function drawRunState() {
  const live = mode === 'tail';
  const on = !!es;
  $('#cal').style.display = live ? 'none' : '';
  $('#cond').style.display = mode === 'grep' ? '' : 'none';
  $('#go').style.display = on ? 'none' : '';
  $('#go').textContent = live ? '시작' : '조회';
  $('#stop').style.display = on ? '' : 'none';
  // 실시간엔 '도는 중' 바를 안 띄운다 — 끝이 없는 작업이라 계속 흘러가면 소음이 된다.
  // 살아 있다는 신호는 초록 점과 계속 쌓이는 줄로 이미 충분하다.
  $('#prog').classList.toggle('on', on && !live);

  // 끝나도 결과를 지우지 않는다 — '몇 건을 얼마나 받았나' 는 조회가 끝난 **뒤에**
  // 보고 싶은 값이다. 다음 조회를 시작할 때 runAt 과 함께 초기화된다.
  $('#live').style.display = runAt ? '' : 'none';
  $('#live').classList.toggle('done', !on);
  if (!runAt) return;

  const bits = [];
  if (!on) {
    // 멈춘 뒤. 실시간은 걸린 시간이 의미 없고, 조회는 얼마나 걸렸는지가 남을 값이다.
    bits.push('<b>' + (live ? '추적 중지' : '조회 완료 ' + fmtElapsed(stoppedMs - runAt)) + '</b>');
  } else if (live) {
    // 실시간은 '얼마나 지났나' 가 아니라 **언제 멈추나** 를 보여준다 — 자동 정지가
    // 있는데 안 보이면 갑자기 끊긴 것처럼 느껴진다.
    const cap = tailMaxMs();
    if (cap === Infinity) {
      bits.push('<b>추적 중</b>');
    } else {
      const left = Math.max(0, cap - (Date.now() - runAt));
      const soon = left < 5 * 60_000;   // 5분 남으면 눈에 띄게
      bits.push('<b>추적 중</b><span class="' + (soon ? 'w' : 'n') + '" title="'
        + (cap / 60_000) + '분이 지나면 자동으로 멈춥니다"> ' + fmtCountdown(left) + '</span>');
    }
  } else {
    bits.push('<b>조회 중 ' + fmtElapsed(Date.now() - runAt) + '</b>');
  }
  bits.push('<span class="n">' + all.length.toLocaleString() + '건</span>');
  if (usage) {
    bits.push('<span class="n">요청 ' + usage.requests.toLocaleString() + '회</span>');
    bits.push('<span class="n">' + fmtBytes(usage.bytes) + '</span>');
  }
  $('#liveT').innerHTML = bits.join('<span class="n"> · </span>');
}

/**
 * 실시간 시간 제한. 조용히 끊으면 '로그가 안 오네' 로 오해하므로 왜 멈췄는지 말하고
 * 다시 켤 방법을 같이 준다 — 받아 둔 줄은 그대로 남긴다.
 */
function hitTailLimit() {
  stopStream();
  appendEvents([{ tier: 'legacy', message:
    '⏸ ' + Math.round(tailMaxMs() / 60_000) + '분이 지나 실시간 추적을 멈췄습니다. '
    + '[시작] 을 누르면 다시 따라갑니다.' }]);
}

function stopStream() {
  if (es) { es.close(); es = null; stoppedMs = Date.now(); }
  for (const t of [tlTimer, runTimer]) if (t) clearInterval(t);
  tlTimer = runTimer = null;
  // 끝난 뒤에도 푸터에는 '얼마나 걸려 무엇을 받았는지' 가 남아야 한다.
  if (usage) setUsage(usage);
  drawRunState();
}

/**
 * 실시간이든 과거 구간이든 같은 SSE 를 쓴다.
 * 과거 구간도 조각씩 받아 쌓으므로 **건수 상한이 없다** — 다 받거나, 중지를 누르면 거기서 멈춘다.
 */
async function run() {
  stopStream();
  if (!picked.length) { clearLog('로그 그룹을 하나 이상 고르세요.'); openPop(true); return; }

  const live = mode === 'tail';
  all = []; sel = null;
  runAt = Date.now(); stoppedMs = 0; usage = null;
  resetColors();
  clearLog(live ? '' : '조회 중…');
  $('#hint').textContent = '';
  if (live) { winB = Date.now(); winA = winB - TAIL_SPAN; }
  else { winA = dayStart(dFrom).getTime(); winB = addD(dayStart(dTo), 1).getTime() - 1; }
  $('#tl').classList.add('on');
  drawTL();
  let got = 0;

  const p = params();
  es = new EventSource(api('/api/tail', live
    // 실시간은 '지금 −5분부터 계속' 이라 구간 개념이 없고, 조건 칸도 감춰 둔다.
    // 감춘 조건을 몰래 걸면 왜 안 나오는지 알 수 없으므로 아예 보내지 않는다.
    ? { profile: p.profile, groups: p.groups, follow: '1', since: '5m', interval: String(SET.intervalSec) }
    : { ...p, follow: '0' }));

  es.addEventListener('meta', (e) => {
    const d = JSON.parse(e.data);
    // 서버가 못 거른 조건이 있을 때만 알린다 — 늘 띄우면 거짓말이 된다.
    if (d.residual?.length) $('#hint').textContent = '일부는 클라이언트에서 거른다: ' + d.residual.join(' · ');
  });
  es.addEventListener('events', (e) => {
    const evs = JSON.parse(e.data);
    if (!got) clearLog('');
    got += evs.length;
    appendEvents(evs);
  });
  es.addEventListener('usage', (e) => setUsage(JSON.parse(e.data)));
  es.addEventListener('notice', (e) => appendEvents([{ tier: 'legacy', message: '⚠ ' + JSON.parse(e.data).text }]));
  es.addEventListener('fatal', (e) => {
    const d = JSON.parse(e.data);
    clearLog(d.error + (d.hint ? '\\n  ' + d.hint : ''));
    stopStream();
  });
  // 과거 구간을 다 훑으면 서버가 done 을 보낸다. 그때 스트림을 닫는다.
  es.addEventListener('done', () => {
    stopStream();
    if (!got) clearLog('결과가 없습니다.');
  });
  es.onerror = () => { if (!live) stopStream(); /* 실시간은 브라우저가 재연결한다 */ };

  // 실시간은 조용해도 창이 흘러야 한다 — 이벤트가 안 와도 눈금을 밀어 준다.
  if (live) tlTimer = setInterval(drawTL, 5000);
  // 표시기 갱신. 실시간은 남은 시간이 1초마다 줄어야 하고(시계가 5초씩 튀면 고장으로 보인다),
  // 조회는 경과를 잘게 보여줘야 '도는 중' 이 전달된다.
  runTimer = setInterval(() => {
    if (live && Date.now() - runAt >= tailMaxMs()) return hitTailLimit();
    drawRunState();
  }, live ? 1000 : 250);
  drawRunState();
}

// ── trace 트리 ───────────────────────────────────────────────────────────
/**
 * 한 행. 소요·waterfall 은 고정 칸이고 depth 는 이름 칸에만 먹인다.
 * 막대가 없는 행(상세·머리글)도 칸은 차지해야 세로가 맞지만, 빈 트랙 배경까지
 * 그리면 회색 막대가 줄마다 깔린다 — 칸만 비워 둔다.
 */
function trow({ depth, cls = '', dur = '', bar = '', body }) {
  return '<div class="trow wf' + (cls ? ' ' + cls : '') + '" style="--d:' + depth + '">'
    + '<span class="dur">' + dur + '</span>'
    + (bar ? '<span class="track">' + bar + '</span>' : '<span></span>')
    + '<span class="nmcol">' + body + '</span>'
    + '</div>';
}

function renderNode(n, depth, t0, total) {
  const ev = n.ev;
  const d = ev.durationMs;

  // waterfall: 시작 = 종료 − 소요 (span 은 끝날 때 기록되므로 되살려야 한다)
  const start = (ev.ts ?? 0) - (d || 0);
  const left = total > 0 ? Math.max(0, Math.min(100, ((start - t0) / total) * 100)) : 0;
  const width = total > 0 && Number.isFinite(d) ? Math.max(0.6, Math.min(100 - left, (d / total) * 100)) : 0;
  const bar = width ? '<i style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></i>' : '';

  // 자식이 있으면 줄 아무 데나 눌러 접었다 펼 수 있다 (마커만으로는 표적이 너무 작다).
  const hasKids = n.children.length > 0;
  const marker = n.orphan ? '⇡ ' : n.parentId == null ? '● ' : '↳ ';
  const mkCls = 'mk' + (n.orphan ? ' orphan' : n.parentId == null ? '' : ' call');
  const body = '<span class="' + mkCls + '">' + marker + '</span>'
    + '<b>' + esc(ev.spanName ?? '(이름 없음)') + '</b>'
    + (hasKids ? '<span class="kidn"> +' + n.children.length + '</span>' : '')
    + (ev.status && ev.status !== 'UNSET' ? ' <span class="' + (ev.status === 'ERROR' ? 'ERROR' : '') + '">' + esc(ev.status) + '</span>' : '')
    + (n.dupes ? ' <span class="t">×' + (n.dupes + 1) + '</span>' : '')
    + (n.cycle ? ' <span class="WARN">⟲순환</span>' : '');

  let h = trow({
    depth,
    cls: hasKids ? 'tog' : '',
    dur: '<span class="' + durClass(d) + '">' + fmtMs(d) + '</span>',
    bar,
    body,
  });

  // 상세는 이름 칸 아래에 붙는다 (한 단계 더 들여쓴다).
  // 긴 값은 접어 둔다 — 안 그러면 값 하나가 트리 전체를 밀어낸다.
  const detail = (inner, cls) => {
    const plain = inner.replace(/<[^>]+>/g, '');
    const body = plain.length > 220 ? '<span class="clip">' + inner + '</span>' : inner;
    return trow({ depth: depth + 1, cls: 'detail ' + (cls || ''), bar: '', body });
  };

  if (n.orphan) h += detail('⚠ 부모 span ' + esc(String(n.parentId ?? '').slice(-12)) + ' 이 조회 범위 밖입니다', 'ex');

  // 상세 화면에서는 속성을 고르지 않는다 — 긴 값은 .clip 으로 접히므로 전부 보여준다.
  // 예전엔 7개 키 allowlist 라, 그 밖의 속성은 어디서도 볼 수 없었다.
  const merged = mergeAttrs(ev);
  for (const [k, v] of Object.entries(merged)) {
    h += detail(esc(k + '=' + fmtVal(v)), 'attr');
  }

  const ex = ev.spanException ?? ev.exception;
  if (ex) {
    h += detail('✗ ' + esc(ex.className) + (ex.message ? ': ' + esc(ex.message) : ''), 'ex');
    if (ex.stackTrace) {
      const frames = String(ex.stackTrace).split('\\n').slice(1)
        .map((f) => '<div class="frame' + (isAppFrame(f) ? ' app' : '') + '">' + esc(f.replace(/\\t/g, '  ')) + '</div>').join('');
      h += detail(frames);
    }
  }

  for (const l of n.logs) {
    const lv = String(l.level ?? '').toUpperCase();
    h += detail('<span class="t">' + timeText(l) + '</span> <span class="' + lv + '">' + lv + '</span> '
      + esc(String(l.message ?? '').split('\\n')[0]));
  }

  // 자식은 별도 컨테이너에 담는다 — 마커를 눌렀을 때 통째로 접으려면 묶여 있어야 한다.
  const kids = n.children.map((c) => renderNode(c, depth + 1, t0, total)).join('');
  return '<div class="grp">' + h + (kids ? '<div class="kids">' + kids + '</div>' : '') + '</div>';
}

let openTraceId = null;

async function openTrace(id) {
  openTraceId = id;
  $('#panel').classList.add('open');
  $('#ptitle').textContent = 'trace ' + shortTrace(id);
  $('#tree').innerHTML = '<div class="msg">불러오는 중…</div>';
  try {
    // 실시간엔 날짜 칸이 없다 — 최근 1시간에서 찾는다.
    const r = await fetch(api('/api/trace', mode === 'tail'
      ? { profile, groups: picked.join(','), since: '1h', trace: id }
      : { ...params(), trace: id }));
    const d = await r.json();
    if (!r.ok) { $('#tree').innerHTML = '<div class="msg err">'+esc(d.error)+'</div>'; return; }
    if (!d.found) { $('#tree').innerHTML = '<div class="msg">찾지 못했습니다. 기간을 늘려 보세요.</div>'; return; }
    const total = Math.max(1, d.t1 - d.t0);
    let h = '<div class="msg">' + d.totalSpans + ' spans · ' + fmtMs(d.t1-d.t0)
      + (d.orphanCount ? ' · <span class="err">'+d.orphanCount+' orphan</span>' : '')
      + '<br>시작 시각은 종료 시각 − 소요 로 되살린 근사치다.</div>';
    if (d.distinct.length > 1) h += '<div class="msg err">이 조각에 trace 가 '+d.distinct.length+'개 걸렸습니다 — 서로 다른 요청이 섞여 있습니다.</div>';
    // 컬럼 머리글도 같은 그리드를 써야 아래 행과 세로가 맞는다
    h += trow({ depth: 0, cls: 'thead', dur: '소요', bar: '', body: 'span' });
    h += d.roots.map((n) => renderNode(n, 0, d.t0, total)).join('');
    if (d.unattached.length) h += '<div class="msg">미연결 로그 '+d.unattached.length+'건</div>'
      + d.unattached.map((l) => '<div class="node t">'+timeText(l)+' '+esc(String(l.message??'').split('\\n')[0])+'</div>').join('');
    $('#tree').innerHTML = h;
  } catch (e) { $('#tree').innerHTML = '<div class="msg err">'+esc(e.message)+'</div>'; }
}

// ── 이벤트 배선 ──────────────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const t = e.target;
  const hit = (s) => t.closest(s);

  // 팝오버 밖을 누르면 닫는다. 트리거와 팝오버 안쪽은 빼고.
  if (!hit('.pop') && !hit('#src') && !hit('#cal') && !hit('#gear')) { openPop(false); openCal(false); openSet(false); }

  if (t.dataset.mode) {
    mode = t.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === t));
    // 실시간만 바로 시작한다. 나머지는 조건을 다 채운 뒤 [조회] 를 눌러야 나간다 —
    // 탭을 옮겼다는 이유만으로 CloudWatch 를 긁을 이유가 없다.
    if (mode === 'tail') run();
    else {
      stopStream();
      all = []; sel = null;
      $('#tl').classList.remove('on');
      clearLog(mode === 'error'
        ? '날짜를 정하고 [조회] 를 누르세요 — ERROR·FATAL 과 예외가 붙은 것만 봅니다.'
        : '검색어와 날짜를 정하고 [조회] 를 누르세요 (검색어를 비우면 그 구간 전체).');
    }
    drawRunState();
  } else if (hit('#src')) {
    openPop(!$('#srcpop').classList.contains('open'));
  } else if (hit('#cal')) {
    openCal(!$('#calpop').classList.contains('open'));
  } else if (hit('#gear')) {
    openSet(!$('#setpop').classList.contains('open'));
  } else if (t.dataset.theme) {
    saveSettings({ theme: t.dataset.theme });
  } else if (t.dataset.font) {
    saveSettings({ fontSize: t.dataset.font });
  } else if (t.dataset.tail) {
    saveSettings({ tailMaxMinutes: t.dataset.tail });
  } else if (t.dataset.int) {
    saveSettings({ intervalSec: t.dataset.int });
  } else if (t.id === 's-close') {
    openSet(false);
  } else if (hit('[data-prof]')) {
    // 프로필이 바뀌면 그룹 선택은 무의미하다 — 비운다.
    profile = hit('[data-prof]').dataset.prof;
    picked = []; groups = [];
    drawSource(); drawProfiles(); drawGroups();
    await loadGroups(false);
  } else if (hit('[data-tog]')) {
    const n = hit('[data-tog]').dataset.tog;
    if (picked.includes(n)) picked = picked.filter((g) => g !== n);
    else if (picked.length < CFG.maxGroups) picked.push(n);
    drawSource(); drawGroups();
  } else if (t.id === 'sapply') {
    openPop(false);
    // 실시간이 돌고 있었으면 새 소스로 다시 시작한다. 조회는 눌러야 나간다.
    if (mode === 'tail' && es) run();
  } else if (t.dataset.cal) {
    [calA, calB] = preset(t.dataset.cal);
    calM = new Date(calB.getFullYear(), calB.getMonth(), 1);
    drawCal();
  } else if (t.dataset.mv) {
    calM = new Date(calM.getFullYear(), calM.getMonth() + Number(t.dataset.mv), 1);
    drawCal();
  } else if (t.dataset.d) {
    // 첫 클릭이 시작, 둘째가 끝. 시작보다 앞을 누르면 시작을 다시 잡는다.
    const d = new Date(t.dataset.d + 'T00:00:00');
    if (!calA || calB || d < calA) { calA = d; calB = null; } else calB = d;
    drawCal();
  } else if (t.id === 'dapply') {
    if (calA) { dFrom = calA; dTo = calB ?? calA; drawDate(); }
    openCal(false);
  } else if (t.id === 'tlClr') {
    sel = null; redraw();
  } else if (t.closest('.trow.tog')) {
    // 줄 클릭 → 그 span 의 하위를 통째로 접었다 편다.
    // 단, 텍스트를 드래그로 고르는 중이면 무시한다 (복사하려다 접히면 짜증난다).
    if (!window.getSelection()?.toString()) t.closest('.grp').classList.toggle('collapsed');
  } else if (t.closest('.clip')) {
    t.closest('.clip').classList.toggle('open');
  } else if (t.dataset.trace) {
    openTrace(t.dataset.trace);
  } else if (t.closest('#log')) {
    // 목록을 클릭하면 상세를 닫는다 (trace_id 클릭은 위에서 이미 걸러졌다)
    $('#panel').classList.remove('open');
  } else if (t.id === 'close') {
    $('#panel').classList.remove('open');
  } else if (t.id === 'go') {
    run();
  } else if (t.id === 'stop') {
    stopStream();
  } else if (hit('#follow')) {
    // 스위치(i)를 눌러도 버튼이 토글돼야 한다 — t 는 그 안쪽 요소일 수 있다.
    hit('#follow').classList.toggle('on');
  } else if (t.id === 'refresh') {
    await loadGroups(true);
  }
});
$('#gq').addEventListener('input', drawGroups);
$('#s-pkg').addEventListener('change', (e) => saveSettings({ appPackages: e.target.value }));
$('#s-warn').addEventListener('change', (e) => saveSettings({ slowWarn: e.target.value }));
$('#s-bad').addEventListener('change', (e) => saveSettings({ slowBad: e.target.value }));
for (const id of ['#s-pkg', '#s-warn', '#s-bad']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
}
$('#term').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#srcpop').classList.contains('open') || $('#calpop').classList.contains('open')
      || $('#setpop').classList.contains('open')) {
    openPop(false); openCal(false); openSet(false);
  } else $('#panel').classList.remove('open');
});

// ── 타임라인에서 구간 고르기 — 화면에 있는 것만 좁힌다 (요청 0회) ────────
$('#bars').addEventListener('pointerdown', (e) => {
  if (!all.length) return;
  const bars = $('#bars');
  const r = bars.getBoundingClientRect();
  const at = (x) => winA + ((Math.max(r.left, Math.min(r.right, x)) - r.left) / r.width) * (winB - winA);
  const a0 = at(e.clientX);
  bars.setPointerCapture(e.pointerId);
  let moved = false;

  const move = (ev) => {
    if (Math.abs(ev.clientX - e.clientX) < 3) return;   // 손떨림은 클릭으로 본다
    moved = true;
    const b = at(ev.clientX);
    sel = { a: Math.min(a0, b), b: Math.max(a0, b) };
    drawTL();
  };
  const up = () => {
    bars.removeEventListener('pointermove', move);
    bars.removeEventListener('pointerup', up);
    if (!moved) {           // 클릭 = 그 버킷 하나
      const [unit] = tlUnit();
      const i = Math.floor((a0 - winA) / unit);
      sel = { a: winA + i * unit, b: winA + (i + 1) * unit };
    }
    redraw();
  };
  bars.addEventListener('pointermove', move);
  bars.addEventListener('pointerup', up);
});

// 패널 폭 조절 — 왼쪽 모서리를 끌면 --pw 가 바뀐다. 폭은 세션 동안 유지된다.
$('#grip').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const panel = $('#panel');
  panel.classList.add('resizing');
  $('#grip').setPointerCapture(e.pointerId);
  const move = (ev) => {
    const w = Math.max(360, Math.min(window.innerWidth - 120, window.innerWidth - ev.clientX));
    panel.style.setProperty('--pw', w + 'px');
  };
  const up = () => {
    panel.classList.remove('resizing');
    $('#grip').removeEventListener('pointermove', move);
    $('#grip').removeEventListener('pointerup', up);
  };
  $('#grip').addEventListener('pointermove', move);
  $('#grip').addEventListener('pointerup', up);
});

// 탭 전환으로는 스트림을 끊지 않는다.
// 예전엔 visibilitychange 로 멈췄는데, 실시간을 켜 두고 그 서비스를 보러 다른 탭으로
// 가는 게 가장 흔한 사용법이다 — 정작 재현하는 동안 로그가 안 쌓이면 '실시간' 이 아니다.
// '켜둔 채 잊기' 는 아래 자동 정지(설정에서 조절)가 대신 막는다.

async function loadGroups(refresh) {
  try {
    const r = await fetch(api('/api/groups', { profile, refresh: refresh ? '1' : '' }));
    const d = await r.json();
    if (!r.ok) { clearLog(d.error + (d.hint ? '\\n  '+d.hint : '')); groups = []; }
    else groups = d.groups;
  } catch (e) { clearLog('그룹 목록을 못 가져왔습니다: ' + e.message); }
  drawGroups();
}

(async function boot() {
  const r = await fetch(api('/api/bootstrap'));
  const d = await r.json();
  CFG.maxGroups = d.maxGroups;
  applySettings(d.settings ?? {});
  if (d.stateDir) $('#s-where').textContent = d.stateDir;
  profiles = d.profiles;
  profile = d.profiles[0]?.name ?? '';
  [dFrom, dTo] = preset('today');
  drawDate(); drawSource(); drawRunState();
  if (profiles.length) await loadGroups(false);
  // 첫 화면은 팝오버를 열어 둔다 — 아직 고를 게 남아 있으니까.
  if (!picked.length) openPop(true);
})();
</script>
</body>
</html>`;
}
