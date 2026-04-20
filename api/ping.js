// Health check — GET /api/ping
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  res.status(200).json({
    status:  'ok',
    app:     'forol-research-lab',
    version: '4.0',
    time:    new Date().toISOString()
  });
}
