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
        const attempts = [];

        // ══════════════════════════════════════════════════════════════════
        // SCHRITT 0: Gemeinde → BFS + Koordinaten via gg25
        // Dynamisch, robust, disambiguiert Gossau SG vs Gossau ZH etc.
        // ══════════════════════════════════════════════════════════════════
        let bfsNr = null, munLat = null, munLon = null, munName = municipality;
        try {
          const munQuery = canton ? `${municipality} ${canton}` : municipality;
          const munUrl = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
            + `?searchText=${encodeURIComponent(munQuery)}`
            + `&type=locations&origins=gg25&sr=4326&lang=de&limit=15`;
          const munR = await fetch(munUrl, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(6000) });
          if (munR.ok) {
            const munData = await munR.json();
            const candidates = munData.results || [];

            // 1. Strikter Match: Name + Kanton im Label
            let hit = candidates.find(x => {
              const label = (x.attrs?.label || '').replace(/<[^>]*>/g, '');
              const nameOnly = label.split('(')[0].trim().toLowerCase();
              const labelHasCanton = canton ? label.includes('(' + canton + ')') : true;
              return nameOnly === municipality.toLowerCase() && labelHasCanton;
            });
            // 2. Lockerer: Name beginnt mit gesuchter Gemeinde + Kanton passt
            if (!hit) {
              hit = candidates.find(x => {
                const label = (x.attrs?.label || '').replace(/<[^>]*>/g, '');
                const nameOnly = label.split('(')[0].trim().toLowerCase();
                const labelHasCanton = canton ? label.includes('(' + canton + ')') : true;
                return nameOnly.startsWith(municipality.toLowerCase()) && labelHasCanton;
              });
            }
            // 3. Notfall: nur Kantons-Match
            if (!hit && canton) {
              hit = candidates.find(x => (x.attrs?.label || '').includes('(' + canton + ')'));
            }
            hit = hit || candidates[0];

            if (hit?.attrs) {
              bfsNr  = hit.attrs.num || hit.attrs.featureId || null;
              munLat = hit.attrs.lat;
              munLon = hit.attrs.lon;
              munName = (hit.attrs.label || munName).replace(/<[^>]*>/g, '').replace(/\([A-Z]{2}\)/, '').trim();
            }
          }
          attempts.push({ step: '0_gemeinde_lookup', bfsNr, munName, munLat, munLon, ok: !!bfsNr });
        } catch(e) { attempts.push({ step: '0_gemeinde_lookup', error: e.message }); }

        if (!bfsNr || !munLat || !munLon) {
          return res.status(200).json({
            found: false,
            reason: `Gemeinde "${municipality}" (${canton || 'kein Kanton'}) konnte nicht aufgelöst werden`,
            attempts
          });
        }

        // ══════════════════════════════════════════════════════════════════
        // STRATEGIE 1: geodienste.ch OGC API — av_0 (harmonisiert alle CH)
        // PRIMÄRE STRATEGIE: Liefert Polygon-Geometrie direkt. Robust für TG+SG.
        // Bei fusionierten Gemeinden: clientseitig auf nbident mit BFS filtern.
        // ══════════════════════════════════════════════════════════════════
        // Bbox-Grösse anpassen je nach Gemeindegrösse (kleinere Gemeinden → kleineres Bbox)
        const bboxSizes = [0.015, 0.04, 0.08];  // ~1.5km / 4km / 8km Radius
        let ogcDone = false;

        for (const d of bboxSizes) {
          if (ogcDone) break;
          for (const ogcBase of [
            'https://geodienste.ch/db/av_0/deu/ogcapi',
            'https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi',
          ]) {
            try {
              // Auto-detect: welche Collection hat Parzellen
              const colR = await fetch(`${ogcBase}/collections?f=json`, {
                headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(5000)
              });
              if (!colR.ok) { attempts.push({ strat: 1, ogcBase, colStatus: colR.status }); continue; }
              const colData = await colR.json();
              const parcelCol = (colData.collections || []).find(c => {
                const id = (c.id || '').toLowerCase();
                return id === 'liegenschaft' || id === 'grundstueck' || id === 'parcel'
                    || id.includes('liegenschaft');
              });
              if (!parcelCol) { attempts.push({ strat: 1, ogcBase, noCol: true }); continue; }

              // Bbox-Query um Gemeindezentrum — limit hoch damit grosse Gemeinden abgedeckt
              const url = `${ogcBase}/collections/${parcelCol.id}/items?f=json&limit=500`
                + `&bbox=${munLon-d},${munLat-d},${munLon+d},${munLat+d}`;
              const featR = await fetch(url, {
                headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(12000)
              });
              if (!featR.ok) { attempts.push({ strat: 1, ogcBase, d, status: featR.status }); continue; }
              const featData = await featR.json();
              const allFeatures = featData.features || [];
              attempts.push({ strat: 1, ogcBase, col: parcelCol.id, d, total: allFeatures.length });

              // Filter: Nummer exakt matcht + (falls nbident vorhanden) BFS muss enthalten sein
              const matches = allFeatures.filter(f => {
                const p = f.properties || {};
                const nr = String(p.number || p.nummer || p.parcelNumber || '');
                if (nr !== String(parcelNumber)) return false;
                // Disambig für fusionierte Gemeinden:
                if (p.nbident) {
                  return String(p.nbident).includes(String(bfsNr));
                }
                if (p.bfs_nr || p.bfsnr || p.gemeinde_bfs_nr) {
                  const fnbfs = p.bfs_nr || p.bfsnr || p.gemeinde_bfs_nr;
                  return +fnbfs === +bfsNr;
                }
                return true;
              });

              ogcDone = allFeatures.length > 0;  // Ab hier wissen wir: Bbox hat Daten

              if (matches.length) {
                // Bei mehreren Treffern: nimm das flächenmässig grösste (ignoriert StWE)
                matches.sort((a, b) => {
                  const aA = +(a.properties?.area || a.properties?.flaeche || a.properties?.flaechenmass || 0);
                  const bA = +(b.properties?.area || b.properties?.flaeche || b.properties?.flaechenmass || 0);
                  return bA - aA;
                });
                const f = matches[0];
                const p = f.properties || {};
                // Zentrum aus Geometrie
                let cLat = munLat, cLon = munLon;
                try {
                  const coords = JSON.stringify(f.geometry?.coordinates || []).match(/-?\d+\.\d+/g);
                  if (coords && coords.length >= 2) {
                    const nums = coords.map(Number);
                    const lons = nums.filter((_,i) => i%2===0);
                    const lats = nums.filter((_,i) => i%2===1);
                    cLon = lons.reduce((a,b)=>a+b,0)/lons.length;
                    cLat = lats.reduce((a,b)=>a+b,0)/lats.length;
                  }
                } catch(e) {}
                return res.status(200).json({
                  found: true,
                  egrid: p.egrid || p.egris_egrid || p.egris_egrid_id || f.id,
                  number: p.number || p.nummer || parcelNumber,
                  nbident: p.nbident || null,
                  bfsNr,
                  area: Math.round(p.area || p.flaeche || p.flaechenmass || 0),
                  municipality: p.gemeinde || p.gemeinde_name || p.gemeindename || munName,
                  canton,
                  lat: cLat, lon: cLon,
                  geometry: f.geometry,
                  source: `geodienste.ch OGC av_0 (${parcelCol.id})`,
                  multipleHits: matches.length > 1 ? matches.length : undefined,
                  attempts
                });
              }
            } catch(e) { attempts.push({ strat: 1, ogcBase, d, error: e.message }); }
          }
        }

        // ══════════════════════════════════════════════════════════════════
        // STRATEGIE 2: Swisstopo SearchServer origins=parcel
        // Fallback: falls OGC-Bbox die Parzelle verfehlt (z.B. weit gestreckte Gemeinde)
        // ══════════════════════════════════════════════════════════════════
        const queries = [
          `${bfsNr}_${parcelNumber}`,
          `${parcelNumber} ${munName}`,
          `${parcelNumber} ${municipality}`,
        ];
        for (const q of queries) {
          try {
            const url = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
              + `?searchText=${encodeURIComponent(q)}`
              + `&type=locations&origins=parcel&sr=4326&lang=de&limit=20`;
            const r = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(6000) });
            if (!r.ok) { attempts.push({ strat: 2, q, status: r.status }); continue; }
            const data = await r.json();
            const results = data.results || [];
            attempts.push({ strat: 2, q, count: results.length });
            if (!results.length) continue;

            const hits = results.filter(h => {
              const a = h.attrs || {};
              const label = (a.label || '').replace(/<[^>]*>/g, '');
              const fid = String(a.featureId || a.detail || '');
              // Kanton muss passen
              if (canton) {
                const ktMatch = label.match(/\(([A-Z]{2})\)/);
                if (ktMatch && ktMatch[1] !== canton) return false;
              }
              // BFS muss passen
              const fidMatch = fid.match(/^(\d+)[_\/](.+)$/);
              if (fidMatch && +fidMatch[1] !== +bfsNr) return false;
              // Nummer muss passen
              if (fidMatch) return fidMatch[2] === String(parcelNumber);
              return label.includes(String(parcelNumber));
            });

            if (hits.length > 0) {
              const a = hits[0].attrs;
              const fid = String(a.featureId || a.detail || '');
              const fidMatch = fid.match(/^(\d+)[_\/](.+)$/);

              // Versuche Geometrie nachzuladen via OGC bbox an Punkt-Koordinaten
              let geom = null, areaVal = 0;
              try {
                const geoR = await fetch(
                  `https://geodienste.ch/db/av_0/deu/ogcapi/collections/liegenschaft/items?`
                  + `f=json&bbox=${a.lon-0.002},${a.lat-0.002},${a.lon+0.002},${a.lat+0.002}&limit=30`,
                  { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(5000) }
                );
                if (geoR.ok) {
                  const gd = await geoR.json();
                  const feat = (gd.features || []).find(f => {
                    const p = f.properties || {};
                    const nr = String(p.number || p.nummer || '');
                    if (nr !== String(parcelNumber)) return false;
                    if (p.nbident) return String(p.nbident).includes(String(bfsNr));
                    return true;
                  });
                  if (feat) {
                    geom = feat.geometry;
                    areaVal = Math.round(feat.properties?.area || feat.properties?.flaeche || 0);
                  }
                }
              } catch(e) {}

              return res.status(200).json({
                found: true,
                egrid: a.egrid || a.egris_egrid || fid,
                number: fidMatch ? fidMatch[2] : parcelNumber,
                bfsNr,
                area: areaVal,
                municipality: munName,
                canton,
                lat: a.lat, lon: a.lon,
                geometry: geom,
                source: 'Swisstopo SearchServer origins=parcel',
                query: q,
                attempts
              });
            }
          } catch(e) { attempts.push({ strat: 2, q, error: e.message }); }
        }

        // ══════════════════════════════════════════════════════════════════
        // Nicht gefunden
        // ══════════════════════════════════════════════════════════════════
        return res.status(200).json({
          found: false,
          reason: `Parzelle ${parcelNumber} in ${munName} (BFS ${bfsNr}) nicht gefunden`,
          bfsNr, munName, parcelNumber, canton,
          hint: `Mögliche Ursachen: (1) Nummer falsch, (2) Parzelle im historischen Teilregister (fusionierte Gemeinde), (3) Stockwerkeigentum/Baurecht hat keine eigene Geometrie. Bitte Adresssuche oder Klick auf Karte nutzen.`,
          attempts
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
