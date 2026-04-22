// POST /api/analyze-plan
// Empfängt einen Bauplan (PDF oder Bild) als base64, analysiert ihn via Claude Vision
// Gibt strukturierte JSON-Daten zurück

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { file } = req.body || {};
  if (!file?.base64 || !file?.mediaType) {
    return res.status(400).json({ error: 'Kein Dateiinhalt übergeben' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const isPDF = file.mediaType === 'application/pdf';

  const systemPrompt = `Du bist ein Schweizer Bauingenieur und Architekt. Du analysierst Baupläne und extrahierst alle relevanten Daten.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt. Kein Text davor oder danach. Kein Markdown.

JSON-Schema:
{
  "planTyp": "grundriss|schnitt|fassade|lageplan|unbekannt",
  "geschoss": "EG|OG1|OG2|UG|Dach|alle",
  "gebaeude": {
    "laenge": Zahl_in_m_oder_null,
    "breite": Zahl_in_m_oder_null,
    "hoehe_gesamt": Zahl_in_m_oder_null,
    "anzahl_geschosse": Zahl_oder_null
  },
  "raeume": [
    {
      "name": "Wohnzimmer",
      "flaeche_m2": Zahl_oder_null,
      "breite_m": Zahl_oder_null,
      "laenge_m": Zahl_oder_null,
      "raumhoehe_m": Zahl_oder_null,
      "typ": "wohnen|schlafen|kueche|bad|wc|erschliessung|nebenraum|keller|garage"
    }
  ],
  "fenster": [
    {
      "raum": "Wohnzimmer",
      "anzahl": Zahl,
      "breite_m": Zahl_oder_null,
      "hoehe_m": Zahl_oder_null,
      "typ": "standard|bodentief|dachfenster"
    }
  ],
  "tueren": {
    "innen": Zahl_oder_null,
    "aussen": Zahl_oder_null,
    "balkon_terrasse": Zahl_oder_null
  },
  "masse": {
    "nettowohnflaeche_m2": Zahl_oder_null,
    "bruttogrundrissflaeche_m2": Zahl_oder_null,
    "fassadenflaeche_m2": Zahl_oder_null
  },
  "massstab": "z.B. 1:100 oder null",
  "bemerkungen": "Besonderheiten etc."
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {})
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: isPDF ? 'document' : 'image',
              source: { type: 'base64', media_type: file.mediaType, data: file.base64 }
            },
            {
              type: 'text',
              text: `Analysiere diesen Bauplan (${file.name || 'Plan'}) und extrahiere alle Daten. Antworte nur mit dem JSON-Objekt.`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(200).json({ error: `API ${response.status}: ${err.error?.message || response.statusText}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(e) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return res.status(200).json({ error: 'JSON konnte nicht geparst werden', raw: text.substring(0, 500) });
    }

    return res.status(200).json({ result: parsed });
  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
}
