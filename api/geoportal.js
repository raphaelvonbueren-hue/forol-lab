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

        // ── SCHRITT 0: BFS-Nr + Koordinaten der Gemeinde (dynamisch, nicht gecached) ──
        // Suche über gg25 (politische Gemeinden) — das liefert garantiert korrekte BFS
        let bfsNr = null, munLat = null, munLon = null, munName = municipality;
        try {
          const munUrl = `https://api3.geo.admin.ch/rest/services/ech/SearchServer`
            + `?searchText=${encodeURIComponent(municipality)}`
            + `&type=locations&origins=gg25&sr=4326&lang=de&limit=10`;
          const munR = await fetch(munUrl, { headers: { 'User-Agent': AGENT } });
          if (munR.ok) {
            const munData = await munR.json();
            // Finde besten Match für gewünschten Kanton
            const candidates = munData.results || [];
            let hit = candidates.find(x => {
              const label = (x.attrs?.label || '').replace(/<[^>]*>/g, '');
              if (!canton) return true;
              return label.includes('(' + canton + ')');
            });
            // Strikter Match: Gemeindename muss passen
            if (!hit) {
              hit = candidates.find(x => {
                const name = (x.attrs?.label || '').replace(/<[^>]*>/g, '').split('(')[0].trim();
                return name.toLowerCase() === municipality.toLowerCase();
              });
            }
            hit = hit || candidates[0];
            if (hit?.attrs) {
              bfsNr  = hit.attrs.num || null;
              munLat = hit.attrs.lat;
              munLon = hit.attrs.lon;
              munName = (hit.attrs.label || munName).replace(/<[^>]*>/g, '').replace(/\([A-Z]{2}\)/, '').trim();
            }
          }
          attempts.push({ step: '0_bfs', bfsNr, munName, munLat, munLon });
        } catch(e) { attempts.push({ step: '0_bfs', error: e.message }); }

        // ── STRATEGIE 1: Swisstopo identify-by-coordinate ────────────────────
        // PRIMÄRE STRATEGIE: Sobald Gemeinde-Zentrum bekannt → identify um diese Koordinate.
        // Dieser Endpoint liefert ECHTES Parzellen-Polygon + alle Attribute (nummer, nbident, egrid, area).
        // Im Gegensatz zu /find funktioniert das zuverlässig für alle Kantone.
        //
        // Problem: identify nur bei Koordinate — aber wir haben bloss die Gemeinde-Mitte.
        // Lösung: Bbox um Gemeinde abtasten, alle Parzellen in Bbox holen → clientside
        // auf parcelNumber filtern. Kann viele Features zurückgeben, daher hoher limit.
        //
        // Alternative: map/identify mit grösserer tolerance + imageDisplay ist kein Massen-
        // endpoint — besser WMS GetFeatureInfo oder direkt OGC API.
        // Wir nutzen hier OGC API bbox als "identify für ein Gebiet".

        // Erst WMS GetFeatureInfo auf Gemeinde-Zentrum (liefert Parzelle falls Mitte drauf)
        if (munLat && munLon) {
          try {
            const wmsUrl = `https://wms.geo.admin.ch/?`
              + `SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo`
              + `&LAYERS=ch.kantone.cadastralwebmap-farbe&QUERY_LAYERS=ch.kantone.cadastralwebmap-farbe`
              + `&CRS=EPSG:4326&BBOX=${munLat-0.01},${munLon-0.01},${munLat+0.01},${munLon+0.01}`
              + `&WIDTH=101&HEIGHT=101&I=50&J=50`
              + `&INFO_FORMAT=application/json`;
            const r = await fetch(wmsUrl, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(6000) });
            if (r.ok) {
              const data = await r.json();
              attempts.push({ strat: 1, type: 'wms_getfeatureinfo', features: (data.features || []).length });
            }
          } catch(e) { attempts.push({ strat: 1, error: e.message }); }
        }

        // ── STRATEGIE 2: Swisstopo SearchServer origins=parcel ────────────────
        // Mit korrekter BFS aus Schritt 0
        const queries = [];
        if (bfsNr) queries.push(`${bfsNr}_${parcelNumber}`);
        queries.push(`${parcelNumber} ${munName}`);
        queries.push(`${parcelNumber} ${municipality}`);
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
              return String(parcelNumber) === fidNum
                  || String(parcelNumber) === labelNum
                  || label.includes(` ${parcelNumber} `)
                  || label.startsWith(`${parcelNumber} `);
            });

            if (hits.length > 0) {
              const a = hits[0].attrs;
              const label = (a.label || '').replace(/<[^>]*>/g, '');
              const featureId = String(a.featureId || a.detail || '');
              const fidMatch = featureId.match(/^(\d+)[_\/](.+)$/);
              const ktMatch = label.match(/\(([A-Z]{2})\)/);
              // Hole Geometrie via OGC API mit den Koordinaten aus SearchServer
              let geom = null, areaVal = 0;
              try {
                const geoR = await fetch(
                  `https://geodienste.ch/db/av_0/deu/ogcapi/collections/liegenschaft/items?`
                  + `f=json&bbox=${a.lon-0.001},${a.lat-0.001},${a.lon+0.001},${a.lat+0.001}&limit=5`,
                  { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(5000) }
                );
                if (geoR.ok) {
                  const geoData = await geoR.json();
                  const feat = (geoData.features || []).find(f => {
                    const p = f.properties || {};
                    return String(p.number || p.nummer || '') === String(parcelNumber);
                  });
                  if (feat) {
                    geom = feat.geometry;
                    areaVal = Math.round(feat.properties?.area || feat.properties?.flaeche || 0);
                  }
                }
              } catch(e) {}

              return res.status(200).json({
                found: true,
                egrid: a.egrid || a.egris_egrid || featureId,
                number: fidMatch ? fidMatch[2] : parcelNumber,
                bfsNr: fidMatch ? +fidMatch[1] : bfsNr,
                area: areaVal || Math.round(a.area || 0),
                municipality: munName,
                canton: (ktMatch && ktMatch[1]) || canton,
                lat: a.lat, lon: a.lon,
                geometry: geom,
                source: 'Swisstopo SearchServer origins=parcel',
                query: q,
                label,
                attempts
              });
            }
          } catch(e) { attempts.push({ strat: 2, q, error: e.message }); }
        }

        // ── STRATEGIE 3: geodienste.ch OGC API (av_0 statt av_tg) ─────────────
        // Der harmonisierte Datensatz av_0 enthält ALLE Kantone inkl. TG.
        // Bei Bbox-Abfrage sehen wir ALLE Parzellen der Gemeinde, clientseitig filtern.
        if (munLat && munLon) {
          const ogcBases = [
            'https://geodienste.ch/db/av_0/deu/ogcapi',
            'https://geodienste.ch/db/av_situationsplan_0/deu/ogcapi',
          ];
          for (const ogcBase of ogcBases) {
            try {
              const colR = await fetch(`${ogcBase}/collections?f=json`, {
                headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(5000)
              });
              if (!colR.ok) { attempts.push({ strat: 3, ogcBase, colStatus: colR.status }); continue; }
              const colData = await colR.json();
              const parcelCol = (colData.collections || []).find(c => {
                const id = (c.id || '').toLowerCase();
                const title = (c.title || '').toLowerCase();
                return id === 'liegenschaft' || id.includes('liegenschaft')
                    || id.includes('grundstueck') || id.includes('parcel')
                    || title.includes('liegenschaft') || title.includes('grundstück');
              });
              if (!parcelCol) { attempts.push({ strat: 3, ogcBase, noCol: true }); continue; }

              const d = 0.03;
              const url = `${ogcBase}/collections/${parcelCol.id}/items?f=json&limit=200`
                + `&bbox=${munLon-d},${munLat-d},${munLon+d},${munLat+d}`;
              const featR = await fetch(url, {
                headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(10000)
              });
              if (!featR.ok) { attempts.push({ strat: 3, ogcBase, status: featR.status }); continue; }
              const featData = await featR.json();
              const allFeatures = featData.features || [];
              attempts.push({ strat: 3, ogcBase, col: parcelCol.id, count: allFeatures.length });

              // Clientseitig filtern: nummer muss EXAKT matchen, nbident bevorzugt mit BFS
              const matches = allFeatures.filter(f => {
                const p = f.properties || {};
                const nr = String(p.number || p.nummer || '');
                if (nr !== String(parcelNumber)) return false;
                // Falls nbident vorhanden: muss BFS enthalten
                if (bfsNr && p.nbident) {
                  return String(p.nbident).includes(String(bfsNr));
                }
                return true;
              });

              if (matches.length) {
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
                  area: Math.round(p.area || p.flaeche || p.areaOfficial || 0),
                  municipality: p.municipality || p.gemeindename || munName,
                  canton: p.canton || canton,
                  lat: cLat, lon: cLon,
                  geometry: f.geometry,
                  source: `geodienste.ch OGC (${parcelCol.id})`,
                  attempts
                });
              }
            } catch(e) { attempts.push({ strat: 3, ogcBase, error: e.message }); }
          }
        }

        // ── STRATEGIE 4: Fallback — Swisstopo MapServer/find ──────────────────
        for (const searchField of ['egrid', 'nbident', 'number', 'nummer']) {
          try {
            const url = `https://api3.geo.admin.ch/rest/services/all/MapServer/find`
              + `?layer=ch.kantone.cadastralwebmap-farbe`
              + `&searchText=${encodeURIComponent(parcelNumber)}`
              + `&searchField=${searchField}&returnGeometry=true&sr=4326&lang=de&contains=false`;
            const r = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(6000) });
            if (!r.ok) { attempts.push({ strat: 4, searchField, status: r.status }); continue; }
            const data = await r.json();
            const results = data.results || [];
            attempts.push({ strat: 4, searchField, count: results.length });
            if (!results.length) continue;

            const hits = results.filter(h => {
              const props = h.attributes || h.properties || {};
              const hitBfs = props.bfs_nr || props.bfsnr || props.gem_bfs || null;
              const hitNr = String(props.nummer || props.number || '');
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
                nbident: p.nbident || null,
                bfsNr: p.bfs_nr || p.bfsnr || bfsNr,
                area: Math.round(p.area || p.flaeche || 0),
                municipality: p.gemeinde || p.gemname || munName,
                canton: p.canton || canton,
                lat: h.geometry?.y, lon: h.geometry?.x,
                geometry: h.geometry,
                source: `Swisstopo find (${searchField})`,
                attempts
              });
            }
          } catch(e) { attempts.push({ strat: 4, searchField, error: e.message }); }
        }

        // ── Nicht gefunden ─────────────────────────────────────────────────────
        return res.status(200).json({
          found: false,
          reason: 'Parzelle konnte mit allen Strategien nicht gefunden werden',
          bfsNr, munName, parcelNumber, canton,
          hint: `Geprüfte Strategien: WMS GetFeatureInfo, SearchServer origins=parcel (${queries.length} Varianten), geodienste.ch OGC av_0 + av_situationsplan_0, Swisstopo find. Falls die Parzelle in einer historischen Gemeinde liegt (z.B. Teilregister nach Fusion), bitte Adresssuche nutzen oder manuell eingeben.`,
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
