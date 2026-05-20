// InvTube v2 - Vercel Serverless Proxy
// Invidious 인스턴스 목록 (속도 좋은 순)
const INSTANCES = [
  'https://invidious.fdn.fr',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacydev.net',
  'https://yt.cdaut.de',
  'https://invidious.lunar.icu',
  'https://iv.melmac.space',
  'https://invidious.perennialte.ch',
  'https://invidious.slipfox.xyz',
  'https://invidious.io.lol',
];

// 현재 인스턴스 인덱스 (메모리, 함수 재시작 시 리셋됨)
let currentIdx = 0;

function getInstance() {
  return INSTANCES[currentIdx % INSTANCES.length];
}

function nextInstance() {
  currentIdx = (currentIdx + 1) % INSTANCES.length;
  return getInstance();
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// 인스턴스 순환하며 API 호출
async function fetchInvidious(path, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const base = getInstance();
    const url = `${base}/api/v1${path}`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'InvTube/2.0' }
      }, 9000);
      if (!res.ok) {
        nextInstance();
        continue;
      }
      const data = await res.json();
      return { data, instance: base };
    } catch (e) {
      lastErr = e;
      nextInstance();
    }
  }
  throw lastErr || new Error('모든 인스턴스 실패');
}

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { type, id, q, page = 1, region = 'KR' } = req.query;

  try {
    // 1) 비디오 정보 + 스트림 URL
    if (type === 'video') {
      if (!id) return res.status(400).json({ error: 'id 필요' });
      const { data, instance } = await fetchInvidious(`/videos/${id}?fields=title,author,authorId,description,publishedText,viewCount,likeCount,lengthSeconds,formatStreams,adaptiveFormats,videoThumbnails,recommendedVideos`);

      // 스트림 URL을 우리 프록시로 래핑
      const streams = (data.formatStreams || []).map(s => ({
        quality: s.qualityLabel || s.quality,
        type: s.type,
        url: `/api/proxy?type=stream&url=${encodeURIComponent(s.url)}&instance=${encodeURIComponent(instance)}`,
        itag: s.itag,
      }));

      return res.status(200).json({
        ...data,
        streams,
        instance,
      });
    }

    // 2) 비디오 스트림 프록시 (실제 영상 바이트 전달)
    if (type === 'stream') {
      const { url: streamUrl } = req.query;
      if (!streamUrl) return res.status(400).json({ error: 'url 필요' });

      const decodedUrl = decodeURIComponent(streamUrl);
      const range = req.headers['range'];

      const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
      };
      if (range) upstreamHeaders['Range'] = range;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const upstream = await fetch(decodedUrl, {
        headers: upstreamHeaders,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // 응답 헤더 복사
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach(h => {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      res.status(upstream.status);

      // 스트림 파이프
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      };
      return pump();
    }

    // 3) 검색
    if (type === 'search') {
      if (!q) return res.status(400).json({ error: 'q 필요' });
      const { data } = await fetchInvidious(
        `/search?q=${encodeURIComponent(q)}&page=${page}&type=video&region=${region}&sort_by=relevance`
      );
      return res.status(200).json(data);
    }

    // 4) 트렌딩
    if (type === 'trending') {
      const { data } = await fetchInvidious(`/trending?region=${region}&type=default`);
      return res.status(200).json(data.slice(0, 24));
    }

    // 5) 채널 정보
    if (type === 'channel') {
      if (!id) return res.status(400).json({ error: 'id 필요' });
      const { data } = await fetchInvidious(`/channels/${id}`);
      return res.status(200).json(data);
    }

    // 6) 인스턴스 상태 확인
    if (type === 'ping') {
      return res.status(200).json({ instance: getInstance(), idx: currentIdx });
    }

    return res.status(400).json({ error: '알 수 없는 type' });

  } catch (err) {
    console.error('[InvTube Error]', err.message);
    return res.status(500).json({
      error: '서버 오류',
      message: err.message,
    });
  }
}
