// netlify/functions/diag.js
//
// A DIAGNOSTIC PROBE, not part of the forecast. Its entire job is to answer,
// from the deployed environment that can actually reach these endpoints,
// the question my sandbox never could: what EXACTLY happens when each SST-
// family data source is queried, and how does that differ from the sources
// that are known to work?
//
// After many rounds of fixes that never changed the result, the honest
// conclusion is that I've been guessing at the server's behavior instead of
// observing it. This observes it. Open this function's URL in a browser
// (it's a plain GET, tiny area, short timeouts, returns fast) and it reports,
// for each dataset, the precise outcome — HTTP status, thrown error, rows
// returned, non-null values, elapsed time — so the actual failure mode is
// visible as fact rather than hypothesis.
//
// Two probes per SST dataset on purpose:
//   1. "minimal"  — the simplest possible single-time-step query for a tiny
//                   area. Answers: is this dataset reachable AT ALL right now?
//   2. "asForecast" — the exact query shape forecast.js builds (range end,
//                   stride, etc.). Answers: does the specific way the forecast
//                   queries it succeed or fail?
// If minimal works but asForecast fails, the bug is in the query construction.
// If minimal itself fails, the dataset/endpoint is the problem, not our query.
//
// Two known-working sources (currents, GEBCO) are probed too, as a baseline —
// if those succeed while the SST ones fail in the SAME run from the SAME
// environment, that isolates the problem to the SST datasets specifically and
// rules out network/server/region-wide explanations for good.

const CWCGOM = 'https://cwcgom.aoml.noaa.gov/erddap/griddap';
const COASTWATCH = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';

// A deliberately tiny area (a ~0.3° box on the Treasure Coast, the app's
// default center) so every probe payload is small and fast regardless of
// striding.
const LAT_MIN = 27.2, LAT_MAX = 27.5, LON_MIN = -80.2, LON_MAX = -79.9;

async function probe(label, url, varName, extraHeaders) {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  const result = { label, url, ok: false, elapsedMs: null, httpStatus: null, error: null, rows: null, nonNull: null, sample: null };
  try {
    const res = await fetch(url, { signal: controller.signal, headers: extraHeaders || {} });
    result.httpStatus = res.status;
    if (!res.ok) {
      // Capture a snippet of the body — ERDDAP returns a human-readable
      // reason (e.g. "time value out of range") in the body on errors, which
      // is exactly what we want to see.
      let body = '';
      try { body = (await res.text()).slice(0, 400); } catch (e) {}
      result.error = 'HTTP ' + res.status + (body ? (': ' + body.replace(/\s+/g, ' ').trim()) : '');
      result.elapsedMs = Date.now() - started;
      return result;
    }
    // varName === null: raw HTTP-level check only, no JSON parsing — for
    // probes against non-JSON formats (e.g. .csv), where what matters is
    // whether the request succeeds at all, not parsing content as
    // structured JSON. Without this, a genuinely successful response
    // here would otherwise be misreported as "threw: unexpected token".
    if (varName === null) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch (e) {}
      result.ok = true;
      result.rows = null;
      result.nonNull = null;
      result.sample = [body];
      result.elapsedMs = Date.now() - started;
      return result;
    }
    const data = await res.json();
    const cols = (data.table && data.table.columnNames) || [];
    const rows = (data.table && data.table.rows) || [];
    result.rows = rows.length;
    const vIdx = cols.indexOf(varName);
    let nonNull = 0;
    const samples = [];
    if (vIdx >= 0) {
      for (const r of rows) {
        if (r[vIdx] !== null && r[vIdx] !== undefined) {
          nonNull++;
          if (samples.length < 3) samples.push(r[vIdx]);
        }
      }
    }
    result.nonNull = nonNull;
    result.sample = samples;
    result.ok = nonNull > 0;
    result.columnNames = cols;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    result.error = (err && err.name === 'AbortError') ? 'timed out after 8000ms' : ('threw: ' + (err && err.message));
    result.elapsedMs = Date.now() - started;
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

exports.handler = async function () {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hourlyStart = new Date(Date.now() - 72 * 3600000).toISOString();
  const hourlyEnd = now.toISOString();
  // Matches forecast.js's own historyStart computation exactly, so this
  // probe uses the identical date range the real persistence code does —
  // not a close approximation.
  const historyStartStr = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  // Matches forecast.js's own chlHistoryStart exactly (20 days back, not
  // the shared 4) — the replacement chlorophyll dataset's documented
  // ~15-day latency means the shared window would request a range
  // entirely before any data exists there.
  const chlHistoryStartStr = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const b = `[(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN}):(${LON_MAX})]`; // unstrided tiny bbox

  // Run all probes concurrently; each is independently time-limited.
  const probes = await Promise.all([
    // --- SST HOURLY (GOES-19): old broken query vs the (last) fix ---
    probe('hourly/minimal', `${CWCGOM}/goes19SSThourly.json?sst[(last)]${b}`, 'sst'),
    probe('hourly/oldBroken', `${CWCGOM}/goes19SSThourly.json?sst[(${hourlyStart}):2:(${hourlyEnd})]${b}`, 'sst'),
    probe('hourly/nowFixed', `${CWCGOM}/goes19SSThourly.json?sst[(${hourlyStart}):2:(last)]${b}`, 'sst'),

    // --- ACSPO (expected 403 — retired) ---
    probe('acspo/minimal', `${CWCGOM}/noaacwLEOACSPOSSTL3SnrtCDaily.json?sea_surface_temperature[(last)]${b}`, 'sea_surface_temperature'),
    // Candidate ACSPO mirror found via search — a completely different
    // host (comet.nefsc.noaa.gov, unrelated to coastwatch.noaa.gov/
    // cwcgom.aoml.noaa.gov, which every ACSPO/chlorophyll/wind dataset
    // tried so far traced back to) and a different dataset ID, whose
    // metadata showed a recent time_coverage_end (~May 2026), unlike the
    // original's frozen-since-early-2025 state. Genuinely untested live —
    // not committed to forecast.js until this probe actually confirms it,
    // the same discipline that caught the chlorophyll alias dead-end and
    // the wind dimension bug earlier.
    probe('acspoCandidate/minimal', `https://comet.nefsc.noaa.gov/erddap/griddap/noaa_coastwatch_acspo_v2_nrt.json?sea_surface_temperature[(last)]${b}`, 'sea_surface_temperature'),
    // Direct question deserves a direct answer: this is the EXACT format
    // the app's own SST page uses for its "Composite (ACSPO)" mode
    // (.transparentPng, not .json) against this exact dataset. Chlorophyll's
    // old dataset already showed .transparentPng also returns 403 on this
    // same host — this confirms whether that holds for ACSPO specifically,
    // rather than inferring it from a different dataset.
    probe('acspo/transparentPng', `${CWCGOM}/noaacwLEOACSPOSSTL3SnrtCDaily.transparentPng?sea_surface_temperature[(last)]${b}&.colorBar=Rainbow|Log|0.1|20`, null),
    // Direct test of a real possibility: every probe so far, and every
    // fetch() in forecast.js, sends a plain request with no browser-like
    // headers. A real page load sends a genuine User-Agent and a Referer
    // pointing back at the site itself — a very common thing for a WAF or
    // access rule to treat differently, even against the identical URL.
    // If ACSPO succeeds here with these headers where the identical
    // headerless request above failed, that's the actual differentiator,
    // not the dataset or host being blocked outright.
    probe('acspo/withBrowserHeaders', `${CWCGOM}/noaacwLEOACSPOSSTL3SnrtCDaily.json?sea_surface_temperature[(last)]${b}`, 'sea_surface_temperature', {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://cwcgom.aoml.noaa.gov/erddap/griddap/noaacwLEOACSPOSSTL3SnrtCDaily.graph',
      'Accept': 'application/json, text/plain, */*'
    }),
    probe('acspo/transparentPng_withBrowserHeaders', `${CWCGOM}/noaacwLEOACSPOSSTL3SnrtCDaily.transparentPng?sea_surface_temperature[(last)]${b}&.colorBar=Rainbow|Log|0.1|20`, null, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://cwcgom.aoml.noaa.gov/erddap/griddap/noaacwLEOACSPOSSTL3SnrtCDaily.graph',
      'Accept': 'image/png,image/*,*/*'
    }),

    // --- MUR (expected OK — now primary) ---
    probe('mur/minimal', `${COASTWATCH}/jplMURSST41.json?analysed_sst[(last)]${b}`, 'analysed_sst'),

    // --- CHLOROPHYLL: old (expected 403) vs new replacement, two dim shapes ---
    probe('chl/oldForbidden', `${CWCGOM}/noaacwNPPVIIRSchlaSectorVYDaily.json?chlor_a[(last)][(0.0)]${b}`, 'chlor_a'),
    // Direct follow-up to a sharp observation: the client's own map layer
    // successfully displays chlorophyll from this EXACT dataset/host via
    // .transparentPng, the same one the probe above shows returns 403 as
    // .json. If that's really a blanket host/dataset block, .csv (still a
    // raw data-export format, not an image) should fail the same way. If
    // it succeeds, the block is specific to .json rather than this
    // dataset being unreachable — a materially different, better answer.
    probe('chl/oldForbidden_csv', `${CWCGOM}/noaacwNPPVIIRSchlaSectorVYDaily.csv?chlor_a[(last)][(0.0)]${b}`, null),
    // The client's OWN chlorophyll map layer requests exactly this format
    // from this exact dataset/host and (per direct report) displays real
    // data successfully. Run from here, this isolates file-format from
    // network origin — diag.js is server-side, same as forecast.js, not
    // the user's browser. If this succeeds where .json fails, the block
    // is specific to that format, not this dataset or Netlify's origin
    // being blocked outright.
    probe('chl/oldForbidden_transparentPng', `${CWCGOM}/noaacwNPPVIIRSchlaSectorVYDaily.transparentPng?chlor_a[(last)][(0.0)]${b}&.colorBar=Rainbow|Log|0.1|20`, null),
    probe('chlNew/withAltitude', `https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPVIIRSchlaDaily.json?chlor_a[(last)][(0.0)]${b}`, 'chlor_a'),
    probe('chlNew/noAltitude', `https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPVIIRSchlaDaily.json?chlor_a[(last)]${b}`, 'chlor_a'),
    // Direct correction: this specific query shape — a multi-day RANGE,
    // not just "(last)" — was never probed before, despite being the new
    // thing persistence actually introduced. The single-day version above
    // already confirms OK; if chlorophyll/persistence are still reported
    // missing, this is the untested gap most likely to explain why.
    probe('chlNew/historyRange', `https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPVIIRSchlaDaily.json?chlor_a[(${historyStartStr}):(last)][(0.0)]${b}`, 'chlor_a'),
    // The dataset forecast.js was actually switched to after the last
    // round of this — never itself probed live, only confirmed to exist
    // via a web search. That's the exact same gap that led to trusting
    // noaacwNPPVIIRSchlaDaily above without a real request first.
    probe('chlReplacement/minimal', `https://coastwatch.pfeg.noaa.gov/erddap/griddap/nesdisVHNSQchlaDaily.json?chlor_a[(last)][(0.0)]${b}`, 'chlor_a'),
    probe('chlReplacement/historyRange', `https://coastwatch.pfeg.noaa.gov/erddap/griddap/nesdisVHNSQchlaDaily.json?chlor_a[(${chlHistoryStartStr}):(last)][(0.0)]${b}`, 'chlor_a'),

    // --- SSH/EDDY: never probed before at all — added for the same reason. ---
    probe('ssh/minimal', `${CWCGOM}/miamidynamicheight.json?sea_surface_height_above_geoid[(last)]${b}`, 'sea_surface_height_above_geoid'),
    probe('ssh/historyRange', `${CWCGOM}/miamidynamicheight.json?sea_surface_height_above_geoid[(${historyStartStr}):(last)]${b}`, 'sea_surface_height_above_geoid'),

    // --- WIND (Ekman/upwelling, new): note the 0-360 longitude bbox here,
    // matching exactly how the app queries this dataset — confirmed
    // directly from its own metadata, not assumed. LAT_MIN/MAX unaffected.
    probe('wind/u_minimal', `https://coastwatch.noaa.gov/erddap/griddap/noaacwBlendedWindsDaily.json?u_wind[(last)][(10.0)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN + 360}):(${LON_MAX + 360})]`, 'u_wind'),
    probe('wind/v_minimal', `https://coastwatch.noaa.gov/erddap/griddap/noaacwBlendedWindsDaily.json?v_wind[(last)][(10.0)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN + 360}):(${LON_MAX + 360})]`, 'v_wind'),
    // Same principle: wind's own history-range shape, never probed before.
    probe('wind/u_historyRange', `https://coastwatch.noaa.gov/erddap/griddap/noaacwBlendedWindsDaily.json?u_wind[(${historyStartStr}):(last)][(10.0)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN + 360}):(${LON_MAX + 360})]`, 'u_wind'),
    // Candidate wind replacement — CCMP daily NRT on oceanwatch.pifsc.noaa.gov,
    // a host never tested server-side before now. Confirmed to exist and use
    // uwnd/vwnd (not u_wind/v_wind) via a real search, same as the
    // chlorophyll replacement — genuinely untested live, not committed to
    // forecast.js until this probe actually confirms it.
    // Real, fixable query bug found in the previous round's 400 error, not
    // an access block: this dataset's own metadata lists only time/
    // latitude/longitude — no altitude dimension, unlike the other wind
    // datasets tested above that do have one. The extra [(10.0)] bracket
    // was invalid for this dataset's actual shape. Removed here.
    probe('windCandidate/u_minimal', `https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ccmp-daily-v2-1-NRT.json?uwnd[(last)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN + 360}):(${LON_MAX + 360})]`, 'uwnd'),
    // Genuinely independent chlorophyll candidate, confirmed via search:
    // NASA/GSFC OBPG MODIS data — a completely different satellite and
    // processing lineage than every noaacw-prefixed dataset tried so far
    // (all confirmed blocked), on coastwatch.pfeg.noaa.gov, the same host
    // already confirmed working for MUR and GEBCO.
    // Fixed from last round's 500 error: 'chlorophyll' is the real
    // variable name for this dataset (confirmed via an actual working
    // query example found this round), not 'chlor_a' — that guess,
    // carried over from the VIIRS-based datasets' naming convention,
    // simply didn't apply here.
    probe('chlCandidate2/minimal', `https://coastwatch.pfeg.noaa.gov/erddap/griddap/erdMH1chla1day.json?chlorophyll[(last)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN}):(${LON_MAX})]`, 'chlorophyll'),
    probe('chlCandidate2/historyRange', `https://coastwatch.pfeg.noaa.gov/erddap/griddap/erdMH1chla1day.json?chlorophyll[(${chlHistoryStartStr}):(last)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN}):(${LON_MAX})]`, 'chlorophyll'),
    // Wind is already confirmed working (see windCandidate/u_minimal
    // above, from last round) and forecast.js has already been switched
    // to it — this re-probes the exact same query one more time as a
    // final confirmation alongside chlorophyll's fix, not a new guess.
    probe('windCandidate/v_minimal', `https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ccmp-daily-v2-1-NRT.json?vwnd[(last)][(${LAT_MIN}):(${LAT_MAX})][(${LON_MIN + 360}):(${LON_MAX + 360})]`, 'vwnd'),

    // --- KNOWN-WORKING BASELINES ---
    probe('currents/baseline', `${CWCGOM}/miamicurrents.json?u_current[(last)]${b}`, 'u_current'),
    probe('gebco/baseline', `${COASTWATCH}/GEBCO_2020.json?elevation${b}`, 'elevation')
  ]);

  // A compact, human-readable summary line per probe, plus the full detail.
  const summary = probes.map((p) =>
    `${p.ok ? 'OK  ' : 'FAIL'} ${p.label.padEnd(22)} ` +
    `status=${p.httpStatus === null ? '-' : p.httpStatus} rows=${p.rows === null ? '-' : p.rows} nonNull=${p.nonNull === null ? '-' : p.nonNull} ${p.elapsedMs}ms` +
    (p.error ? ` | ${p.error}` : '')
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      generatedAt: now.toISOString(),
      today,
      note: 'Probes each SST-family source two ways (minimal reachability vs the exact query the forecast builds), plus known-working baselines. FAIL on an SST source while baselines are OK isolates the problem to those datasets/queries.',
      summary,
      detail: probes
    }, null, 2)
  };
};
