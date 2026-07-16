// netlify/functions/forecast.js
//
// The ROFFS-style scoring engine. Fetches every data source in parallel,
// computes a per-cell productivity score across a grid, and returns a
// ranked list of the most productive spots — each with a plain-language
// narrative for why it scored well — plus the full scored grid for a heat
// map. Tunable per target species: the weights themselves change, not just
// a cosmetic label, because different species genuinely respond to
// different signals.
//
// DESIGN PRINCIPLE (because this is being deployed before live testing):
// every data source is fetched independently and defensively. If one
// source fails, its contribution silently drops to neutral rather than
// taking down the whole forecast — and the response reports exactly which
// sources succeeded, so a partial result is still useful and the failure
// is diagnosable. Nothing here throws on a single bad fetch.
//
// CONVERGENCE-CORE WEIGHTS. This is the structural change from the original
// version: these are no longer combined with a weighted arithmetic sum plus
// a small bonus tacked on at the end. They're combined with a weighted
// GEOMETRIC mean (product of score_i ^ weight_i) — which mathematically
// requires signals to co-occur, since any single near-zero factor collapses
// the whole product toward zero, rather than being diluted into an average
// by other decent factors. That's what "convergence" actually means
// mathematically, and it's why the original scoring produced flat, similar
// numbers everywhere: an arithmetic mean of moderate values stays moderate
// everywhere; a geometric mean only stays high where everything lines up.
//
// Pelagic species (mahi/tuna/wahoo/sailfish/general) use surface signals:
// temp preference match, SST break sharpness, chlorophyll edge, eddy
// proximity, current strength, and a lesser structure term. Wahoo gets a
// real structure bump (drop-off/seamount oriented among open-water fish)
// and a separate bonus below for favoring the cooler side of a break.
// Bottom species (snapper/grouper) use a completely different, much
// smaller signal set: structure dominates, tide-driven current matters a
// lot, and temperature is a minor secondary factor — reflecting that these
// are structure-obsessed fish, not surface-break hunters. Every profile is
// verified to sum to exactly 1.0 before being used (checked with a script,
// not eyeballed).
// chlGrad split 60/40 into chlGrad (edge/gradient, unchanged, neighborhood-
// aware) and chlFavor (absolute concentration favorability, new, point-
// exact) — same total chlorophyll-related weight budget per species as
// before, just now expressed across two distinct signals instead of one.
// See chlFavorabilityScore for the sourcing behind the favorable range.
// All prior weights scaled by 0.92 to make room for the new upwelling
// signal at 8% — a modest starting allocation for a newly-added,
// physically well-grounded but still-new signal, comparable in scale to
// currFavor. Every other weight's RELATIVE balance against each other is
// preserved exactly (each just multiplied by the same 0.92 factor), so
// this is purely "making room," not re-judging any prior weighting
// decision.
// Flat registry of documented, named productive fishing grounds — no
// region concept at all (that whole system was removed per direct
// request), just real named places checked directly against whatever area
// is actually being analyzed. See fishing-grounds.js for the full
// rationale and sources.
const GROUNDS_KB = require('./fishing-grounds');

// Pelagic surface signals: temp preference match, SST break sharpness,
// chlorophyll edge + absolute favorability, eddy proximity, current
// break + absolute favorability, a lesser structure term, and wind-driven
// upwelling. Verified to sum to exactly 1.0 before being used (checked
// with a script, not eyeballed).
// chlGrad split 60/40 into chlGrad (edge/gradient, neighborhood-aware) and
// chlFavor (absolute concentration favorability, point-exact) — see
// chlFavorabilityScore for the sourcing behind the favorable range.
// currBreak/currFavor and upwelling follow the same pattern — see
// currentShearAt and ekmanUpwellingMDayAt respectively.
// temp and currFavor removed per direct request (Water Temperature and
// Current absolute-speed are no longer scored at all — not hidden, not
// zero-weighted, genuinely gone). Their combined 0.2125 was redistributed
// proportionally across the remaining 7 signals, preserving each one's
// relative balance against the others exactly — verified to sum to
// exactly 1.0, not eyeballed.
const CORE_WEIGHTS = { sstGrad: 0.3447, chlGrad: 0.1479, chlFavor: 0.0985, eddy: 0.1846, currBreak: 0.0737, struct: 0.049, upwelling: 0.1016 };

// Weighted geometric mean: product(score_i ^ weight_i). Requires every
// weighted component to have some signal — a single near-zero score with
// meaningful weight collapses the result, by design.
function weightedGeoMean(scores, weights) {
  let product = 1;
  for (const key in weights) {
    const s = Math.max(0.02, scores[key] !== undefined ? scores[key] : 0.5); // floor avoids a hard 0 wiping out a partial-data cell entirely
    product *= Math.pow(s, weights[key]);
  }
  return clamp01(product);
}

// How well an actual temperature matches a species' preferred range — full
// credit inside the range, tapering off over roughly 3°C outside it.
// How favorable the ABSOLUTE chlorophyll-a concentration itself is —
// genuinely distinct from chlGradScore (the existing edge/gradient
// detector, unchanged): this is "is the water here plankton-rich enough to
// be worth fishing," not "is there a sharp transition nearby." Direct
// request, and grounded in real research rather than guessed: multiple
// independent studies on tuna/pelagic catch rates converge on roughly
// 0.15-1.0 mg/m^3 as a productive range (Gulf of Bone-Flores skipjack
// hotspots: 0.15-0.35; Sri Lankan yellowfin aggregations: 0.3-0.4; Ternate
// Island skipjack: >0.2-0.35) — this app's own default range is set a
// little wider than any single study to cover the full pelagic species mix
// here, not just tuna specifically. A mahi-specific source (SatFish)
// separately confirms these fish tolerate a much broader 0.01-5.0 range,
// with "near color changes" (i.e. the edge, already captured by
// chlGradScore) mattering more than the absolute level for that species —
// consistent with treating this as a real but secondary signal, not the
// dominant one (see the weight split in PELAGIC_CORE_WEIGHTS). Both very
// low (clear, nutrient-poor "desert" water) and very high (murky,
// visibility-limited, often coastal/riverine) concentrations reduce this
// score. Log-scale falloff, not linear like temperature's — chlorophyll's
// meaningful variation is multiplicative (0.05 to 0.15 mg/m^3 is a real,
// oceanographically significant jump; 5.0 to 5.1 is noise), so distance
// from the favorable range is measured in log10 units, falling to 0 at
// roughly one order of magnitude outside it.
// How well an actual temperature matches a species' preferred range — full
// credit inside the range, tapering off over roughly 3°C outside it.
function chlFavorabilityScore(chlValue) {
  const FAVORABLE_MIN = 0.15, FAVORABLE_MAX = 1.0; // mg/m^3 -- see the comment above for sourcing; a starting default, easy to retune
  if (chlValue >= FAVORABLE_MIN && chlValue <= FAVORABLE_MAX) return 1.0;
  const logVal = Math.log10(Math.max(chlValue, 0.001)); // guard against log(0)/negative
  const logMin = Math.log10(FAVORABLE_MIN), logMax = Math.log10(FAVORABLE_MAX);
  const logDist = chlValue < FAVORABLE_MIN ? (logMin - logVal) : (logVal - logMax);
  return clamp01(1 - logDist / 1.0);
}

const ERDDAP = 'https://cwcgom.aoml.noaa.gov/erddap/griddap';
const GRID_N = 18; // NxN scoring grid — ~324 cells, a readable spot map without a huge compute
// 2.5x a map's own typical point spacing — generous enough to cover normal
// grid gaps without also silently accepting a genuinely distant reading as
// if it were local. Used both for each source's own per-cell distance
// cutoff (see estimateSpacingMi below) and for the SST compositing
// coverage check's grid-resolution-based threshold — same constant, two
// related but distinct uses, kept in one place rather than duplicated.
const SPACING_TOLERANCE_MULTIPLIER = 2.5;

// ---- small numeric helpers ---------------------------------------------

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Normalize a raw value into 0..1 given an expected [lo, hi] range.
function norm(v, lo, hi) { return clamp01((v - lo) / (hi - lo)); }

// Direct correction: area-relative scoring's own normalization range was
// raw min/max, which meant a single outlier cell — one unusually strong
// or weak reading anywhere in the analyzed box — could single-handedly
// stretch or compress every other cell's score for that signal, even
// though their own underlying data never changed. Confirmed directly:
// the identical cell, identical data, scored 0.211 with one outlier
// included in the box and 1.000 with that same outlier excluded — as a
// small location shift easily could, since it only takes a handful of
// edge cells changing. Standard linear-interpolation percentile (the
// same method numpy.percentile uses by default), used below to compute
// a robust [5th, 95th] range instead of raw [min, max] — norm() already
// clamps to 0-1, so a genuine outlier still scores at the extreme (0 or
// 1), it just can no longer drag every OTHER cell's scale along with it.
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = p * (sortedValues.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const frac = idx - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

// THE CORE BUG FIX: find the nearest sampled point in a value map to a given
// (lat, lon), rather than an exact-key lookup. The original code looked up
// valueMap[lat+','+lon] directly using grid-cell-center coordinates against a
// map keyed by the data source's own sample points — those essentially never
// match exactly, so the lookup silently returned undefined for nearly every
// cell, every component fell back to neutral, and every cell ended up with
// an identical score. This is why the productivity percentage was flat
// across all spots. Returns null if the map is empty.
//
// DISTANCE-CUTOFF FIX (added after a direct question about cloud-cover
// gaps): distance is now real miles (equirectangular approximation), not a
// raw sum of degrees — the old metric wasn't even proportional to real
// distance once you're far enough north/south for longitude compression to
// matter. And an optional maxDistanceMi cutoff means a cell far from ANY
// actual observation returns null (treated as no local data) instead of
// silently pulling in a distant reading and presenting it as if it applied
// here. Without this, a patchy cloud-cover day could have 80% of a zone
// clouded and one clear corner, and every cell in that 80% would still
// silently borrow that corner's reading as if it were local.
function nearestValue(points, lat, lon, maxDistanceMi){
  const milesPerDegLon = 69 * Math.cos(lat * Math.PI / 180); // computed once per call, not per candidate — keeps the loop cheap
  let best = null, bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dLatMi = (p.lat - lat) * 69;
    const dLonMi = (p.lon - lon) * milesPerDegLon;
    const d = Math.sqrt(dLatMi * dLatMi + dLonMi * dLonMi);
    if (d < bestDist) { bestDist = d; best = p.value; }
  }
  if (best === null) return null;
  if (maxDistanceMi !== undefined && bestDist > maxDistanceMi) return null;
  return best;
}

// Estimates how far apart this specific map's own data points typically are,
// in miles — used to set a sensible, self-scaling maxDistanceMi rather than
// one fixed number that would be too tight for a naturally-coarse source
// (altimetry, currents) and too loose for a naturally-dense one (SST,
// chlorophyll). A sparser map (more cloud cover, or a coarser native
// dataset) gets a proportionally larger allowed radius; a denser map gets a
// tighter one. Falls back to a fixed default for degenerate cases (0 or 1
// points total, where spacing can't be measured at all).
const DEFAULT_SPACING_FALLBACK_MI = 15; // a reasonable stand-in for typical satellite composite resolution when spacing can't be measured
function estimateSpacingMi(points) {
  if (points.length === 0) return DEFAULT_SPACING_FALLBACK_MI; // empty map — doesn't matter, sources.X will be false anyway
  const latSet = new Set(), lonSet = new Set();
  for (let i = 0; i < points.length; i++) { latSet.add(points[i].lat); lonSet.add(points[i].lon); }
  const lats = [...latSet].sort((a, b) => a - b);
  const lons = [...lonSet].sort((a, b) => a - b);
  const midLat = (lats[0] + lats[lats.length - 1]) / 2;
  const latSpacingMi = lats.length > 1 ? ((lats[lats.length - 1] - lats[0]) / (lats.length - 1)) * 69 : null;
  const lonSpacingMi = lons.length > 1 ? ((lons[lons.length - 1] - lons[0]) / (lons.length - 1)) * 69 * Math.cos(midLat * Math.PI / 180) : null;
  if (latSpacingMi === null && lonSpacingMi === null) return DEFAULT_SPACING_FALLBACK_MI; // a single point total — can't measure spacing
  return Math.max(latSpacingMi || 0, lonSpacingMi || 0);
}

// Fetch JSON with a timeout so one slow source can't stall the whole function.
async function fetchJSON(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

// Parse an ERDDAP griddap .json table into a { "lat,lon": value } map, keyed
// to grid cells. Returns {} on any structural problem rather than throwing.
function erddapToMap(json, varName) {
  try {
    const cols = json.table.columnNames;
    const latIdx = cols.indexOf('latitude');
    const lonIdx = cols.indexOf('longitude');
    const vIdx = cols.indexOf(varName);
    if (latIdx < 0 || lonIdx < 0 || vIdx < 0) return {};
    const map = {};
    for (const row of json.table.rows) {
      const v = row[vIdx];
      if (v === null || v === undefined) continue;
      map[row[latIdx] + ',' + row[lonIdx]] = v;
    }
    return map;
  } catch (e) {
    return {};
  }
}

// Sibling to erddapToMap for a multi-time-step response (a time RANGE
// request, not "(last)") — splits the rows into separate per-day maps,
// grouped by their distinct time values and sorted oldest to newest.
// Needed for persistence/rate-of-change specifically: every other fetch in
// this app only ever requests a single time step, so erddapToMap has never
// needed to look at the time column at all. Returns [] on any structural
// problem, same defensive spirit as erddapToMap.
function erddapToMapsByDay(json, varName) {
  try {
    const cols = json.table.columnNames;
    const timeIdx = cols.indexOf('time');
    const latIdx = cols.indexOf('latitude');
    const lonIdx = cols.indexOf('longitude');
    const vIdx = cols.indexOf(varName);
    if (timeIdx < 0 || latIdx < 0 || lonIdx < 0 || vIdx < 0) return [];
    const byTime = {};
    for (const row of json.table.rows) {
      const v = row[vIdx];
      if (v === null || v === undefined) continue;
      const t = row[timeIdx];
      if (!byTime[t]) byTime[t] = {};
      byTime[t][row[latIdx] + ',' + row[lonIdx]] = v;
    }
    const times = Object.keys(byTime).sort(); // ISO timestamps sort correctly as strings, oldest first
    return times.map((t) => ({ time: t, map: byTime[t] }));
  } catch (e) {
    return [];
  }
}

// SST PIXEL-LEVEL COMPOSITING (direct specification, superseding an earlier
// whole-tier fallback version): rather than accepting or rejecting an
// entire source as one unit, this builds a single composite SST field by
// backfilling individual missing pixels — hourly (GOES-19) first, walking
// back up to 72 hours; then ACSPO, up to 5 days; then MUR, up to 5 days —
// stopping as soon as at least 90% of the actual scoring-grid cells (the
// exact same GRID_N x GRID_N cell centers the scoring loop itself uses, so
// "90% of the forecast area" means 90% of the cells that actually get
// scored, not an abstract notion of area) have a usable nearby reading.
// Whatever's still uncovered after all three tiers is left null — no
// fabrication, honest gaps.
//
// Each tier fetches its ENTIRE lookback window in ONE network call rather
// than one call per hour/day — the difference between at most 3 network
// round-trips total and the 80+ it would otherwise take, which is what
// actually makes this feasible within the function's time budget. Frames
// within a tier are then processed newest-to-oldest entirely in memory,
// each one merging in only the pixels not already present (first/freshest
// write always wins, since processing order is strictly newest-to-oldest
// within a tier, and hourly is fully exhausted before ACSPO is attempted,
// which is fully exhausted before MUR).
//
// Coverage is checked after every frame merge, but only against cells not
// already covered — coverage is monotonic (once a cell has a usable point
// within range, adding more points elsewhere can't un-cover it), so a
// covered cell never needs re-checking. This is what keeps the worst case
// (all 72 hourly + 5 ACSPO + 5 MUR frames, still short of 90%) cheap:
// measured directly at 4ms in-memory for that exact scenario, not a source
// of real risk to the time budget the way 80+ actual network calls would
// have been.
// ERDDAP griddap supports [(start):stride:(stop)] — every Nth native grid
// point, not every one. Added after checking the actual live dataset
// metadata for goes19SSThourly (not assumed — fetched directly): its
// _ChunkSizes attributes show roughly 6000 x 5900 points across its full
// extent, working out to about 0.02 degrees per pixel, genuine high-
// resolution satellite data. Every query in this file up to this point
// requested that full native resolution with no stride at all — for a
// realistic bbox across up to 72 hourly frames (or 5 days for the
// composites), that's a potentially enormous single response, an
// oversized-payload risk this project's mock-based testing never actually
// caught, since every test grid used so far has been far sparser than a
// real satellite's native density. None of this is needed anyway: the
// scoring grid itself only ever uses ~40 points per axis at most
// (downsampleMap's own existing cap), so fetching native resolution was
// pure waste even before considering the payload-size risk.
//
// Assumes a conservative (dense) ~0.01-degree native resolution — MUR's
// well-documented ~1km grid, the densest of the three sources used here —
// so the computed stride is never too SMALL even for the densest case.
// Getting somewhat more resolution than strictly necessary from a coarser
// source (ACSPO, hourly) is a far safer error than under-striding a dense
// one and reintroducing the exact payload problem this exists to prevent.
function erddapStride(spanDegrees, targetPointsPerAxis = 40, assumedResolutionDeg = 0.01) {
  const nativePoints = spanDegrees / assumedResolutionDeg;
  return Math.max(1, Math.round(nativePoints / targetPointsPerAxis));
}

async function buildCompositeSst(latMin, latMax, lonMin, lonMax, remainingBudgetMsFn) {
  const COVERAGE_TARGET = 0.90;

  // THE ACTUAL GAP FOUND after a second "still missing" report pushed past
  // continuing to guess at external causes: this function is sequential
  // internally (hourly awaited, then ACSPO, then MUR), and every mock used
  // to test it up to this point resolved fetch() instantly — which hid the
  // real risk entirely. Computed by hand, not assumed: with the original
  // per-tier caps (6000ms/5000ms/5000ms), a worst case where each tier
  // takes close to its full timeout before failing adds up to roughly
  // 6000+2500+300 ≈ 8800ms for this one chain alone — already past the
  // 8500ms overall function budget, before the scoring loop that runs
  // after this resolves gets any guaranteed time at all, and plausibly
  // past the hosting platform's own hard execution limit.
  //
  // First fix attempt used a shared, depleting time pool across all three
  // tiers — tested with REAL simulated network delays (not instant mock
  // resolution, the actual blind spot that let the original bug through)
  // and caught a second, real problem directly: if hourly and ACSPO were
  // both slow before failing, they could exhaust the shared pool entirely,
  // and MUR — the most independent, most likely-to-succeed fallback, on a
  // completely different server — never got attempted AT ALL, even though
  // it would have worked. That's a very plausible match for "still
  // missing": not every tier down, just the one most likely to help never
  // getting its turn.
  //
  // Fixed properly with independent, fixed caps per tier rather than a
  // shared pool — every tier gets its own full allotment regardless of
  // what happened before it, so a slow-but-failing hourly attempt can
  // never crowd out MUR's chance. The sum of the fixed caps (2000 + 1500 +
  // 2000 = 5500ms worst case) is still a known, safe ceiling that leaves
  // guaranteed time for everything that runs after this resolves.
  // Rebalanced after the realistic-delay test above showed 2000ms was too
  // tight for MUR specifically — a genuinely-working-but-3.5s-slow response
  // was being aborted by the timeout itself, solving the original problem
  // by creating a new one. MUR gets the most generous allotment of the
  // three, since it's the most important, most independent fallback and
  // the one this whole chain most needs to succeed at reaching. Total
  // across all three tiers (6500ms worst case) stays within a ceiling that
  // still reserves guaranteed time afterward for the scoring loop, which
  // earlier measurement showed comfortably fits in under 2 seconds even in
  // its own worst case.
  //
  // hourly's own cap raised again after a seventh report ("Water
  // Temperature, SST Break, Persistence, Rate of Change, Chlorophyll" all
  // still missing) pointed at something specific to the multi-day
  // time-RANGE queries (all four SST-family gaps go through them; every
  // currently-working source uses a single-time-step query instead).
  // hourly's own range can still be up to 36 distinct time steps even
  // after adding a stride of 2 to it (see the query itself, right below) —
  // by far the largest payload of the three tiers, and the previous
  // 2200ms cap may simply not have been enough time for a payload that
  // size to transfer, not a sign anything about the data or the query
  // itself was wrong. MUR trimmed slightly to keep the three-tier total
  // from growing further.
  const hourlyTimeoutMs = Math.max(300, Math.min(remainingBudgetMsFn(), 2800));
  const acspoTimeoutMs = Math.max(300, Math.min(remainingBudgetMsFn(), 1800));
  const murTimeoutMs = Math.max(300, Math.min(remainingBudgetMsFn(), 2200));

  // The exact scoring-grid cell centers — same formula the scoring loop
  // itself uses below, so this coverage check is measuring the real thing.
  const dLat = (latMax - latMin) / GRID_N;
  const dLon = (lonMax - lonMin) / GRID_N;
  const gridPoints = [];
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      gridPoints.push({
        lat: +(latMin + (i + 0.5) * dLat).toFixed(4),
        lon: +(lonMin + (j + 0.5) * dLon).toFixed(4),
        covered: false
      });
    }
  }
  const totalCells = gridPoints.length;
  let coveredCount = 0;

  // This threshold answers "is a point close enough to represent THIS
  // SCORING CELL" — which depends on how far apart the scoring cells
  // themselves are, not on whatever a given source's native satellite
  // pixel spacing happens to be. Computed once, reused for every coverage
  // check across every tier (deliberately different from sstMaxDistMi
  // below, which is computed on the finished composite for the actual
  // per-cell gradient lookups during scoring — this one is specifically
  // for the "is the area adequately covered" question during backfill).
  const midLat = (latMin + latMax) / 2;
  const coverageMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * Math.max(dLat * 69, dLon * 69 * Math.cos(midLat * Math.PI / 180));

  // See erddapStride's comment above for why this exists — requesting full
  // native satellite resolution across a multi-frame time range risked a
  // dangerously oversized response; this keeps every tier's query down to
  // roughly the resolution actually needed.
  const latStride = erddapStride(latMax - latMin);
  const lonStride = erddapStride(lonMax - lonMin);

  let compositeMap = {};
  const log = [];

  function recomputeCoverage() {
    if (coveredCount >= totalCells) return;
    const points = toPointArray(compositeMap);
    if (points.length === 0) return;
    for (const cell of gridPoints) {
      if (cell.covered) continue;
      if (nearestValue(points, cell.lat, cell.lon, coverageMaxDistMi) !== null) {
        cell.covered = true;
        coveredCount++;
      }
    }
  }
  function coverageFraction(){ return coveredCount / totalCells; }
  function mergeFrame(frameMap){
    let added = 0;
    for (const key in frameMap) {
      if (!(key in compositeMap)) { compositeMap[key] = frameMap[key]; added++; }
    }
    return added;
  }

  // --- TIER 1: hourly, up to 72h, one network fetch for the whole window ---
  // Range END is '(last)', not a computed "now": a live diagnostic proved
  // this exact query was 404-ing because "now" overshoots the dataset's
  // newest available timestamp by several hours (ERDDAP rejects the WHOLE
  // request when the stop bound exceeds the axis maximum — not a clip, a
  // hard error). This is the same (last) fix already applied to the ACSPO
  // and MUR tiers; it was simply missed here, and that miss alone took out
  // the entire hourly tier. The ':2:' time-stride still applies (every 2nd
  // step across the window).
  const hourlyStart = new Date(Date.now() - 72 * 3600000).toISOString();
  const hourlyR = await fetchJSON(
    `${ERDDAP}/goes19SSThourly.json?sst[(${hourlyStart}):2:(last)][(${latMin}):${latStride}:(${latMax})][(${lonMin}):${lonStride}:(${lonMax})]`,
    hourlyTimeoutMs
  );
  if (hourlyR.ok) {
    const frames = erddapToMapsByDay(hourlyR.data, 'sst'); // sorted oldest->newest; name is historical, groups by any distinct time value, not just calendar days
    if (frames.length === 0) {
      log.push('hourly:ok-but-zero-frames'); // the fetch succeeded at the HTTP level but the response had no usable time-keyed data — a different failure mode than a fetch error, worth distinguishing in the log
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const added = mergeFrame(frames[i].map);
      if (added > 0) recomputeCoverage();
      log.push('hourly@' + frames[i].time + ':+' + added + 'px,cov=' + Math.round(coverageFraction() * 100) + '%');
      if (coverageFraction() >= COVERAGE_TARGET) break;
    }
  } else {
    log.push('hourly:fetch-failed:' + (hourlyR.status ? ('http' + hourlyR.status) : (hourlyR.error || 'unknown')));
  }

  // --- ACSPO TIER RETIRED (was tier 2) ------------------------------------
  // A live diagnostic against the deployed environment returned HTTP 403
  // Forbidden for this dataset ("You don't have permission to access
  // /erddap/griddap/noaacwLEOACSPOSSTL3SnrtCDaily.json on this server") on
  // every query shape, while OTHER datasets on the very same cwcgom server
  // (currents, altimetry) returned 200 in the same run — so this is a
  // dataset-specific access restriction, not a server or network problem,
  // and nothing in this code can grant permission the server refuses.
  // Independently, the dataset's own metadata shows time_coverage_end of
  // 2025-01-30 and NOAA's own "testOutOfDate: now-95days" flag — i.e. it's
  // been frozen/stale since early 2025 regardless of the 403. It was
  // therefore removed rather than repaired: no (last) fix or timeout change
  // could help a source that both refuses access AND has no recent data.
  // MUR (below) covers the same need and the same diagnostic proved it
  // fully working. If AOML ever restores ACSPO access and currency, its
  // tier can be reinstated here — the surrounding structure is unchanged.

  // --- TIER 2 (was tier 3): MUR — now the primary fallback after hourly ----
  // A completely independent server (coastwatch.pfeg.noaa.gov, not
  // cwcgom.aoml.noaa.gov). The live diagnostic proved this dataset fully
  // working (both a minimal probe and the exact forecast-shaped query
  // returned thousands of valid points), which is what makes retiring
  // ACSPO safe: hourly + MUR alone cover the SST need. Always attempted if
  // coverage isn't there yet, with its own fixed, guaranteed timeout.
  if (coverageFraction() < COVERAGE_TARGET) {
    const murStart = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    // '(last)'-anchored end, confirmed correct against MUR's live metadata
    // (multi-day latency; daily points land at 09:00:00Z, not midnight).
    const murR = await fetchJSON(
      `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?analysed_sst[(${murStart}):(last)][(${latMin}):${latStride}:(${latMax})][(${lonMin}):${lonStride}:(${lonMax})]`,
      murTimeoutMs
    );
    if (murR.ok) {
      const frames = erddapToMapsByDay(murR.data, 'analysed_sst');
      if (frames.length === 0) log.push('mur:ok-but-zero-frames');
      for (let i = frames.length - 1; i >= 0; i--) {
        const added = mergeFrame(frames[i].map);
        if (added > 0) recomputeCoverage();
        log.push('mur@' + frames[i].time + ':+' + added + 'px,cov=' + Math.round(coverageFraction() * 100) + '%');
        if (coverageFraction() >= COVERAGE_TARGET) break;
      }
    } else {
      log.push('mur:fetch-failed:' + (murR.status ? ('http' + murR.status) : (murR.error || 'unknown')));
    }
  }

  return { map: compositeMap, coverage: coverageFraction(), reachedTarget: coverageFraction() >= COVERAGE_TARGET, log };
}

// Generic sibling to fetchSstHistoryWithFallback, for the other three
// signals persistence now also considers (direct request: "it's not just
// SST... consider Eddys, Chlorophyll and upwellings also"). No multi-tier
// fallback here — unlike SST, each of these already has exactly one
// source for its "today" snapshot, so history uses that same source
// requesting a multi-day range instead of "(last)". Same defensive
// shape as every other fetch here: empty frames on any failure, never
// thrown.
async function fetchHistoryGeneric(url, varName, timeoutMs) {
  const log = [];
  const r = await fetchJSON(url, timeoutMs);
  if (r.ok) {
    const frames = erddapToMapsByDay(r.data, varName);
    if (frames.some((f) => Object.keys(f.map).length > 0)) {
      log.push('ok:' + frames.length + 'frames');
      return { frames, log };
    }
    log.push('ok-but-zero-frames');
  } else {
    log.push('fetch-failed:' + (r.status ? ('http' + r.status) : (r.error || 'unknown')));
  }
  return { frames: [], log };
}

// Same resilience principle applied to the multi-day history fetch that
// persistence/rate-of-change relies on — ACSPO then MUR. No hourly tier
// here on purpose: a multi-day trend comparison is a poor fit for a single
// hourly snapshot's noise level, and switching datasets mid-comparison
// would make "the front strengthened/weakened" meaningless anyway, since
// different sources don't necessarily agree pixel-for-pixel.
async function fetchSstHistoryWithFallback(latMin, latMax, lonMin, lonMax, historyStart, remainingBudgetMsFn) {
  // ACSPO removed here too (was the first source tried): same live 403 and
  // same frozen-since-Jan-2025 staleness as in buildCompositeSst — a source
  // that both refuses access and has no recent data can't feed a
  // "recent-days trend" feature. MUR is now the sole source; the live
  // diagnostic proved its multi-day range query returns thousands of valid
  // points across distinct days, which is exactly what persistence/rate-of-
  // change need (multiple separate days to compare). Spatial stride and the
  // '(last)'-anchored range end are unchanged and confirmed correct.
  const latStride = erddapStride(latMax - latMin);
  const lonStride = erddapStride(lonMax - lonMin);
  const murTimeoutMs = Math.max(300, Math.min(remainingBudgetMsFn(), 2500));

  const log = [];
  const murR = await fetchJSON(
    `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json?analysed_sst[(${historyStart}):(last)][(${latMin}):${latStride}:(${latMax})][(${lonMin}):${lonStride}:(${lonMax})]`,
    murTimeoutMs
  );
  if (murR.ok) {
    const frames = erddapToMapsByDay(murR.data, 'analysed_sst');
    if (frames.some((f) => Object.keys(f.map).length > 0)) {
      log.push('mur:ok:' + frames.length + 'frames');
      return { frames, source: 'mur', log };
    }
    log.push('mur:ok-but-zero-frames');
  } else {
    log.push('mur:fetch-failed:' + (murR.status ? ('http' + murR.status) : (murR.error || 'unknown')));
  }
  return { frames: [], source: null, log };
}

// THE OTHER CRITICAL FIX (alongside the 50-mile area cap): nearestValue does
// an O(N) scan per lookup, and the scoring loop calls it roughly 7000+
// times across all signals. Measured directly before writing this: at
// 3,000 points that's already ~7.8s — more than the entire time budget —
// and at 15,000 points it's ~42s. This was completely unprotected by the
// fetch-timing budget, since it all happens after every fetch already
// succeeded. Downsampling every map to a small, fixed maximum immediately
// after parsing bounds this cost to a constant regardless of how much data
// ERDDAP actually returns — measured at 70-80ms flat from 3,000 to 50,000
// source points, a 97x-2342x improvement over the unbounded version.
// Same "keep every Nth unique lat/lon" technique already proven in
// currents.js, since the underlying grid is regular.
function downsampleMap(valueMap, maxPerAxis) {
  const latSet = new Set(), lonSet = new Set();
  for (const key in valueMap) {
    const commaIdx = key.indexOf(',');
    latSet.add(key.slice(0, commaIdx));
    lonSet.add(key.slice(commaIdx + 1));
  }
  const uniqueLats = [...latSet].map(Number).sort((a, b) => a - b);
  const uniqueLons = [...lonSet].map(Number).sort((a, b) => a - b);
  if (uniqueLats.length <= maxPerAxis && uniqueLons.length <= maxPerAxis) return valueMap; // already small enough

  const latStride = Math.max(1, Math.floor(uniqueLats.length / maxPerAxis));
  const lonStride = Math.max(1, Math.floor(uniqueLons.length / maxPerAxis));
  const keepLats = new Set(uniqueLats.filter((_, i) => i % latStride === 0));
  const keepLons = new Set(uniqueLons.filter((_, i) => i % lonStride === 0));

  const result = {};
  for (const key in valueMap) {
    const commaIdx = key.indexOf(',');
    const lat = Number(key.slice(0, commaIdx));
    const lon = Number(key.slice(commaIdx + 1));
    if (keepLats.has(lat) && keepLons.has(lon)) result[key] = valueMap[key];
  }
  return result;
}

// PERFORMANCE FIX (found while testing the distance-cutoff fix, not caused by
// it — confirmed by direct comparison: the old distance formula was equally
// slow at the same scale). The actual bottleneck was never the distance
// math; it was re-parsing the same "lat,lon" string keys from scratch on
// every single one of the ~7000 nearestValue lookups per request, each
// scanning up to 1,600 points after downsampling. Measured directly: a
// realistic worst case (the largest FIFR zone, fully dense data on all six
// sources — a clear-sky day, not a rare edge case) took 6.3s in the scoring
// loop alone, out of an 8,500ms total budget. Pre-parsing each map ONCE into
// a plain numeric array right after downsampling — rather than re-parsing
// on every candidate, on every lookup — removes that entirely redundant
// work. nearestValue and estimateSpacingMi below operate on this array
// format, not the raw string-keyed object.
function toPointArray(valueMap) {
  const points = [];
  for (const key in valueMap) {
    const commaIdx = key.indexOf(',');
    points.push({
      lat: Number(key.slice(0, commaIdx)),
      lon: Number(key.slice(commaIdx + 1)),
      value: valueMap[key]
    });
  }
  return points;
}

// THE ACTUAL BUG behind "SST Break worked before pixel-compositing and
// stopped after," found from that specific before/after report — not
// server-side data availability at all, and not something further tuning
// of timeouts or striding could ever have fixed, because it was never a
// network problem. downsampleMap (above toPointArray) keeps a lat value
// and a lon value independently, then keeps a point only if BOTH its exact
// lat and its exact lon individually survived — correct for a genuinely
// regular, rectangular grid (true for every OTHER source in this app: one
// query against one dataset's own native grid, where every kept lat
// really does pair with every kept lon in the real data). It was never
// true for the SST composite once compositing existed, because that
// composite can be the union of up to three DIFFERENT sources' grids,
// each with its own independent native resolution and coordinate offset
// — hourly, ACSPO, and MUR don't share a coordinate lattice. On a merged,
// misaligned point scatter like that, a given point's specific (lat, lon)
// pair is essentially unique, so requiring both coordinates to
// independently survive two unrelated, separate selections discards most
// of the data. Confirmed directly, not just reasoned about: a realistic
// 3-source composite (each source already at the 40-point-per-axis
// server-side stride target) retained only 24.9% of its points through
// downsampleMap, against 100% for a single-source grid of the same size —
// and this specific ratio would only get worse or better depending on how
// the real sources happen to align, never reliably safe either way.
//
// Fixed with simple, order-based decimation on the point ARRAY directly
// instead, used specifically for the SST composite (every other source
// keeps using downsampleMap unchanged, since it's genuinely correct for
// them). Correctness here doesn't depend on any grid-regularity
// assumption — it just keeps every Nth point in whatever order they
// happen to be in, regardless of their spatial arrangement, so it can't
// be defeated by multiple misaligned coordinate systems the way the
// lat/lon-independent approach could.
function capPointArray(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const result = [];
  for (let i = 0; i < points.length; i += stride) result.push(points[i]);
  return result;
}

// Gradient magnitude at a point, using the nearest real sample to the center
// and to each neighboring offset — this is what turns a raw field
// (temperature, chlorophyll) into an "edge strength" score, big where the
// value changes fast, which is the front. Also reports whether the center
// point itself reads cooler than its neighbors on average, which wahoo
// scoring uses directly (wahoo favor the cooler side of a break, not just
// break sharpness generically). maxDistanceMi (see estimateSpacingMi) means
// a center or neighbor lookup too far from any real data returns null
// rather than silently borrowing a distant reading.
function gradientAt(valueMap, lat, lon, dLat, dLon, maxDistanceMi) {
  const here = nearestValue(valueMap, lat, lon, maxDistanceMi);
  if (here === null) return null;
  let maxDiff = 0;
  let neighborSum = 0, neighborCount = 0;
  const neighbors = [
    [lat + dLat, lon], [lat - dLat, lon],
    [lat, lon + dLon], [lat, lon - dLon]
  ];
  for (const [nLat, nLon] of neighbors) {
    const val = nearestValue(valueMap, nLat, nLon, maxDistanceMi);
    if (val !== null) {
      maxDiff = Math.max(maxDiff, Math.abs(val - here));
      neighborSum += val;
      neighborCount++;
    }
  }
  const hereIsCooler = neighborCount > 0 && here < (neighborSum / neighborCount);
  return { magnitude: maxDiff, hereIsCooler, value: here };
}

// Plain-and-simple distance between two scoring-grid cell centers, in
// miles — same flat-earth approximation nearestValue already uses
// internally (accurate at the scale this is used for: comparing points a
// few miles apart within a single FIFR zone, not intercontinental
// distances). Used by the neighborhood-convergence search below: how far
// apart are two cells, so "is this within the search radius" can be
// answered directly.
// Vector analog of gradientAt, for a genuine current BREAK/shear signal —
// direct correction found from a precise question: current has only ever
// measured absolute speed (nearestValue on u/v, then magnitude), never a
// break, even though the original framing of the four convergence
// signals explicitly named "current break" alongside temperature break.
// A scalar gradient on speed alone would miss a real, common case: two
// currents converging at different ANGLES but similar speeds still
// creates a genuine shear line — visible current edges, rip lines, and
// convergence zones where debris and bait concentrate are as much about
// directional change as speed change, sometimes more. This measures the
// magnitude of the VECTOR difference between this cell's current and
// each neighbor's — same max-of-4-neighbors structure as gradientAt,
// applied to (u, v) pairs together instead of one scalar field.
function currentShearAt(uValueMap, vValueMap, lat, lon, dLat, dLon, uMaxDistanceMi, vMaxDistanceMi) {
  const hereU = nearestValue(uValueMap, lat, lon, uMaxDistanceMi);
  const hereV = nearestValue(vValueMap, lat, lon, vMaxDistanceMi);
  if (hereU === null || hereV === null) return null;
  let maxDiff = 0;
  const neighbors = [
    [lat + dLat, lon], [lat - dLat, lon],
    [lat, lon + dLon], [lat, lon - dLon]
  ];
  for (const [nLat, nLon] of neighbors) {
    const nU = nearestValue(uValueMap, nLat, nLon, uMaxDistanceMi);
    const nV = nearestValue(vValueMap, nLat, nLon, vMaxDistanceMi);
    if (nU !== null && nV !== null) {
      const dU = nU - hereU, dV = nV - hereV;
      maxDiff = Math.max(maxDiff, Math.sqrt(dU * dU + dV * dV));
    }
  }
  return { magnitude: maxDiff, hereSpeed: Math.sqrt(hereU * hereU + hereV * hereV) };
}

// ---- Ekman transport / wind-driven upwelling (direct request) ----------
// Wind pushes surface water not in the direction it blows, but roughly
// perpendicular to it (90° right in the Northern Hemisphere, left in the
// Southern), because of the Coriolis effect — this is Ekman transport.
// Where that transport diverges (spreads out from a point faster than it
// converges in), the surface water has to be replaced from below: deep,
// cold, nutrient-rich water rises to fill the gap. That's upwelling, and
// it's one of the most reliable drivers of biological productivity in the
// ocean — nutrients feed plankton, plankton feeds bait, bait feeds
// everything this app is trying to find. Where transport converges
// instead, surface water gets pushed down (downwelling) — generally the
// less productive case.
//
// Every formula below was verified against real, independently-documented
// physical cases before being trusted, not just derived and assumed
// correct — an earlier draft had the final sign backwards (caught by
// testing against a known cyclonic-wind-causes-upwelling case, a
// documented wind-jet divergence case, and a clockwise-wind-causes-
// downwelling negative control; all three independently confirmed the fix
// before this shipped).

const EARTH_ROTATION_RAD_S = 7.2921159e-5; // Earth's angular rotation rate
const RHO_AIR = 1.225;   // kg/m^3, standard sea-level air density
const RHO_SEAWATER = 1025; // kg/m^3

// Large & Pond (1981) bulk drag coefficient — a standard, widely-used
// parameterization in physical oceanography for converting wind speed
// into wind stress on the sea surface.
function windDragCoefficient(windSpeedMs) {
  return windSpeedMs < 11 ? 0.0012 : 0.00049 + 0.000065 * windSpeedMs;
}

// Ekman transport (volume transport, m^2/s) at a single point from wind
// velocity — the standard bulk-formula chain: wind -> stress -> transport,
// rotated via the Coriolis parameter. Returns null within 2° of the
// equator (where f -> 0 and the transport formula blows up) — not a
// practically relevant case for this app's Florida/Gulf Stream latitudes,
// but a cheap, correct safety guard regardless.
// Direct correction: chlorophyll and wind are single-day satellite
// snapshots with real, physically-expected coverage gaps (cloud cover
// for optical chlorophyll sensors, swath/pass timing for wind) — unlike
// SST, they had no backfill at all, so a location with a genuine gap in
// that specific day's pass would simply show nothing for that signal,
// even though nearby days' data existed and would have covered it. Fixed
// by reusing the SAME multi-day history data already being fetched for
// persistence (zero new network calls, not a new coupling risk) to fill
// gaps in today's own map — same coverage-based, additive-only merge
// pattern already proven working in SST's own multi-tier compositing:
// never overwrites a genuine today reading, only fills in what's
// actually missing.
function backfillFromHistory(todayMap, histFrames, latMin, latMax, lonMin, lonMax) {
  const COVERAGE_TARGET = 0.90;
  const dLatLocal = (latMax - latMin) / GRID_N;
  const dLonLocal = (lonMax - lonMin) / GRID_N;
  const gridPoints = [];
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      gridPoints.push({ lat: latMin + (i + 0.5) * dLatLocal, lon: lonMin + (j + 0.5) * dLonLocal });
    }
  }
  // Real bug found via direct testing: using the scoring grid's own fine
  // spacing as the coverage-check tolerance works for fine-resolution
  // signals like chlorophyll, but was far too tight for wind's much
  // coarser 0.25° native grid — coverage always read exactly 0 there,
  // regardless of how much wind data genuinely existed, since no
  // scoring cell could ever find a wind point "close enough." Same root
  // cause as the earlier zero-collapse bug in the divergence calculation
  // itself, just surfacing in a different place. Fixed by measuring each
  // map's own actual point spacing instead of assuming one fixed
  // tolerance for every signal — the same SPACING_TOLERANCE_MULTIPLIER *
  // estimateSpacingMi pattern already used for sstMaxDistMi/chlMaxDistMi/
  // windMaxDistMi elsewhere in this file.
  function coverageFraction(map) {
    const points = toPointArray(map);
    if (points.length === 0) return 0;
    const maxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(points);
    let covered = 0;
    for (const g of gridPoints) {
      if (nearestValue(points, g.lat, g.lon, maxDistMi) !== null) covered++;
    }
    return covered / gridPoints.length;
  }
  const merged = Object.assign({}, todayMap);
  const coverageBefore = coverageFraction(merged);
  if (coverageBefore >= COVERAGE_TARGET) return { map: merged, coverageBefore, coverageAfter: coverageBefore, framesUsed: 0 };
  let framesUsed = 0;
  for (let i = histFrames.length - 1; i >= 0; i--) {
    const frame = histFrames[i].map;
    for (const key in frame) {
      if (!(key in merged)) merged[key] = frame[key];
    }
    framesUsed++;
    if (coverageFraction(merged) >= COVERAGE_TARGET) break;
  }
  return { map: merged, coverageBefore, coverageAfter: coverageFraction(merged), framesUsed };
}

function ekmanTransportAt(uWindMap, vWindMap, lat, lon, uMaxDistanceMi, vMaxDistanceMi) {
  const u = nearestValue(uWindMap, lat, lon, uMaxDistanceMi);
  const v = nearestValue(vWindMap, lat, lon, vMaxDistanceMi);
  if (u === null || v === null || Math.abs(lat) < 2) return null;
  const spd = Math.sqrt(u * u + v * v);
  const cd = windDragCoefficient(spd);
  const tauX = RHO_AIR * cd * spd * u;
  const tauY = RHO_AIR * cd * spd * v;
  const f = 2 * EARTH_ROTATION_RAD_S * Math.sin(lat * Math.PI / 180);
  return { Mx: tauY / (f * RHO_SEAWATER), My: -tauX / (f * RHO_SEAWATER) };
}

// The actual upwelling signal: divergence of the Ekman transport field at
// a cell, using the same 4-neighbor finite-difference structure as
// gradientAt/currentShearAt. Positive divergence (transport spreading out)
// means upwelling; negative (transport converging) means downwelling —
// confirmed by mass conservation and verified against three independent
// documented physical cases (see the file-level comment above). Returned
// directly in meters/day of vertical velocity — an interpretable unit
// grounded in a real citation: "upwelling... occurs at a rate of about
// 5-10 meters per day" under typical wind-driven conditions (Wikipedia,
// Upwelling), used below as the normalization anchor.
function ekmanUpwellingMDayAt(uWindMap, vWindMap, lat, lon, dLat, dLon, uMaxDistanceMi, vMaxDistanceMi) {
  const east = ekmanTransportAt(uWindMap, vWindMap, lat, lon + dLon, uMaxDistanceMi, vMaxDistanceMi);
  const west = ekmanTransportAt(uWindMap, vWindMap, lat, lon - dLon, uMaxDistanceMi, vMaxDistanceMi);
  const north = ekmanTransportAt(uWindMap, vWindMap, lat + dLat, lon, uMaxDistanceMi, vMaxDistanceMi);
  const south = ekmanTransportAt(uWindMap, vWindMap, lat - dLat, lon, uMaxDistanceMi, vMaxDistanceMi);
  if (!east || !west || !north || !south) return null;
  const dxMeters = 2 * dLon * (69 * Math.cos(lat * Math.PI / 180)) * 1609.34;
  const dyMeters = 2 * dLat * 69 * 1609.34;
  const divergence = (east.Mx - west.Mx) / dxMeters + (north.My - south.My) / dyMeters; // units: 1/s
  return divergence * 86400; // -> meters/day, positive = upwelling
}

function cellDistanceMi(lat1, lon1, lat2, lon2) {
  const milesPerDegLon = 69 * Math.cos(lat1 * Math.PI / 180);
  const dLatMi = (lat2 - lat1) * 69;
  const dLonMi = (lon2 - lon1) * milesPerDegLon;
  return Math.sqrt(dLatMi * dLatMi + dLonMi * dLonMi);
}

// ---- moon phase (pure math — no API, exact) ----------------------------
// Fraction of the lunar cycle (0 = new, 0.5 = full). Fishing lore (and real
// solunar theory) favors new and full moons — the strongest tides — so the
// bonus peaks at both ends and dips at the quarters.
function moonPhaseInfo(date) {
  const synodic = 29.530588853;
  // Known new moon reference: 2000-01-06 18:14 UTC.
  const ref = Date.UTC(2000, 0, 6, 18, 14, 0);
  const days = (date.getTime() - ref) / 86400000;
  let phase = (days % synodic) / synodic;
  if (phase < 0) phase += 1;
  // Illumination-ish and a "solunar strength" that peaks at new & full —
  // both produce the month's strongest (spring) tides, which is a
  // genuinely symmetric effect.
  const solunar = Math.abs(Math.cos(phase * 2 * Math.PI)); // 1 at new/full, 0 at quarters
  // Deliberately asymmetric, unlike solunar above — direct request: bright
  // moonlight specifically (not the dark of a new moon) lets pelagic
  // predators feed heavily overnight, which multiple charter captains and
  // a fisheries scientist (Dr. Ray Waldner, quoted in Sport Fishing Mag)
  // describe as leaving them comparably lethargic — even "poor to
  // nonexistent" bite — the following day, with new-moon daytime bites
  // reported as the best of the cycle by the same source. Peaks at exactly
  // full (phase=0.5), is exactly 0 through the entire new-moon half of the
  // cycle (unlike solunar, which is symmetric), and is cubed for a
  // sharper falloff concentrated within a few days of full — roughly
  // matching an independent charter-log data point (a ~15% catch-rate
  // change concentrated within 3 days either side of full/new) rather
  // than tapering slowly all the way out to the quarters.
  const fullMoonProximity = Math.pow(Math.max(0, Math.cos((phase - 0.5) * 2 * Math.PI)), 3);
  const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.round(phase * 8) % 8];
  return { phase, solunar, fullMoonProximity, name };
}

// Solar elevation angle (degrees; negative = below the horizon) for a given
// UTC instant and location — the standard NOAA solar position algorithm.
// Verified against known reference facts before being trusted (same
// discipline as the Ekman transport physics elsewhere in this file): Miami
// at summer-solstice solar noon computes to ~84° (expected 80-88°), winter-
// solstice solar noon to ~41° (expected ~40-45°), local midnight to a
// strongly negative angle, and the zero-crossing (sunrise) lands within the
// expected hour. Used below for a smooth, physically real "how deep into
// daytime is it right now" measure — not just a hard day/night flag, so the
// effect fades naturally toward dawn/dusk rather than snapping on and off.
function solarElevationDeg(date, lat, lon) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const jc = (jd - 2451545.0) / 36525.0;

  const geomMeanLongSun = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const geomMeanAnomSun = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccentEarthOrbit = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const sunEqOfCtr = Math.sin(rad * geomMeanAnomSun) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(rad * 2 * geomMeanAnomSun) * (0.019993 - 0.000101 * jc)
    + Math.sin(rad * 3 * geomMeanAnomSun) * 0.000289;
  const sunTrueLong = geomMeanLongSun + sunEqOfCtr;
  const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin(rad * (125.04 - 1934.136 * jc));

  const meanObliqEcliptic = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliqEcliptic + 0.00256 * Math.cos(rad * (125.04 - 1934.136 * jc));
  const sunDeclin = Math.asin(Math.sin(rad * obliqCorr) * Math.sin(rad * sunAppLong)) / rad;

  const varY = Math.tan(rad * obliqCorr / 2) * Math.tan(rad * obliqCorr / 2);
  const eqOfTime = 4 * (varY * Math.sin(2 * rad * geomMeanLongSun)
    - 2 * eccentEarthOrbit * Math.sin(rad * geomMeanAnomSun)
    + 4 * eccentEarthOrbit * varY * Math.sin(rad * geomMeanAnomSun) * Math.cos(2 * rad * geomMeanLongSun)
    - 0.5 * varY * varY * Math.sin(4 * rad * geomMeanLongSun)
    - 1.25 * eccentEarthOrbit * eccentEarthOrbit * Math.sin(2 * rad * geomMeanAnomSun)) / rad;

  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (utcMinutes + eqOfTime + 4 * lon) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const zenithRad = Math.acos(
    Math.sin(rad * lat) * Math.sin(rad * sunDeclin) +
    Math.cos(rad * lat) * Math.cos(rad * sunDeclin) * Math.cos(rad * hourAngle)
  );
  return 90 - zenithRad / rad;
}

// ---- narrative generation ----------------------------------------------
// Template-based, not free-form — this runs in a serverless function with no
// language model access, so it's built from the same component scores that
// actually drove the number, ordered by what matters for the target species.
// Bottom species lead with structure/tide; pelagics lead with the surface
// break/chlorophyll/eddy signals, since those are genuinely what each type
// of fish responds to, not just a stylistic choice.

// Converts a 0-1 score into a 0-5 star rating in 0.5-point increments (11
// possible values: 0, 0.5, 1.0, ... 5.0) — direct request, replacing the
// prose narrative entirely.
function toStars(score) {
  return Math.round(clamp01(score) * 10) / 2;
}

// Builds a star rating (0-5, 0.5 increments) for every input actually
// considered for this spot's score — not just the standout ones. Replaces
// the old prose narrative entirely (direct request: no narrative, star
// ratings of each input instead). Each rating carries a short label, the
// star value, and — where a meaningful real-world number exists — a
// concrete detail alongside it (actual °F, knots, feet), continuing the
// same "what data was considered" transparency the narrative used to
// provide, in a different format. An input the source genuinely wasn't
// available for is omitted entirely rather than shown at a misleading
// neutral rating — same honesty principle as everywhere else in this app
// (e.g. the old factors breakdown already worked this way).
function buildStarRatings(spot, species, sources, moon, pressureScoreVal, tideScoreVal, historyAvailable) {
  const c = spot.components;
  const ratings = [];

  ratings.push(sources.sst
    ? { label: 'SST Break', stars: toStars(c.sst), detail: c.sstGradF !== null ? c.sstGradF.toFixed(1) + '\u00B0F swing' : null, noData: false }
    : { label: 'SST Break', stars: null, detail: 'No data available', noData: true });
  ratings.push(sources.chlorophyll
    ? { label: 'Chlorophyll', stars: toStars(c.chl), detail: null, noData: false }
    : { label: 'Chlorophyll', stars: null, detail: 'No data available', noData: true });
  ratings.push(sources.altimetry
    ? { label: 'Eddy / SSH', stars: toStars(c.eddy), detail: null, noData: false }
    : { label: 'Eddy / SSH', stars: null, detail: 'No data available', noData: true });
  ratings.push(sources.currents
    ? { label: 'Current break', stars: toStars(c.currBreak), detail: c.currBreakKn !== null ? c.currBreakKn.toFixed(1) + ' kn shift' : null, noData: false }
    : { label: 'Current break', stars: null, detail: 'No data available', noData: true });
  ratings.push(sources.structure
    ? { label: 'Structure', stars: toStars(c.struct), detail: c.structDepthChangeFt !== null ? c.structDepthChangeFt + ' ft relief' : null, noData: false }
    : { label: 'Structure', stars: null, detail: 'No data available', noData: true });
  ratings.push(sources.upwelling
    ? { label: 'Upwelling (Ekman)', stars: toStars(c.upwelling), detail: c.upwellingMDay !== null ? (c.upwellingMDay >= 0 ? '+' : '') + c.upwellingMDay.toFixed(1) + ' m/day' : null, noData: false }
    : { label: 'Upwelling (Ekman)', stars: null, detail: 'No data available', noData: true });
  // Local Grounds is always present, like Moon Phase — the underlying
  // groundsInfluenceAt score already scales smoothly with distance to
  // the nearest relevant ground (full credit at the center, fading
  // toward 0 well beyond its radius), so "0 stars, none documented
  // nearby" is itself real information, not a placeholder to hide.
  ratings.push({
    label: 'Local Grounds', stars: toStars(c.zone),
    detail: c.zoneName || 'none documented nearby', noData: false
  });
  if (c.notableFeatures) {
    ratings.push({
      label: 'Feature Intersection', stars: toStars(c.notableFeatures.length / 4),
      detail: c.notableFeatures.length + '/4' + (c.notableFeatures.length > 0 ? ' (' + c.notableFeatures.join(', ') + ')' : ''), noData: false
    });
  }
  ratings.push(historyAvailable
    ? { label: 'Persistence', stars: toStars(c.persistenceDays / 2), detail: c.persistenceDays.toFixed(1) + '/2 prior days (SST + eddy + chlorophyll + upwelling)', noData: false }
    : { label: 'Persistence', stars: null, detail: 'No data available', noData: true });
  if (c.sstTrend) {
    // Directional, not a "how good" score in the same sense as the
    // others — strengthening rates high, steady sits neutral,
    // weakening rates low, matching the bonus/penalty already applied
    // to the score itself.
    const trendStars = c.sstTrend === 'strengthening' ? 4.5 : c.sstTrend === 'weakening' ? 1.0 : 2.5;
    ratings.push({
      label: 'Rate of Change', stars: trendStars,
      detail: c.sstTrend + (c.sstTrendDeltaF !== null ? ' (' + (c.sstTrendDeltaF > 0 ? '+' : '') + c.sstTrendDeltaF + '\u00B0F)' : ''), noData: false
    });
  }

  ratings.push(sources.pressure
    ? { label: 'Pressure Trend', stars: toStars(pressureScoreVal), detail: null, noData: false }
    : { label: 'Pressure Trend', stars: null, detail: 'No data available', noData: true });
  // Moon phase is pure astronomical math — always available, never
  // gated on a fetch succeeding.
  // Moon Phase stars now reflect the SAME combined effect actually applied
  // to the score (solunar strength, reduced by the daytime-full-moon
  // suppression when it's active) — not just the raw tidal-strength
  // number — so what's shown here matches what happened to the score, the
  // same transparency principle every other rating follows. The detail
  // text only calls out the suppression specifically when it's meaningfully
  // engaged (>0.15), rather than adding noise to the common case where it
  // doesn't apply at all.
  const daytimeSuppression = moon.fullMoonProximity * (moon.daylightIntensity || 0);
  const moonEffectiveStrength = clamp01(moon.solunar * (1 - 0.20 * daytimeSuppression));
  ratings.push({
    label: 'Moon Phase', stars: toStars(moonEffectiveStrength),
    detail: daytimeSuppression > 0.15 ? moon.name + ' (daytime bite may be slow)' : moon.name, noData: false
  });

  return ratings;
}

// ---- main handler ------------------------------------------------------

// THE ACTUAL FIX for the third "still missing" report: weather (wind),
// tide, and pressure were structurally forced to wait for the ENTIRE
// round-1 Promise.all() to settle — including the SST chain, chlorophyll,
// altimetry, currents, and bathymetry — even though none of that data is
// actually needed here. This was never a real dependency, just an
// accident of how the code was originally grouped. Whenever the SST
// chain (by far the slowest round-1 fetch, especially after it grew a
// 3-tier resilience chain) took a while, wind/tide/pressure's own
// downstream rounds were starved of whatever time happened to be left —
// not because they needed to wait, but purely because of where they sat
// in the code. Extracted into its own self-contained function so it can
// be its own entry in the main Promise.all() below, running truly
// concurrently with the oceanographic fetches rather than sequentially
// after them.
//
// Mutates the shared `sources` object directly (passed by reference,
// standard JS object semantics) for the same fields it always has
// (sources.weather, sources.weatherDetail, sources.tide,
// sources.tideDetail, sources.pressure) — nothing about what gets tracked
// changed, only when this work happens relative to everything else.
async function fetchWeatherTidePressureChain(cLat, cLon, sources, remainingBudgetMsFn) {
  const [weatherR, tideR] = await Promise.all([
    fetchJSON(`https://api.weather.gov/points/${cLat.toFixed(4)},${cLon.toFixed(4)}`, Math.min(remainingBudgetMsFn(), 5000)),
    fetchJSON('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions', Math.min(remainingBudgetMsFn(), 5000))
  ]);

  // Nearest tide station — synchronous, no fetch.
  let nearestTideStation = null;
  if (tideR.ok && tideR.data.stations && tideR.data.stations.length) {
    let nd = Infinity;
    for (const s of tideR.data.stations) {
      const d = Math.abs(s.lat - cLat) + Math.abs(s.lng - cLon);
      if (d < nd) { nd = d; nearestTideStation = s; }
    }
  }
  let tidePredUrl = null;
  if (nearestTideStation) {
    const today = new Date();
    const ymd = today.getUTCFullYear() +
      String(today.getUTCMonth() + 1).padStart(2, '0') +
      String(today.getUTCDate()).padStart(2, '0');
    tidePredUrl = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter' +
      `?product=predictions&application=bluewater&begin_date=${ymd}&end_date=${ymd}` +
      `&datum=MLLW&station=${nearestTideStation.id}&time_zone=lst_ldt&units=english&interval=hilo&format=json`;
  }

  // Round 2: wind's forecast fetch, pressure's station lookup, and tide
  // predictions — three fetches that each depend only on weatherR/tideR
  // above, not on each other. If there's not enough budget left, skip
  // outright rather than risk going over — all three fall back to neutral
  // gracefully when unavailable.
  const round2Budget = Math.min(remainingBudgetMsFn(), 2500);
  const [fhR, stationsR, tidePredR] = round2Budget < 500
    ? [{ ok: false }, { ok: false }, { ok: false }]
    : await Promise.all([
        (weatherR.ok && weatherR.data.properties && weatherR.data.properties.forecastHourly)
          ? fetchJSON(weatherR.data.properties.forecastHourly, round2Budget) : Promise.resolve({ ok: false }),
        (weatherR.ok && weatherR.data.properties && weatherR.data.properties.observationStations)
          ? fetchJSON(weatherR.data.properties.observationStations, round2Budget) : Promise.resolve({ ok: false }),
        tidePredUrl ? fetchJSON(tidePredUrl, round2Budget) : Promise.resolve({ ok: false })
      ]);

  // Wind: still fetched and shown as plain informational context (the
  // "Wind: X mph" text in the forecast panel), but direct request — no
  // longer a scoring input. No windScore computed at all now.
  try {
    if (fhR.ok && fhR.data.properties && fhR.data.properties.periods && fhR.data.properties.periods.length) {
      const now = fhR.data.properties.periods[0];
      const windMph = parseFloat(String(now.windSpeed).replace(/[^\d.]/g, '')) || 0;
      sources.weather = true;
      sources.weatherDetail = { windMph, shortForecast: now.shortForecast };
    }
  } catch (e) { /* leave sources.weather as already set */ }
  if (sources.weather === undefined) sources.weather = false;

  // Tides: score by how much water is *moving* (big range between highs and
  // lows means stronger tidal current).
  let tideScore = 0.5;
  try {
    if (tidePredR.ok && tidePredR.data.predictions && tidePredR.data.predictions.length > 1) {
      const vals = tidePredR.data.predictions.map((p) => parseFloat(p.v));
      const range = Math.max(...vals) - Math.min(...vals);
      tideScore = norm(range, 1, 8);
      sources.tide = true;
      sources.tideDetail = { station: nearestTideStation.name, id: nearestTideStation.id, rangeFt: +range.toFixed(1) };
    }
  } catch (e) { /* leave tideScore neutral */ }
  if (sources.tide === undefined) sources.tide = false;

  // Barometric pressure TREND, not just the current reading — the real,
  // well-established signal serious anglers watch: a falling barometer ahead
  // of a front often triggers aggressive feeding, while a sharp rise behind a
  // front (a clearing high settling in) typically shuts the bite down.
  // Pulled from actual observation history at the nearest station over
  // roughly the last day — real recent conditions, not a forecast. This is
  // the one remaining sequential hop after round 2 — it needs the station
  // ID that round 2's observationStations fetch just returned — but it's
  // only one hop, not stacked behind wind and tide like before either.
  let pressureScore = 0.5; // neutral default
  let pressureDetail = null;
  try {
    const round3Budget = Math.min(remainingBudgetMsFn(), 1500);
    if (round3Budget >= 500 && stationsR.ok && stationsR.data.features && stationsR.data.features.length) {
      const stationId = stationsR.data.features[0].properties.stationIdentifier;
      // ~30 hourly-ish readings comfortably covers a 24h lookback window.
      const obsR = await fetchJSON(`https://api.weather.gov/stations/${stationId}/observations?limit=30`, round3Budget);
      if (obsR.ok && obsR.data.features && obsR.data.features.length) {
        // Features come back newest-first. Pull every valid (timestamp, hPa)
        // reading, then compare the latest to the one nearest 24h back.
        const readings = obsR.data.features
          .map((f) => ({
            t: new Date(f.properties.timestamp).getTime(),
            hpa: (f.properties.barometricPressure && f.properties.barometricPressure.value !== null)
              ? f.properties.barometricPressure.value / 100 // Pa -> hPa
              : null
          }))
          .filter((r) => r.hpa !== null && isFinite(r.hpa));

        if (readings.length >= 2) {
          const latest = readings[0];
          const targetTime = latest.t - 24 * 3600 * 1000;
          let best = readings[readings.length - 1], bestDiff = Infinity;
          for (const r of readings) {
            const diff = Math.abs(r.t - targetTime);
            if (diff < bestDiff) { bestDiff = diff; best = r; }
          }
          const deltaHpa = +(latest.hpa - best.hpa).toFixed(1);
          const hoursSpan = +((latest.t - best.t) / 3600000).toFixed(1);

          let trendWord;
          if (deltaHpa <= -2) { trendWord = 'falling'; pressureScore = 0.9; }
          else if (deltaHpa <= -0.5) { trendWord = 'slowly falling'; pressureScore = 0.72; }
          else if (deltaHpa < 0.5) { trendWord = 'steady'; pressureScore = 0.6; }
          else if (deltaHpa < 2) { trendWord = 'slowly rising'; pressureScore = 0.45; }
          else { trendWord = 'rising sharply'; pressureScore = 0.25; }

          sources.pressure = true;
          pressureDetail = {
            nowHpa: +latest.hpa.toFixed(1), deltaHpa, hoursSpan, trend: trendWord
          };
        }

        // WIND FALLBACK (informational only now): if the gridded hourly
        // forecast above didn't produce usable wind data, try this SAME
        // observations response (already fetched successfully for
        // pressure) instead of leaving the wind display empty.
        // forecastHourly is a WFO-generated gridded product with real,
        // NWS-documented US-only coverage — a 404 is possible entirely
        // outside it, and even within nominal coverage the hourly-period
        // product is fundamentally land-forecasting, not guaranteed to
        // extend meaningfully offshore. Station observations come from
        // physical instruments (including NDBC buoys) rather than the
        // gridded forecast system, so they don't share that limitation —
        // a genuinely independent second source, not just a retry of the
        // same one, using data already in hand rather than an extra fetch.
        if (!sources.weather) {
          try {
            const withWind = obsR.data.features.find((f) =>
              f.properties.windSpeed && f.properties.windSpeed.value !== null && isFinite(f.properties.windSpeed.value));
            if (withWind) {
              // NWS station observations report windSpeed in km/h (unlike
              // forecastHourly's US-customary "8 mph" strings) — convert to
              // mph for display consistency with the primary source.
              const windKph = withWind.properties.windSpeed.value;
              const windMph = windKph * 0.621371;
              sources.weather = true;
              sources.weatherDetail = { windMph: +windMph.toFixed(1), shortForecast: null, fallbackSource: 'station-observation' };
            }
          } catch (e) { /* leave sources.weather as already set */ }
        }
      }
    }
  } catch (e) { /* leave pressureScore neutral */ }
  if (sources.pressure === undefined) sources.pressure = false;

  return { tideScore, pressureScore, pressureDetail };
}

exports.handler = async function (event) {
  // Declared before the try block specifically so it's accessible in the
  // catch block too — a const declared inside try is block-scoped to try
  // only and would throw a ReferenceError if referenced from catch, which
  // would defeat the entire point of having a safety net.
  const FUNCTION_START = Date.now();
  try {
  const qs = event.queryStringParameters || {};
  let latMin = parseFloat(qs.latMin);
  let latMax = parseFloat(qs.latMax);
  let lonMin = parseFloat(qs.lonMin);
  let lonMax = parseFloat(qs.lonMax);

  if ([latMin, latMax, lonMin, lonMax].some((v) => !isFinite(v))) {
    return json(400, { ok: false, message: 'latMin, latMax, lonMin, lonMax are all required and must be numbers.' });
  }

  // How many top spots to return, user-adjustable client-side (1-15,
  // default 5) — but re-validated here regardless of what's sent, since a
  // request parameter is never trusted to already be in range.
  const rawPointCount = parseInt(qs.pointCount, 10);
  const pointCount = (isFinite(rawPointCount) && rawPointCount >= 1 && rawPointCount <= 15) ? rawPointCount : 5;

  // The analyzed area is always a SQUARE — equal real-world miles in both
  // directions — capped at a maximum side length of 50 miles (a 50x50mi
  // square, 2500 sq mi total).
  //
  // Direct correction to a real, major bug: this used to ALSO shrink the
  // incoming box to "50% of its own smaller dimension" before applying
  // the 50-mile cap — but the client already computes that exact same
  // 50%-of-viewport, capped-at-50mi box BEFORE ever sending the request
  // (see computeCappedForecastBounds() client-side). The incoming
  // latMin/latMax/lonMin/lonMax here were already that final, intended
  // box, not a raw map viewport needing its own independent shrink.
  // Applying the same 50% rule a second time meant the server was
  // actually analyzing roughly a QUARTER of the geographic area the
  // client displayed and the person saw drawn on the map (half the side
  // length in each dimension) — invisible until the response redrew the
  // area box to match what was actually scored, at which point it
  // visibly shrank. Only the 50-mile maximum is kept now, as a
  // server-side safety backstop against an unbounded area from a direct
  // API call bypassing the client entirely — not an additional shrink of
  // whatever the client already sized.
  const origCLat = (latMin + latMax) / 2;
  const origCLon = (lonMin + lonMax) / 2;
  const milesPerDegLat = 69;
  const milesPerDegLon = 69 * Math.cos(origCLat * Math.PI / 180);
  const milesPerDegLonSafe = Math.max(milesPerDegLon, 1); // guard against cos()->0 near the poles

  const MAX_SIDE_MILES = 50;

  const requestedLatMiles = (latMax - latMin) * milesPerDegLat;
  const requestedLonMiles = (lonMax - lonMin) * milesPerDegLonSafe;
  // The SMALLER of the two requested dimensions is what a square can
  // fully fit within on both axes — using the larger one instead would
  // let the analyzed area exceed what was actually requested on its
  // constraining axis.
  const requestedSmallerDimMiles = Math.min(requestedLatMiles, requestedLonMiles);

  const squareSideMiles = Math.min(requestedSmallerDimMiles, MAX_SIDE_MILES);
  const areaWasCapped = requestedSmallerDimMiles > MAX_SIDE_MILES;

  const squareLatSpan = squareSideMiles / milesPerDegLat;
  const squareLonSpan = squareSideMiles / milesPerDegLonSafe;
  latMin = origCLat - squareLatSpan / 2;
  latMax = origCLat + squareLatSpan / 2;
  lonMin = origCLon - squareLonSpan / 2;
  lonMax = origCLon + squareLonSpan / 2;

  // Direct request: use mahi settings for every forecast, no species
  // selection at all. qs.species is no longer read.
  const species = 'mahi';

  const cLat = (latMin + latMax) / 2;
  const cLon = (lonMin + lonMax) / 2;
  // Same striding fix as buildCompositeSst/fetchSstHistoryWithFallback
  // above, extended here too: every gridded ERDDAP query in this file was
  // requesting full native satellite/model resolution with no stride at
  // all, not just the SST ones. These are single-frame ("(last)") queries
  // rather than multi-day ranges, so the risk was smaller to begin with —
  // but the fix is the same proven mechanism, and there's no reason to
  // leave the other sources fetching more resolution than the ~40-point
  // scoring grid will ever use, once the underlying issue was understood.
  const latStride = erddapStride(latMax - latMin);
  const lonStride = erddapStride(lonMax - lonMin);
  const bbox = `[(last)][(${latMin}):${latStride}:(${latMax})][(${lonMin}):${lonStride}:(${lonMax})]`;

  // Track which sources actually succeeded, for the response + debugging.
  const sources = {};

  // A hard overall time budget for the whole function, not just individual
  // fetch timeouts. This is a more robust fix than tuning individual
  // numbers, because it protects against the timeout regardless of WHICH
  // step turns out to be the slow one — network latency on any one source,
  // or the scoring computation itself — rather than betting on a specific
  // diagnosis. Kept safely under even a conservative 10s platform limit,
  // leaving real margin for the scoring loop after fetches complete.
  const TOTAL_BUDGET_MS = 8500;
  function remainingBudgetMs(){ return Math.max(300, TOTAL_BUDGET_MS - (Date.now() - FUNCTION_START)); }

  // --- Round 1: everything with no dependencies, fully parallel ---------
  // Bathymetry moved in here too — it never depended on anything else, so
  // it was previously running as an extra sequential hop after everything
  // below for no real reason, adding to a fetch chain that risked exceeding
  // the function's execution time limit.
  //
  // PERSISTENCE / RATE-OF-CHANGE (added on direct request): a front that's
  // held the same position for several days has had time to accumulate
  // weed, plankton, and bait — a materially different, better bet than an
  // identical-looking front that appeared five minutes ago. This needs
  // actual historical data, not just today's snapshot, so a second SST
  // fetch requests a 4-day time RANGE (confirmed ERDDAP syntax: explicit
  // ISO timestamps as the start/stop of the time dimension) rather than
  // "(last)" — generous enough to robustly catch at least 3 distinct valid
  // days even if the most recent day's composite isn't fully processed yet
  // (the same reason the primary SST fetch below uses "(last)" instead of
  // an exact date). This is scoped to SST specifically, matching the
  // "front persistence" framing of the request directly, rather than every
  // source at once.
  const historyStart = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  // Chlorophyll-specific, wider than the shared 4-day window above.
  // erdMH1chla1day (NASA/GSFC MODIS, the dataset actually settled on
  // after two earlier attempts both turned out to be blocked or aliased
  // to a blocked source) is a "science quality" rather than near-real-
  // time product, so it can carry meaningfully more processing latency
  // than SST/SSH/wind. 20 days back keeps this well clear of that,
  // rather than requesting a range that risks landing entirely before
  // any data exists yet.
  const chlHistoryStart = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  // No explicit end date: the history fetch anchors its range end to 'last'
  // internally (ERDDAP's guaranteed-newest-point token), for the same
  // confirmed-latency reason as the composite tiers above — a hardcoded
  // "today" reaches past these datasets' actual newest data.

  // The default latStride/lonStride assume dense ~0.01° SST-class
  // resolution. Chlorophyll (VIIRS SectorVY) is ~0.0375° natively —
  // confirmed from the dataset's own metadata, roughly 4x coarser — so
  // applying the SST-tuned stride to it over-strides badly: it could
  // request so few actual native points that the response comes back
  // near-empty or misses the small scoring area entirely, which is a
  // strong candidate for why chlorophyll specifically has been missing
  // so consistently. Computing its stride against its own real resolution
  // keeps roughly the same target point density every other source gets.
  // (Altimetry and currents go through the shared `bbox`, which is
  // unstrided-per-fetch by construction below and unaffected; this is
  // specifically the one gridded source that both has a coarse native
  // resolution AND gets an explicit per-axis stride.)
  const chlLatStride = erddapStride(latMax - latMin, 40, 0.0375);
  const chlLonStride = erddapStride(lonMax - lonMin, 40, 0.0375);

  // Wind (Ekman/upwelling): CCMP daily NRT is also natively 0.25° — much
  // coarser than any other source this app uses — so it gets its own
  // stride computation against its real resolution, same reasoning as
  // chlorophyll above. It also uses 0-360° longitude (confirmed directly
  // from its metadata), unlike every other source here, which are all
  // -180/180 — a real, easy-to-miss mismatch, handled explicitly by
  // to360Lon rather than assumed away.
  const windLatStride = erddapStride(latMax - latMin, 40, 0.25);
  const windLonStride = erddapStride(lonMax - lonMin, 40, 0.25);
  function to360Lon(lon) { return lon < 0 ? lon + 360 : lon; }
  const windLonMin360 = to360Lon(lonMin), windLonMax360 = to360Lon(lonMax);
  // Real, latent bug just exposed now that wind actually returns data for
  // the first time: the Ekman divergence calculation was sampling four
  // points offset by the scoring grid's own dLat/dLon (~0.04° across a
  // 50mi area) — roughly 6x finer than wind's real 0.25° resolution. All
  // four east/west/north/south samples frequently landed on the exact
  // same underlying wind grid cell (nearestValue returning the identical
  // point for each), collapsing the divergence to precisely zero — not
  // because upwelling was genuinely absent, but because the offset was
  // too small to ever reach a neighboring cell. This bug existed even
  // before this round's dataset switch (the old wind dataset was also
  // 0.25°); it just never surfaced, since wind never successfully
  // returned real data until now. Fixed with an offset matched to wind's
  // own actual resolution, not the scoring grid's.
  const windGradDLat = 0.25, windGradDLon = 0.25;

  const [
    sstResult, chlR, sshR, uR, vR, weatherTidePressureResult, bathyR, sstHistResult, uWindR, vWindR,
    chlHistResult, sshHistResult, uWindHistResult, vWindHistResult
  ] = await Promise.all([
    buildCompositeSst(latMin, latMax, lonMin, lonMax, remainingBudgetMs),
    // Direct correction, found via two rounds of live diagnostic evidence:
    // the previous replacement (nesdisVHNSQchlaDaily) turned out to be an
    // internal alias/mirror of the SAME blocked noaacw-namespace source —
    // its own error messages named noaacwNPPVIIRSSQchlaDaily, the exact
    // prefix already confirmed blocked everywhere else. Switched to
    // erdMH1chla1day — NASA/GSFC MODIS data, a genuinely different
    // satellite and processing pipeline, not a NOAA CoastWatch product at
    // all. Its actual variable name is 'chlorophyll', not 'chlor_a' —
    // confirmed directly from a real, working query example, not assumed
    // from the pattern other chlorophyll datasets use. No altitude
    // dimension either, unlike the VIIRS-based datasets tried before —
    // confirmed the same way, from an actual working query.
    fetchJSON(`https://coastwatch.pfeg.noaa.gov/erddap/griddap/erdMH1chla1day.json?chlorophyll[(last)][(${latMin}):${chlLatStride}:(${latMax})][(${lonMin}):${chlLonStride}:(${lonMax})]`, Math.min(remainingBudgetMs(), 5000)),
    fetchJSON(`${ERDDAP}/miamidynamicheight.json?sea_surface_height_above_geoid${bbox}`, Math.min(remainingBudgetMs(), 5000)),
    fetchJSON(`${ERDDAP}/miamicurrents.json?u_current${bbox}`, Math.min(remainingBudgetMs(), 5000)),
    fetchJSON(`${ERDDAP}/miamicurrents.json?v_current${bbox}`, Math.min(remainingBudgetMs(), 5000)),
    // Weather/tide/pressure's entire chain (including its own internal
    // round 2 and round 3) is now ONE self-contained entry here, running
    // truly concurrently with the SST chain and everything else — not
    // forced to wait for them the way it used to be, despite never
    // actually needing any of that data. See fetchWeatherTidePressureChain
    // above for the full explanation.
    fetchWeatherTidePressureChain(cLat, cLon, sources, remainingBudgetMs),
    fetchJSON(`https://coastwatch.pfeg.noaa.gov/erddap/griddap/GEBCO_2020.json?elevation[(${latMin}):${latStride}:(${latMax})][(${lonMin}):${lonStride}:(${lonMax})]`, Math.min(remainingBudgetMs(), 5000)),
    fetchSstHistoryWithFallback(latMin, latMax, lonMin, lonMax, historyStart, remainingBudgetMs),
    // Wind, for Ekman transport / upwelling: (last) time anchor for the
    // same latency-safety reason as the SST/history sources above. 0-360
    // longitude, confirmed directly from the dataset's own metadata.
    // Direct correction, confirmed via a live diagnostic report: the
    // previous wind dataset (noaacwBlendedWindsDaily) is on
    // coastwatch.noaa.gov, which returns HTTP 403 on every query to it —
    // same host-level block already found and fixed for SST/chlorophyll
    // sources. Switched to CCMP daily NRT on oceanwatch.pifsc.noaa.gov, a
    // host confirmed reachable via a real probe (status 200, real data
    // returned — not just assumed from a search). Variable names are
    // 'uwnd'/'vwnd' here, not 'u_wind'/'v_wind', and this dataset carries
    // no altitude dimension at all (confirmed directly — the old
    // dataset's [(10.0)] bracket doesn't apply here and was the actual
    // cause of an earlier 400 error against this same dataset).
    fetchJSON(`https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ccmp-daily-v2-1-NRT.json?uwnd[(last)][(${latMin}):${windLatStride}:(${latMax})][(${windLonMin360}):${windLonStride}:(${windLonMax360})]`, Math.min(remainingBudgetMs(), 5000)),
    fetchJSON(`https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ccmp-daily-v2-1-NRT.json?vwnd[(last)][(${latMin}):${windLatStride}:(${latMax})][(${windLonMin360}):${windLonStride}:(${windLonMax360})]`, Math.min(remainingBudgetMs(), 5000)),
    // Direct correction, reverting an earlier merge: chlorophyll/SSH/wind
    // history is fetched as its OWN separate request again, not folded
    // into "today's" fetch above. That merge was meant to cut duplicate
    // requests to the same host, but it had a real cost that likely
    // outweighed the benefit — it made today's core signal depend on the
    // SAME request as history's much larger, multi-day, inherently
    // slower-and-riskier query succeeding. If persistence's own fetch is
    // ever slow or fails, that must never be able to take today's actual
    // forecast signal down with it. Separate requests cost more
    // connections; a core signal's reliability depending on a bonus
    // feature's fetch succeeding is the worse trade.
    fetchHistoryGeneric(`https://coastwatch.pfeg.noaa.gov/erddap/griddap/erdMH1chla1day.json?chlorophyll[(${chlHistoryStart}):(last)][(${latMin}):${chlLatStride}:(${latMax})][(${lonMin}):${chlLonStride}:(${lonMax})]`, 'chlorophyll', Math.min(remainingBudgetMs(), 5000)),
    fetchHistoryGeneric(`${ERDDAP}/miamidynamicheight.json?sea_surface_height_above_geoid[(${historyStart}):(last)][(${latMin}):${latStride}:(${latMax})][(${lonMin}):${lonStride}:(${lonMax})]`, 'sea_surface_height_above_geoid', Math.min(remainingBudgetMs(), 5000)),
    fetchHistoryGeneric(`https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ccmp-daily-v2-1-NRT.json?uwnd[(${historyStart}):(last)][(${latMin}):${windLatStride}:(${latMax})][(${windLonMin360}):${windLonStride}:(${windLonMax360})]`, 'uwnd', Math.min(remainingBudgetMs(), 5000)),
    fetchHistoryGeneric(`https://oceanwatch.pifsc.noaa.gov/erddap/griddap/ccmp-daily-v2-1-NRT.json?vwnd[(${historyStart}):(last)][(${latMin}):${windLatStride}:(${latMax})][(${windLonMin360}):${windLonStride}:(${windLonMax360})]`, 'vwnd', Math.min(remainingBudgetMs(), 5000))
  ]);
  const { tideScore, pressureScore, pressureDetail } = weatherTidePressureResult;

  // --- Build per-source value maps (each defensive) ---------------------
  // Downsampled immediately after parsing — see downsampleMap's comment for
  // why this matters as much as the area cap above, if not more.
  //
  // sstResult.map is already the finished, pixel-backfilled composite
  // (buildCompositeSst handles every tier's fetch, parse, and merge
  // internally), so no ok-guard is needed here the way the other sources
  // still need one.
  const MAX_PER_AXIS = 40;
  const sstMap = capPointArray(toPointArray(sstResult.map), MAX_PER_AXIS * MAX_PER_AXIS);
  const chlTodayRawMap = chlR.ok ? erddapToMap(chlR.data, 'chlorophyll') : {};
  const chlBackfill = backfillFromHistory(chlTodayRawMap, chlHistResult.frames, latMin, latMax, lonMin, lonMax);
  const chlMap = toPointArray(downsampleMap(chlBackfill.map, MAX_PER_AXIS));
  const sshMap = toPointArray(downsampleMap(sshR.ok ? erddapToMap(sshR.data, 'sea_surface_height_above_geoid') : {}, MAX_PER_AXIS));
  const uMap = toPointArray(downsampleMap(uR.ok ? erddapToMap(uR.data, 'u_current') : {}, MAX_PER_AXIS));
  const vMap = toPointArray(downsampleMap(vR.ok ? erddapToMap(vR.data, 'v_current') : {}, MAX_PER_AXIS));
  const bathyMap = toPointArray(downsampleMap(bathyR.ok ? erddapToMap(bathyR.data, 'elevation') : {}, MAX_PER_AXIS));
  // Wind's 0-360 longitude (confirmed from its metadata) converted back to
  // this app's -180/180 convention right after parsing — erddapToMap
  // builds its points directly from the response's own coordinate values,
  // so without this, every later nearestValue lookup (which all use
  // -180/180) would silently never match a single wind point.
  const uWindTodayRawMap = uWindR.ok ? erddapToMap(uWindR.data, 'uwnd') : {};
  const uWindBackfill = backfillFromHistory(uWindTodayRawMap, uWindHistResult.frames, latMin, latMax, windLonMin360, windLonMax360);
  const uWindMapRaw = toPointArray(downsampleMap(uWindBackfill.map, MAX_PER_AXIS));
  const vWindTodayRawMap = vWindR.ok ? erddapToMap(vWindR.data, 'vwnd') : {};
  const vWindBackfill = backfillFromHistory(vWindTodayRawMap, vWindHistResult.frames, latMin, latMax, windLonMin360, windLonMax360);
  const vWindMapRaw = toPointArray(downsampleMap(vWindBackfill.map, MAX_PER_AXIS));
  function from360Lon(lon) { return lon > 180 ? lon - 360 : lon; }
  const uWindMap = uWindMapRaw.map((p) => ({ lat: p.lat, lon: from360Lon(p.lon), value: p.value }));
  const vWindMap = vWindMapRaw.map((p) => ({ lat: p.lat, lon: from360Lon(p.lon), value: p.value }));

  // Distance-cutoff fix: each map gets its own tolerance, scaled to how
  // densely that specific source's data actually came back this run (cloud
  // cover, sensor gaps, or just a naturally coarser dataset like altimetry
  // all affect this differently, so one fixed number wouldn't fit all of
  // them). SPACING_TOLERANCE_MULTIPLIER (module scope, shared with the SST
  // compositing coverage check below) is 2.5x a map's own typical point
  // spacing — generous enough to cover normal grid gaps without also
  // silently accepting a genuinely distant reading as if it were local.
  const sstMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(sstMap);
  const chlMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(chlMap);
  const sshMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(sshMap);
  const uMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(uMap);
  const vMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(vMap);
  const bathyMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(bathyMap);
  const uWindMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(uWindMap);
  const vWindMaxDistMi = SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(vWindMap);

  // Persistence / rate-of-change: up to the 3 most recent distinct days from
  // the history fetch, each converted to the same point-array format (and
  // given its own distance threshold, same principle as every other source
  // here) so gradientAt works identically against a historical day as it
  // does against today.
  const sstHistDaysRaw = sstHistResult.frames;
  let sstHistDays = sstHistDaysRaw.slice(-3).map((d) => {
    const points = toPointArray(downsampleMap(d.map, MAX_PER_AXIS));
    return { time: d.time, points, maxDistMi: SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(points) };
  });

  // Same treatment for eddy, chlorophyll, and upwelling's own history —
  // direct correction: persistence now considers whether the FULL feature
  // intersection (all four signals, not SST alone) held together nearby
  // across prior days, not just whether SST break itself did.
  let chlHistDays = chlHistResult.frames.slice(0, -1).slice(-3).map((d) => { // slice(0,-1) drops the most recent frame, since that's now also used as today's own map above, not a "prior day"
    const points = toPointArray(downsampleMap(d.map, MAX_PER_AXIS));
    return { time: d.time, points, maxDistMi: SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(points) };
  });
  let sshHistDays = sshHistResult.frames.slice(0, -1).slice(-3).map((d) => { // same exclusion as chlHistDays above
    const points = toPointArray(downsampleMap(d.map, MAX_PER_AXIS));
    return { time: d.time, points, maxDistMi: SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(points) };
  });
  // Wind history keeps u and v as separate parallel-indexed arrays (same
  // day at the same array index in each) rather than merging them, since
  // ekmanUpwellingMDayAt takes two separate maps, same as it does for
  // today's u/v wind.
  let uWindHistDays = uWindHistResult.frames.slice(0, -1).slice(-3).map((d) => { // same exclusion as chlHistDays above
    // Same from360Lon conversion today's uWindMap/vWindMap already apply
    // (see below) — without it, these points stay in u_wind's native
    // 0-360 longitude range while every lookup against them uses normal
    // -180/180 coordinates, so proximity checks would silently fail here
    // even though today's wind processing already handles this correctly.
    const converted = {};
    for (const key in d.map) {
      const [latStr, lonStr] = key.split(',');
      const newLon = from360Lon(parseFloat(lonStr));
      converted[latStr + ',' + newLon] = d.map[key];
    }
    const points = toPointArray(downsampleMap(converted, MAX_PER_AXIS));
    return { time: d.time, points, maxDistMi: SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(points) };
  });
  let vWindHistDays = vWindHistResult.frames.slice(0, -1).slice(-3).map((d) => { // same exclusion as chlHistDays above
    const converted = {};
    for (const key in d.map) {
      const [latStr, lonStr] = key.split(',');
      const newLon = from360Lon(parseFloat(lonStr));
      converted[latStr + ',' + newLon] = d.map[key];
    }
    const points = toPointArray(downsampleMap(converted, MAX_PER_AXIS));
    return { time: d.time, points, maxDistMi: SPACING_TOLERANCE_MULTIPLIER * estimateSpacingMi(points) };
  });

  // Direct correction: persistence now needs ALL FOUR signals' history to
  // agree on which calendar day they're each talking about, not just line
  // up by array position. Each was fetched independently (different
  // satellites, different processing latency), so their available dates
  // can genuinely differ — matching by index alone risked silently
  // comparing SST's Tuesday against chlorophyll's Monday. Matched on the
  // date portion only (not full timestamp), since different products
  // stamp a different time-of-day even for "the same day."
  function dateOnly(isoTime) { return isoTime.slice(0, 10); }
  const sstDatesSet = new Set(sstHistDays.map((d) => dateOnly(d.time)));
  const chlDatesSet = new Set(chlHistDays.map((d) => dateOnly(d.time)));
  const sshDatesSet = new Set(sshHistDays.map((d) => dateOnly(d.time)));
  const uWindDatesSet = new Set(uWindHistDays.map((d) => dateOnly(d.time)));
  const vWindDatesSet = new Set(vWindHistDays.map((d) => dateOnly(d.time)));
  const commonHistoryDates = [...sstDatesSet]
    .filter((d) => chlDatesSet.has(d) && sshDatesSet.has(d) && uWindDatesSet.has(d) && vWindDatesSet.has(d))
    .sort(); // oldest first, same convention as the individual *HistDays arrays
  function alignToCommonDates(histDays) {
    return commonHistoryDates.map((date) => histDays.find((d) => dateOnly(d.time) === date));
  }
  // Reassigned in place (not renamed) so pass 1's per-signal history loops
  // below, written against these same names, automatically get the
  // date-aligned version with no further changes needed there.
  sstHistDays = alignToCommonDates(sstHistDays);
  chlHistDays = alignToCommonDates(chlHistDays);
  sshHistDays = alignToCommonDates(sshHistDays);
  uWindHistDays = alignToCommonDates(uWindHistDays);
  vWindHistDays = alignToCommonDates(vWindHistDays);

  // Direct correction: none of today's chlorophyll/SSH/current/wind/bathy
  // fetches had ANY failure-reason logging before now — only the history
  // fetches did. That's the actual gap behind two rounds of guessing at
  // structural causes (duplicate requests, then coupled reliability)
  // without being able to see which fetch was actually failing or why.
  // Same shape as every other diagnostic log in this file: 'ok', or
  // 'fetch-failed:httpNNN' / 'fetch-failed:<reason>' — enough to tell a
  // genuine HTTP error from a timeout from a malformed response.
  function describeFetchResult(r) {
    if (r.ok) return 'ok';
    if (r.status) return 'fetch-failed:http' + r.status;
    return 'fetch-failed:' + (r.error || 'unknown');
  }
  sources.chlTodayLog = [describeFetchResult(chlR)];
  sources.sshTodayLog = [describeFetchResult(sshR)];
  sources.uCurrentLog = [describeFetchResult(uR)];
  sources.vCurrentLog = [describeFetchResult(vR)];
  sources.uWindTodayLog = [describeFetchResult(uWindR)];
  sources.vWindTodayLog = [describeFetchResult(vWindR)];
  sources.bathyLog = [describeFetchResult(bathyR)];

  sources.sst = sstMap.length > 0;
  sources.sstCoverage = +sstResult.coverage.toFixed(3); // fraction of the actual scoring-grid cells with a usable nearby SST reading after compositing
  sources.sstReachedTarget = sstResult.reachedTarget; // did backfilling actually reach the 90% target, or just do its best across all three tiers
  sources.sstLog = sstResult.log; // the full frame-by-frame compositing trail (e.g. ["hourly@2026-07-09T14:00:00Z:+210px,cov=65%", "hourly@...:+80px,cov=91%"]) — not shown in the app; kept for direct diagnosis rather than guessing, same principle as everywhere else here
  sources.sstHistoryLog = sstHistResult.log; // same diagnostic principle, for the separate history fetch that feeds Persistence/Rate of Change specifically — this fetch had no failure-reason logging at all before now
  sources.chlHistoryLog = chlHistResult.log;
  sources.sshHistoryLog = sshHistResult.log;
  sources.uWindHistoryLog = uWindHistResult.log;
  sources.vWindHistoryLog = vWindHistResult.log;
  // Same diagnostic principle as sstCoverage/sstReachedTarget/sstLog —
  // direct correction for two signals that previously had no way to tell
  // "today's own pass had a real coverage gap here, backfilled from
  // history" from any other kind of missing-data explanation.
  sources.chlCoverageBefore = +chlBackfill.coverageBefore.toFixed(3);
  sources.chlCoverageAfter = +chlBackfill.coverageAfter.toFixed(3);
  sources.chlBackfillFramesUsed = chlBackfill.framesUsed;
  sources.uWindCoverageBefore = +uWindBackfill.coverageBefore.toFixed(3);
  sources.uWindCoverageAfter = +uWindBackfill.coverageAfter.toFixed(3);
  sources.uWindBackfillFramesUsed = uWindBackfill.framesUsed;
  sources.vWindCoverageBefore = +vWindBackfill.coverageBefore.toFixed(3);
  sources.vWindCoverageAfter = +vWindBackfill.coverageAfter.toFixed(3);
  sources.vWindBackfillFramesUsed = vWindBackfill.framesUsed;
  sources.chlorophyll = chlMap.length > 0;
  sources.altimetry = sshMap.length > 0;
  sources.currents = uMap.length > 0 && vMap.length > 0;
  sources.structure = bathyMap.length > 0;
  sources.upwelling = uWindMap.length > 0 && vWindMap.length > 0;

  // Altimetry eddy edges: an eddy is a local extreme in SSH, so the *gradient*
  // of SSH marks its edge — same trick as fronts, applied to height.
  // Current strength: sqrt(u^2+v^2), high where flow converges/accelerates.

  // Weather/tide/pressure chain now lives entirely in fetchWeatherTidePressureChain above, run concurrently as part of the main Promise.all — see the destructured tideScore/pressureScore/pressureDetail near the top of this function.

  // Moon phase — always available (pure math).
  const moon = moonPhaseInfo(new Date());
  sources.moon = true;

  // Solar elevation at the analyzed area's center, right now — a smooth
  // 0..1 "how deep into daytime is it" measure (0 at and below the
  // horizon, ramping up toward solar noon), not a hard day/night flag, so
  // the effect below fades naturally toward dawn/dusk rather than
  // snapping on and off at an arbitrary instant.
  const daylightIntensity = clamp01(Math.sin(solarElevationDeg(new Date(), cLat, cLon) * Math.PI / 180));
  moon.daylightIntensity = daylightIntensity; // attached for buildStarRatings' use below, rather than adding a new parameter

  sources.moonDetail = {
    phase: moon.name, solunarStrength: +moon.solunar.toFixed(2),
    daytimeFullMoonSuppression: +(moon.fullMoonProximity * daylightIntensity).toFixed(2)
  };

  // Small, area-wide adjustment applied AFTER the location-specific
  // convergence score — pressure trend represents whether it's a good day
  // to fish at all, not whether this particular spot is good, so it
  // modulates rather than competes with the per-cell signals inside the
  // geometric mean. Previously blended with wind (as weatherScore); with
  // wind removed as a scoring input, pressure alone drives this now.
  const areaModulator = 0.9 + 0.2 * pressureScore;
  // The existing ±3% solunar term (new AND full moon both credited for the
  // month's strongest tides) is unchanged. Multiplied by a SEPARATE,
  // asymmetric term for the specific pattern directly requested: bright
  // moonlight lets pelagics feed heavily overnight near a full moon,
  // leaving them comparably lethargic the following day — up to a 20%
  // reduction at the extreme (exactly full moon, solar noon), fading to no
  // effect at all away from full moon OR away from broad daylight. A full
  // moon at night, or a new/quarter moon at any hour, is completely
  // unaffected by this term — it only engages where both conditions
  // (near-full AND currently daytime) actually overlap.
  const moonModulator = (0.97 + 0.06 * moon.solunar) * (1 - 0.20 * moon.fullMoonProximity * daylightIntensity);

  // --- Score the grid ---------------------------------------------------
  const dLat = (latMax - latMin) / GRID_N;
  const dLon = (lonMax - lonMin) / GRID_N;
  const cells = [];
  let landCellsExcluded = 0;
  let shallowCellsExcluded = 0; // pelagic-only depth floor, see the comment at the mask itself

  // --- PASS 1: per-cell raw component values -------------------------------
  // Every signal computed AT ITS OWN EXACT CELL, same computations as
  // before this restructuring — nothing about "nearby" happens in this
  // pass. Stored so pass 2 (below) can search among them for the
  // neighborhood-convergence rework (direct request: score where multiple
  // signals are found NEARBY each other, not literally stacked on the
  // exact same point).
  const rawCells = [];

  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const lat = +(latMin + (i + 0.5) * dLat).toFixed(4);
      const lon = +(lonMin + (j + 0.5) * dLon).toFixed(4);

      // LAND MASK (added after a direct report of forecast points on land):
      // every FIFR zone's bounding box includes coastline, and the grid
      // covers the whole box, so cells with centers on land were always
      // being scored — it just never MATTERED until SST started working,
      // because the land-sea boundary in satellite SST reads as an enormous
      // "gradient" (ocean pixels stop, so the nearest-value transition looks
      // like the sharpest break on the map), which suddenly made coastal and
      // land cells score as top spots. GEBCO covers land as well as seafloor
      // (positive elevation = above sea level), so its value at the cell
      // center is a direct land test using data already fetched. Cells at or
      // above sea level are skipped before any scoring — they can't be
      // fishing spots regardless of what any other signal says. When
      // bathymetry is unavailable (sources.structure false), no mask is
      // possible and behavior is unchanged rather than guessing.
      if (sources.structure) {
        const elevHere = nearestValue(bathyMap, lat, lon, bathyMaxDistMi);
        if (elevHere !== null && elevHere >= 0) {
          landCellsExcluded++;
          continue;
        }

        // MINIMUM-DEPTH FLOOR (direct response to clarified intent: this
        // is meant to find the Gulf Stream edge, not score nearshore
        // water).
        const MIN_PELAGIC_DEPTH_M = 37; // ~120 ft — a starting default, easy to retune; see the delivery note
        if (elevHere !== null && elevHere > -MIN_PELAGIC_DEPTH_M) {
          shallowCellsExcluded++;
          continue;
        }
      }

      // Each component defaults to neutral 0.5 when its source is missing, so
      // a dead source neither helps nor unfairly penalizes a cell. "Here"
      // suffix on the four convergence signals specifically: this is each
      // one's value AT THIS EXACT CELL, before pass 2's neighborhood search
      // — kept distinct from the plain names (sstGradScore etc.) used
      // downstream, which become the neighborhood-max versions.
      let sstGradScoreHere = 0.5, chlGradScoreHere = 0.5, chlFavorScore = 0.5, eddyScoreHere = 0.5, currBreakScoreHere = 0.5, upwellingScoreHere = 0.5, groundsScoreHere = 0;
      let coolerSide = false;
      let sstGradFHere = null, sstGradMagnitudeCHere = null, currBreakKnHere = null, structDepthChangeFt = null, chlValueHere = null, upwellingMDayHere = null, nearestGroundHere = null;
      let chlGradMagnitudeHere = null, eddyMagnitudeHere = null, currBreakMagnitudeHere = null;

      // Persistence + rate-of-change (direct correction: evaluated as a
      // NEIGHBOR, not pixel-by-pixel — real fronts drift a mile or two day
      // to day, so requiring the identical exact coordinate to have been
      // notable on a prior day could miss a front that's plainly the same
      // feature, just having moved slightly). The actual neighborhood
      // search happens in pass 2, alongside today's four convergence
      // signals — this pass only gathers the raw, point-exact historical
      // gradient at THIS cell for each prior day, for pass 2 to search
      // across nearby cells.
      const histMagnitudesHere = []; // parallel to sstHistDays; each entry a magnitude (degC) or null
      const chlHistMagnitudesHere = []; // parallel to chlHistDays; each entry a magnitude (mg/m^3) or null
      const eddyHistMagnitudesHere = []; // parallel to sshHistDays; each entry a magnitude (meters) or null
      const upwellingHistMDayHere = []; // parallel to min(uWindHistDays.length, vWindHistDays.length); each entry m/day or null

      if (sources.sst) {
        const g = gradientAt(sstMap, lat, lon, dLat, dLon, sstMaxDistMi);
        if (g !== null) {
          // sstGradScoreHere is now assigned area-relatively, right after
          // pass 1 finishes (see attachAreaRelativeScores below) — not
          // computed here against a fixed global threshold.
          coolerSide = g.hereIsCooler;
          sstGradFHere = g.magnitude * 9 / 5;
          sstGradMagnitudeCHere = g.magnitude; // raw degC — feeds both the area-relative normalization below and pass 2's trend comparison

          // Gather this cell's own historical gradient for each prior day
          // — raw data only, no notability/persistence decision made here.
          // Pass 2 searches this SAME data across nearby cells (the actual
          // correction: evaluated as a neighbor, not pixel-by-pixel).
          for (let hd = 0; hd < sstHistDays.length; hd++) {
            const day = sstHistDays[hd];
            const hg = gradientAt(day.points, lat, lon, dLat, dLon, day.maxDistMi);
            histMagnitudesHere.push(hg !== null ? hg.magnitude : null);
          }
        }
      }
      if (sources.chlorophyll) {
        const g = gradientAt(chlMap, lat, lon, dLat, dLon, chlMaxDistMi);
        if (g !== null) {
          // chlGradScoreHere is now assigned area-relatively after pass 1
          // completes — not computed here against a fixed global threshold.
          chlGradMagnitudeHere = g.magnitude; // raw mg/m^3 gradient
          // Reuses g.value (the absolute concentration at this cell,
          // already computed by the same gradientAt call above) rather
          // than a second lookup — chlFavorScore is point-exact, like
          // temperature preference, since "is the water here plankton-
          // rich enough" is about actual local conditions, not proximity
          // to an edge (that's what chlGradScore/chlorophyll edge already
          // covers, and stays neighborhood-aware in pass 2 below).
          chlFavorScore = chlFavorabilityScore(g.value);
          chlValueHere = g.value;

          // Direct correction: persistence now considers chlorophyll's own
          // history too, same raw-gathering-here / neighborhood-search-in-
          // pass-2 pattern as SST above.
          for (let hd = 0; hd < chlHistDays.length; hd++) {
            const day = chlHistDays[hd];
            const hg = gradientAt(day.points, lat, lon, dLat, dLon, day.maxDistMi);
            chlHistMagnitudesHere.push(hg !== null ? hg.magnitude : null);
          }
        }
      }
      if (sources.altimetry) {
        const g = gradientAt(sshMap, lat, lon, dLat, dLon, sshMaxDistMi);
        // eddyScoreHere is now assigned area-relatively after pass 1
        // completes — not computed here against a fixed global threshold.
        if (g !== null) {
          eddyMagnitudeHere = g.magnitude; // raw meters SSH gradient
          // Direct correction: persistence now considers eddy's own
          // history too, same pattern as SST/chlorophyll above.
          for (let hd = 0; hd < sshHistDays.length; hd++) {
            const day = sshHistDays[hd];
            const hg = gradientAt(day.points, lat, lon, dLat, dLon, day.maxDistMi);
            eddyHistMagnitudesHere.push(hg !== null ? hg.magnitude : null);
          }
        }
      }
      if (sources.currents) {
        // CURRENT BREAK (direct correction found from a precise question:
        // current had only ever measured absolute speed, never a break,
        // even though the original framing of the four convergence
        // signals explicitly named "current break" alongside temperature
        // break). A genuine vector-shear signal via currentShearAt, not a
        // scalar gradient on speed — catches real convergence zones where
        // two currents meet at different ANGLES with similar speeds,
        // which a speed-only gradient would miss entirely (confirmed
        // directly before trusting this: a test case with equal speed but
        // opposite direction on each side registered a strong break, while
        // a scalar speed gradient there would have shown almost none).
        // This is what now joins the neighborhood-convergence structure in
        // place of the old single "Current" entry, matching "current
        // break" as it was originally named.
        const shear = currentShearAt(uMap, vMap, lat, lon, dLat, dLon, uMaxDistMi, vMaxDistMi);
        if (shear !== null) {
          // currBreakScoreHere is now assigned area-relatively after pass
          // 1 completes — not computed here against a fixed global
          // threshold.
          currBreakMagnitudeHere = shear.magnitude; // raw m/s shear
          currBreakKnHere = shear.magnitude * 1.94384; // m/s -> kn, unchanged, purely for display
        }
      }
      if (sources.upwelling) {
        // Point-exact, like temperature preference or chlorophyll
        // favorability — "is this water being enriched by wind-driven
        // upwelling right here" is about actual local conditions, not
        // proximity to a feature elsewhere, and wasn't one of the four
        // signals in the original convergence request anyway.
        const mDay = ekmanUpwellingMDayAt(uWindMap, vWindMap, lat, lon, windGradDLat, windGradDLon, uWindMaxDistMi, vWindMaxDistMi);
        if (mDay !== null) {
          upwellingMDayHere = mDay;
          // Symmetric around 0.5 at zero vertical motion; +8 m/day (strong
          // upwelling, near the top of the "typical" 5-10 m/day range) ->
          // 1.0; -8 m/day (equally strong downwelling) -> 0.0.
          upwellingScoreHere = clamp01(0.5 + mDay / 16);

          // Direct correction: persistence now considers upwelling's own
          // history too. Wind history keeps u/v as two separate parallel
          // arrays (not merged ahead of time), so this walks both by index
          // together — using the shorter of the two lengths guards against
          // the two fetches ever returning a mismatched day count, which
          // shouldn't normally happen (same dataset, same requested
          // range) but isn't assumed away.
          const windHistDayCount = Math.min(uWindHistDays.length, vWindHistDays.length);
          for (let hd = 0; hd < windHistDayCount; hd++) {
            const uDay = uWindHistDays[hd], vDay = vWindHistDays[hd];
            const hMDay = ekmanUpwellingMDayAt(uDay.points, vDay.points, lat, lon, windGradDLat, windGradDLon, uDay.maxDistMi, vDay.maxDistMi);
            upwellingHistMDayHere.push(hMDay);
          }
        }
      }
      // LOCAL FISHING GROUNDS (kept after the region system's removal, per
      // direct follow-up request): no region lookup at all — just a direct
      // check of this cell against the flat GROUNDS list, so a documented
      // ground counts wherever the analyzed area happens to fall, not
      // gated behind any region ever being resolved. Point-exact — the
      // groundsInfluenceAt formula already has its own smooth radius-based
      // falloff built in, so it doesn't need the separate neighborhood
      // treatment the convergence signals get.
      const grAt = GROUNDS_KB.groundsInfluenceAt(lat, lon, species);
      groundsScoreHere = grAt.influence;
      nearestGroundHere = grAt.influence > 0.35 ? grAt.nearest : null; // only worth naming if genuinely close, same bar the old region system used
      let structMagnitudeHere = null; // raw meters of relief across this cell — normalized against the AREA's own range in pass 2, not a fixed global threshold
      if (sources.structure) {
        const g = gradientAt(bathyMap, lat, lon, dLat, dLon, bathyMaxDistMi);
        // Direct correction: relief is now scored relative to THIS area's
        // own range (a rugged reef zone and a naturally flat offshore
        // area shouldn't share one fixed global "extreme" threshold), and
        // — reversing the earlier point-exact design — now also considers
        // relief found nearby, not just at the exact cell, via the same
        // neighborhood-decay search used for the convergence signals.
        // Both the area-relative basis and the neighborhood search happen
        // in pass 2, once every cell's raw magnitude is known; this pass
        // only gathers the raw number itself.
        if (g !== null) {
          structMagnitudeHere = g.magnitude;
          structDepthChangeFt = g.magnitude * 3.28084;
        }
      }

      rawCells.push({
        lat, lon, structMagnitudeHere, structDepthChangeFt,
        sstGradScoreHere, sstGradFHere, sstGradMagnitudeCHere, coolerSide,
        chlGradScoreHere, chlGradMagnitudeHere, chlFavorScore, chlValueHere,
        eddyScoreHere, eddyMagnitudeHere, currBreakScoreHere, currBreakMagnitudeHere, currBreakKnHere,
        upwellingScoreHere, upwellingMDayHere,
        groundsScoreHere, nearestGroundHere,
        histMagnitudesHere, chlHistMagnitudesHere, eddyHistMagnitudesHere, upwellingHistMDayHere
      });
    }
  }

  // --- PASS 2: neighborhood convergence + final scoring ---------------------
  // THE ACTUAL RESTRUCTURING (direct request): "the scoring should look at
  // these factors more holistically to find where all of these inputs are
  // nearby each other" — not require literal, exact point-coincidence. For
  // pelagic species, each of the four convergence signals explicitly named
  // in the request (SST break, chlorophyll edge, eddy, current) is now the
  // BEST occurrence found within CONVERGENCE_RADIUS_MI of a cell, not just
  // that cell's own value. A cell doesn't need a break running exactly
  // through it to credit a strong one a couple of miles away — it needs to
  // be IN THE NEIGHBORHOOD of one, which is a materially more accurate
  // model of how "the area where things are converging" actually gets
  // read than requiring every signal to peak at one exact pixel. The
  // detail numbers shown alongside each score (sstGradF, currBreakKn, etc.)
  // travel with whichever nearby cell actually produced the max, so a
  // displayed number always matches the score it drove — never a
  // convergence-boosted score paired with a mismatched, merely-local detail
  // figure. Species temperature preference and bottom structure are
  // deliberately excluded — not part of the four signals named, and both
  // are about actual local conditions rather than proximity to a feature
  // elsewhere.
  //
  // O(N^2) over the scoring grid — at most 324 cells, so at most ~105,000
  // distance checks — measured directly before trusting it as cheap, not
  // assumed.
  const CONVERGENCE_RADIUS_MI = 5; // tunable; see the delivery note for why this number specifically
  // SST break specifically considered across a 1-mile radius, direct
  // request — distinct from the shared 5-mile radius the other five
  // signals (chlorophyll edge, eddy, current break, structure, upwelling)
  // still use. Deliberately smaller: a break is a comparatively sharp,
  // local feature, and a 1-mile window keeps its neighborhood search from
  // blurring into a much broader area's average gradient.
  const SST_CONVERGENCE_RADIUS_MI = 1;

  // sources.regional: always true now, matching sources.moon — grounds are
  // unconditionally part of every forecast (direct correction), so this
  // is "available" the same way moon phase always is, not conditional on
  // the analyzed area actually coming near a documented ground.
  sources.regional = true;

  // AREA-RELATIVE SCORING (direct request, extended from structure to SST
  // break, chlorophyll edge, eddy, current break, and upwelling): instead
  // of one fixed global threshold applied everywhere, each signal is now
  // scored relative to what THIS specific analyzed area actually contains
  // — a naturally dynamic zone and a naturally quiet one shouldn't share a
  // single universal "extreme" bar for any of these. One shared helper,
  // not six copies of the identical min/max/normalize/safeguard logic.
  //
  // A genuinely uniform area (near-zero variation in a signal anywhere)
  // shouldn't have that tiny, essentially-noise variation artificially
  // stretched across the full 0-1 range — that would falsely call the
  // area's biggest wiggle "extreme" purely because it's the biggest
  // wiggle around. Below flatAreaThresholdSpan, every cell gets
  // flatAreaScore instead — the honest answer being "no meaningful X
  // anywhere in this area," not "unknown data" (which stays at the
  // neutral 0.5 default). Each signal's flatAreaThresholdSpan reuses that
  // SAME signal's own original global norm() lower bound (0.1 for SST
  // gradient, 0.05 for chlorophyll gradient, etc.) — not a new, arbitrary
  // number, but that original calibration repurposed as "is there any
  // signal here at all worth measuring," while the actual 0-5 star
  // scoring becomes purely relative to what's actually present.
  function attachAreaRelativeScores(magnitudeField, scoreField, flatAreaThresholdSpan, flatAreaScore) {
    const magnitudes = rawCells.map((rc) => rc[magnitudeField]).filter((m) => m !== null);
    const sorted = magnitudes.slice().sort((a, b) => a - b);
    const areaMin = sorted.length > 0 ? percentile(sorted, 0.05) : 0;
    const areaMax = sorted.length > 0 ? percentile(sorted, 0.95) : 0;
    const areaSpan = areaMax - areaMin;
    for (const rc of rawCells) {
      if (rc[magnitudeField] === null) { rc[scoreField] = 0.5; continue; } // no data here — neutral, not "confirmed flat"
      rc[scoreField] = areaSpan >= flatAreaThresholdSpan ? norm(rc[magnitudeField], areaMin, areaMax) : flatAreaScore;
    }
  }
  attachAreaRelativeScores('structMagnitudeHere', 'structScoreHere', 10, 0.15); // meters of relief
  attachAreaRelativeScores('sstGradMagnitudeCHere', 'sstGradScoreHere', 0.1, 0.15); // degC gradient
  attachAreaRelativeScores('chlGradMagnitudeHere', 'chlGradScoreHere', 0.05, 0.15); // mg/m^3 gradient
  attachAreaRelativeScores('eddyMagnitudeHere', 'eddyScoreHere', 0.02, 0.15); // meters SSH gradient
  attachAreaRelativeScores('currBreakMagnitudeHere', 'currBreakScoreHere', 0.05, 0.15); // m/s shear
  // Upwelling is the one genuine exception in flavor, not mechanism: it's
  // signed (positive=upwelling, negative=downwelling) around a physically
  // real zero (no vertical motion), unlike the other five, which are all
  // unsigned "how much does this change" measures with no equivalent
  // meaningful zero. Applying the identical area-relative treatment here
  // means a mildly-upwelling area could show 5 stars for a physically
  // modest signal, or a genuinely strong upwelling zone could show low
  // stars for not being the MOST extreme cell in that specific box —
  // implemented as directly requested, with that tradeoff called out
  // explicitly rather than left for it to surface later as a confusing
  // result. flatAreaScore is 0.5 (true neutral) here, not 0.15, since "no
  // meaningful vertical-motion variation" genuinely means neutral for a
  // signed measure, not "unfavorable" the way it does for the five
  // unsigned ones above.
  attachAreaRelativeScores('upwellingMDayHere', 'upwellingScoreHere', 1, 0.5); // m/day

  for (const rc of rawCells) {
    let sstGradScore = rc.sstGradScoreHere, sstGradF = rc.sstGradFHere, coolerSide = rc.coolerSide;
    let sstGradMagnitudeC = rc.sstGradMagnitudeCHere; // tracked alongside sstGradScore, needed for the trend comparison below
    let chlGradScore = rc.chlGradScoreHere;
    let eddyScore = rc.eddyScoreHere;
    let currBreakScore = rc.currBreakScoreHere, currBreakKn = rc.currBreakKnHere;
    let structScore = rc.structScoreHere, structDepthChangeFt = rc.structDepthChangeFt;
    let upwellingScore = rc.upwellingScoreHere, upwellingMDay = rc.upwellingMDayHere;
    // Best nearby historical magnitude per day, starting from this cell's
    // own reading — updated during the same neighborhood search below.
    // Two parallel arrays for SST specifically: the DECAYED version
    // decides which day/cell is most relevant (closer and/or stronger
    // wins) and drives the persistence "notable" count; the RAW version
    // tracks that SAME winning cell's actual, undecayed degrees, needed
    // for the trend delta below — comparing a decayed historical value
    // against today's raw magnitude would produce a misleading
    // "weakening" trend that's really just distance decay, not an actual
    // physical change. Direct correction: persistence now tracks eddy,
    // chlorophyll, and upwelling's own nearby history the same way — each
    // needs its own array since each can have a different closest/
    // strongest occurrence nearby than the others do.
    const bestNearbyMagnitudeOnDay = rc.histMagnitudesHere.slice();
    const bestNearbyRawMagnitudeOnDay = rc.histMagnitudesHere.slice();
    const bestNearbyChlOnDay = rc.chlHistMagnitudesHere.slice();
    const bestNearbyEddyOnDay = rc.eddyHistMagnitudesHere.slice();
    const bestNearbyUpwellingOnDay = rc.upwellingHistMDayHere.slice();

    for (const other of rawCells) {
        if (other === rc) continue;
        const dist = cellDistanceMi(rc.lat, rc.lon, other.lat, other.lon);
        if (dist > CONVERGENCE_RADIUS_MI) continue;
        // DISTANCE DECAY (direct correction to a precise question: Feature
        // Intersection did have a radius, but it was a hard cutoff — a
        // signal at 0.1mi and one at 4.9mi counted identically, and
        // anything past 5mi counted as zero. Linear falloff instead: full
        // strength at this cell's own location (dist=0), scaling straight
        // down to zero exactly at the radius boundary. Simple and
        // literal, matching "scale based on how close... and decrease as
        // they get further away" as directly as possible, and easy to
        // verify: decayFactor(0)=1, decayFactor(radius)=0, linear between.
        const decayFactor = clamp01(1 - dist / CONVERGENCE_RADIUS_MI);
        // SST break's own, tighter radius — same linear falloff shape,
        // just zeroing out past 1mi instead of 5mi. Computed separately
        // (not derived from decayFactor) since 1mi and 5mi are
        // independent cutoffs, not one nested inside the other in any way
        // that would let one be reused for the other.
        const sstDecayFactor = dist <= SST_CONVERGENCE_RADIUS_MI ? clamp01(1 - dist / SST_CONVERGENCE_RADIUS_MI) : 0;
        const decayedSst = other.sstGradScoreHere * sstDecayFactor;
        const decayedChl = other.chlGradScoreHere * decayFactor;
        const decayedEddy = other.eddyScoreHere * decayFactor;
        const decayedCurrBreak = other.currBreakScoreHere * decayFactor;
        const decayedStruct = other.structScoreHere * decayFactor;
        const decayedUpwelling = other.upwellingScoreHere * decayFactor;
        // The SCORE that wins is the decayed one (what actually feeds core
        // and the notable-features bonus below) — but the DETAIL numbers
        // shown alongside it (actual °F, knots) travel with whichever cell
        // produced the win, undecayed: the real break really was that many
        // degrees, however much distance dampens its influence here.
        if (decayedSst > sstGradScore) { sstGradScore = decayedSst; sstGradF = other.sstGradFHere; sstGradMagnitudeC = other.sstGradMagnitudeCHere; coolerSide = other.coolerSide; }
        if (decayedStruct > structScore) { structScore = decayedStruct; structDepthChangeFt = other.structDepthChangeFt; }
        if (decayedUpwelling > upwellingScore) { upwellingScore = decayedUpwelling; upwellingMDay = other.upwellingMDayHere; }
        if (decayedChl > chlGradScore) chlGradScore = decayedChl;
        if (decayedEddy > eddyScore) eddyScore = decayedEddy;
        if (decayedCurrBreak > currBreakScore) { currBreakScore = decayedCurrBreak; currBreakKn = other.currBreakKnHere; }
        // PERSISTENCE, EVALUATED AS A NEIGHBOR (direct correction to the
        // previous pixel-exact design): for each historical day, track the
        // strongest front found anywhere nearby on THAT day, not just at
        // this one coordinate. Real fronts drift a mile or two day to day
        // — requiring the identical exact point to have been notable on a
        // prior day could miss a front that's plainly the same feature,
        // just having moved slightly. Direct correction: this uses the
        // shared 5-mile decayFactor, NOT SST break's own tighter 1-mile
        // radius — a front that's genuinely persisted can easily have
        // drifted more than 1 mile day to day, so persistence needs the
        // wider search even though today's break itself is deliberately
        // tighter. Direct follow-up correction: eddy, chlorophyll, and
        // upwelling's own history now gets the exact same neighbor search,
        // not just SST's.
        for (let hd = 0; hd < bestNearbyMagnitudeOnDay.length; hd++) {
          const otherMag = other.histMagnitudesHere[hd];
          if (otherMag === null) continue;
          const decayedMag = otherMag * decayFactor;
          if (bestNearbyMagnitudeOnDay[hd] === null || decayedMag > bestNearbyMagnitudeOnDay[hd]) {
            bestNearbyMagnitudeOnDay[hd] = decayedMag;
            bestNearbyRawMagnitudeOnDay[hd] = otherMag; // this same winning cell's actual, undecayed degrees
          }
        }
        for (let hd = 0; hd < bestNearbyChlOnDay.length; hd++) {
          const otherMag = other.chlHistMagnitudesHere[hd];
          if (otherMag === null) continue;
          const decayedMag = otherMag * decayFactor;
          if (bestNearbyChlOnDay[hd] === null || decayedMag > bestNearbyChlOnDay[hd]) bestNearbyChlOnDay[hd] = decayedMag;
        }
        for (let hd = 0; hd < bestNearbyEddyOnDay.length; hd++) {
          const otherMag = other.eddyHistMagnitudesHere[hd];
          if (otherMag === null) continue;
          const decayedMag = otherMag * decayFactor;
          if (bestNearbyEddyOnDay[hd] === null || decayedMag > bestNearbyEddyOnDay[hd]) bestNearbyEddyOnDay[hd] = decayedMag;
        }
        for (let hd = 0; hd < bestNearbyUpwellingOnDay.length; hd++) {
          const otherMDay = other.upwellingHistMDayHere[hd];
          if (otherMDay === null || otherMDay === undefined) continue;
          // Upwelling's raw value is signed (m/day, can be negative for
          // downwelling) — decay pulls it toward 0 (neutral), same
          // direction-preserving treatment as everywhere else magnitude
          // decay is applied in this file, not toward some arbitrary floor.
          const decayedMDay = otherMDay * decayFactor;
          if (bestNearbyUpwellingOnDay[hd] === null || Math.abs(decayedMDay) > Math.abs(bestNearbyUpwellingOnDay[hd])) bestNearbyUpwellingOnDay[hd] = decayedMDay;
        }
      }

    // PERSISTENCE + RATE OF CHANGE: a front that's held position NEARBY
    // for multiple days — even if it's drifted somewhat — has had time to
    // accumulate weed, plankton, and bait. Direct correction: persistence
    // is no longer SST break alone — it now requires the FULL feature
    // intersection (SST + eddy + chlorophyll + upwelling, the same
    // convergence this app already looks for today) to have been strong
    // nearby on a given prior day for that day to count. A strong SST
    // front two days ago that wasn't near an eddy, a chlorophyll edge, or
    // upwelling doesn't count the same as the same front WITH that
    // company. Direct follow-up correction: not binary either, same
    // principle already applied to the neighborhood search radius itself
    // (linear decay by distance, not a hard cutoff at the boundary) — a
    // day at 0.54 combined strength and one at 0.56 should differ by a
    // hair, not fall on opposite sides of a cliff. Each day now gets a
    // continuous 0-1 "intersection strength" (the MINIMUM of the four
    // signals' own normalized strengths — an intersection is only as
    // strong as its weakest member, not an average that lets one strong
    // signal paper over three weak ones), summed continuously across days
    // rather than counted as a hard yes/no. sstTrend/rateOfChangeBonus
    // stay SST-specific below — "is this front strengthening or
    // weakening" is a temperature-gradient concept that doesn't
    // generalize to the other three signals the same way persistence's
    // strength calculation does.
    let persistenceDays = 0, sstTrend = null, sstTrendDeltaF = null;
    let persistenceBonus = 1.0, rateOfChangeBonus = 1.0;
    if (bestNearbyMagnitudeOnDay.length > 0) {
      let intersectionStrengthSum = 0;
      let oldestMagnitude = null;
      const dayCount = Math.min(
        bestNearbyMagnitudeOnDay.length, bestNearbyChlOnDay.length,
        bestNearbyEddyOnDay.length, bestNearbyUpwellingOnDay.length
      );
      for (let hd = 0; hd < dayCount; hd++) {
        const sstMag = bestNearbyMagnitudeOnDay[hd]; // decayed — correct for the continuous strength calculation
        const chlMag = bestNearbyChlOnDay[hd];
        const eddyMag = bestNearbyEddyOnDay[hd];
        const upwellingMDayNearby = bestNearbyUpwellingOnDay[hd];
        // Same normalization ranges as before — the difference now is
        // there's no >=0.55 cutoff applied to each; the raw 0-1 value
        // itself is what matters, continuously. Missing data (null) means
        // zero evidence of that signal on that day, not a neutral 0.5 —
        // same treatment the old notability check gave it.
        const sstStrength = sstMag !== null ? norm(sstMag, 0.1, 2.0) : 0;
        const chlStrength = chlMag !== null ? norm(chlMag, 0.02, 0.3) : 0;
        const eddyStrength = eddyMag !== null ? norm(eddyMag, 0.01, 0.12) : 0;
        const upwellingStrength = upwellingMDayNearby !== null ? clamp01(0.5 + upwellingMDayNearby / 16) : 0;
        const dayIntersectionStrength = Math.min(sstStrength, chlStrength, eddyStrength, upwellingStrength);
        intersectionStrengthSum += dayIntersectionStrength;
        // oldestMagnitude pulls from the RAW array at this same day/cell
        // — the decayed value already identified which occurrence is
        // most relevant; this needs that SAME occurrence's actual,
        // undecayed degrees for a physically meaningful trend delta.
        // Unchanged: SST's own trend doesn't depend on the other three
        // signals' strength, only on SST itself having a reading.
        if (oldestMagnitude === null && sstMag !== null) oldestMagnitude = bestNearbyRawMagnitudeOnDay[hd]; // first valid hit = oldest, since history is sorted oldest-to-newest
      }
      // Capped at 2.0 "day-equivalents" — same ceiling the old discrete
      // count had (persistence caring about roughly the last couple of
      // days, not accumulating indefinitely), just continuous within it
      // now instead of jumping straight from 1 to 2.
      persistenceDays = Math.min(intersectionStrengthSum, 2.0);
      // Same linear shape as the old discrete table (1.0 at zero, +0.06
      // per "day-equivalent", capping at 1.12) — continuous now rather
      // than jumping in three fixed steps.
      persistenceBonus = 1.0 + 0.06 * persistenceDays;

      // Only worth calling a trend if there's an actual signal in the area
      // today to trend in the first place — gated on the same
      // neighborhood-aware sstGradScore used everywhere else now.
      if (oldestMagnitude !== null && sstGradMagnitudeC !== null && sstGradScore >= 0.35) {
        const deltaC = sstGradMagnitudeC - oldestMagnitude;
        sstTrendDeltaF = deltaC * 9 / 5;
        if (deltaC >= 0.3) { sstTrend = 'strengthening'; rateOfChangeBonus = 1.12; }
        else if (deltaC <= -0.3) { sstTrend = 'weakening'; rateOfChangeBonus = 0.95; }
        else { sstTrend = 'steady'; rateOfChangeBonus = 1.0; }
      }
    }

    // FEATURE INTERSECTION SCORE ("secret sauce" per direct request): the
    // geometric mean below already requires factors to co-occur to some
    // degree, but it doesn't explicitly reward the discrete pattern
    // experienced captains actually look for — not "is the blended average
    // good" but "how many different, largely-independent features are
    // converging in this area." Genuinely about the AREA, not one pixel,
    // since sstGradScore/chlGradScore/eddyScore/currBreakScore above are
    // already the neighborhood-max versions — this check inherits the
    // "nearby" property automatically rather than needing its own separate
    // search.
    const NOTABLE_THRESHOLD = 0.55; // matches the "noticeable" bucket already used in the narrative's own strength buckets
    const notableFeatures = [];
    if (sstGradScore >= NOTABLE_THRESHOLD) notableFeatures.push('SST break');
    if (chlGradScore >= NOTABLE_THRESHOLD) notableFeatures.push('Chlorophyll edge');
    if (eddyScore >= NOTABLE_THRESHOLD) notableFeatures.push('Eddy');
    if (currBreakScore >= NOTABLE_THRESHOLD) notableFeatures.push('Current break');
    // 0-1 features notable: no bonus, nothing convergent enough to call
    // out. 2: a real, modest bump. 3: a strong, genuine convergence signal.
    // 4 (every tracked feature notable somewhere nearby simultaneously):
    // the "jackpot" case directly named in the request.
    const FEATURE_INTERSECTION_BONUS = { 0: 1.0, 1: 1.0, 2: 1.1, 3: 1.25, 4: 1.45 };
    const featureIntersectionBonus = FEATURE_INTERSECTION_BONUS[notableFeatures.length];

    // The convergence core: a weighted GEOMETRIC mean, not an arithmetic
    // one — requires signals to genuinely co-occur (a location strong
    // everywhere except badly out of temperature range collapses hard,
    // rather than averaging out to a deceptively decent score).
    const core = weightedGeoMean(
      { sstGrad: sstGradScore, chlGrad: chlGradScore, chlFavor: rc.chlFavorScore, eddy: eddyScore, currBreak: currBreakScore, struct: structScore, upwelling: upwellingScore },
      CORE_WEIGHTS
    );

    // Final score: convergence core, nudged by how many major features
    // intersect nearby, then modulated by the area-wide weather/moon
    // factors.
    // Local fishing grounds: a multiplicative adjustment (0.9x-1.2x) toward
    // documented productive grounds relevant to this species — kept after
    // the region system's removal, per direct follow-up request, but now
    // driven directly by rc.groundsScoreHere (a flat, region-free check)
    // rather than a region lookup. Applied on top of the convergence core,
    // not as a factor inside it, same as the original design.
    const groundsBonus = 0.9 + 0.3 * rc.groundsScoreHere;

    const score = clamp01(core * groundsBonus * featureIntersectionBonus * persistenceBonus * rateOfChangeBonus * areaModulator * moonModulator);

    cells.push({
      lat: rc.lat, lon: rc.lon, score: +score.toFixed(3),
      components: {
        sst: +sstGradScore.toFixed(2), chl: +chlGradScore.toFixed(2),
        chlFavor: +rc.chlFavorScore.toFixed(2), chlValue: rc.chlValueHere !== null ? +rc.chlValueHere.toFixed(3) : null,
        eddy: +eddyScore.toFixed(2), struct: +structScore.toFixed(2),
        currBreak: +currBreakScore.toFixed(2),
        upwelling: +upwellingScore.toFixed(2), upwellingMDay: upwellingMDay !== null ? +upwellingMDay.toFixed(2) : null,
        coolerSide,
        sstGradF: sstGradF !== null ? +sstGradF.toFixed(1) : null,
        currBreakKn: currBreakKn !== null ? +currBreakKn.toFixed(1) : null,
        structDepthChangeFt: structDepthChangeFt !== null ? Math.round(structDepthChangeFt) : null,
        zone: +rc.groundsScoreHere.toFixed(2),
        zoneName: rc.nearestGroundHere ? rc.nearestGroundHere.name : null,
        zoneNote: rc.nearestGroundHere ? rc.nearestGroundHere.note : null,
        notableFeatures,
        featureIntersectionBonus: +featureIntersectionBonus.toFixed(2),
        persistenceDays: +persistenceDays.toFixed(2),
        sstTrend,
        sstTrendDeltaF: sstTrendDeltaF !== null ? +sstTrendDeltaF.toFixed(1) : null
      }
    });
  }


  // Rank the top spots, keeping them spatially distinct so we don't return a
  // cluster of adjacent cells describing the same feature.
  const ranked = cells.slice().sort((a, b) => b.score - a.score);
  const topSpots = [];
  const minSep = Math.max(dLat, dLon) * 1.5;
  for (const c of ranked) {
    if (topSpots.every((s) => Math.abs(s.lat - c.lat) + Math.abs(s.lon - c.lon) > minSep)) {
      topSpots.push(c);
      if (topSpots.length >= pointCount) break;
    }
  }

  // DEPTH AS REFERENCE (direct request, explicitly clarified as reference
  // only — NOT a scoring input): a plain nearestValue lookup against the
  // same bathyMap already fetched for the land mask/depth floor/structure
  // scoring, computed only for the final top spots (1-15, user-adjustable) rather than all 324
  // scoring-grid cells, since it's purely informational and doesn't need
  // to run at grid scale. Deliberately placed AFTER scoring is complete —
  // it has no path back into score or any other part of the
  // formula above.
  if (sources.structure) {
    for (const spot of topSpots) {
      const elev = nearestValue(bathyMap, spot.lat, spot.lon, bathyMaxDistMi);
      spot.components.depthFt = (elev !== null && elev < 0) ? Math.round(Math.abs(elev) * 3.28084) : null;
    }
  }

  // Attach star ratings to each top spot — built from that spot's own
  // component scores, not just the blended number, so the ratings actually
  // reflect what drove it, the same principle the old narrative followed.
  const historyAvailable = sstHistDays.length > 0;
  for (const spot of topSpots) {
    spot.starRatings = buildStarRatings(spot, species, sources, moon, pressureScore, tideScore, historyAvailable);
  }


  return json(200, {
    ok: true,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - FUNCTION_START, // for diagnosing timeout issues later
    areaWasCapped, // true if the requested map-view box exceeded 50x50 miles and was shrunk to fit
    analysisBounds: { latMin, latMax, lonMin, lonMax }, // the actual area scored — always the (possibly capped) requested box, i.e. the map viewport
    species,               // which profile actually scored this — for the UI to confirm
    sources,               // which data actually contributed — key for debugging
    moon: sources.moonDetail,
    weather: sources.weatherDetail || null,
    pressure: pressureDetail,
    tide: sources.tideDetail || null,
    gridN: GRID_N,
    pointCount, // how many top spots were requested (1-15) — topSpots.length may be lower if fewer spatially-distinct candidates exist
    landCellsExcluded, // cells skipped by the land mask (GEBCO elevation >= 0 at the cell center) — 0 for fully-offshore areas, larger for zones whose bounding box includes coastline
    shallowCellsExcluded, // pelagic-only: cells skipped by the minimum-depth floor (shallower than MIN_PELAGIC_DEPTH_M) — 0 for bottom species (the floor doesn't apply) or fully-deep-water areas
    cells,                 // full scored grid, for the heat map
    topSpots               // ranked distinct spots, with narratives, for the labeled markers
  });
  } catch (err) {
    // A defensive backstop, not a substitute for fixing real bugs — this
    // exists so an unexpected error produces a clear, diagnosable message
    // instead of a silent crash. (This exact class of bug — an uncaught
    // ReferenceError from a stale variable name after a rewrite — is what
    // caused the "forecast failed" error this was added to fix.)
    return json(500, { ok: false, message: 'Unexpected error: ' + err.message, elapsedMs: Date.now() - FUNCTION_START });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    // Cache-Control: no-store — direct fix for a report that results
    // seemed to depend on which client page was active. Traced end to
    // end: the request URL, bbox computation, and every reference to
    // currentPage in the client were all confirmed independent of it —
    // the forecast computation itself never discriminates by page. What
    // WAS missing: this response had no cache directive at all, for data
    // that represents live, changing conditions (SST/chlorophyll
    // availability genuinely varies minute to minute). Without an
    // explicit no-store, a browser is free to serve a stale cached
    // response for an identical bbox — and switching pages often
    // coincides with panning/zooming, which changes the bbox and
    // incidentally bypasses a stale entry, which could look like a
    // page-dependent effect without actually being one. Fixed on the
    // client side too (see the fetch() call in runForecast) as a
    // belt-and-suspenders measure.
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}
