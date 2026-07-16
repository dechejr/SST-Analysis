// netlify/functions/test-fetch.js
//
// One job: prove that fetching real numeric data from ERDDAP works
// server-side, where there's no browser CORS wall. Everything else
// (the real forecast algorithm) depends on this exact pattern working.
//
// Small bounding box near Blue Water Intelligence's default view (off Cape
// Hatteras, where the Gulf Stream runs close to shore) — just enough points
// to see real numbers, not a full production-sized request.

exports.handler = async function (event, context) {
  const url =
    'https://cwcgom.aoml.noaa.gov/erddap/griddap/noaacwLEOACSPOSSTL3SnrtCDaily.json' +
    '?sea_surface_temperature[(last)][(33.0):(35.0)][(-76.0):(-74.0)]';

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({
          ok: false,
          step: 'fetch',
          status: response.status,
          message: 'ERDDAP responded, but not with success — see status code above.'
        })
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        message: 'Server-side fetch succeeded — this is the real, unblocked data.',
        rowCount: data.table && data.table.rows ? data.table.rows.length : 0,
        sample: data.table && data.table.rows ? data.table.rows.slice(0, 5) : null
      }, null, 2)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        step: 'exception',
        message: err.message
      })
    };
  }
};
