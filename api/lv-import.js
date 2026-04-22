// POST /api/lv-import
// Leistungsverzeichnis-Import via Vercel AI SDK + @ai-sdk/anthropic
// Extrahiert Einheitspreise aus PDF-Offerten/LVs, gibt strukturiertes JSON zurück

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

// ─── Zod Schema für eine einzelne Preisposition ───────────────────────────────
const PreisPositionSchema = z.object({
  pos:         z.string().describe('Positionsnummer z.B. 211, 2.1.3, E411.1'),
  bkp:         z.enum(['1','2','3','4']).nullable().describe('BKP-Hauptgruppe 1-4 oder null'),
  name:        z.string().max(80).describe('Kurzbezeichnung der Leistung'),
  unit:        z.string().describe('Einheit: m², m³, m, lm, Stk, psch, h, kg, t'),
  price:       z.number().positive().describe('Einheitspreis CHF (nur Zahl, kein Symbol)'),
  description: z.string().max(200).nullable().describe('Längere Beschreibung optional'),
});

const LVImportSchema = z.object({
  items: z.array(PreisPositionSchema)
    .describe('Alle gefundenen Positionen mit Einheitspreis > 0'),
});

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { files } = req.body || {};
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Keine Dateien übergeben' });
  }

  const results = [];

  for (const file of files) {
    const { name, base64, mediaType } = file;
    if (!base64) { results.push({ name, error: 'Kein Inhalt', items: [] }); continue; }

    try {
      const { object } = await generateObject({
        model: anthropic('claude-sonnet-4-5'),
        schema: LVImportSchema,
        schemaName: 'LVImport',
        schemaDescription: 'Einheitspreise aus einem Schweizer Leistungsverzeichnis oder einer Offerte.',
        system: `Du bist ein Experte für schweizerische Leistungsverzeichnisse (LV) und BKP-Positionen.
Extrahiere NUR Positionen mit konkretem Einheitspreis (>0 CHF).
Apostrophe in Zahlen entfernen: 1'234.00 → 1234.00.
Keine Pauschalpreise als Einheitspreise.`,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'file',
              data: base64,
              mediaType: mediaType || 'application/pdf',
              filename: name,
            },
            {
              type: 'text',
              text: `Extrahiere alle Einheitspreise aus diesem Leistungsverzeichnis (${name}).`,
            },
          ],
        }],
        maxTokens: 4000,
        temperature: 0.1,
      });

      results.push({ name, items: object.items, count: object.items.length });

    } catch (err) {
      console.error('lv-import error:', name, err.message);
      results.push({ name, error: err.message, items: [] });
    }
  }

  const totalItems = results.reduce((s, r) => s + (r.items?.length || 0), 0);
  return res.status(200).json({ results, totalItems });
}
