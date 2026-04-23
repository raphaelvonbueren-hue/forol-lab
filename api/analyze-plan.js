// POST /api/analyze-plan
// Umfassende Bauplan-Analyse via Vercel AI SDK + Claude
// Extrahiert ALLE relevanten Ausmass-Daten für Kostenplanung

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

// ─── SUB-SCHEMAS ──────────────────────────────────────────────────────────────

// Einzelnes Fenster (für die Fensterliste, Pkt. 5)
const FensterSchema = z.object({
  id:           z.string().describe('Kurz-ID z.B. F1, F2'),
  gebaeude:    z.string().nullable().describe('Gebäude-Bezeichnung wenn mehrere'),
  geschoss:    z.string().nullable().describe('EG, OG1, UG, Dach'),
  raum:        z.string().nullable(),
  breite_m:    z.number().nullable(),
  hoehe_m:     z.number().nullable(),
  flaeche_m2:  z.number().nullable().describe('breite × hoehe'),
  anzahl:      z.number().default(1),
  typ:         z.enum(['standard','bodentief','dachfenster','festverglasung','schiebetuer']),
  beschattung: z.enum(['raffstore','markise','rolladen','keine','unbekannt']).default('unbekannt'),
});

// Raum mit allen Ausmass-relevanten Daten (Pkt. 7-9)
const RaumSchema = z.object({
  name:        z.string(),
  gebaeude:    z.string().nullable(),
  geschoss:    z.string().nullable(),
  wohnung:     z.string().nullable().describe('Wohnungs-ID z.B. W1, 2.OG-links'),
  typ: z.enum([
    'wohnen','schlafen','kueche','bad','wc','dusche',
    'erschliessung','flur','treppenhaus','nebenraum',
    'keller','garage','technik','terrasse','balkon','loggia'
  ]),
  flaeche_boden_m2: z.number().nullable().describe('Nettobodenfläche'),
  flaeche_wand_m2:  z.number().nullable().describe('Abwickelbare Wandfläche ohne Öffnungen'),
  flaeche_decke_m2: z.number().nullable().describe('Nettodeckenfläche'),
  umfang_m:         z.number().nullable().describe('Raumumfang für Sockelleisten etc.'),
  raumhoehe_m:      z.number().nullable(),
  plattenbelag_bad_m2: z.number().nullable().describe('Nur bei Bad/Dusche: Boden + Wandflächen für Plattenbelag'),
});

// Tür-Position
const TuerSchema = z.object({
  gebaeude: z.string().nullable(),
  wohnung:  z.string().nullable(),
  typ:      z.enum(['innen','wohnungstuer','hauseingang','garage','technik','balkon_terrasse']),
  anzahl:   z.number(),
});

// Einzelnes Gebäude (Pkt. 1-4)
const GebaeudeSchema = z.object({
  bezeichnung: z.string().describe('Haus A, Gebäude 1 etc.'),
  laenge_m:         z.number().nullable(),
  breite_m:         z.number().nullable(),
  hoehe_gesamt_m:   z.number().nullable(),
  anzahl_geschosse: z.number().nullable(),
  grundflaeche_m2:  z.number().nullable().describe('Footprint'),
  volumen_m3:       z.number().nullable().describe('SIA 416 Gebäudevolumen'),
  nutzflaeche_m2:   z.number().nullable().describe('Summe aller Nutzräume'),
  erschliessung_m2: z.number().nullable().describe('Flure, Treppen, Lift pro Gebäude'),
  anzahl_wohnungen: z.number().nullable(),
});

// Wand-Typen (Pkt. 11)
const WandSchema = z.object({
  typ: z.enum(['backstein','beton','leichtbau','unbekannt']),
  laenge_m: z.number().nullable(),
  hoehe_m:  z.number().nullable(),
  flaeche_m2: z.number().nullable(),
  gebaeude: z.string().nullable(),
  geschoss: z.string().nullable(),
  notiz: z.string().nullable().describe('z.B. aus Schraffur erkannt'),
});

// Tiefgarage (Pkt. 10, 16)
const TiefgarageSchema = z.object({
  vorhanden: z.boolean(),
  flaeche_m2: z.number().nullable(),
  volumen_m3: z.number().nullable().describe('Bautechnisches Volumen TG'),
  anzahl_parkplaetze: z.number().nullable(),
  hartbetonbelag_m2: z.number().nullable().describe('Bodenfläche TG für Hartbetonbelag'),
  aushub_humus_m3:    z.number().nullable().describe('Humus 0.20m × Grundfläche'),
  aushub_erde_m3:     z.number().nullable().describe('Aushub bis 10cm unter Bodenplatte TG'),
});

// Umgebung (Pkt. 13-15)
const UmgebungSchema = z.object({
  gartenflaeche_m2:       z.number().nullable().describe('Bepflanzbare Fläche'),
  rasenflaeche_m2:        z.number().nullable(),
  befestigte_flaechen_m2: z.number().nullable().describe('Gehwege, Vorplätze, Zufahrten'),
  erschliessungswege_m2:  z.number().nullable(),
  anzahl_baeume:          z.number().nullable(),
  anzahl_straeucher:      z.number().nullable(),
  terrassen_m2:           z.number().nullable().describe('Summe aller privaten Terrassen'),
  balkone_m2:             z.number().nullable(),
});

// Aggregierte Ausmasse für KV (Pkt. 8, 9, 17)
const AusmasseSchema = z.object({
  // Böden
  bodenflaeche_wohnen_m2:      z.number().nullable().describe('Für Unterlagsboden + Parkett/Bodenbelag'),
  bodenflaeche_nass_m2:        z.number().nullable().describe('Bäder/Küchen für Plattenbelag'),
  bodenflaeche_nebenraum_m2:   z.number().nullable(),

  // Wände
  wandflaeche_grundputz_m2:    z.number().nullable().describe('Alle verputzten Wände'),
  wandflaeche_abrieb_m2:       z.number().nullable(),
  wandflaeche_maler_m2:        z.number().nullable().describe('Maler Innenwände'),
  wandflaeche_platten_m2:      z.number().nullable().describe('Plattenbelag Bäder/Küchen'),

  // Decken
  deckenflaeche_weissputz_m2:  z.number().nullable(),
  deckenflaeche_maler_m2:      z.number().nullable(),

  // Beschattung (Pkt. 17)
  beschattung_raffstoren_m2:   z.number().nullable(),
  beschattung_markisen_m2:     z.number().nullable(),
});

// ─── MAIN SCHEMA ──────────────────────────────────────────────────────────────
const BauplanSchema = z.object({
  // Metadaten
  planTyp:  z.enum(['grundriss','schnitt','fassade','lageplan','umgebung','tiefgarage','unbekannt']),
  geschoss: z.string().nullable(),
  massstab: z.string().nullable(),

  // 1-4: Gebäude
  anzahl_gebaeude: z.number().nullable(),
  gebaeude: z.array(GebaeudeSchema).describe('Ein Eintrag pro erkanntem Gebäude'),

  // Räume mit allen Flächen (5, 6, 7, 8, 9)
  raeume: z.array(RaumSchema),

  // 5: Fensterliste
  fenster: z.array(FensterSchema),

  // 6: Küchen + Bäder zählen
  anzahl_kuechen: z.number().nullable(),
  anzahl_baeder:  z.number().nullable(),
  anzahl_wc:      z.number().nullable(),

  // 11: Wandtypen
  waende: z.array(WandSchema),

  // 12: Türen
  tueren: z.array(TuerSchema),
  tueren_total: z.object({
    innen:        z.number().nullable(),
    wohnungstuer: z.number().nullable(),
    hauseingang:  z.number().nullable(),
    balkon_terrasse: z.number().nullable(),
    gesamt:       z.number().nullable(),
  }),

  // 10, 16: Tiefgarage
  tiefgarage: TiefgarageSchema,

  // 13, 14, 15, 18: Umgebung
  umgebung: UmgebungSchema,

  // Aggregierte Ausmasse (8, 9, 17)
  ausmasse: AusmasseSchema,

  // Sonstiges
  nutzflaeche_total_m2:      z.number().nullable(),
  bruttogrundflaeche_m2:     z.number().nullable(),
  fassadenflaeche_total_m2:  z.number().nullable(),

  bemerkungen: z.string().nullable().describe('Besonderheiten, fehlende Angaben, Unsicherheiten'),
});

// ─── HANDLER ──────────────────────────────────────────────────────────────────
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

  const systemPrompt = `Du bist ein Schweizer Bauingenieur, Architekt und Kostenplaner mit Expertise in SIA-Normen und BKP-Kalkulation.

Analysiere den Bauplan umfassend und extrahiere ALLE relevanten Daten für eine Ausmass-Berechnung:

GEBÄUDE:
- Zähle alle Gebäude (Mehrhaus-Projekte: Haus A, B, C)
- Pro Gebäude: Länge × Breite × Höhe, Grundfläche, Volumen (SIA 416)
- Nutzfläche = alle bewohnten/genutzten Räume
- Erschliessungsfläche = Flure + Treppenhaus + Lift pro Gebäude

RÄUME (jeder Raum mit voller Ausmass-Information):
- Bodenfläche (netto)
- Wandfläche (abgewickelter Umfang × Raumhöhe, ohne Fenster/Türen)
- Deckenfläche
- Umfang für Sockelleisten
- Bei Bädern/Duschen: Plattenbelag-Fläche = Boden + Wände bis 2.2m

FENSTER (vollständige Fensterliste):
- Jedes Fenster einzeln mit ID, Raum, Breite × Höhe, Typ, Beschattung
- Unterscheide: standard, bodentief, dachfenster, festverglasung
- Beschattung aus Fassadenansicht: Raffstore, Markise, Rolladen

WÄNDE (Pkt. 11 – Schraffur-Analyse!):
- Backstein: diagonale Schraffur, Block-Muster
- Beton: dichte Schraffur oder massive Füllung
- Leichtbau: doppelte Linie mit heller Füllung
- Pro Wandtyp: Länge + Höhe + Gesamtfläche

TÜREN:
- Innentüren, Wohnungstüren, Hauseingang, Balkon/Terrassentüren
- Pro Wohnung + pro Gebäude aufschlüsseln
- Gesamtsumme

TIEFGARAGE (wenn vorhanden):
- Bodenfläche + Volumen
- Anzahl Parkplätze (einzeln markierte Felder zählen)
- Hartbetonbelag = gesamte TG-Bodenfläche
- Aushub: Humus 0.20m × Grundfläche + Erdaushub bis 10cm unter TG-Bodenplatte

UMGEBUNG (aus Lageplan):
- Bepflanzbare Gartenfläche vs. Rasen
- Befestigte Flächen: Wege, Vorplätze, Zufahrten
- Bäume (grosse Symbole) + Sträucher (kleine Symbole) zählen
- Terrassen pro Wohnung summieren

AUSMASSE für KV (aggregiert):
- Boden Wohnen (Parkett), Nass (Platten), Nebenraum
- Wand: Grundputz, Abrieb, Maler, Plattenbelag
- Decke: Weissputz, Maler
- Beschattung: Raffstore-Fläche + Markisen-Fläche

WICHTIG:
- Masse exakt ablesen, nur bei klaren Massangaben
- Fehlende Werte = null (niemals schätzen oder interpolieren)
- Bei Schraffur-Unsicherheit: "unbekannt" + Notiz
- Bei mehreren Plänen im gleichen Projekt: Gebäude-Bezeichnungen konsistent halten`;

  const contentParts = [
    isPDF
      ? { type: 'file',  data: file.base64, mediaType: 'application/pdf', filename: file.name || 'plan.pdf' }
      : { type: 'image', image: file.base64, mediaType: file.mediaType },
    {
      type: 'text',
      text: `Analysiere diesen Bauplan (${file.name || 'Plan'}) gemäss Schema.
Gehe systematisch durch jeden Datenpunkt. Fehlende Angaben = null.`,
    },
  ];

  try {
    const { object } = await generateObject({
      model: anthropic('claude-sonnet-4-5'),
      schema: BauplanSchema,
      schemaName: 'BauplanAnalyse',
      schemaDescription: 'Vollständige Ausmass-Extraktion aus Schweizer Bauplänen für BKP-Kalkulation',
      system: systemPrompt,
      messages: [{ role: 'user', content: contentParts }],
      maxTokens: 8000,
      temperature: 0.1,
    });

    return res.status(200).json({ result: object });

  } catch (err) {
    console.error('analyze-plan error:', err);
    return res.status(200).json({ error: err.message || 'Analyse fehlgeschlagen' });
  }
}
