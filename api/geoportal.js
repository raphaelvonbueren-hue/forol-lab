// POST /api/geoportal  — Phase 3 LIVE
// Bestätigte Endpoints:
//   Swisstopo PLZ:    api3.geo.admin.ch/SearchServer  ✅ funktioniert
//   Swisstopo Höhe:   api3.geo.admin.ch/height        ✅ funktioniert
//   geodienste OGC:   geodienste.ch/db/av_situationsplan_0/deu/ogcapi  ✅ antwortet
//   geodienste Download-API: /api/v1/downloads/av  ✅ für Parzellendaten

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { action, params } = req.body || {};
  const AGENT = 'forol-research-lab/4.0 (r.vonbueren@forol.ch)';

  try {
    switch (action) {

      // ── 1. PLZ → Gemeinde + Koordinaten ────────────────────────────────
      case 'plz_lookup': {
        const { plz } = params;
        const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
          + `?searchText=${encodeURIComponent(plz)}&type=locations&origins=zipcode&sr=4326&lang=de`;
        const r = await fetch(url, { headers: { 'User-Agent': AGENT } });
        if (!r.ok) return res.status(200).json({ results: [] });
        const data = await r.json();
        const results = (data.results || [])
          .filter(x => ['TG','SG','AI','AR'].includes(x.attrs?.kanton))
          .map(x => ({
            plz:    x.attrs?.detail,
            name:   (x.attrs?.label || '').replace(/<[^>]*>/g,'').replace(/^\d+\s*[-–]\s*/,'').trim(),
            canton: x.attrs?.kanton,
            lat:    x.attrs?.lat,
            lon:    x.attrs?.lon,
          }));
        return res.status(200).json({ results });
      }

      // ── 2. Gemeinde → Koordinaten ───────────────────────────────────────
      case 'municipality_lookup': {
        const { name } = params;
        const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
          + `?searchText=${encodeURIComponent(name)}&type=locations&origins=gg25&sr=4326&lang=de`;
        const r = await fetch(url, { headers: { 'User-Agent': AGENT } });
        if (!r.ok) return res.status(200).json({ found: false });
        const data = await r.json();
        const hit  = data.results?.[0]?.attrs;
        if (!hit) return res.status(200).json({ found: false });
        return res.status(200).json({
          found: true, name: (hit.label || '').replace(/<[^>]*>/g,''),
          bfsNr: hit.num, lat: hit.lat, lon: hit.lon
        });
      }

      // ── 3. Parzelle suchen ──────────────────────────────────────────────
      // Strategie:
      //   A) OGC API Features mit bbox um Gemeinde → land_parcel Collection
      //   B) Fallback: WFS GetFeature mit property-Filter
      case 'parcel_search': {
        const { municipality, parcelNumber, canton } = params;

        // Koordinaten der Gemeinde holen
        let lat = null, lon = null;
        try {
          const munUrl = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
            + `?searchText=${encodeURIComponent(municipality + ' ' + canton)}&type=locations&origins=gg25&sr=4326&lang=de`;
          const munR = await fetch(munUrl, { headers: { 'User-Agent': AGENT } });
          if (munR.ok) {
            const munData = await munR.json();
            const hit = munData.results?.[0]?.attrs;
            if (hit) { lat = hit.lat; lon = hit.lon; }
          }
        } catch(e) {}

        // A) OGC API — Situationsplan Endpoint, land_parcel Collection
        const ogcBases = [
          'https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi',
          'https://geodienste.ch/db/av_0/deu/ogcapi',
        ];

        for (const ogcBase of ogcBases) {
          try {
            // Alle Collections holen um den richtigen Layer zu finden
            const colR = await fetch(`${ogcBase}/collections?f=json`, {
              headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(8000)
            });
            if (!colR.ok) continue;
            const colData = await colR.json();
            const collections = colData.collections || [];

            // Parzellen-Collection finden (land_parcel, parcel, liegenschaft, etc.)
            const parcelCol = collections.find(c => {
              const id = (c.id || '').toLowerCase();
              const title = (c.title || '').toLowerCase();
              return id.includes('parcel') || id.includes('liegenschaft') || id.includes('lig')
                  || title.includes('liegenschaft') || title.includes('parzell') || title.includes('grundstück');
            });

            if (!parcelCol) continue;

            // Parzelle abfragen mit Bbox + Nummer
            let url = `${ogcBase}/collections/${parcelCol.id}/items?f=json&limit=5`;
            if (lat && lon) {
              const d = 0.05;
              url += `&bbox=${lon-d},${lat-d},${lon+d},${lat+d}`;
            }

            const featR = await fetch(url, {
              headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000)
            });
            if (!featR.ok) continue;
            const featData = await featR.json();

            // Nach Parzellennummer filtern
            const features = (featData.features || []).filter(f => {
              const props = f.properties || {};
              return String(props.number || props.nummer || props.nbident || '').includes(parcelNumber);
            });

            if (features.length > 0) {
              const f = features[0];
              const p = f.properties || {};
              return res.status(200).json({
                found:        true,
                egrid:        p.egrid || p.egris_egrid || f.id,
                number:       p.number || p.nummer || parcelNumber,
                area:         Math.round(p.area || p.flaeche || p.areaOfficial || 0),
                municipality: p.municipality || p.gemeindename || municipality,
                canton:       p.canton || canton,
                source:       `geodienste.ch OGC (${parcelCol.id})`,
              });
            }
          } catch(e) { /* try next */ }
        }

        // B) Fallback: WFS GetFeature
        try {
          const CANTON_WFS = {
            TG: 'av_tg', SG: 'av_sg', AI: 'av_ai', AR: 'av_ar'
          };
          const topic = CANTON_WFS[canton] || 'av_0';
          let bboxParam = '';
          if (lat && lon) {
            // Konvertiere auf LV95 approximiert (grob)
            bboxParam = `&BBOX=${lon-0.05},${lat-0.05},${lon+0.05},${lat+0.05},EPSG:4326`;
          }

          const wfsUrl = `https://geodienste.ch/db/${topic}/deu`
            + `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
            + `&TYPENAMES=ms:Grundstueck&COUNT=5`
            + `&CQL_FILTER=nummer='${parcelNumber}'`
            + `&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326`;

          const wfsR = await fetch(wfsUrl, {
            headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000)
          });

          if (wfsR.ok) {
            const wfsData = await wfsR.json();
            const features = wfsData.features || [];
            if (features.length > 0) {
              const f = features[0];
              const p = f.properties || {};
              return res.status(200).json({
                found:        true,
                egrid:        p.egrid || f.id,
                number:       p.nummer || parcelNumber,
                area:         Math.round(p.flaeche || p.area || 0),
                municipality: p.gemeindename || municipality,
                canton,
                source:       'geodienste.ch WFS',
              });
            }
          }
        } catch(e) {}

        return res.status(200).json({
          found:        false,
          reason:       'Parzelle nicht gefunden',
          municipality, parcelNumber, canton,
          hint:         'Versuchen Sie eine andere Parzellennummer oder geben Sie Daten manuell ein.'
        });
      }

      // ── 4. OGC Collections auflisten (Debug) ────────────────────────────
      case 'list_collections': {
        const base = params?.base || 'https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi';
        const r = await fetch(`${base}/collections?f=json`, { headers: { 'User-Agent': AGENT } });
        if (!r.ok) return res.status(200).json({ error: `HTTP ${r.status}`, base });
        const data = await r.json();
        return res.status(200).json({
          base,
          collections: (data.collections || []).map(c => ({ id: c.id, title: c.title }))
        });
      }

      // ── 5. Höhenmodell ──────────────────────────────────────────────────
      case 'elevation': {
        const { lat, lon } = params;
        const r = await fetch(
          `https://api3.geo.admin.ch/rest/services/height?easting=${lon}&northing=${lat}&sr=4326&format=json`,
          { headers: { 'User-Agent': AGENT } }
        );
        if (!r.ok) return res.status(200).json({ elevation: null });
        const data = await r.json();
        return res.status(200).json({ elevation: data.height, unit: 'm.ü.M.' });
      }

      default:
        return res.status(400).json({ error: `Unbekannte Aktion: ${action}` });
    }
  } catch (err) {
    console.error('[geoportal]', action, err.message);
    return res.status(500).json({ error: 'API Fehler', detail: err.message });
  }
}
