// Painted-carriageway table for OSM road types — the SINGLE source of truth for
// "how wide is this street, and is it a street at all".
//
// It used to be inlined in components/Roads.jsx; it lives here as plain .js
// (no JSX, no three.js) so the non-rendering consumers can import it too:
//   · Roads.jsx                  — ribbon buckets + drivable-segment publisher
//   · City.jsx                   — building-vs-road rejection (roadWidthFor)
//   · StreetHUD.jsx              — street naming
//   · car-modules/planParkingSpots.js — parks cars INSIDE the painted width
//   · scripts/park-repro.mjs     — Node harness (needs a JS-importable module)
//
// Widths are metres, matching lib/geo.js world units (1 unit = 1 m).

export const ROAD_STYLE = {
  motorway: { w: 16, bucket: 'major' },
  motorway_link: { w: 8, bucket: 'major' },
  trunk: { w: 14, bucket: 'major' },
  trunk_link: { w: 8, bucket: 'major' },
  primary: { w: 12, bucket: 'major' },
  primary_link: { w: 7, bucket: 'major' },
  secondary: { w: 9, bucket: 'major' },
  secondary_link: { w: 6, bucket: 'major' },
  tertiary: { w: 8, bucket: 'minor' },
  residential: { w: 6, bucket: 'minor' },
  unclassified: { w: 6, bucket: 'minor' },
  living_street: { w: 5.5, bucket: 'minor' },
  service: { w: 4.5, bucket: 'minor' },
  pedestrian: { w: 5, bucket: 'minor' },
  footway: { w: 2.2, bucket: 'path' },
  path: { w: 2, bucket: 'path' },
  track: { w: 3, bucket: 'path' },
  cycleway: { w: 2.2, bucket: 'path' },
}

/** Painted carriageway width (m) for an OSM road type. Unknown → 6 m. */
export const roadWidthFor = (type) => ROAD_STYLE[type]?.w ?? 6

/** Render bucket of a road type ('major' | 'minor' | 'path' | null). */
export const roadBucketFor = (type) => ROAD_STYLE[type]?.bucket ?? null

/**
 * A way the game actually PAINTS as tarmac. The `path` bucket (footway / path
 * / track / cycleway) is pavement-coloured, not carriageway, and a type with no
 * style at all (steps, busway, …) is not drawn — so neither counts as road
 * surface for a car. This is the predicate behind Roads.publishRoadSegments.
 */
export const isPaintedRoad = (type) => {
  const style = ROAD_STYLE[type]
  return !!style && style.bucket !== 'path'
}

/** Narrowest carriageway a car can be parked in (service = 4.5 m). */
export const MIN_PARK_WIDTH = 4.5

// `highway=pedestrian` in this crop is a pedestrianised square/street, not a
// parking bay — the old layout happily parked cars on it because the way IS
// painted 5 m of tarmac. Parking is for real streets only.
const NEVER_PARK = new Set(['pedestrian'])

/**
 * A road a car may be PARKED on: painted carriageway, wide enough for a car,
 * and not a pedestrian zone. Candidate spots come only from these ways, so a
 * footway / step / path way can never contribute a car at any lateral offset.
 */
export const isParkableRoad = (type) => {
  const style = ROAD_STYLE[type]
  if (!style || style.bucket === 'path') return false
  if (style.w < MIN_PARK_WIDTH) return false
  return !NEVER_PARK.has(type)
}
