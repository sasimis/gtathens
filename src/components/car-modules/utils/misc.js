

export const CAR_IDS_SET = new Set([
  'sedan', 'sedan-blue', 'sedan-darkred',
  'sports', 'sports-yellow', 'sports-stripe',
  'muscle', 'muscle-black', 'muscle-green', 'muscle-teal',
  'suv', 'suv-black', 'suv-green', 'suv-teal',
  'suv-yellow', 'suv-blue', 'suv-orange', 'suv-red',
])

export const normalizeId = (id) => CAR_IDS_SET.has(id) ? id : 'sedan'

export const hash01 = (i) => {
  let h = (i * 2654435761) >>> 0
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  return h / 4294967295
}

export const roadHeading = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1])
