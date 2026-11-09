/**
 * 坐标工具：异地模式要在场馆坐标附近做小范围抖动，
 * 避免每次提交的经纬度完全一致（完全一致的静止坐标更容易被判异常）。
 */
const M_PER_DEG_LAT = 111320

export function jitterPoint (longitude, latitude, meters = 0) {
  const lng = Number(longitude)
  const lat = Number(latitude)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return { longitude: lng, latitude: lat }
  const r = Number(meters) || 0
  if (r <= 0) return { longitude: lng, latitude: lat }
  // 极坐标均匀采样，保证落在半径 r 的圆内
  const theta = Math.random() * Math.PI * 2
  const rho = Math.sqrt(Math.random()) * r
  const dLat = (rho * Math.cos(theta)) / M_PER_DEG_LAT
  const dLng = (rho * Math.sin(theta)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 1)
  return {
    longitude: Number((lng + dLng).toFixed(6)),
    latitude: Number((lat + dLat).toFixed(6))
  }
}

/** 两点球面距离（米），用于预判提示 */
export function distanceMeters (a, b) {
  if (!a || !b) return null
  const R = 6371000
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(s)))
}
