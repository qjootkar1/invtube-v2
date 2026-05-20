// InvTube v2 - Piped API 기반 프록시
// Piped는 Invidious와 달리 Vercel 서버 IP를 잘 허용함

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
];

const INV_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yt.cdaut.de',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.fdn.fr',
];

async function fetchTimeout(url, opts, ms) {
  ms = ms || 8000;
  const ctrl = new AbortController();
  const t = setTimeout(function() { ctrl.abort(); }, ms);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    clearTimeout(t);
    return r;
  } catch(e) { clearTimeout(t); throw e; }
}

// 여러 인스턴스 동시에 쏴서 제일 빠른 성공 반환
async function raceInstances(instances, pathFn, validateFn) {
  const tasks = instances.map(async function(base) {
    const url = base + pathFn(base);
    const r = await fetchTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, 8000);
    if (!r.ok) throw new Error(base + ' HTTP ' + r.status);
    const data = await r.json();
    if (validateFn && !validateFn(data)) throw new Error(base + ' invalid data');
    return { data: data, instance: base };
  });
  try {
    return await Promise.any(tasks);
  } catch(e) {
    const msgs = e.errors ? e.errors.map(function(x){return x.message;}).slice(0,3).join(' | ') : String(e);
    throw new Error('모든 인스턴스 실패: ' + msgs);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const type = q.type || '';

  // ── 디버그: 어떤 인스턴스가 살아있는지 확인 ──
  if (type === 'test') {
    const results = {};
    const tests = PIPED_INSTANCES.slice(0,3).map(async function(base) {
      try {
        const r = await fetchTimeout(base + '/trending?region=KR', {}, 5000);
        const d = await r.json();
        const arr = Array.isArray(d) ? d : [];
        results[base] = arr.length ? 'OK (' + arr.length + '개)' : 'EMPTY';
      } catch(e) { results[base] = 'FAIL: ' + e.message; }
    });
    await Promise.allSettled(tests);
    return res.status(200).json({ piped: results, time: new Date().toISOString() });
  }

  // ── 트렌딩 (Piped 우선) ──
  if (type === 'trending') {
    try {
      const region = q.region || 'KR';
      const result = await raceInstances(
        PIPED_INSTANCES,
        function() { return '/trending?region=' + region; },
        function(d) { return Array.isArray(d) && d.length > 0; }
      );
      // Piped 형식 → 통합 형식 변환
      const list = result.data.slice(0, 24).map(function(v) {
        return {
          videoId: v.url ? v.url.replace('/watch?v=','') : v.videoId,
          title: v.title,
          author: v.uploaderName || v.author,
          viewCount: v.views || v.viewCount,
          publishedText: v.uploadedDate || v.publishedText,
          lengthSeconds: v.duration || v.lengthSeconds,
          videoThumbnails: [{ url: v.thumbnail, quality: 'high', width: 480 }],
        };
      });
      res.setHeader('Cache-Control', 's-maxage=120');
      return res.status(200).json(list);
    } catch(e) {
      // Invidious 폴백
      try {
        const r2 = await raceInstances(
          INV_INSTANCES,
          function() { return '/api/v1/trending'; },
          function(d) { return Array.isArray(d) && d.length > 0; }
        );
        res.setHeader('Cache-Control', 's-maxage=120');
        return res.status(200).json(r2.data.slice(0,24));
      } catch(e2) {
        return res.status(500).json({ error: 'trending 실패', piped: e.message, invidious: e2.message });
      }
    }
  }

  // ── 검색 (Piped 우선) ──
  if (type === 'search') {
    if (!q.q) return res.status(400).json({ error: 'q 필요' });
    try {
      const result = await raceInstances(
        PIPED_INSTANCES,
        function() { return '/search?q=' + encodeURIComponent(q.q) + '&filter=videos'; },
        function(d) { return d && (Array.isArray(d.items) || Array.isArray(d)); }
      );
      const raw = Array.isArray(result.data) ? result.data : (result.data.items || []);
      const list = raw.map(function(v) {
        return {
          videoId: v.url ? v.url.replace('/watch?v=','') : v.videoId,
          title: v.title,
          author: v.uploaderName || v.author,
          viewCount: v.views || v.viewCount,
          publishedText: v.uploadedDate || v.publishedText,
          lengthSeconds: v.duration || v.lengthSeconds,
          videoThumbnails: [{ url: v.thumbnail, quality: 'high', width: 480 }],
        };
      });
      res.setHeader('Cache-Control', 's-maxage=60');
      return res.status(200).json(list);
    } catch(e) {
      try {
        const r2 = await raceInstances(
          INV_INSTANCES,
          function() { return '/api/v1/search?q=' + encodeURIComponent(q.q) + '&type=video'; },
          null
        );
        const arr = Array.isArray(r2.data) ? r2.data : [];
        return res.status(200).json(arr);
      } catch(e2) {
        return res.status(500).json({ error: '검색 실패', detail: e.message });
      }
    }
  }

  // ── 비디오 정보 (Piped 우선) ──
  if (type === 'video') {
    if (!q.id) return res.status(400).json({ error: 'id 필요' });
    try {
      const result = await raceInstances(
        PIPED_INSTANCES,
        function() { return '/streams/' + q.id; },
        function(d) { return d && d.title; }
      );
      const d = result.data;
      // Piped 스트림 형식 변환
      const streams = (d.videoStreams || [])
        .filter(function(s) { return s.mimeType && s.mimeType.includes('video/mp4') && s.videoOnly === false; })
        .sort(function(a,b) { return (b.quality||'').localeCompare(a.quality||''); })
        .map(function(s) {
          return {
            quality: s.quality,
            url: '/api/proxy?type=stream&url=' + encodeURIComponent(s.url),
          };
        });
      const thumbUrl = d.thumbnailUrl || '';
      const related = (d.relatedStreams || []).slice(0,15).map(function(v) {
        return {
          videoId: v.url ? v.url.replace('/watch?v=','') : '',
          title: v.title,
          author: v.uploaderName || '',
          lengthSeconds: v.duration,
          videoThumbnails: [{ url: v.thumbnail, quality: 'high', width: 480 }],
        };
      });
      res.setHeader('Cache-Control', 's-maxage=30');
      return res.status(200).json({
        title: d.title,
        author: d.uploader,
        description: d.description,
        viewCount: d.views,
        likeCount: d.likes,
        publishedText: d.uploadDate,
        videoThumbnails: [{ url: thumbUrl, quality: 'maxresdefault', width: 1280 }],
        streams: streams,
        recommendedVideos: related,
        instance: result.instance,
      });
    } catch(e) {
      // Invidious 폴백
      try {
        const r2 = await raceInstances(
          INV_INSTANCES,
          function() { return '/api/v1/videos/' + q.id; },
          function(d) { return d && d.title; }
        );
        const d2 = r2.data;
        const streams2 = (d2.formatStreams || [])
          .filter(function(s) { return s.type && s.type.includes('mp4'); })
          .map(function(s) {
            return {
              quality: s.qualityLabel || s.quality,
              url: '/api/proxy?type=stream&url=' + encodeURIComponent(s.url),
            };
          });
        res.setHeader('Cache-Control', 's-maxage=30');
        return res.status(200).json(Object.assign({}, d2, { streams: streams2, instance: r2.instance }));
      } catch(e2) {
        return res.status(500).json({ error: '비디오 정보 실패', detail: e.message, fallback: e2.message });
      }
    }
  }

  // ── 스트림 프록시 ──
  if (type === 'stream') {
    const su = q.url;
    if (!su) return res.status(400).json({ error: 'url 필요' });
    const decoded = decodeURIComponent(su);
    const range = req.headers['range'];
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.youtube.com/',
    };
    if (range) headers['Range'] = range;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(function(){ ctrl.abort(); }, 28000);
      const up = await fetch(decoded, { headers: headers, signal: ctrl.signal });
      clearTimeout(t);
      ['content-type','content-length','content-range','accept-ranges'].forEach(function(h) {
        const v = up.headers.get(h);
        if (v) res.setHeader(h, v);
      });
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(up.status);
      const reader = up.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { res.end(); break; }
        res.write(Buffer.from(chunk.value));
      }
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
    return;
  }

  return res.status(400).json({ error: 'type 필요: trending|search|video|stream|test' });
};
