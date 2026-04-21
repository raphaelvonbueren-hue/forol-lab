// POST /api/lv-import
// Empfängt eine oder mehrere PDFs (base64), extrahiert Einheitspreise via Claude Vision
// Gibt strukturierte Preisdaten zurück für die lokale Preisdatenbank

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { files, existingPositions } = req.body || {};
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Keine Dateien übergeben' });
  }

  const results = [];

  for (const file of files) {
    const { name, base64, mediaType } = file;
    if (!base64) { results.push({ name, error: 'Kein Inhalt', items: [] }); continue; }

    try {
      const systemPrompt = `Du bist ein Experte für schweizerische Leistungsverzeichnisse (LV) und BKP-Positionen.
Extrahiere aus dem Dokument alle Einheitspreise als JSON-Array.

Für jede Position extrahiere:
- pos: Positionsnummer (z.B. "231", "2.1.3", "E411.1") 
- bkp: BKP-Hauptgruppe wenn erkennbar (1-4, sonst null)
- name: Kurzbezeichnung der Leistung (max 80 Zeichen)
- unit: Einheit (m², m³, m, lm, Stk, psch, h, kg, t)
- price: Einheitspreis in CHF (nur die Zahl, kein Währungssymbol)
- description: längere Beschreibung falls vorhanden (max 200 Zeichen)

Wichtige Regeln:
- Nur Positionen mit KONKRETEM Einheitspreis (>0 CHF)
- Keine Pauschalpreise als Einheitspreise
- Preise aus dem LV-Dokument exakt übernehmen (nicht runden)
- Wenn keine BKP-Gruppe erkennbar: bkp=null

Antworte NUR mit einem JSON-Array. Kein Text davor oder danach.
Beispiel: [{"pos":"211","bkp":"2","name":"Aushub allgemein","unit":"m³","price":45.50,"description":"maschineller Aushub Klasse 3-4"}]`;

      const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '';
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {})
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'application/pdf',
                  data: base64
                }
              },
              {
                type: 'text',
                text: 'Extrahiere alle Einheitspreise aus diesem Leistungsverzeichnis als JSON-Array.'
              }
            ]
          }]
        })
      });

      if (!apiResponse.ok) {
        const err = await apiResponse.text();
        results.push({ name, error: `API Fehler: ${apiResponse.status}`, items: [] });
        continue;
      }

      const data = await apiResponse.json();
      const rawText = data.content?.[0]?.text || '';
      
      // Parse JSON aus Antwort
      let items = [];
      try {
        // Entferne mögliche Markdown-Fences
        const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        items = JSON.parse(cleaned);
        if (!Array.isArray(items)) items = [];
      } catch(e) {
        // Versuche JSON-Array aus Text zu extrahieren
        const match = rawText.match(/\[[\s\S]*\]/);
        if (match) {
          try { items = JSON.parse(match[0]); } catch(e2) { items = []; }
        }
      }

      // Validierung und Bereinigung
      items = items.filter(item => {
        return item.price > 0 && item.name && item.unit;
      }).map(item => ({
        pos: String(item.pos || '').trim(),
        bkp: item.bkp ? String(item.bkp).trim() : null,
        name: String(item.name || '').substring(0, 80).trim(),
        unit: String(item.unit || '').trim(),
        price: parseFloat(item.price) || 0,
        description: item.description ? String(item.description).substring(0, 200).trim() : '',
        source: name,
        importedAt: new Date().toISOString()
      }));

      results.push({ name, items, count: items.length });

    } catch(e) {
      results.push({ name, error: e.message, items: [] });
    }
  }

  const totalItems = results.reduce((s, r) => s + (r.items?.length || 0), 0);
  res.status(200).json({ results, totalItems });
}
