/**
 * Shared geo -> world conversion helpers.
 * World units are meters (1 unit = 1 m); north = -Z, east = +X.
 * Must stay in sync with REF_LAT / REF_LON in parse_map.py.
 */
export const REF_LAT = 37.975521
export const REF_LON = 23.733642

export const M_PER_DEG_LAT = 111320
export const M_PER_DEG_LON = 111320 * Math.cos((REF_LAT * Math.PI) / 180)

export const lonToWorldX = (lon) => (lon - REF_LON) * M_PER_DEG_LON
export const latToWorldZ = (lat) => -(lat - REF_LAT) * M_PER_DEG_LAT
