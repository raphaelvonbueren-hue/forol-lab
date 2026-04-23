// POST /api/analyze-plan
// Umfassende Bauplan-Analyse via Vercel AI SDK + Claude
// Extrahiert ALLE relevanten Daten für vollständige BKP-Kalkulation


import { generateObject } from 'ai';
import { z } from 'zod';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

// ─── SUB-SCHEMAS ──────────────────────────────────────────────────────────────

const FensterSchema = z.object({
  id:           z.string().describe('Kurz-ID z.B. F1'),
  gebaeude:     z.string().nullable(),
  geschoss:     z.string().nullable(),
  raum:         z.string().nullable(),
  breite_m:     z.number().nullable(),
  hoehe_m:      z.number().nullable(),
  flaeche_m2:   z.number().nullable(),
  anzahl:       z.number().default(1),
  typ:          z.enum(['standard','bodentief','dachfenster','festverglasung','schiebetuer','oberlicht']),
  verglasung:   z.enum(['2-fach','3-fach','einfach','unbekannt']).default('unbekannt'),
  rahmen:       z.enum(['holz','holz-alu','alu','kunststoff','unbekannt']).default('unbekannt'),
  beschattung:  z.enum(['raffstore','markise','rolladen','lamellenstoren','keine','unbekannt']).default('unbekannt'),
  brustung_m:   z.number().nullable().describe('Brüstungshöhe'),
  fensterbank:  z.enum(['stein','holz','kunststoff','keine','unbekannt']).default('unbekannt'),
});

const RaumSchema = z.object({
  name:                    z.string(),
  gebaeude:                z.string().nullable(),
  geschoss:                z.string().nullable(),
  wohnung:                 z.string().nullable(),
  typ: z.enum([
    'wohnen','essen','kueche','schlafen','kind','bad','dusche','wc',
    'erschliessung','flur','treppenhaus','lift','eingang','nebenraum',
    'abstellraum','garderobe','reduit','waschkueche','technik','heizung',
    'keller','garage','einstellhalle','hobbyraum','buero','atelier',
    'terrasse','balkon','loggia','wintergarten','dachterrasse'
  ]),
  flaeche_boden_m2:        z.number().nullable(),
  flaeche_wand_m2:         z.number().nullable(),
  flaeche_decke_m2:        z.number().nullable(),
  umfang_m:                z.number().nullable(),
  raumhoehe_m:             z.number().nullable(),
  lichte_hoehe_m:          z.number().nullable(),
  plattenbelag_bad_m2:     z.number().nullable(),
  bodenbelag:              z.enum(['parkett','laminat','vinyl','fliesen','naturstein','beton','teppich','linoleum','hartbeton','unbekannt']).default('unbekannt'),
  wandbelag:               z.enum(['putz','fliesen','tapete','holz','beton-sichtbar','unbekannt']).default('unbekannt'),
  deckenbelag:             z.enum(['weissputz','akustik','abgehaengt','beton-sichtbar','holz','unbekannt']).default('unbekannt'),
  heizkoerper:             z.number().nullable().describe('Anzahl Heizkörper'),
  bodenheizung:            z.boolean().default(false),
  steckdosen:              z.number().nullable().describe('Anzahl Steckdosen'),
  lichtauslaesse:          z.number().nullable(),
  anschluss_wasser:        z.boolean().default(false),
  anschluss_abwasser:      z.boolean().default(false),
});

const TuerSchema = z.object({
  id:         z.string().nullable(),
  gebaeude:   z.string().nullable(),
  wohnung:    z.string().nullable(),
  geschoss:   z.string().nullable(),
  typ:        z.enum(['innen','wohnungstuer','hauseingang','garage','technik','balkon_terrasse','schiebetuer','brandschutz','kellertuer']),
  breite_m:   z.number().nullable(),
  hoehe_m:    z.number().nullable(),
  flaeche_m2: z.number().nullable(),
  material:   z.enum(['holz','glas','stahl','alu','kunststoff','unbekannt']).default('unbekannt'),
  brandschutz: z.enum(['EI30','EI60','EI90','keine','unbekannt']).default('unbekannt'),
  anzahl:     z.number().default(1),
});

const SanitaerSchema = z.object({
  wc:           z.number().nullable(),
  lavabo:       z.number().nullable(),
  dusche:       z.number().nullable(),
  badewanne:    z.number().nullable(),
  bidet:        z.number().nullable(),
  urinal:       z.number().nullable(),
  ausgussbecken: z.number().nullable(),
  waschtrog:    z.number().nullable(),
  spuele_kueche: z.number().nullable(),
});

const KuecheSchema = z.object({
  gebaeude:     z.string().nullable(),
  wohnung:      z.string().nullable(),
  geschoss:     z.string().nullable(),
  laenge_m:     z.number().nullable().describe('Gesamtlänge Küchenzeile'),
  typ:          z.enum(['einzeilig','l-form','u-form','insel','unbekannt']).default('unbekannt'),
  kuehlschrank: z.boolean().default(true),
  geschirrspueler: z.boolean().default(true),
  backofen:     z.boolean().default(true),
  kochfeld:     z.enum(['induktion','ceran','gas','unbekannt']).default('unbekannt'),
  dampfabzug:   z.boolean().default(true),
  mikrowelle:   z.boolean().default(false),
});

const BadSchema = z.object({
  gebaeude:     z.string().nullable(),
  wohnung:      z.string().nullable(),
  geschoss:     z.string().nullable(),
  flaeche_m2:   z.number().nullable(),
  plattenbelag_boden_m2:  z.number().nullable(),
  plattenbelag_wand_m2:   z.number().nullable(),
  hat_wc:       z.boolean().default(true),
  hat_lavabo:   z.boolean().default(true),
  hat_dusche:   z.boolean().default(false),
  hat_badewanne: z.boolean().default(false),
  hat_bidet:    z.boolean().default(false),
  typ:          z.enum(['vollbad','duschbad','gaeste-wc','dusch-wc','unbekannt']).default('unbekannt'),
});

const GebaeudeSchema = z.object({
  bezeichnung:      z.string(),
  laenge_m:         z.number().nullable(),
  breite_m:         z.number().nullable(),
  hoehe_gesamt_m:   z.number().nullable(),
  hoehe_first_m:    z.number().nullable().describe('Höhe bis Dachfirst'),
  hoehe_trauf_m:    z.number().nullable(),
  anzahl_geschosse: z.number().nullable(),
  anzahl_ug:        z.number().nullable().describe('Untergeschosse'),
  grundflaeche_m2:  z.number().nullable(),
  volumen_m3:       z.number().nullable(),
  nutzflaeche_m2:   z.number().nullable(),
  erschliessung_m2: z.number().nullable(),
  anzahl_wohnungen: z.number().nullable(),
  lift:             z.boolean().default(false),
  treppenhaus_typ:  z.enum(['innen','aussen','offen','geschlossen','unbekannt']).default('unbekannt'),
  fassadenflaeche_m2: z.number().nullable(),
  dachflaeche_m2:   z.number().nullable(),
  dachtyp:          z.enum(['flachdach','satteldach','walmdach','pultdach','mansarddach','unbekannt']).default('unbekannt'),
  dachneigung_grad: z.number().nullable(),
});

const WandSchema = z.object({
  id:         z.string().nullable(),
  typ:        z.enum(['backstein','beton','stahlbeton','leichtbau','holzbau','naturstein','unbekannt']),
  tragend:    z.boolean().default(false),
  laenge_m:   z.number().nullable(),
  hoehe_m:    z.number().nullable(),
  dicke_cm:   z.number().nullable(),
  flaeche_m2: z.number().nullable(),
  gebaeude:   z.string().nullable(),
  geschoss:   z.string().nullable(),
  daemmung_cm: z.number().nullable().describe('Dämmstärke wenn Aussenwand'),
  notiz:      z.string().nullable(),
});

const DaemmungSchema = z.object({
  fassade_cm:     z.number().nullable(),
  dach_cm:        z.number().nullable(),
  bodenplatte_cm: z.number().nullable(),
  perimeter_cm:   z.number().nullable(),
  fassade_m2:     z.number().nullable(),
  dach_m2:        z.number().nullable(),
  bodenplatte_m2: z.number().nullable(),
  perimeter_m2:   z.number().nullable(),
});

const TiefgarageSchema = z.object({
  vorhanden: z.boolean(),
  flaeche_m2: z.number().nullable(),
  volumen_m3: z.number().nullable(),
  anzahl_parkplaetze: z.number().nullable(),
  anzahl_pp_behindert: z.number().nullable(),
  anzahl_motorrad: z.number().nullable(),
  hartbetonbelag_m2: z.number().nullable(),
  aushub_humus_m3:   z.number().nullable(),
  aushub_erde_m3:    z.number().nullable(),
  deckenhoehe_m:     z.number().nullable(),
  einfahrt_rampe_m:  z.number().nullable().describe('Rampenlänge'),
  einfahrt_tor:      z.boolean().default(false),
  entwaesserung_rinne_m: z.number().nullable(),
  anzahl_ladestationen_ev: z.number().nullable(),
  lueftung:          z.enum(['natuerlich','mechanisch','unbekannt']).default('unbekannt'),
});

const UmgebungSchema = z.object({
  gartenflaeche_m2:       z.number().nullable(),
  rasenflaeche_m2:        z.number().nullable(),
  bepflanzte_flaeche_m2:  z.number().nullable(),
  befestigte_flaechen_m2: z.number().nullable(),
  erschliessungswege_m2:  z.number().nullable(),
  einfahrt_m2:            z.number().nullable(),
  parkplaetze_aussen:     z.number().nullable(),
  veloabstellplatz:       z.number().nullable(),
  anzahl_baeume:          z.number().nullable(),
  anzahl_baeume_zu_erhalten: z.number().nullable(),
  anzahl_baeume_neu:      z.number().nullable(),
  anzahl_straeucher:      z.number().nullable(),
  anzahl_hecken_m:        z.number().nullable().describe('Hecken in laufenden Metern'),
  terrassen_m2:           z.number().nullable(),
  balkone_m2:             z.number().nullable(),
  sitzplatz_m2:           z.number().nullable(),
  biotop_teich_m2:        z.number().nullable(),
  spielgeraete:           z.number().nullable(),
  stuetzmauer_m:          z.number().nullable().describe('Stützmauer in lfm'),
  zaun_m:                 z.number().nullable(),
  gartentor:              z.number().nullable(),
  aussenbeleuchtung:      z.number().nullable(),
  versickerung_m2:        z.number().nullable(),
});

const TechnikSchema = z.object({
  heizung_typ:            z.enum(['waermepumpe','gas','oel','pellet','fernwaerme','elektro','solar','unbekannt']).default('unbekannt'),
  heizung_leistung_kw:    z.number().nullable(),
  warmwasser_boiler_l:    z.number().nullable(),
  photovoltaik_m2:        z.number().nullable(),
  photovoltaik_kwp:       z.number().nullable(),
  solar_thermie_m2:       z.number().nullable(),
  lueftung_komfort:       z.boolean().default(false),
  kuehlung:               z.boolean().default(false),
  anzahl_verteilerkasten: z.number().nullable(),
  smart_home:             z.boolean().default(false),
  anzahl_raumthermostate: z.number().nullable(),
});

const ElektroSchema = z.object({
  steckdosen_total:       z.number().nullable(),
  lichtauslaesse_total:   z.number().nullable(),
  schalter_total:         z.number().nullable(),
  netzwerk_dosen:         z.number().nullable(),
  tv_anschluesse:         z.number().nullable(),
  rauchmelder:            z.number().nullable(),
  tuerkommunikation:      z.boolean().default(false),
  briefkasten_anlage:     z.boolean().default(false),
});

const AusmasseSchema = z.object({
  // BÖDEN
  bodenflaeche_wohnen_m2:      z.number().nullable(),
  bodenflaeche_nass_m2:        z.number().nullable(),
  bodenflaeche_nebenraum_m2:   z.number().nullable(),
  bodenflaeche_treppenhaus_m2: z.number().nullable(),
  bodenflaeche_keller_m2:      z.number().nullable(),
  unterlagsboden_total_m2:     z.number().nullable(),
  sockelleisten_m:             z.number().nullable(),

  // WÄNDE
  wandflaeche_grundputz_m2:    z.number().nullable(),
  wandflaeche_abrieb_m2:       z.number().nullable(),
  wandflaeche_maler_m2:        z.number().nullable(),
  wandflaeche_platten_m2:      z.number().nullable(),
  wandflaeche_tapete_m2:       z.number().nullable(),

  // DECKEN
  deckenflaeche_weissputz_m2:  z.number().nullable(),
  deckenflaeche_maler_m2:      z.number().nullable(),
  deckenflaeche_akustik_m2:    z.number().nullable(),
  deckenflaeche_abgehaengt_m2: z.number().nullable(),

  // BESCHATTUNG
  beschattung_raffstoren_m2:   z.number().nullable(),
  beschattung_raffstoren_stk:  z.number().nullable(),
  beschattung_markisen_m2:     z.number().nullable(),
  beschattung_markisen_stk:    z.number().nullable(),
  beschattung_rolladen_m2:     z.number().nullable(),

  // FASSADE
  fassade_verputzt_m2:         z.number().nullable(),
  fassade_hinterluftet_m2:     z.number().nullable(),
  fassade_sichtbeton_m2:       z.number().nullable(),
  fassade_holz_m2:             z.number().nullable(),
  fassade_verkleidet_m2:       z.number().nullable(),

  // DACH
  dachflaeche_total_m2:        z.number().nullable(),
  dachrand_m:                  z.number().nullable(),
  rinnen_m:                    z.number().nullable(),
  fallrohre_m:                 z.number().nullable(),
  dachfenster_stk:             z.number().nullable(),
  spengler_attika_m:           z.number().nullable(),
});

// ─── MAIN SCHEMA ──────────────────────────────────────────────────────────────
const BauplanSchema = z.object({
  // Metadaten
  planTyp:  z.enum(['grundriss','schnitt','fassade','lageplan','umgebung','tiefgarage','detail','ubersicht','unbekannt']),
  geschoss: z.string().nullable(),
  massstab: z.string().nullable(),
  datum:    z.string().nullable().describe('Plandatum wenn lesbar'),
  nordpfeil: z.enum(['oben','unten','links','rechts','unbekannt']).default('unbekannt'),

  // 1-4: Gebäude
  anzahl_gebaeude: z.number().nullable(),
  gebaeude: z.array(GebaeudeSchema),

  // Räume
  raeume: z.array(RaumSchema),

  // 5: Fenster (vollständige Liste)
  fenster: z.array(FensterSchema),

  // 6: Küchen & Bäder als detaillierte Listen
  kuechen: z.array(KuecheSchema),
  baeder:  z.array(BadSchema),
  anzahl_kuechen: z.number().nullable(),
  anzahl_baeder:  z.number().nullable(),
  anzahl_wc:      z.number().nullable(),
  anzahl_duschen: z.number().nullable(),

  // Wände (inkl. Schraffur)
  waende: z.array(WandSchema),

  // Türen
  tueren: z.array(TuerSchema),
  tueren_total: z.object({
    innen:              z.number().nullable(),
    wohnungstuer:       z.number().nullable(),
    hauseingang:        z.number().nullable(),
    balkon_terrasse:    z.number().nullable(),
    brandschutz:        z.number().nullable(),
    schiebetueren:      z.number().nullable(),
    gesamt:             z.number().nullable(),
  }),

  // Sanitär (gesamt)
  sanitaer_total: SanitaerSchema,

  // Tiefgarage
  tiefgarage: TiefgarageSchema,

  // Umgebung
  umgebung: UmgebungSchema,

  // Technik
  technik: TechnikSchema,

  // Elektro
  elektro: ElektroSchema,

  // Dämmung
  daemmung: DaemmungSchema,

  // Ausmasse für Kalkulation
  ausmasse: AusmasseSchema,

  // Aggregierte Totale
  nutzflaeche_total_m2:      z.number().nullable(),
  bruttogrundflaeche_m2:     z.number().nullable(),
  hauptnutzflaeche_m2:       z.number().nullable().describe('HNF nach SIA 416'),
  nebennutzflaeche_m2:       z.number().nullable().describe('NNF nach SIA 416'),
  verkehrsflaeche_m2:        z.number().nullable().describe('VF nach SIA 416'),
  funktionsflaeche_m2:       z.number().nullable().describe('FF nach SIA 416'),
  konstruktionsflaeche_m2:   z.number().nullable().describe('KF nach SIA 416'),
  gebaeudevolumen_sia_m3:    z.number().nullable().describe('GV nach SIA 416'),
  fassadenflaeche_total_m2:  z.number().nullable(),

  // Kennzahlen
  anzahl_wohnungen_total:    z.number().nullable(),
  anzahl_zimmer_total:       z.number().nullable(),
  anzahl_geschosse_max:      z.number().nullable(),

  // Besonderheiten
  besonderheiten: z.array(z.string()).describe('Auffälligkeiten: Lift, Dachgarten, Pool, Kamin, etc.'),
  bemerkungen: z.string().nullable(),
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

const systemPrompt = `Du bist Schweizer Bauingenieur, Architekt und Ausmass-Spezialist mit Expertise in SIA 416, SIA 451, BKP/eBKP-H und CRB-Normpositionen.

DEINE KERNKOMPETENZ: Aus einem Vektor-Bauplan präzise Ausmasse herleiten — durch GEOMETRISCHE BERECHNUNG anhand der sichtbaren Referenzmasse, NICHT nur durch direktes Ablesen.

═══════════════════════════════════════════════════════════════════════════════
ARBEITSMETHODE — so gehst du systematisch vor:
═══════════════════════════════════════════════════════════════════════════════

SCHRITT 1: REFERENZ-KALIBRIERUNG
- Lies ALLE sichtbaren Bemassungs-Ketten auf dem Plan ab (Gebäudeaussenmasse, Raum-Innenmasse, Wandstärken)
- Bestimme den Massstab: aus Massstab-Angabe (1:100 etc.) oder aus Referenzlänge (z.B. bemasster Wandzug)
- Ab jetzt: JEDE Länge im Plan lässt sich anhand dieser Referenzen proportional berechnen

SCHRITT 2: GEOMETRISCHE RECHERCHE statt passivem Ablesen
Wenn ein Fenster nicht direkt bemasst ist, aber die Aussenwand 12.50m misst und das Fenster proportional ~1/5 dieser Wand einnimmt → Fenster ≈ 2.50m breit.
Wenn die Raumhöhe im Schnitt mit 2.60m angegeben ist und eine Tür von Boden bis 90% der Raumhöhe geht → Türhöhe ≈ 2.00m (Standard).
Wenn eine Brüstung im Schnitt 1/3 der Raumhöhe einnimmt → Brüstung ≈ 0.87m.

Du MUSST diese proportionalen Berechnungen aktiv anstellen. Das ist KEIN Schätzen — das ist Bauplan-Lesen auf Ingenieursniveau.

SCHRITT 3: SCHWEIZER STANDARDMASSE als sekundäre Referenz nutzen
Wenn Bemassung fehlt UND keine Proportion ermittelbar, greife auf Standard-Masse zurück:
- Innentür Standard: 0.80 × 2.00 m (oder 0.90 × 2.00 m in Bädern)
- Wohnungstür: 1.00 × 2.00 m
- Fenster Schlafzimmer/Kinderzimmer: 1.20 × 1.40 m Brüstung 0.90m
- Fenster Wohnzimmer: 2.00-3.00 m breit, oft bodentief (2.40m hoch)
- Fenster Bad: 0.60 × 1.00 m
- Balkontür: 1.00 × 2.20 m (oder als Teil einer Fensterfront)
- Raumhöhe EG/OG Wohnen: 2.40-2.60 m netto
- Raumhöhe UG/Technik: 2.20 m
- Wandstärke Aussenwand: 30-40 cm
- Wandstärke tragende Innenwand: 17-25 cm
- Wandstärke Leichtbau: 10-12 cm

Vermerke IMMER in der Raum/Fenster-"bemerkungen", wenn du einen Standardwert angenommen hast.

═══════════════════════════════════════════════════════════════════════════════
FENSTER — DAS IST KRITISCH:
═══════════════════════════════════════════════════════════════════════════════

Fenster im Grundriss erkennst du an:
- Wandunterbrechung mit doppelter oder dreifacher Parallellinie
- Oft ein kleines Dreieck oder Bogen als Öffnungsrichtung
- Brüstung als gestrichelte Linie dargestellt
- Bodentiefe Fenster/Türen: durchgehende Öffnung bis zum Boden, oft mit Schwelle markiert

Fenster in der Fassade erkennst du an:
- Rechteckige Öffnungen mit Kreuz (Fensterflügel-Unterteilung)
- Beschattungen darüber als horizontale/vertikale Linien oder Lamellen
- Grössenverhältnisse zur Fassadenhöhe geben Fensterhöhe

WICHTIG: Der Plan enthält Fenster — du MUSST sie finden. Wenn du bei einem Wohnhaus 0 Fenster findest, hast du nicht genau genug hingesehen. Ein Einfamilienhaus hat typischerweise 15-30 Fenster, eine Wohnung 8-15 Fenster.

Für JEDES Fenster: gib B × H an. Falls nicht direkt bemasst: proportional aus Wandlänge berechnen.
Berechne flaeche_m2 = breite_m × hoehe_m. Zähle alle Fensterflächen zusammen.

═══════════════════════════════════════════════════════════════════════════════
AUSHUB TIEFGARAGE — PRÄZISE BERECHNEN:
═══════════════════════════════════════════════════════════════════════════════

Wenn eine Tiefgarage/UG erkennbar ist:

1. TG-Grundfläche aus Grundriss ablesen (L × B, oder direkt aus Bemassung)
2. TG-Tiefe aus Schnitt: Höhe UK Bodenplatte unter OK Terrain
   - Typisch: Bodenplatte ~30 cm dick, Terrain 10 cm über OK Bodenplatte
   - Aushub-Tiefe = Geschosshöhe UG + Bodenplattendicke + ~10 cm Überhub
3. Humus-Abtrag: 0.20m × Grundfläche der gesamten Baugrube (nicht nur TG, sondern inkl. Arbeitsraum ~0.5m rundherum)
4. Erdaushub = (Grundfläche + Arbeitsraum) × Aushub-Tiefe MINUS Humus-Volumen

Beispiel: TG 20×15m, 2.80m UG + 30cm Bodenplatte + 10cm Überhub = 3.20m Aushub-Tiefe
- Baugruben-Grundfläche mit 0.5m Arbeitsraum: 21×16 = 336 m²
- Humus: 336 × 0.20 = 67.2 m³
- Erde: 336 × 3.20 - 67.2 = 1075.2 - 67.2 = 1008 m³

Gib aushub_humus_m3 und aushub_erde_m3 IMMER an, wenn eine TG erkennbar ist. Berechne aus den Plan-Massen.

═══════════════════════════════════════════════════════════════════════════════
RAUM-AUSMASSE — PRÄZISE BERECHNEN:
═══════════════════════════════════════════════════════════════════════════════

Pro Raum:
- flaeche_boden_m2 = Länge × Breite des Raums (aus Bemassung oder Proportion)
- umfang_m = 2 × (L + B) minus Türbreiten
- flaeche_wand_m2 = umfang × raumhoehe MINUS Fensterflächen dieses Raums MINUS Türflächen
- flaeche_decke_m2 = flaeche_boden_m2 (gleiche Fläche, minus evtl. Treppenöffnung)

Bei Bädern:
- plattenbelag_bad_m2 = flaeche_boden_m2 + (umfang × 2.2m Wandhöhe) - Türflächen - Fensterflächen

Wenn ein Raum erkennbar ist, MUSS mindestens die Bodenfläche berechnet werden. null ist nur erlaubt wenn der Raum gar nicht auf dem Plan ist.

═══════════════════════════════════════════════════════════════════════════════
FASSADENFLÄCHEN — aus Gebäudemassen berechnen:
═══════════════════════════════════════════════════════════════════════════════

fassadenflaeche_total_m2 = Umfang Gebäude × Höhe bis Dachrand - Fensterflächen - Türflächen
Beispiel: 12m × 10m × 2 Geschosse à 3m = 44m Umfang × 6m = 264 m² - Fenster(40m²) = 224 m² Fassade

═══════════════════════════════════════════════════════════════════════════════
UMGEBUNG — auf Lageplan systematisch zählen:
═══════════════════════════════════════════════════════════════════════════════

Bäume: jeder Kreis oder Kreuz-Symbol mit Durchmesser > 2m
Sträucher: kleinere Kreise, oft in Gruppen
Wege: befestigte Linienelemente ausserhalb des Gebäudes
Terrassen: schraffierte Flächen direkt am Gebäude, oft mit Geländer markiert

═══════════════════════════════════════════════════════════════════════════════
REGELN:
═══════════════════════════════════════════════════════════════════════════════

1. RECHNE AKTIV — du bist Ingenieur, nicht Scanner. Wenn Masse nicht direkt dastehen, leite sie aus Proportionen ab.
2. SIA-Standardmasse sind erlaubte Annahmen, wenn proportional nichts ermittelbar. Dokumentiere in "bemerkungen".
3. null ist nur bei komplett fehlendem Element erlaubt, NICHT bei fehlender Bemassung.
4. Wenn ein Raum sichtbar ist → mindestens Bodenfläche.
5. Wenn ein Fenster sichtbar ist → mindestens B × H.
6. Wenn UG/TG sichtbar ist → Aushubmengen berechnen.
7. Fassadenflächen aus Geometrie berechnen.
8. Lagerpläne: Bäume, Sträucher, Wege ZÄHLEN/MESSEN.

Deine Antwort muss alle Felder des Schemas MAXIMAL befüllt zurückgeben. Leere Arrays und null-Werte nur, wenn das Element real nicht im Plan ist.`;


  const contentParts = [
    isPDF
      ? { type: 'file',  data: file.base64, mediaType: 'application/pdf', filename: file.name || 'plan.pdf' }
      : { type: 'image', image: file.base64, mediaType: file.mediaType },
    {
      type: 'text',
      text: `Analysiere diesen Bauplan (${file.name || 'Plan'}) vollständig.

WICHTIG: Du bist Ingenieur — nicht Scanner.
1. Lies zuerst ALLE sichtbaren Bemassungen und den Massstab ab (Kalibrierung).
2. Berechne dann aktiv fehlende Masse proportional aus den Referenzmassen.
3. Nutze bei Bedarf SIA-Standardmasse für typische Elemente (Fenster, Türen, Raumhöhen).
4. Berechne Fassadenflächen, Aushub, Raumflächen aus der Geometrie.

Zähle jedes einzelne Fenster im Plan. Jedes Zimmer hat Fenster — finde sie alle.
Wenn eine Tiefgarage erkennbar ist, berechne Aushub_Humus_m3 und Aushub_Erde_m3.

null ist nur erlaubt wenn das Element real nicht im Plan ist — NICHT bei fehlender Bemassung.
Dokumentiere Annahmen in "bemerkungen".`,
    },
  ];

  try {
    const { object } = await generateObject({
      model: 'anthropic/claude-sonnet-4-5',
      schema: BauplanSchema,
      schemaName: 'BauplanAnalyse',
      schemaDescription: 'Vollständige SIA-konforme Extraktion aller relevanten Daten aus Schweizer Bauplänen',
      system: systemPrompt,
      messages: [{ role: 'user', content: contentParts }],
      maxTokens: 12000,
      temperature: 0.3,
    });

    return res.status(200).json({ result: object });

  } catch (err) {
    console.error('analyze-plan error:', err);
    return res.status(200).json({ error: err.message || 'Analyse fehlgeschlagen' });
  }
}
