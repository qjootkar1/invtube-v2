// InvTube v2 - Vercel Serverless Proxy (CommonJS)
const INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.cdaut.de',
  'https://invidious.lunar.icu',
  'https://iv.melmac.space',
  'https://invidious.slipfox.xyz',
  'https://invidious.io.lol',
  'https://invidious.fdn.fr',
  'https://invidious.privacydev.net',
  'https://invidious.protokolla.fi',
  'https://invidious.tiekoetter.com',
  'https://invidious.perennialte.ch',
];

let currentIdx = 0;

function getInstance() {
  return INSTANCES[currentIdx % INSTANCES.length];
}

function nextInstance() {
  currentIdx = (currentIdx + 1) % INSTANCES.length;
  return getInstance();
}

async function fetchWithTimeout(url, options, timeout) {
  timeout = timeout || 8000;
  const controller = new AbortController();
  const id = setTimeout(function() { controller.abort(); }, timeout);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// 여러 인스턴스 동시에 시도 → 제일 빠른 것 사용
async function fetchInvidious(path) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; InvTube/2.0)',
    'Accept': 'application/json',
  };

  // 인스턴스 3개 동시에 쏘고 제일 먼저 성공한 거 사용
  const shuffled = [...INSTANCES].sort(() => Math.random() - 0.5).slice(0, 4);

  const attempts = shuffled.map(async function(base) {
    const url = base + '/api/v1' + path;
    const res = await fetchWithTimeout(url, { headers: headers }, 9000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data) throw new Error('empty response');
    return { data: data, instance: base };
  });

  try {
    return await Promise.any(attempts);
  } catch (e) {
    throw new Error('모든 인스턴스 실패: ' + (e.errors ? e.errors.map(function(x){return x.message;}).join(', ') : e.message));
  }
}

// 배열 정규화 유틸
function toArray(data) {
  if (Array.isArray(data)) return data;
  return data.videos || data.trending || data.items || data.results ||
    (Object.values(data).find(function(v){ return Array.isArray(v); })) || [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = req.query || {};
  const type = query.type;
  const id = query.id;
  const q = query.q;
  const page = query.page || 1;
  const region = query.region || 'KR';

  try {
    // 트렌딩
    if (type === 'trending') {
      let result;
      try {
        result = await fetchInvidious('/trending?region=' + region + '&type=default');
      } catch(e) {
        // region 없이 재시도
        result = await fetchInvidious('/trending');
      }
      const list = toArray(result.data);
      if (!list.length) throw new Error('빈 트렌딩 응답');
      res.setHeader('Cache-Control', 's-maxage=120');
      return res.status(200).json(list.slice(0, 24));
    }

    // 검색
    if (type === 'search') {
      if (!q) return res.status(400).json({ error: 'q 필요' });
      const result = await fetchInvidious(
        '/search?q=' + encodeURIComponent(q) + '&page=' + page + '&type=video&sort_by=relevance'
      );
      const list = toArray(result.data);
      res.setHeader('Cache-Control', 's-maxage=60');
      return res.status(200).json(list);
    }

    // 비디오 정보
    if (type === 'video') {
      if (!id) return res.status(400).json({ error: 'id 필요' });
      const result = await fetchInvidious(
        '/videos/' + id + '?fields=title,author,authorId,description,publishedText,viewCount,likeCount,lengthSeconds,formatStreams,videoThumbnails,recommendedVideos'
      );
      const data = result.data;
      const instance = result.instance;

      const streams = (data.formatStreams || []).map(function(s) {
        return {
          quality: s.qualityLabel || s.quality,
          type: s.type,
          // 스트림을 직접 프록시로 래핑
          url: '/api/proxy?type=stream&url=' + encodeURIComponent(s.url),
          itag: s.itag,
        };
      });

      res.setHeader('Cache-Control', 's-maxage=30');
      return res.status(200).json(Object.assign({}, data, { streams: streams, instance: instance }));
    }

    // 스트림 프록시
    if (type === 'stream') {
      const streamUrl = query.url;
      if (!streamUrl) return res.status(400).json({ error: 'url 필요' });

      const decodedUrl = decodeURIComponent(streamUrl);
      const range = req.headers['range'];
      const upHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
      };
      if (range) upHeaders['Range'] = range;

      const controller = new AbortController();
      const timeout = setTimeout(function(){ controller.abort(); }, 25000);
      const upstream = await fetch(decodedUrl, { headers: upHeaders, signal: controller.signal });
      clearTimeout(timeout);

      ['content-type','content-length','content-range','accept-ranges'].forEach(function(h) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(upstream.status);

      const reader = upstream.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { res.end(); break; }
        res.write(Buffer.from(chunk.value));
      }
      return;
    }

    // 핑
    if (type === 'ping') {
      return res.status(200).json({ instance: getInstance(), total: INSTANCES.length });
    }

    return res.status(400).json({ error: '알 수 없는 type: ' + type });

  } catch (err) {
    console.error('[InvTube]', err.message);
    return res.status(500).json({ error: '서버 오류', message: err.message });
  }
};
