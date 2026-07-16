// netlify/functions/currents.js
//
// Fetches real u/v current velocity across a grid and returns direction +
// speed per point, so the app can draw actual arrows — the thing that was
// never possible in the browser alone, since it needs raw numeric values,
// and this data server won't hand those to client-side JavaScript directly
// (confirmed blocked, six different ways, earlier in this project). This
// runs server-to-server instead, where that restriction doesn't apply.
//
// Two separate requests (u, then v) in parallel, rather than one combined
// query — this mirrors the exact pattern already proven in test-fetch.js,
// rather than gambling on an untested combined-variable request syntax.

const GRIDDAP_URL = 'https://cwcgom.aoml.noaa.gov/erddap/griddap/miamicurrents.json';
const TARGET_ARROWS_PER_AXIS = 12; // ~144 arrows total at most — a readable density, not a wall of arrows

exports.handler = async function (event, context) {
  const qs = event.queryStringParameters || {};
  const latMin = parseFloat(qs.latMin);
  const latMax = parseFloat(qs.latMax);
  const lonMin = parseFloat(qs.lonMin);
  const lonMax = parseFloat(qs.lonMax);

  if ([latMin, latMax, lonMin, lonMax].some((v) => !isFinite(v))) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, message: 'latMin, latMax, lonMin, lonMax are all required and must be numbers.' })
    };
  }

  const bboxPart = `[(last)][(${latMin}):(${latMax})][(${lonMin}):(${lonMax})]`;
  const uUrl = `${GRIDDAP_URL}?u_current${bboxPart}`;
  const vUrl = `${GRIDDAP_URL}?v_current${bboxPart}`;

  try {
    const [uRes, vRes] = await Promise.all([fetch(uUrl), fetch(vUrl)]);

    if (!uRes.ok || !vRes.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          ok: false,
          message: 'ERDDAP request failed.',
          uStatus: uRes.status,
          vStatus: vRes.status
        })
      };
    }

    const [uData, vData] = await Promise.all([uRes.json(), vRes.json()]);
    const uRows = uData.table.rows;
    const vRows = vData.table.rows;

    if (uRows.length === 0 || vRows.length === 0) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, arrows: [] }) };
    }

    // Read column positions from columnNames rather than assuming a fixed
    // order — more robust than hardcoding indices.
    const uCols = uData.table.columnNames;
    const vCols = vData.table.columnNames;
    const latIdx = uCols.indexOf('latitude');
    const lonIdx = uCols.indexOf('longitude');
    const uIdx = uCols.indexOf('u_current');
    const vLatIdx = vCols.indexOf('latitude');
    const vLonIdx = vCols.indexOf('longitude');
    const vIdx = vCols.indexOf('v_current');

    // Match v_current to u_current by lat/lon rather than assuming identical
    // row order between the two separate requests — safer, even though they
    // should line up for the same bbox/grid.
    const vLookup = {};
    for (const row of vRows) {
      vLookup[row[vLatIdx] + ',' + row[vLonIdx]] = row[vIdx];
    }

    // The grid is regular, so an evenly-spaced downsample means picking every
    // Nth *unique* lat and every Nth unique lon — not just every Nth row,
    // since the flat row order interleaves longitude within each latitude,
    // and naive row-striding would give uneven, distorted spacing instead.
    const uniqueLats = [...new Set(uRows.map((r) => r[latIdx]))].sort((a, b) => a - b);
    const uniqueLons = [...new Set(uRows.map((r) => r[lonIdx]))].sort((a, b) => a - b);
    const latStride = Math.max(1, Math.floor(uniqueLats.length / TARGET_ARROWS_PER_AXIS));
    const lonStride = Math.max(1, Math.floor(uniqueLons.length / TARGET_ARROWS_PER_AXIS));
    const keepLats = new Set(uniqueLats.filter((_, i) => i % latStride === 0));
    const keepLons = new Set(uniqueLons.filter((_, i) => i % lonStride === 0));

    const arrows = [];
    for (const row of uRows) {
      const lat = row[latIdx];
      const lon = row[lonIdx];
      if (!keepLats.has(lat) || !keepLons.has(lon)) continue;

      const u = row[uIdx];
      const v = vLookup[lat + ',' + lon];
      if (u === null || u === undefined || v === null || v === undefined) continue; // no-data cells (often land) — skip rather than draw a bogus arrow

      const speed = Math.sqrt(u * u + v * v);
      // atan2(east, north) gives bearing clockwise from true north — verified
      // against the four cardinal cases before using it (pure east -> 90,
      // pure north -> 0, pure south -> 180, pure west -> 270).
      const bearing = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;

      arrows.push({ lat: lat, lon: lon, speed: speed, bearing: bearing });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, count: arrows.length, arrows: arrows })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, step: 'exception', message: err.message })
    };
  }
};
