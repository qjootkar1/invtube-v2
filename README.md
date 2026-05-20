# InvTube v2 🎬

학교 네트워크에서 YouTube를 볼 수 있는 프록시 사이트입니다.
Invidious 오픈소스 프론트엔드를 Vercel 서버리스로 래핑했습니다.

## 🚀 Vercel 배포 방법

### 방법 1 — Vercel CLI

```bash
npm i -g vercel
cd invtube-v2
vercel --prod
```

### 방법 2 — GitHub 연동 (추천)

1. 이 폴더를 GitHub 새 레포에 올리기
2. https://vercel.com 에서 "New Project" → GitHub 레포 선택
3. 그대로 Deploy 클릭
4. 완료! 자동으로 URL 발급

## 📁 파일 구조

```
invtube-v2/
├── index.html        ← 프론트엔드 (단일 파일)
├── api/
│   └── proxy.js      ← Vercel 서버리스 함수
├── vercel.json       ← Vercel 설정
└── package.json
```

## ✨ v2 개선사항

- **트렌딩 홈화면** — 한국 인기 영상 자동 표시
- **검색 기능** — YouTube 검색 지원
- **직접 스트림** — iframe 대신 HTML5 네이티브 플레이어
- **화질 선택** — 360p / 480p / 720p / 1080p 선택 가능
- **자동 인스턴스 전환** — 인스턴스 죽으면 자동으로 다음으로 전환
- **추천 영상** — 영상 오른쪽에 관련 영상 목록
- **설명란** 토글 지원
- **스켈레톤 로딩** 애니메이션

## ⚙️ 인스턴스 관리

`api/proxy.js` 상단 `INSTANCES` 배열에서 인스턴스 추가/제거 가능.
속도가 느린 인스턴스는 제거하고 빠른 걸로 교체하면 됩니다.

현재 사용 중인 인스턴스 목록: https://docs.invidious.io/instances/
