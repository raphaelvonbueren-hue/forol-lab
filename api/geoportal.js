// POST /api/geoportal
// Server-side proxy to Swiss geoportal APIs (avoids CORS from browser)
// APIs used:
//   - api3.geo.admin.ch  → Swisstopo (free, no key needed)
//   - geodienste.ch      → Kantone TG/SG/AI/AR (free, no key needed)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { action, params } = req.body || {};

  try {
    switch (action) {

      // ── 1. PLZ → Gemeinde + Kanton (Swisstopo) ─────────────────────────
      case 'plz_lookup': {
        const { plz } = params;
        const r = await fetch(
          `https://api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=${plz}&type=locations&origins=zipcode&sr=4326&lang=de`,
          { headers: { 'User-Agent': 'forol-research-lab/4.0' } }
        );
        const data = await r.json();
        const results = (data.results || []).map(x => ({
          plz:       x.attrs?.zz,
          name:      x.attrs?.label?.replace(/<[^>]*>/g,''),
          commune:   x.attrs?.gemeinde,
          canton:    x.attrs?.kanton,
          lat:       x.attrs?.lat,
          lon:       x.attrs?.lon,
        }));
        return res.status(200).json({ results });
      }

      // ── 2. Parzelle via EGRID suchen (Grundbuchnummer + Gemeinde) ───────
      case 'parcel_search': {
        const { municipality, parcelNumber, canton } = params;

        // Step 1: Gemeinde → BFS-Nummer
        const munSearch = await fetch(
          `https://api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=${encodeURIComponent(municipality)}&type=locations&origins=gg25&sr=4326&lang=de`
        );
        const munData = await munSearch.json();
        const bfsNr = munData.results?.[0]?.attrs?.num;

        if (!bfsNr) {
          return res.status(200).json({ found: false, reason: 'Gemeinde nicht gefunden' });
        }

        // Step 2: EGRID über Grundbuchnummer
        const egridSearch = await fetch(
          `https://geodienste.ch/services/av/parcel?number=${parcelNumber}&bfsnr=${bfsNr}&format=json`
        );

        if (!egridSearch.ok) {
          return res.status(200).json({ found: false, reason: 'Grundbuchamt nicht erreichbar' });
        }

        const egridData = await egridSearch.json();
        if (!egridData?.features?.length) {
          return res.status(200).json({ found: false, reason: 'Parzelle nicht gefunden' });
        }

        const parcel = egridData.features[0].properties;
        return res.status(200).json({
          found:        true,
          egrid:        parcel.egrid,
          number:       parcel.number,
          area:         parcel.area,           // m²
          municipality: parcel.municipality,
          bfsNr:        parcel.bfsNr,
          canton:       parcel.canton,
          coordinates:  egridData.features[0].geometry?.coordinates
        });
      }

      // ── 3. Zonenplan via ÖREB-API (Bauzone, AZ, etc.) ─────────────────
      case 'zone_lookup': {
        const { egrid } = params;

        // Cantonal WMS/WFS for land use zones
        // TG: https://ows.geo.tg.ch/geoserver/TBA/ows
        // SG: https://services.gis.sg.ch/geoserver/ows
        const oerebUrl =
          `https://www.cadastre.ch/en/oereb/extract.json?egrid=${egrid}&topics=ch.Nutzungsplanung`;

        const r = await fetch(oerebUrl);
        if (!r.ok) return res.status(200).json({ found: false, reason: 'ÖREB nicht verfügbar' });

        const data = await r.json();
        const zones = data?.extract?.RealEstate?.RestrictionOnLandownership || [];

        const nutzung = zones
          .filter(z => z.Theme?.Code === 'ch.Nutzungsplanung')
          .map(z => ({
            zone:         z.LegendEntry?.[0]?.LegendText?.Text,
            typeCode:     z.TypeCode,
            areaShare:    z.AreaShare,
          }));

        return res.status(200).json({ found: nutzung.length > 0, zones: nutzung });
      }

      // ── 4. Höhenmodell / Hangneigung (Swisstopo) ─────────────────────
      case 'elevation': {
        const { lat, lon } = params;
        const r = await fetch(
          `https://api3.geo.admin.ch/rest/services/height?easting=${lon}&northing=${lat}&sr=4326&format=json`
        );
        const data = await r.json();
        return res.status(200).json({
          elevation: data.height,
          unit:      'm.ü.M.'
        });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }

  } catch (err) {
    console.error('Geoportal API error:', err);
    return res.status(500).json({ error: 'Geoportal nicht erreichbar', detail: err.message });
  }
}
