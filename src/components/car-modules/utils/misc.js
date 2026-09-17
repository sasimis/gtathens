
export const CAR_IDS_SET = new Set([
  'sedan','taxi','hatchback','sports','roadster','muscle','muscle-2',
  'suv','pickup','van','ambulance','bus','firetruck','truck',
  'truck-with-trailer','limousine','police-sedan','police-muscle',
  'police-sports','police-suv','monster-truck',
])

export const normalizeId = (id) => CAR_IDS_SET.has(id) ? id : 'sedan'

export const hash01 = (i) => {
  let h = (i * 2654435761) >>> 0
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  return h / 4294967295
}

export const roadHeading = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1])
