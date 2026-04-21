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

        // Schritt 0: BFS-Nummer + Koordinaten der Gemeinde
        let bfsNr = null, munLat = null, munLon = null, munName = municipality;
        try {
          const munUrl = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
            + `?searchText=${encodeURIComponent(municipality + ' ' + canton)}`
            + `&type=locations&origins=gg25&sr=4326&lang=de&limit=5`;
          const munR = await fetch(munUrl, { headers: { 'User-Agent': AGENT } });
          if (munR.ok) {
            const munData = await munR.json();
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
          attempts.push({ step: 'bfs_lookup', bfsNr, munLat, munLon });
        } catch(e) { attempts.push({ step: 'bfs_lookup', error: e.message }); }

        // ── STRATEGIE 1: Swisstopo MapServer find — amtliche Vermessung ─────
        // Am direktesten: Layer cadastralwebmap-farbe oder amtliche-vermessung
        for (const layer of ['ch.kantone.cadastralwebmap-farbe', 'ch.swisstopo-vd.amtliche-vermessung']) {
          try {
            const url = `https://api3.geo.admin.ch/rest/services/all/MapServer/find`
              + `?layer=${layer}&searchText=${encodeURIComponent(parcelNumber)}`
              + `&searchFields=nummer,number,parzellennummer&returnGeometry=true&sr=4326&lang=de&contains=false`;
            const r = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(8000) });
            if (!r.ok) { attempts.push({ strat: 1, layer, status: r.status }); continue; }
            const data = await r.json();
            const results = data.results || [];
            attempts.push({ strat: 1, layer, count: results.length });
            if (!results.length) continue;

            // Filter: BFS muss matchen, Nummer exakt
            const hits = results.filter(h => {
              const props = h.attributes || h.properties || {};
              const hitBfs = props.bfs_nr || props.bfsnr || props.gem_bfs || null;
              const hitNr = String(props.nummer || props.number || props.parzellennummer || '');
              if (bfsNr && hitBfs && +hitBfs !== +bfsNr) return false;
              return hitNr === String(parcelNumber);
            });
            if (hits.length > 0) {
              const h = hits[0];
              const p = h.attributes || h.properties || {};
              return res.status(200).json({
                found: true,
                egrid: p.egrid || p.egris_egrid || null,
                number: p.nummer || p.number || parcelNumber,
                bfsNr: p.bfs_nr || p.bfsnr || bfsNr,
                area: Math.round(p.area || p.flaeche || 0),
                municipality: p.gemeinde || p.gemname || munName,
                canton: p.canton || canton,
                lat: h.geometry?.y || (h.bbox && (h.bbox[1]+h.bbox[3])/2),
                lon: h.geometry?.x || (h.bbox && (h.bbox[0]+h.bbox[2])/2),
                geometry: h.geometry || null,
                source: `Swisstopo MapServer/find (${layer})`,
                attempts
              });
            }
          } catch(e) { attempts.push({ strat: 1, layer, error: e.message }); }
        }

        // ── STRATEGIE 2: Swisstopo SearchServer origins=parcel mit BFS ──────
        const queries = [];
        if (bfsNr) {
          queries.push(`${bfsNr}_${parcelNumber}`);
          queries.push(`${bfsNr} ${parcelNumber}`);
        }
        queries.push(`${parcelNumber} ${munName}`);
        queries.push(`${parcelNumber} ${municipality}`);
        queries.push(`${municipality} ${parcelNumber}`);
        queries.push(String(parcelNumber));

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
              const featureId = String(a.featureId || a.detail || '');

              if (canton) {
                const ktMatch = label.match(/\(([A-Z]{2})\)/);
                if (ktMatch && ktMatch[1] !== canton) return false;
              }

              if (bfsNr) {
                const fidMatch = featureId.match(/^(\d+)[_\/](.+)$/);
                if (fidMatch && +fidMatch[1] !== +bfsNr) return false;
              }

              const fidParts = featureId.split(/[_\/]/);
              const fidNum = fidParts[fidParts.length - 1];
              const labelNum = (label.match(/^([\d\w]+)/) || [])[1] || '';
              if (String(parcelNumber) !== fidNum && String(parcelNumber) !== labelNum
                  && !label.startsWith(String(parcelNumber))) {
                return false;
              }
              return true;
            });

            if (hits.length > 0) {
              const a = hits[0].attrs;
              const label = (a.label || '').replace(/<[^>]*>/g, '');
              const featureId = String(a.featureId || a.detail || '');
              const fidMatch = featureId.match(/^(\d+)[_\/](.+)$/);
              const ktMatch = label.match(/\(([A-Z]{2})\)/);
              return res.status(200).json({
                found: true,
                egrid: a.egrid || a.egris_egrid || featureId,
                number: fidMatch ? fidMatch[2] : parcelNumber,
                bfsNr: fidMatch ? +fidMatch[1] : bfsNr,
                area: Math.round(a.area || 0),
                municipality: munName,
                canton: (ktMatch && ktMatch[1]) || canton,
                lat: a.lat, lon: a.lon,
                source: 'Swisstopo SearchServer origins=parcel',
                query: q,
                label,
                attempts
              });
            }
          } catch(e) { attempts.push({ strat: 2, q, error: e.message }); }
        }

        // ── STRATEGIE 3: geodienste.ch WFS GetFeature per Kanton ────────────
        const CANTON_WFS = { TG: 'av_tg', SG: 'av_sg', AI: 'av_ai', AR: 'av_ar' };
        const topic = CANTON_WFS[canton];
        if (topic) {
          const wfsUrls = [
            // Mit BFS + Nummer (strikt)
            bfsNr ? `https://geodienste.ch/db/${topic}/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:Grundstueck&COUNT=5&CQL_FILTER=${encodeURIComponent(`nummer='${parcelNumber}' AND bfs_nr=${bfsNr}`)}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326` : null,
            // Nur Nummer
            `https://geodienste.ch/db/${topic}/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:Grundstueck&COUNT=10&CQL_FILTER=${encodeURIComponent(`nummer='${parcelNumber}'`)}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326`,
            // Nummer als Integer
            `https://geodienste.ch/db/${topic}/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:Grundstueck&COUNT=10&CQL_FILTER=${encodeURIComponent(`nummer=${parcelNumber}`)}&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326`,
          ].filter(Boolean);

          for (const wfsUrl of wfsUrls) {
            try {
              const wfsR = await fetch(wfsUrl, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(8000) });
              if (!wfsR.ok) { attempts.push({ strat: 3, topic, status: wfsR.status }); continue; }
              const wfsData = await wfsR.json();
              const features = wfsData.features || [];
              attempts.push({ strat: 3, topic, count: features.length });
              if (features.length) {
                const f = features[0];
                const p = f.properties || {};
                // Geometrie-Zentrum berechnen
                let cLat = null, cLon = null;
                if (f.geometry?.coordinates) {
                  const flat = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.\d+/g);
                  if (flat && flat.length >= 2) {
                    const nums = flat.map(Number);
                    cLon = nums.filter((_,i) => i%2===0).reduce((a,b)=>a+b,0)/nums.filter((_,i)=>i%2===0).length;
                    cLat = nums.filter((_,i) => i%2===1).reduce((a,b)=>a+b,0)/nums.filter((_,i)=>i%2===1).length;
                  }
                }
                return res.status(200).json({
                  found: true,
                  egrid: p.egrid || p.egris_egrid || f.id,
                  number: p.nummer || parcelNumber,
                  bfsNr: p.bfs_nr || p.bfsnr || bfsNr,
                  area: Math.round(p.flaeche || p.area || 0),
                  municipality: p.gemeindename || p.gemname || munName,
                  canton,
                  lat: cLat, lon: cLon,
                  geometry: f.geometry,
                  source: `geodienste.ch WFS (${topic})`,
                  attempts
                });
              }
            } catch(e) { attempts.push({ strat: 3, topic, error: e.message }); }
          }
        }

        // ── STRATEGIE 4: geodienste.ch OGC API mit Bbox ─────────────────────
        for (const ogcBase of [
          `https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi`,
          `https://geodienste.ch/db/av_0/deu/ogcapi`,
          topic ? `https://geodienste.ch/db/${topic}/deu/ogcapi` : null,
        ].filter(Boolean)) {
          try {
            const colR = await fetch(`${ogcBase}/collections?f=json`, {
              headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(5000)
            });
            if (!colR.ok) continue;
            const colData = await colR.json();
            const parcelCol = (colData.collections || []).find(c => {
              const id = (c.id || '').toLowerCase();
              const title = (c.title || '').toLowerCase();
              return id.includes('parcel') || id.includes('liegenschaft') || id.includes('grundstueck')
                  || title.includes('liegenschaft') || title.includes('parzell') || title.includes('grundstück');
            });
            if (!parcelCol) continue;

            let url = `${ogcBase}/collections/${parcelCol.id}/items?f=json&limit=50`;
            if (munLat && munLon) {
              const d = 0.04;
              url += `&bbox=${munLon-d},${munLat-d},${munLon+d},${munLat+d}`;
            }
            const featR = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(8000) });
            if (!featR.ok) continue;
            const featData = await featR.json();
            attempts.push({ strat: 4, ogcBase, col: parcelCol.id, count: (featData.features || []).length });

            const features = (featData.features || []).filter(f => {
              const props = f.properties || {};
              const nr = String(props.number || props.nummer || props.nbident || '');
              return nr === String(parcelNumber);
            });
            if (features.length) {
              const f = features[0];
              const p = f.properties || {};
              return res.status(200).json({
                found: true,
                egrid: p.egrid || p.egris_egrid || f.id,
                number: p.number || p.nummer || parcelNumber,
                area: Math.round(p.area || p.flaeche || 0),
                municipality: p.municipality || p.gemeindename || munName,
                canton: p.canton || canton,
                geometry: f.geometry,
                source: `geodienste.ch OGC (${parcelCol.id})`,
                attempts
              });
            }
          } catch(e) { attempts.push({ strat: 4, ogcBase, error: e.message }); }
        }

        // ── Nicht gefunden — Debug-Info mitgeben ────────────────────────────
        return res.status(200).json({
          found: false,
          reason: 'Parzelle konnte mit allen 4 Strategien nicht gefunden werden',
          bfsNr, munName, parcelNumber, canton,
          hint: `Mögliche Ursachen:
1. Parzellennummer falsch (bitte prüfen)
2. Gemeinde hat Split-Register (z.B. ehem. Gemeinden vor Fusion)
3. Kanton publiziert diese Daten nicht öffentlich
Versuchen Sie: Adresssuche oder Klick auf Karte.`,
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
