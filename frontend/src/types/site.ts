/** 海图档案核对状态（测绘组侧） */
export type VerifyStatus = '未核对' | '核对中' | '核对通过' | '核对失败'

export const VERIFY_STATUSES: VerifyStatus[] = ['未核对', '核对中', '核对通过', '核对失败']

/** 站位：测绘组海图档案（坐标以海图档案为准，外业实测不得覆盖） */
export interface Site {
  id: string
  /** 所属礁区 */
  reefId: string
  /** 站位编号，如 S-01（与外业队对账的主键） */
  no: string
  /** 海图纬度（十进制度，-90 ~ 90，测绘组档案值） */
  chartLat: number
  /** 海图经度（十进制度，-180 ~ 180，测绘组档案值） */
  chartLng: number
  /** 海图水深（m，测绘组档案值） */
  chartDepthM: number
  /** 底质类型（测绘组档案值） */
  substrate: string
  /** 档案核对状态（测绘组核对流程，外业实测不影响它） */
  verifyStatus: VerifyStatus
  /** 最近核对时间（ms），未核对为 null */
  verifiedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 外业实测记录：外业队每次补测一条，与测绘组档案相互独立、互不覆盖 */
export interface SiteSurvey {
  id: string
  /** 对账命中的档案站位 id；档案缺此站位编号（对不上）时为 null */
  siteId: string | null
  /** 所属礁区（对账上下文） */
  reefId: string
  /** 外业记录的站位编号（对账主键） */
  siteNo: string
  /** 实测纬度（十进制度） */
  measuredLat: number
  /** 实测经度（十进制度） */
  measuredLng: number
  /** 实测水深（m） */
  measuredDepthM: number
  /** 测量时间（YYYY-MM-DD） */
  measuredAt: string
  createdAt: number
}

/** 站位列表页筛选条件（存于 reefStore） */
export interface SiteFilterState {
  keyword: string
  /** 水深区间下限（m，按海图档案水深过滤） */
  minDepthM: number | null
  /** 水深区间上限（m，按海图档案水深过滤） */
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

/** 实测与海图偏差超过该阈值（m）时，样带压住不布 */
export const SURVEY_DISTANCE_LIMIT_M = 100

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

/** 地球平均半径（m），用于球面距离近似 */
const EARTH_RADIUS_M = 6371000

/**
 * 哈夫辛公式计算两点间球面距离（m）。
 * 用于判定外业实测位置与海图档案位置偏差是否超限。
 */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 在一组站位中按礁区 + 站位编号匹配档案站位（对账主键） */
export function matchSite(
  sites: Site[],
  reefId: string,
  siteNo: string
): Site | null {
  const no = siteNo.trim()
  return sites.find((site) => site.reefId === reefId && site.no === no) ?? null
}

/** 取某站位最近一次外业实测记录（按测量时间，回退创建时间） */
export function latestSurveyOf(surveys: SiteSurvey[], site: Site): SiteSurvey | null {
  const list = surveys
    .filter((survey) => survey.siteId === site.id || (survey.reefId === site.reefId && survey.siteNo === site.no))
    .sort((a, b) => {
      const aTime = a.measuredAt || ''
      const bTime = b.measuredAt || ''
      if (aTime !== bTime) return bTime.localeCompare(aTime)
      return b.createdAt - a.createdAt
    })
  return list[0] ?? null
}

/** 对账状态：对得上 / 对不上（档案缺此编号）/ 偏差超限 */
export type ReconcileStatus = 'matched' | 'missing-archive' | 'too-far'

export interface ReconcileItem {
  survey: SiteSurvey
  /** 命中的海图档案站位；对不上时为 null */
  site: Site | null
  /** 实测与海图偏差（m）；对不上时为 null */
  distanceM: number | null
  status: ReconcileStatus
  /** 归责提示：对不上查测绘组（补档案），偏差超限两边各查各的 */
  hint: string
}

/**
 * 两边按站位编号对账：
 * - 外业实测记录与海图档案按（礁区, 站位编号）匹配；
 * - 档案缺此编号 → 对不上，由测绘组补档案；
 * - 编号对得上但实测与海图偏差超限 → 两边各查各的（外业核实测、测绘组核档案）。
 */
export function reconcileSurveys(surveys: SiteSurvey[], sites: Site[]): ReconcileItem[] {
  return surveys.map((survey) => {
    const site = matchSite(sites, survey.reefId, survey.siteNo)
    if (!site) {
      return {
        survey,
        site: null,
        distanceM: null,
        status: 'missing-archive',
        hint: '档案中无此站位编号，对不上：请测绘组补登海图档案'
      }
    }
    const dist = distanceMeters(
      { lat: survey.measuredLat, lng: survey.measuredLng },
      { lat: site.chartLat, lng: site.chartLng }
    )
    if (dist > SURVEY_DISTANCE_LIMIT_M) {
      return {
        survey,
        site,
        distanceM: dist,
        status: 'too-far',
        hint: `实测与海图偏差 ${Math.round(dist)} m 超限差 ${SURVEY_DISTANCE_LIMIT_M} m：外业核实测点位，测绘组核海图档案，两边各查各的`
      }
    }
    return {
      survey,
      site,
      distanceM: dist,
      status: 'matched',
      hint: '实测与海图吻合'
    }
  })
}
