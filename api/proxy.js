// InvTube v2 - 스트림 전용 프록시 (API는 프론트에서 직접 호출)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url: streamUrl } = req.query || {};
  if (!streamUrl) return res.status(400).json({ error: 'url 파라미터 필요' });

  const decodedUrl = decodeURIComponent(streamUrl);
  const range = req.headers['range'];

  const upHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
    'Origin': 'https://www.youtube.com',
  };
  if (range) upHeaders['Range'] = range;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28000);
    const upstream = await fetch(decodedUrl, { headers: upHeaders, signal: controller.signal });
    clearTimeout(timeout);

    ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(upstream.status);

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error('[stream error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
