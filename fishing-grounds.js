// netlify/functions/fishing-grounds.js
//
// A flat registry of documented, named productive fishing grounds —
// recovered from the deleted regional-knowledge.js after the region
// system was removed, per a direct follow-up request: keep the grounds
// knowledge itself, but drop everything about "regions" (auto-detected
// FIFR zones, custom regions, the picker). No region concept exists here
// at all — every ground is just a real place with real coordinates, and
// forecast.js checks it directly against whatever area is actually being
// analyzed (the current map viewport), regardless of which of the old
// region boxes it used to sit inside.
//
// One direct consequence of dropping the region concept, worth naming:
// Hatteras's grounds were previously locked behind an explicit, disabled
// region selection nobody could actually reach. They're included here
// like everything else, so they simply apply on their own if someone
// happens to analyze an area near Cape Hatteras — no selection needed.
//
// COORDINATES ARE APPROXIMATE and for weighting/context only — NOT for
// navigation. Every position is a documented general area, not a surveyed
// waypoint; anglers should verify against official NOAA charts.
//
// Sources (unchanged from the original research): seadreamfishing.com,
// hatteraslanding.com, hatterasrelease.com, fishingbooker.com regional
// guides, villagerealtyobx.com, ncangler.com/tidalfish.com forums,
// outerbanks.com, offthehookboating.com, kickazzfishingcharters.com,
// fishingfloridakeys.com, thekeywestfishingreport.com, fishanywhere.com,
// twoconchs.com, fishtrack.com, floridasportfishing.com,
// florida-keys-vacation.com, fishmastersebastian.com,
// surfsidegrillandadventures.com, thefisherman.com, krakendowncharters.com,
// filetshow.com. Compiled 2026-07.
const GROUNDS = [
  {
    name: 'the Rock Pile', lat: 35.00, lon: -75.22, radiusMi: 9,
    species: ['wahoo', 'sailfish', 'tuna', 'mahi'], style: 'rocky ridge / pelagic + structure',
    note: 'a rocky ridge south of Cape Point in roughly 180 ft — a classic wahoo and billfish stop on the way offshore'
  },
  {
    name: 'the Diamond Shoals tower area', lat: 35.15, lon: -75.30, radiusMi: 8,
    species: ['grouper', 'snapper'], style: 'tower pilings / structure',
    note: 'the old Diamond Shoals light-tower pilings, holding amberjack, cobia and bottom fish (navigate the shoals with care)'
  },
  {
    name: 'the Cape Point convergence', lat: 35.20, lon: -75.50, radiusMi: 14,
    species: ['mahi', 'tuna', 'wahoo', 'sailfish'], style: 'current convergence',
    note: 'where the cold Labrador current and warm Gulf Stream collide off Cape Point, driving upwelling and bait — the reason this area fishes as well as it does'
  },
  {
    name: 'the Atlantic canyons (Pamlico / Hatteras)', lat: 35.35, lon: -74.65, radiusMi: 18,
    species: ['tuna', 'sailfish', 'mahi', 'wahoo', 'grouper'], style: 'shelf-edge canyons / deep',
    note: 'the shelf-edge canyons — bigeye and yellowfin tuna, billfish up top, and deep-drop tilefish and grouper down below'
  },
  {
    name: 'the E.M. Clark wreck', lat: 34.85, lon: -75.54, radiusMi: 6,
    species: ['tuna', 'grouper', 'snapper'], style: 'wreck / structure',
    note: 'a well-known deep wreck that stacks bait and holds tuna even through summer, plus bottom fish on the structure'
  },
  {
    name: 'the Middle Grounds', lat: 27.3, lon: -83.0, radiusMi: 12,
    species: ['general'], style: 'live bottom / structure',
    note: 'a documented live-bottom area popular with Sarasota anglers for cobia, bluefish, and snapper, best fished June-July'
  },
  {
    name: 'the Islamorada Hump', lat: 24.8017, lon: -80.4433, radiusMi: 6,
    species: ['mahi', 'tuna', 'wahoo', 'sailfish'], style: 'seamount / pelagic',
    note: 'possibly the single most popular fishing spot in the Keys — a seamount that draws blackfin, mahi, wahoo and sailfish nearly every day of the year'
  },
  {
    name: 'the 409 Hump', lat: 24.5917, lon: -80.5917, radiusMi: 5,
    species: ['mahi', 'tuna', 'wahoo', 'sailfish'], style: 'seamount / pelagic',
    note: 'a quieter alternative seamount to the Islamorada Hump when traffic is heavy there'
  },
  {
    name: 'the Marathon (West) Hump', lat: 24.4255, lon: -80.7555, radiusMi: 6,
    species: ['mahi', 'tuna', 'wahoo', 'sailfish'], style: 'seamount / deep pelagic',
    note: 'the biggest and deepest of the humps, rising from over 1,000 ft — reliable blackfin tuna and a real shot at mahi, wahoo, or a marlin'
  },
  {
    name: 'Western Dry Rocks', lat: 24.45, lon: -81.93, radiusMi: 4,
    species: ['snapper'], style: 'reef',
    note: 'a reef area southwest of Key West known for the mangrove snapper spawn'
  },
  {
    name: 'the Lower Keys Gulf-side wrecks', lat: 24.65, lon: -81.55, radiusMi: 15,
    species: ['grouper', 'snapper'], style: 'wreck / structure',
    note: 'Gulf-side wrecks off the Lower Keys holding grouper, snapper, and other structure-oriented bottom fish'
  },
  {
    name: 'the nearshore reef line', lat: 27.65, lon: -80.32, radiusMi: 12,
    species: ['snapper', 'grouper'], style: 'natural reef / ledge',
    note: 'a limestone reef line running south from Sebastian Inlet toward Fort Pierce, close enough to shore for a short run — holds snapper and grouper along with cobia and kingfish'
  }
];

// Rough great-circle-ish distance in miles (equirectangular approximation —
// plenty accurate at these scales, and cheap).
function milesBetween(lat1, lon1, lat2, lon2) {
  const mLat = 69;
  const mLon = 69 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const dLat = (lat1 - lat2) * mLat;
  const dLon = (lon1 - lon2) * mLon;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

// For a given point and species, how strongly documented grounds vouch for
// it: 0 (nothing relevant nearby) up to ~1 (right on top of a relevant
// ground), with a smooth falloff scaled to each ground's own radius. Also
// returns the single closest relevant ground, for the narrative. No region
// concept at all — just checks every known ground directly, regardless of
// which of the old region boxes it used to sit inside.
function groundsInfluenceAt(lat, lon, species) {
  let best = 0;
  let nearest = null, nearestMi = Infinity;
  for (const g of GROUNDS) {
    // A ground is relevant if it's classically known for this species — or
    // if the angler picked "General" (they'll take anything, so every
    // documented ground counts). Keeps a bottom wreck from vouching for a
    // wahoo troll while still letting "General" benefit from the whole area.
    const relevant = species === 'general' || g.species.indexOf(species) !== -1;
    if (!relevant) continue;
    const mi = milesBetween(lat, lon, g.lat, g.lon);
    // Smooth falloff: full credit at the center, ~0.6 at the radius edge,
    // trailing off beyond. exp(-(d/r)^2) is a clean bell with no hard cutoff.
    const infl = Math.exp(-Math.pow(mi / g.radiusMi, 2));
    if (infl > best) best = infl;
    if (mi < nearestMi) { nearestMi = mi; nearest = g; }
  }
  return { influence: best, nearest, nearestMi };
}

module.exports = { GROUNDS, milesBetween, groundsInfluenceAt };
