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

        // Schritt 1: BFS-Nummer der Gemeinde via gg25
        let bfsNr = null, munLat = null, munLon = null, munName = municipality;
        try {
          const munUrl = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
            + `?searchText=${encodeURIComponent(municipality + ' ' + canton)}`
            + `&type=locations&origins=gg25&sr=4326&lang=de&limit=3`;
          const munR = await fetch(munUrl, { headers: { 'User-Agent': AGENT } });
          if (munR.ok) {
            const munData = await munR.json();
            // Finde besten match für Kanton
            const hit = (munData.results || []).find(x => {
              const label = (x.attrs?.label || '').replace(/<[^>]*>/g, '');
              return !canton || label.includes('(' + canton + ')');
            }) || munData.results?.[0];
            if (hit?.attrs) {
              bfsNr  = hit.attrs.num || null;
              munLat = hit.attrs.lat;
              munLon = hit.attrs.lon;
              munName = (hit.attrs.label || munName).replace(/<[^>]*>/g, '').replace(/\([A-Z]{2}\)/, '').trim();
            }
          }
        } catch(e) {}

        // Schritt 2: Parzelle suchen — mehrere Query-Formate probieren
        const queries = [];
        if (bfsNr) queries.push(`${bfsNr}_${parcelNumber}`);       // featureId-Format (bester Match)
        queries.push(`${parcelNumber} ${municipality}`);           // Freitext num + gem
        queries.push(`${parcelNumber} ${munName}`);                // Freitext num + official name
        queries.push(parcelNumber);                                // Nur Nummer (breitest)

        for (const q of queries) {
          try {
            const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
              + `?searchText=${encodeURIComponent(q)}`
              + `&type=locations&origins=parcel&sr=4326&lang=de&limit=20`;
            const r = await fetch(url, {
              headers: { 'User-Agent': AGENT },
              signal: AbortSignal.timeout(8000)
            });
            if (!r.ok) continue;
            const data = await r.json();
            const results = data.results || [];
            if (!results.length) continue;

            // Filter:
            // 1. Kanton muss passen (Label enthält "(TG)")
            // 2. Wenn BFS bekannt: featureId muss mit "BFS_" beginnen
            // 3. Nummer muss exakt passen (parcelNumber)
            const hits = results.filter(h => {
              const a = h.attrs || {};
              const label = (a.label || '').replace(/<[^>]*>/g, '');
              const featureId = a.featureId || a.detail || '';

              // Kanton check
              if (canton) {
                const ktMatch = label.match(/\(([A-Z]{2})\)/);
                if (ktMatch && ktMatch[1] !== canton) return false;
              }

              // BFS check (stärkster Filter)
              if (bfsNr) {
                const fidMatch = String(featureId).match(/^(\d+)[_\/](.+)$/);
                if (fidMatch && +fidMatch[1] !== +bfsNr) return false;
              }

              // Nummer check: Label oder featureId enthält parcelNumber
              const labelNum = label.match(/^([\d\w]+)/)?.[1] || '';
              const fidNum = String(featureId).split(/[_\/]/).pop();
              if (String(parcelNumber).trim() !== labelNum && String(parcelNumber).trim() !== fidNum) {
                // Weniger strikt: nur enthalten
                if (!label.includes(parcelNumber) && !String(featureId).includes(parcelNumber)) return false;
              }

              return true;
            });

            if (hits.length > 0) {
              const a = hits[0].attrs;
              const label = (a.label || '').replace(/<[^>]*>/g, '');
              const featureId = a.featureId || a.detail || '';
              const fidMatch = String(featureId).match(/^(\d+)[_\/](.+)$/);
              const ktMatch = label.match(/\(([A-Z]{2})\)/);
              return res.status(200).json({
                found:        true,
                egrid:        a.egrid || a.egris_egrid || featureId,
                number:       fidMatch ? fidMatch[2] : parcelNumber,
                bfsNr:        fidMatch ? +fidMatch[1] : bfsNr,
                area:         Math.round(a.area || 0),
                municipality: munName,
                canton:       (ktMatch && ktMatch[1]) || canton,
                lat:          a.lat,
                lon:          a.lon,
                source:       'Swisstopo origins=parcel',
                query:        q,
                label,
                allResults:   hits.length
              });
            }
          } catch(e) { /* try next query */ }
        }

        // Fallback: geodienste.ch OGC API
        for (const ogcBase of [
          'https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi',
          'https://geodienste.ch/db/av_0/deu/ogcapi',
        ]) {
          try {
            const colR = await fetch(`${ogcBase}/collections?f=json`, {
              headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(6000)
            });
            if (!colR.ok) continue;
            const colData = await colR.json();
            const parcelCol = (colData.collections || []).find(c => {
              const id = (c.id || '').toLowerCase();
              const title = (c.title || '').toLowerCase();
              return id.includes('parcel') || id.includes('liegenschaft') || id.includes('lig')
                  || title.includes('liegenschaft') || title.includes('parzell') || title.includes('grundstück');
            });
            if (!parcelCol) continue;
            let url = `${ogcBase}/collections/${parcelCol.id}/items?f=json&limit=10`;
            if (munLat && munLon) {
              const d = 0.03;
              url += `&bbox=${munLon-d},${munLat-d},${munLon+d},${munLat+d}`;
            }
            const featR = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000) });
            if (!featR.ok) continue;
            const featData = await featR.json();
            const features = (featData.features || []).filter(f => {
              const props = f.properties || {};
              return String(props.number || props.nummer || props.nbident || '').includes(parcelNumber);
            });
            if (features.length) {
              const f = features[0];
              const p = f.properties || {};
              return res.status(200).json({
                found:        true,
                egrid:        p.egrid || p.egris_egrid || f.id,
                number:       p.number || p.nummer || parcelNumber,
                area:         Math.round(p.area || p.flaeche || 0),
                municipality: p.municipality || p.gemeindename || munName,
                canton:       p.canton || canton,
                source:       `geodienste.ch OGC (${parcelCol.id})`,
              });
            }
          } catch(e) {}
        }

        return res.status(200).json({
          found:   false,
          reason:  'Parzelle nicht gefunden',
          bfsNr, munName, parcelNumber, canton,
          hint:    'Swisstopo origins=parcel hat für diese Nummer keine Treffer. Mögliche Ursachen: Nummer falsch, Gemeinde-Split-Register, oder Parzelle im Kanton nicht publiziert.',
          triedQueries: queries
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
