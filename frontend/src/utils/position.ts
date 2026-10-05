/**
 * 样带落位判定：样带认海图档案站位，落位坐标取海图档案值；
 * 外业实测与档案偏差超限则压住不布，待测绘组核对通过后放行。
 */
import { distanceMeters, SURVEY_DISTANCE_LIMIT_M, type Site, type SiteSurvey } from '@/types/site'
import type { Belt, BeltPositionStatus } from '@/types/belt'

export interface PositionEval {
  positionStatus: BeltPositionStatus
  /** 落位纬度（压住待核时为 null） */
  lat: number | null
  /** 落位经度（压住待核时为 null） */
  lng: number | null
  /** 偏差距离（m），无实测记录时为 null */
  distanceM: number | null
  /** 压住原因（已落位时为空串） */
  reason: string
}

/**
 * 评估样带落位：
 * - 无实测记录：按海图档案正常落位；
 * - 实测与海图偏差 ≤ 限差：按海图档案落位；
 * - 实测与海图偏差 > 限差且档案未核对通过：压住不布；
 * - 实测与海图偏差 > 限差但档案已核对通过：放行，按海图档案落位。
 */
export function evaluateBeltPosition(
  site: Site,
  survey: SiteSurvey | null,
  now: number
): PositionEval {
  void now
  if (survey) {
    const dist = distanceMeters(
      { lat: survey.measuredLat, lng: survey.measuredLng },
      { lat: site.chartLat, lng: site.chartLng }
    )
    if (dist > SURVEY_DISTANCE_LIMIT_M) {
      if (site.verifyStatus === '核对通过') {
        return {
          positionStatus: 'positioned',
          lat: site.chartLat,
          lng: site.chartLng,
          distanceM: dist,
          reason: ''
        }
      }
      return {
        positionStatus: 'held',
        lat: null,
        lng: null,
        distanceM: dist,
        reason: `实测与海图偏差 ${Math.round(dist)} m 超过限差 ${SURVEY_DISTANCE_LIMIT_M} m，样带压住待测绘组核对档案后放行`
      }
    }
    return { positionStatus: 'positioned', lat: site.chartLat, lng: site.chartLng, distanceM: dist, reason: '' }
  }
  return { positionStatus: 'positioned', lat: site.chartLat, lng: site.chartLng, distanceM: null, reason: '' }
}

/** 按评估结果生成样带落位字段 */
export function beltPositionFields(
  evalResult: PositionEval,
  now: number
): Pick<Belt, 'lat' | 'lng' | 'positionStatus' | 'positionedAt'> {
  if (evalResult.positionStatus === 'held') {
    return { lat: null, lng: null, positionStatus: 'held', positionedAt: null }
  }
  return {
    lat: evalResult.lat,
    lng: evalResult.lng,
    positionStatus: 'positioned',
    positionedAt: now
  }
}
