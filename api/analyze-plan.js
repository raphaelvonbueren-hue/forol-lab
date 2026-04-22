// POST /api/analyze-plan
// Bauplan-Analyse via Vercel AI SDK + @ai-sdk/anthropic
// Unterstützt PDF und Bilder (base64), gibt strukturiertes JSON zurück

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

// ─── Zod Schema ───────────────────────────────────────────────────────────────
const BauplanSchema = z.object({
  planTyp: z.enum(['grundriss', 'schnitt', 'fassade', 'lageplan', 'unbekannt']),
  geschoss: z.string().nullable(),
  gebaeude: z.object({
    laenge:           z.number().nullable(),
    breite:           z.number().nullable(),
    hoehe_gesamt:     z.number().nullable(),
    anzahl_geschosse: z.number().nullable(),
  }),
  raeume: z.array(z.object({
    name:        z.string(),
    flaeche_m2:  z.number().nullable(),
    breite_m:    z.number().nullable(),
    laenge_m:    z.number().nullable(),
    raumhoehe_m: z.number().nullable(),
    typ: z.enum(['wohnen','schlafen','kueche','bad','wc','erschliessung','nebenraum','keller','garage']),
  })),
  fenster: z.array(z.object({
    raum:     z.string(),
    anzahl:   z.number(),
    breite_m: z.number().nullable(),
    hoehe_m:  z.number().nullable(),
    typ: z.enum(['standard','bodentief','dachfenster']),
  })),
  tueren: z.object({
    innen:           z.number().nullable(),
    aussen:          z.number().nullable(),
    balkon_terrasse: z.number().nullable(),
  }),
  masse: z.object({
    nettowohnflaeche_m2:       z.number().nullable(),
    bruttogrundrissflaeche_m2: z.number().nullable(),
    fassadenflaeche_m2:        z.number().nullable(),
  }),
  massstab:    z.string().nullable(),
  bemerkungen: z.string().nullable(),
});

// ─── Handler ──────────────────────────────────────────────────────────────────
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

  const isPDF = file.mediaType === 'application/pdf';

  const contentParts = [
    isPDF
      ? { type: 'file',  data: file.base64, mimeType: 'application/pdf', filename: file.name || 'plan.pdf' }
      : { type: 'image', image: file.base64, mimeType: file.mediaType },
    {
      type: 'text',
      text: `Analysiere diesen Bauplan (${file.name || 'Plan'}) und extrahiere alle verfügbaren Daten.
Masse: exakt ablesen wenn sichtbar. Fehlende Werte = null (nicht schätzen).
Schnitte: Raumhöhen + Geschosshöhen beachten. Fassaden: Fensteranzahl + Grössen.`,
    },
  ];

  try {
    const { object } = await generateObject({
      model: anthropic('claude-sonnet-4-5'),
      schema: BauplanSchema,
      schemaName: 'BauplanAnalyse',
      schemaDescription: 'Strukturierte Extraktion aller relevanten Daten aus einem Schweizer Bauplan.',
      system: 'Du bist ein Schweizer Bauingenieur. Analysiere Baupläne präzise und extrahiere alle Daten vollständig.',
      messages: [{ role: 'user', content: contentParts }],
      maxTokens: 2000,
      temperature: 0.1,
    });

    return res.status(200).json({ result: object });

  } catch (err) {
    console.error('analyze-plan error:', err);
    return res.status(200).json({ error: err.message || 'Analyse fehlgeschlagen' });
  }
}
