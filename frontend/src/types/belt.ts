/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/** 样带落位状态：已落位（按海图档案坐标）/ 压住待核（实测与档案偏差超限） */
export type BeltPositionStatus = 'positioned' | 'held'

/** 样带：站位上布设的普查样带，落位坐标认海图档案站位 */
export interface Belt {
  id: string
  /** 所属站位 */
  siteId: string
  /** 样带编号，如 T-01 */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  /** 落位纬度（取自海图档案；压住待核时为 null） */
  lat: number | null
  /** 落位经度（取自海图档案；压住待核时为 null） */
  lng: number | null
  /** 落位状态：已落位 / 压住待核 */
  positionStatus: BeltPositionStatus
  /** 落位时间（ms），未落地为 null */
  positionedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 样带布设草稿（存于 beltStore） */
export interface BeltDraft {
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: ''
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
