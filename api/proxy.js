// InvTube v2 - 타임아웃 최적화 버전
// Vercel Hobby 플랜 = 함수 최대 10초

const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.garudalinux.org',
];

async function ft(url, ms) {
  ms = ms || 3500;
  const c = new AbortController();
  const t = setTimeout(function(){ c.abort(); }, ms);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch(e) { clearTimeout(t); throw e; }
}

// Promise.any 대신 직접 구현 (구버전 Node 호환)
async function raceAny(fns) {
  return new Promise(function(resolve, reject) {
    let done = false, errs = [], left = fns.length;
    fns.forEach(function(fn) {
      fn().then(function(v) {
        if (!done) { done = true; resolve(v); }
      }).catch(function(e) {
        errs.push(e.message);
        left--;
        if (left === 0 && !done) reject(new Error(errs.join(' | ')));
      });
    });
  });
}

function pipedVideoToCommon(v) {
  return {
    videoId: (v.url||'').replace('/watch?v=',''),
    title: v.title || '',
    author: v.uploaderName || v.author || '',
    viewCount: v.views || v.viewCount || 0,
    publishedText: v.uploadedDate || v.publishedText || '',
    lengthSeconds: v.duration || v.lengthSeconds || 0,
    videoThumbnails: [{ url: v.thumbnail || '', quality: 'high', width: 480 }],
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const type = q.type || '';

  try {

    // ── 디버그 테스트 ──
    if (type === 'test') {
      const results = {};
      await Promise.allSettled(PIPED.map(async function(base) {
        try {
          const d = await ft(base + '/trending?region=KR', 4000);
          results[base] = Array.isArray(d) ? 'OK:' + d.length : 'BAD_FORMAT:' + JSON.stringify(d).slice(0,80);
        } catch(e) { results[base] = 'FAIL:' + e.message; }
      }));
      return res.status(200).json(results);
    }

    // ── 트렌딩 ──
    if (type === 'trending') {
      const region = q.region || 'KR';
      const data = await raceAny(PIPED.map(function(base) {
        return function() {
          return ft(base + '/trending?region=' + region, 4000).then(function(d) {
            if (!Array.isArray(d) || !d.length) throw new Error('empty');
            return d;
          });
        };
      }));
      res.setHeader('Cache-Control', 's-maxage=120');
      return res.status(200).json(data.slice(0, 24).map(pipedVideoToCommon));
    }

    // ── 검색 ──
    if (type === 'search') {
      if (!q.q) return res.status(400).json({ error: 'q 필요' });
      const data = await raceAny(PIPED.map(function(base) {
        return function() {
          return ft(base + '/search?q=' + encodeURIComponent(q.q) + '&filter=videos', 4000).then(function(d) {
            const arr = Array.isArray(d) ? d : (d.items || []);
            if (!arr.length) throw new Error('empty');
            return arr;
          });
        };
      }));
      res.setHeader('Cache-Control', 's-maxage=60');
      return res.status(200).json(data.map(pipedVideoToCommon));
    }

    // ── 비디오 정보 ──
    if (type === 'video') {
      if (!q.id) return res.status(400).json({ error: 'id 필요' });
      const data = await raceAny(PIPED.map(function(base) {
        return function() {
          return ft(base + '/streams/' + q.id, 5000).then(function(d) {
            if (!d || !d.title) throw new Error('no title');
            return { d: d, base: base };
          });
        };
      }));

      const d = data.d;
      const streams = (d.videoStreams || [])
        .filter(function(s) { return s.mimeType && s.mimeType.includes('video/mp4') && !s.videoOnly; })
        .map(function(s) {
          return {
            quality: s.quality || '',
            url: '/api/proxy?type=stream&url=' + encodeURIComponent(s.url),
          };
        });

      const related = (d.relatedStreams || []).slice(0, 15).map(function(v) {
        return {
          videoId: (v.url||'').replace('/watch?v=',''),
          title: v.title || '',
          author: v.uploaderName || '',
          lengthSeconds: v.duration || 0,
          videoThumbnails: [{ url: v.thumbnail || '', quality: 'high', width: 480 }],
        };
      });

      res.setHeader('Cache-Control', 's-maxage=30');
      return res.status(200).json({
        title: d.title,
        author: d.uploader,
        description: d.description || '',
        viewCount: d.views,
        likeCount: d.likes,
        publishedText: d.uploadDate || '',
        videoThumbnails: [{ url: d.thumbnailUrl || '', quality: 'maxresdefault', width: 1280 }],
        streams: streams,
        recommendedVideos: related,
        instance: data.base,
      });
    }

    // ── 스트림 프록시 ──
    if (type === 'stream') {
      if (!q.url) return res.status(400).json({ error: 'url 필요' });
      const decoded = decodeURIComponent(q.url);
      const range = req.headers['range'];
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
      };
      if (range) headers['Range'] = range;
      const c = new AbortController();
      const t = setTimeout(function(){ c.abort(); }, 27000);
      const up = await fetch(decoded, { headers: headers, signal: c.signal });
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
        if (chunk.done) { res.end(); return; }
        res.write(Buffer.from(chunk.value));
      }
    }

    return res.status(400).json({ error: 'type 필요: trending|search|video|stream|test' });

  } catch(err) {
    console.error('[InvTube]', type, err.message);
    return res.status(500).json({ error: err.message, type: type });
  }
};
