// InvTube v2 - YouTube InnerTube API 직접 사용
// 외부 의존성 없음, YouTube 자체 API라 Vercel에서 확실히 작동

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

// YouTube InnerTube API 호출
async function innertube(endpoint, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/' + endpoint, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('YouTube ' + r.status);
    return r.json();
  } catch(e) { clearTimeout(t); throw e; }
}

const WEB_CTX = {
  client: { clientName: 'WEB', clientVersion: '2.20240515.01.00', hl: 'ko', gl: 'KR' }
};
const ANDROID_CTX = {
  client: {
    clientName: 'ANDROID', clientVersion: '19.09.37',
    androidSdkVersion: 30, platform: 'MOBILE',
    userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
    hl: 'ko', gl: 'KR',
  }
};

// JSON 트리에서 videoRenderer 전부 추출
function extractVideos(obj, arr) {
  arr = arr || [];
  if (!obj || typeof obj !== 'object') return arr;
  if (obj.videoRenderer && obj.videoRenderer.videoId) {
    const vr = obj.videoRenderer;
    const thumbs = vr.thumbnail && vr.thumbnail.thumbnails || [];
    const best = thumbs[thumbs.length - 1] || {};
    const title = (vr.title && (vr.title.runs && vr.title.runs[0] && vr.title.runs[0].text || vr.title.simpleText)) || '';
    const author = (vr.ownerText && vr.ownerText.runs && vr.ownerText.runs[0] && vr.ownerText.runs[0].text)
                || (vr.shortBylineText && vr.shortBylineText.runs && vr.shortBylineText.runs[0] && vr.shortBylineText.runs[0].text) || '';
    const viewText = (vr.viewCountText && (vr.viewCountText.simpleText || (vr.viewCountText.runs && vr.viewCountText.runs.map(function(r){return r.text;}).join('')))) || '';
    const pubText = (vr.publishedTimeText && vr.publishedTimeText.simpleText) || '';
    const durText = (vr.lengthText && vr.lengthText.simpleText) || '';
    const dur = parseDur(durText);
    arr.push({
      videoId: vr.videoId,
      title: title,
      author: author,
      viewCountText: viewText,
      publishedText: pubText,
      lengthSeconds: dur,
      videoThumbnails: [{ url: best.url || 'https://i.ytimg.com/vi/' + vr.videoId + '/hqdefault.jpg', quality: 'high', width: best.width || 480 }],
    });
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (Array.isArray(v)) { for (let j = 0; j < v.length; j++) extractVideos(v[j], arr); }
    else if (v && typeof v === 'object') extractVideos(v, arr);
  }
  return arr;
}

function parseDur(s) {
  if (!s) return 0;
  const p = s.split(':').map(Number);
  if (p.length === 3) return p[0]*3600+p[1]*60+p[2];
  if (p.length === 2) return p[0]*60+p[1];
  return 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const type = q.type || '';

  try {

    // ── 트렌딩 ──
    if (type === 'trending') {
      const data = await innertube('browse', { context: WEB_CTX, browseId: 'FEtrending' });
      const videos = extractVideos(data);
      if (!videos.length) return res.status(500).json({ error: '트렌딩 파싱 실패', keys: Object.keys(data) });
      res.setHeader('Cache-Control', 's-maxage=120');
      return res.status(200).json(videos.slice(0, 24));
    }

    // ── 검색 ──
    if (type === 'search') {
      if (!q.q) return res.status(400).json({ error: 'q 필요' });
      const data = await innertube('search', { context: WEB_CTX, query: q.q });
      const videos = extractVideos(data);
      res.setHeader('Cache-Control', 's-maxage=60');
      return res.status(200).json(videos);
    }

    // ── 비디오 정보 + 스트림 ──
    if (type === 'video') {
      if (!q.id) return res.status(400).json({ error: 'id 필요' });

      // ANDROID 클라이언트 → 직접 스트림 URL 제공 (암호화 없음)
      const data = await innertube('player', {
        context: ANDROID_CTX,
        videoId: q.id,
        params: '8AEB',
      });

      const sd = data.streamingData || {};
      const vd = data.videoDetails || {};

      // formats = 영상+음성 합쳐진 스트림
      const formats = (sd.formats || [])
        .filter(function(f) { return f.url && f.mimeType && f.mimeType.includes('video/mp4'); })
        .map(function(f) {
          return {
            quality: f.qualityLabel || f.quality,
            url: '/api/proxy?type=stream&url=' + encodeURIComponent(f.url),
            mimeType: f.mimeType,
          };
        });

      if (!formats.length) {
        // adaptiveFormats 폴백 (영상만, 음성 없음 - 학교에선 이것도 OK)
        const af = (sd.adaptiveFormats || [])
          .filter(function(f){ return f.url && f.mimeType && f.mimeType.includes('video/mp4') && !f.mimeType.includes('audio'); })
          .map(function(f){
            return { quality: f.qualityLabel || f.quality, url: '/api/proxy?type=stream&url=' + encodeURIComponent(f.url) };
          });
        if (af.length) formats.push.apply(formats, af);
      }

      // 추천 영상
      const related = extractVideos(data.contents || {});

      const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
      const bestThumb = thumbs[thumbs.length-1] || { url: 'https://i.ytimg.com/vi/' + q.id + '/maxresdefault.jpg' };

      res.setHeader('Cache-Control', 's-maxage=30');
      return res.status(200).json({
        title: vd.title || '',
        author: vd.author || '',
        description: vd.shortDescription || '',
        viewCount: parseInt(vd.viewCount) || 0,
        lengthSeconds: parseInt(vd.lengthSeconds) || 0,
        videoThumbnails: [{ url: bestThumb.url, quality: 'maxresdefault', width: 1280 }],
        streams: formats,
        recommendedVideos: related.slice(0, 15),
      });
    }

    // ── 스트림 프록시 ──
    if (type === 'stream') {
      if (!q.url) return res.status(400).json({ error: 'url 필요' });
      const decoded = decodeURIComponent(q.url);
      const range = req.headers['range'];
      const upHdr = {
        'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
        'Referer': 'https://www.youtube.com/',
      };
      if (range) upHdr['Range'] = range;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 27000);
      const up = await fetch(decoded, { headers: upHdr, signal: ctrl.signal });
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

    // ── 테스트 ──
    if (type === 'test') {
      // YouTube InnerTube 직접 ping
      try {
        const r = await innertube('browse', { context: WEB_CTX, browseId: 'FEtrending' });
        const vids = extractVideos(r);
        return res.status(200).json({ status: 'OK', videoCount: vids.length, sample: vids[0] && vids[0].title });
      } catch(e) {
        return res.status(200).json({ status: 'FAIL', error: e.message });
      }
    }

    return res.status(400).json({ error: 'type 필요: trending|search|video|stream|test' });

  } catch(err) {
    console.error('[InvTube]', type, err.message);
    return res.status(500).json({ error: err.message, type: type });
  }
};
