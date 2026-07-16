// netlify/functions/depth.js
//
// Looks up seafloor depth at a single tapped point. This is the actual fix
// for the point feature: coordinates already worked (pure client-side
// math), but depth never did — bathymetry (GEBCO) was only ever fetched as
// a full grid for forecast.js's structure scoring, there was no path for
// "get the exact value at this one tapped point." Separately, temperature
// still can't be read this way — the SST layer is a rendered image tile,
// and (confirmed elsewhere in this app, six different ways) the tile
// server never grants permission to read a pixel's value back out of a
// browser canvas. Bathymetry doesn't have that problem: it's the same
// GEBCO_2020 ERDDAP griddap dataset forecast.js already queries for real
// numeric values, just asked for one point instead of a whole area.
//
// GEBCO_2020 has no time dimension (bathymetry doesn't change day to day),
// so this is a plain two-dimension (lat, lon) query. A degenerate
// single-value range like [(25.123):(25.123)] is standard ERDDAP/OPeNDAP
// syntax that snaps to the nearest actual grid cell — same mechanism
// already relied on for the full-grid version, just at N=1.

const GEBCO_URL = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/GEBCO_2020.json';

exports.handler = async function (event) {
  const qs = event.queryStringParameters || {};
  const lat = parseFloat(qs.lat);
  const lon = parseFloat(qs.lon);

  if (!isFinite(lat) || !isFinite(lon)) {
    return json(400, { ok: false, message: 'lat and lon are required and must be numbers.' });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return json(400, { ok: false, message: 'lat/lon out of valid range.' });
  }

  const url = `${GEBCO_URL}?elevation[(${lat}):(${lat})][(${lon}):(${lon})]`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // a single-point query should be fast; this is a generous ceiling, not an expected duration
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      return json(502, { ok: false, message: `GEBCO returned ${res.status}` });
    }
    const data = await res.json();
    const rows = data && data.table && data.table.rows;
    if (!rows || !rows.length) {
      return json(200, { ok: false, message: 'No bathymetry data at this point.' });
    }
    const cols = data.table.columnNames;
    const elevIdx = cols.indexOf('elevation');
    const latIdx = cols.indexOf('latitude');
    const lonIdx = cols.indexOf('longitude');
    if (elevIdx < 0 || latIdx < 0 || lonIdx < 0) {
      return json(502, { ok: false, message: 'Unexpected response shape from GEBCO.' });
    }

    // GEBCO elevation convention: negative = below sea level (depth),
    // positive = above sea level (land) — reported honestly either way
    // rather than assuming every tap lands on water.
    const elevationM = rows[0][elevIdx];
    const isLand = elevationM > 0;

    return json(200, {
      ok: true,
      matchedLat: rows[0][latIdx], // the actual GEBCO grid cell used — may differ slightly from the requested point, snapped to the dataset's own ~450m resolution
      matchedLon: rows[0][lonIdx],
      elevationM: +elevationM.toFixed(1),
      isLand,
      depthFt: isLand ? null : Math.round(Math.abs(elevationM) * 3.28084),
      depthM: isLand ? null : Math.round(Math.abs(elevationM)),
      elevationFt: isLand ? Math.round(elevationM * 3.28084) : null
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return json(504, { ok: false, message: timedOut ? 'Bathymetry lookup timed out.' : ('Bathymetry lookup failed: ' + err.message) });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}
