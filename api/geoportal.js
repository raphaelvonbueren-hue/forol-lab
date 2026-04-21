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

        // ── A) Swisstopo SearchServer origins=parcel ───────────────────────
        // Format: "PARZELLENNUMMER MUNICIPALITY" oder nur Nummer.
        // Funktioniert für alle 26 Kantone inkl. TG/SG/AI/AR.
        const queries = [
          `${parcelNumber} ${municipality}`,
          `${municipality} ${parcelNumber}`,
          parcelNumber,
        ];

        for (const q of queries) {
          try {
            const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
              + `?searchText=${encodeURIComponent(q)}&type=locations&origins=parcel&sr=4326&lang=de&limit=10`;
            const r = await fetch(url, {
              headers: { 'User-Agent': AGENT },
              signal: AbortSignal.timeout(8000)
            });
            if (!r.ok) continue;
            const data = await r.json();
            const results = data.results || [];
            if (!results.length) continue;

            // Filter auf gewünschten Kanton und Gemeinde (Label enthält "(TG)" etc.)
            const hits = results.filter(h => {
              const label = (h.attrs?.label || '').replace(/<[^>]*>/g, '');
              const ktMatch = label.match(/\(([A-Z]{2})\)/);
              const hitCanton = ktMatch ? ktMatch[1] : null;
              const hitMunicipality = label.replace(/\([A-Z]{2}\)/, '').trim();
              // Match canton if given, and municipality loosely
              const cantonOk = !canton || hitCanton === canton;
              const munOk = !municipality ||
                hitMunicipality.toLowerCase().includes(municipality.toLowerCase()) ||
                municipality.toLowerCase().includes(hitMunicipality.split(',')[0].toLowerCase().trim());
              return cantonOk && munOk;
            });

            if (hits.length > 0) {
              const hit = hits[0].attrs;
              const label = (hit.label || '').replace(/<[^>]*>/g, '');
              // featureId format: "BFSNR_NUMMER"
              const featureId = hit.featureId || hit.detail || '';
              const bfsMatch = featureId.match(/^(\d+)_(.+)$/);
              return res.status(200).json({
                found:        true,
                egrid:        hit.egrid || hit.egris_egrid || featureId,
                number:       bfsMatch ? bfsMatch[2] : parcelNumber,
                bfsNr:        bfsMatch ? +bfsMatch[1] : null,
                area:         Math.round(hit.area || 0),
                municipality: label.split(',')[1]?.replace(/\([A-Z]{2}\)/,'').trim() || municipality,
                canton:       (label.match(/\(([A-Z]{2})\)/) || [])[1] || canton,
                lat:          hit.lat,
                lon:          hit.lon,
                source:       'Swisstopo SearchServer (origins=parcel)',
                label,
              });
            }
          } catch(e) { /* try next query */ }
        }

        // ── B) Fallback: geodienste.ch OGC API ─────────────────────────────
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

        const ogcBases = [
          'https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi',
          'https://geodienste.ch/db/av_0/deu/ogcapi',
        ];

        for (const ogcBase of ogcBases) {
          try {
            const colR = await fetch(`${ogcBase}/collections?f=json`, {
              headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(8000)
            });
            if (!colR.ok) continue;
            const colData = await colR.json();
            const collections = colData.collections || [];
            const parcelCol = collections.find(c => {
              const id = (c.id || '').toLowerCase();
              const title = (c.title || '').toLowerCase();
              return id.includes('parcel') || id.includes('liegenschaft') || id.includes('lig')
                  || title.includes('liegenschaft') || title.includes('parzell') || title.includes('grundstück');
            });
            if (!parcelCol) continue;

            let url = `${ogcBase}/collections/${parcelCol.id}/items?f=json&limit=10`;
            if (lat && lon) {
              const d = 0.05;
              url += `&bbox=${lon-d},${lat-d},${lon+d},${lat+d}`;
            }

            const featR = await fetch(url, {
              headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000)
            });
            if (!featR.ok) continue;
            const featData = await featR.json();

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

        return res.status(200).json({
          found:        false,
          reason:       'Parzelle nicht gefunden',
          municipality, parcelNumber, canton,
          hint:         'Die Parzellennummer konnte weder via Swisstopo noch via geodienste.ch gefunden werden. Bitte Adresssuche nutzen oder Daten manuell eingeben.'
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
