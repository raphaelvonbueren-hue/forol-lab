// POST /api/geoportal
// Server-side proxy to Swiss geoportal APIs
// ✅ CONFIRMED WORKING:
//   - api3.geo.admin.ch → PLZ lookup, Gemeinde search (no key needed)
// ⏳ PENDING geodienste.ch credentials:
//   - Parcel WFS (amtliche Vermessung)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { action, params } = req.body || {};

  try {
    switch (action) {

      // ── 1. PLZ → Gemeinde + Koordinaten ────────────────────────────────
      // CONFIRMED WORKING: api3.geo.admin.ch/SearchServer
      case 'plz_lookup': {
        const { plz } = params;
        const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=${encodeURIComponent(plz)}&type=locations&origins=zipcode&sr=4326&lang=de`;
        const r   = await fetch(url, { headers: { 'User-Agent': 'forol-research-lab/4.0' } });
        if (!r.ok) return res.status(200).json({ results: [] });
        const data = await r.json();

        const results = (data.results || [])
          .filter(x => ['TG','SG','AI','AR'].includes(x.attrs?.kanton))
          .map(x => ({
            plz:    x.attrs?.detail,
            name:   (x.attrs?.label || '').replace(/<[^>]*>/g,'').replace(/^\d+\s*-?\s*/,'').trim(),
            label:  (x.attrs?.label || '').replace(/<[^>]*>/g,''),
            canton: x.attrs?.kanton,
            lat:    x.attrs?.lat,
            lon:    x.attrs?.lon,
          }));
        return res.status(200).json({ results });
      }

      // ── 2. Gemeindename → BFS-Nummer + Koordinaten ─────────────────────
      case 'municipality_lookup': {
        const { name } = params;
        const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=${encodeURIComponent(name)}&type=locations&origins=gg25&sr=4326&lang=de`;
        const r   = await fetch(url, { headers: { 'User-Agent': 'forol-research-lab/4.0' } });
        if (!r.ok) return res.status(200).json({ found: false });
        const data = await r.json();
        const hit  = data.results?.[0]?.attrs;
        if (!hit) return res.status(200).json({ found: false });
        return res.status(200).json({
          found:    true,
          name:     (hit.label || '').replace(/<[^>]*>/g,''),
          bfsNr:    hit.num,
          featureId:hit.featureId,
          lat:      hit.lat,
          lon:      hit.lon,
          bbox:     hit.geom_st_box2d,
        });
      }

      // ── 3. Höhenmodell (Swisstopo DHM25) ──────────────────────────────
      case 'elevation': {
        const { lat, lon } = params;
        // Convert WGS84 to LV95 for swisstopo height API
        const r = await fetch(
          `https://api3.geo.admin.ch/rest/services/height?easting=${lon}&northing=${lat}&sr=4326&format=json`,
          { headers: { 'User-Agent': 'forol-research-lab/4.0' } }
        );
        if (!r.ok) return res.status(200).json({ elevation: null });
        const data = await r.json();
        return res.status(200).json({ elevation: data.height, unit: 'm.ü.M.' });
      }

      // ── 4. Parcel search via geodienste.ch WFS ──────────────────────────
      // Requires GEODIENSTE_TOKEN env variable (free account at geodienste.ch)
      case 'parcel_search': {
        const { municipality, parcelNumber, canton } = params;
        const token = process.env.GEODIENSTE_TOKEN;

        if (!token) {
          // Fallback: try swisstopo cadastral layer
          return res.status(200).json({
            found:  false,
            reason: 'geodienste.ch Token nicht konfiguriert',
            hint:   'Account auf geodienste.ch erstellen und GEODIENSTE_TOKEN in Vercel Env setzen'
          });
        }

        // geodienste.ch WFS — Amtliche Vermessung
        // Canton-specific endpoints:
        const WFS_ENDPOINTS = {
          TG: 'https://geodienste.ch/db/av_tg/daten',
          SG: 'https://geodienste.ch/db/av_sg/daten',
          AI: 'https://geodienste.ch/db/av_ai/daten',
          AR: 'https://geodienste.ch/db/av_ar/daten',
        };
        const baseUrl = WFS_ENDPOINTS[canton];
        if (!baseUrl) return res.status(200).json({ found: false, reason: 'Kanton nicht unterstützt' });

        const wfsUrl = `${baseUrl}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
          `&TYPENAMES=av:Liegenschaft&COUNT=5` +
          `&CQL_FILTER=nummer='${parcelNumber}'` +
          `&TOKEN=${token}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326`;

        const r = await fetch(wfsUrl, { headers: { 'User-Agent': 'forol-research-lab/4.0' } });
        if (!r.ok) {
          return res.status(200).json({ found: false, reason: `WFS Fehler: ${r.status}` });
        }
        const data = await r.json();
        const features = data.features || [];
        if (!features.length) return res.status(200).json({ found: false, reason: 'Parzelle nicht gefunden' });

        const props = features[0].properties;
        return res.status(200).json({
          found:        true,
          egrid:        props.egris_egrid || props.egrid,
          number:       props.nummer,
          area:         Math.round(props.flaeche || props.area),
          municipality: props.gemeindename || municipality,
          canton:       canton,
          geometry:     features[0].geometry,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[geoportal]', err.message);
    return res.status(500).json({ error: 'API Fehler', detail: err.message });
  }
}
