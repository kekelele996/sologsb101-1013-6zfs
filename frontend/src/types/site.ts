/** 测绘组站位档案：样带布设只认这一份坐标、水深和底质 */
export interface Site {
  id: string
  /** 所属礁区 */
  reefId: string
  /** 站位编号，如 S-01；测绘组与外业队按 reefId + no 对账 */
  no: string
  /** 海图纬度（十进制度，-90 ~ 90） */
  chartLat: number
  /** 海图经度（十进制度，-180 ~ 180） */
  chartLng: number
  /** 海图水深（m） */
  chartDepthM: number
  /** 底质类型（测绘组档案字段） */
  substrate: string
  /** 档案与外业实测的核对状态 */
  reconcileStatus: SiteReconcileStatus
  /** 测绘组最近一次核对通过时间（毫秒时间戳） */
  reconciledAt: number | null
  createdAt: number
  updatedAt: number
}

/** 外业队实测站位数据：补测只更新本表，不顶替测绘档案 */
export interface SiteMeasurement {
  id: string
  /** 所属礁区；与档案按 reefId + no 对账 */
  reefId: string
  /** 站位编号，如 S-01 */
  no: string
  /** 实测纬度（十进制度，-90 ~ 90） */
  measuredLat: number
  /** 实测经度（十进制度，-180 ~ 180） */
  measuredLng: number
  /** 实测水深（m） */
  measuredDepthM: number
  /** 测量时间，格式 YYYY-MM-DD HH:mm */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/**
 * 档案核对状态：
 * - unmeasured：外业尚未录入，按档案正常布设
 * - pending：实测与档案超差，样带先压住，等待测绘组核对
 * - verified：测绘组核对完成；距离已回到阈值内或人工确认档案无误
 * - failed：测绘组核对失败，只允许重试档案侧，外业记录保持不变
 */
export type SiteReconcileStatus = 'unmeasured' | 'pending' | 'verified' | 'failed'

export const SITE_RECONCILE_STATUS_LABEL: Record<SiteReconcileStatus, string> = {
  unmeasured: '未录实测',
  pending: '待测绘核对',
  verified: '核对通过',
  failed: '档案核对失败'
}

/** 实测经纬度与海图经纬度超过该水平距离时，先压住新样带（m） */
export const SITE_COORDINATE_HOLD_THRESHOLD_M = 100

/** 站位列表页筛选条件（存于 reefStore） */
export interface SiteFilterState {
  keyword: string
  /** 档案水深区间下限（m） */
  minDepthM: number | null
  /** 档案水深区间上限（m） */
  maxDepthM: number | null
}

export function createEmptySiteFilter(): SiteFilterState {
  return {
    keyword: '',
    minDepthM: null,
    maxDepthM: null
  }
}

/** 底质常用取值 */
export const SUBSTRATES: string[] = ['珊瑚礁石', '礁砂', '砾石', '泥沙', '岩礁', '混合底质']

/** 经纬度格式校验：返回错误信息（为空表示通过） */
export function validateLatLng(lat: number, lng: number): string[] {
  const errors: string[] = []
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('纬度应在 -90 ~ 90 之间')
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('经度应在 -180 ~ 180 之间')
  return errors
}

/** 十进制度 → 度分秒文本，便于外业核对 */
export function formatLatLng(lat: number, lng: number): string {
  const toDms = (value: number, positive: string, negative: string): string => {
    const hemisphere = value >= 0 ? positive : negative
    const abs = Math.abs(value)
    const degree = Math.floor(abs)
    const minutesFloat = (abs - degree) * 60
    const minute = Math.floor(minutesFloat)
    const second = ((minutesFloat - minute) * 60).toFixed(1)
    return `${degree}°${minute}′${second}″${hemisphere}`
  }
  return `${toDms(lat, 'N', 'S')} ${toDms(lng, 'E', 'W')}`
}

const EARTH_RADIUS_M = 6_371_008.8
const DEGREE_TO_RADIAN = Math.PI / 180

/** Haversine 大圆距离，返回米；用于实测坐标与海图档案坐标的超差判断 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * DEGREE_TO_RADIAN
  const dLng = (lng2 - lng1) * DEGREE_TO_RADIAN
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEGREE_TO_RADIAN) * Math.cos(lat2 * DEGREE_TO_RADIAN) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

export interface SiteCoordinateGap {
  /** 实测点与档案点的水平距离（m） */
  distanceM: number
  /** 实测水深与档案水深差（m，实测 - 档案） */
  depthGapM: number
  coordinateOutOfTolerance: boolean
}

export function getSiteCoordinateGap(site: Pick<Site, 'chartLat' | 'chartLng' | 'chartDepthM'>, measurement: Pick<SiteMeasurement, 'measuredLat' | 'measuredLng' | 'measuredDepthM'>): SiteCoordinateGap {
  const distanceM = haversineMeters(
    site.chartLat,
    site.chartLng,
    measurement.measuredLat,
    measurement.measuredLng
  )
  return {
    distanceM,
    depthGapM: measurement.measuredDepthM - site.chartDepthM,
    coordinateOutOfTolerance: distanceM > SITE_COORDINATE_HOLD_THRESHOLD_M
  }
}

/**
 * 是否压住新样带：
 * 无实测或距离未超阈值时按档案布设；超差后只有测绘组核对通过才能放行。
 */
export function isSiteDeploymentBlocked(
  site: Pick<Site, 'reconcileStatus' | 'chartLat' | 'chartLng' | 'chartDepthM'>,
  measurement: Pick<SiteMeasurement, 'measuredLat' | 'measuredLng' | 'measuredDepthM'> | null | undefined
): boolean {
  if (!measurement) return false
  const gap = getSiteCoordinateGap(site, measurement)
  return gap.coordinateOutOfTolerance && site.reconcileStatus !== 'verified'
}

/** 根据实测与档案距离给出核对状态；距离内自动通过，超差进入待核对 */
export function reconcileStatusFromGap(
  site: Pick<Site, 'chartLat' | 'chartLng' | 'chartDepthM' | 'reconcileStatus'>,
  measurement: Pick<SiteMeasurement, 'measuredLat' | 'measuredLng' | 'measuredDepthM'> | null | undefined
): SiteReconcileStatus {
  if (!measurement) return 'unmeasured'
  const gap = getSiteCoordinateGap(site, measurement)
  if (!gap.coordinateOutOfTolerance) return 'verified'
  return site.reconcileStatus === 'failed' ? 'failed' : 'pending'
}
