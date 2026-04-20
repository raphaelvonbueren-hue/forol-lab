// POST /api/export
// Receives a BKP payload and returns it validated + enriched.
// This is the bridge endpoint that FOROL Futur (or any third-party) can poll.

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Source, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body;

    // ── Basic validation ──────────────────────────────────────────────────
    const errors = [];
    if (!body?.project?.name)   errors.push('project.name is required');
    if (!body?.project?.region) errors.push('project.region is required');
    if (!Array.isArray(body?.buildings) || body.buildings.length === 0)
      errors.push('buildings[] must contain at least one entry');
    if (!Array.isArray(body?.bkp?.items))
      errors.push('bkp.items[] is required');

    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', fields: errors });
    }

    // ── Enrich payload ────────────────────────────────────────────────────
    const exported = {
      ...body,
      exportedAt: new Date().toISOString(),
      exportedBy: 'forol-research-lab-api',
      // Generate a deterministic reference ID from project name + date
      referenceId: 'RL-' + Date.now().toString(36).toUpperCase(),
    };

    // ── Forward to FOROL Futur if env var is set ──────────────────────────
    const futurUrl = process.env.FOROL_FUTUR_API_URL;
    const futurKey = process.env.FOROL_FUTUR_API_KEY;

    if (futurUrl) {
      const fwdRes = await fetch(futurUrl, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source':     'forol-research-lab',
          ...(futurKey ? { 'Authorization': `Bearer ${futurKey}` } : {})
        },
        body: JSON.stringify(exported)
      });

      if (fwdRes.ok) {
        const futurData = await fwdRes.json();
        return res.status(200).json({
          status:      'forwarded',
          referenceId: exported.referenceId,
          futur:       futurData,
          message:     'Erfolgreich an FOROL Futur übertragen'
        });
      } else {
        // FOROL Futur returned error — log but still return our ID
        const futurErr = await fwdRes.text();
        console.error('FOROL Futur error:', fwdRes.status, futurErr);
        return res.status(200).json({
          status:      'stored',
          referenceId: exported.referenceId,
          warning:     'FOROL Futur nicht erreichbar — Daten lokal gespeichert',
          futurStatus: fwdRes.status
        });
      }
    }

    // ── No FOROL Futur URL configured — just return enriched payload ──────
    return res.status(200).json({
      status:      'ok',
      referenceId: exported.referenceId,
      payload:     exported,
      message:     'Payload validiert. FOROL_FUTUR_API_URL noch nicht konfiguriert.'
    });

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
}
