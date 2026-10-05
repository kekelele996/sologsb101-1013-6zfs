/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 珊瑚记录/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site, SiteSurvey } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import { evaluateBeltPosition, beltPositionFields } from '@/utils/position'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  /** 外业实测记录（与海图档案相互独立，备份时两边各留一份） */
  siteSurveys: SiteSurvey[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  siteSurveys!: Table<SiteSurvey, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：站位拆成「海图档案」与「外业实测」两份，样带落位认档案
    this.version(3)
      .stores({
        sites: 'id, reefId, no, chartLat, chartLng, chartDepthM, substrate, verifyStatus, updatedAt',
        siteSurveys: 'id, siteId, reefId, siteNo, measuredAt, createdAt',
        belts: 'id, siteId, no, positionStatus, surveyDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：旧数据没记坐标来源，升级时按现有站位补出海图档案一份（外业实测留空，不编造来源）
        await tx
          .table('sites')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const site = row as Record<string, unknown>
            if (site.chartLat === undefined) {
              site.chartLat = typeof site.lat === 'number' ? site.lat : 0
              site.chartLng = typeof site.lng === 'number' ? site.lng : 0
              site.chartDepthM = typeof site.depthM === 'number' ? site.depthM : 5
              delete site.lat
              delete site.lng
              delete site.depthM
            }
            if (typeof site.substrate !== 'string' || site.substrate === '') site.substrate = '珊瑚礁石'
            if (!['未核对', '核对中', '核对通过', '核对失败'].includes(site.verifyStatus as string)) {
              site.verifyStatus = '未核对'
            }
            if (site.verifiedAt === undefined) site.verifiedAt = null
          })

        // 迁移：样带补落位状态，按档案站位坐标落位（升级时无外业实测，全部正常落位）
        const siteRows = (await tx.table('sites').toArray()) as Array<Record<string, unknown>>
        const siteCoord = new Map(
          siteRows.map((site) => [site.id as string, { lat: site.chartLat as number, lng: site.chartLng as number }])
        )
        const now = Date.now()
        await tx
          .table('belts')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const belt = row as Record<string, unknown>
            if (belt.positionStatus === undefined) {
              const coord = siteCoord.get(belt.siteId as string)
              belt.lat = coord ? coord.lat : null
              belt.lng = coord ? coord.lng : null
              belt.positionStatus = coord ? 'positioned' : 'held'
              belt.positionedAt = coord ? (typeof belt.createdAt === 'number' ? belt.createdAt : now) : null
            }
          })
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 14 条珊瑚记录 + 12 条鱼类计数，
 * 覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级，保证每个页面打开都有内容、层级路由也能命中真实 id。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      chartLat: 19.5621,
      chartLng: 110.7924,
      chartDepthM: 4.2,
      substrate: '珊瑚礁石',
      verifyStatus: '核对通过',
      verifiedAt: now - 86400000 * 2
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      chartLat: 19.5487,
      chartLng: 110.8103,
      chartDepthM: 8.6,
      substrate: '礁砂',
      verifyStatus: '未核对',
      verifiedAt: null
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      chartLat: 16.8342,
      chartLng: 112.3286,
      chartDepthM: 12.4,
      substrate: '砾石',
      verifyStatus: '核对通过',
      verifiedAt: now - 86400000 * 5
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      chartLat: 18.6712,
      chartLng: 110.4913,
      chartDepthM: 6.8,
      substrate: '岩礁',
      verifyStatus: '核对失败',
      verifiedAt: now - 86400000
    }
  ]

  // 外业实测记录：与海图档案相互独立。清澜湾 S-02 实测明显偏远（触发样带压住），
  // 清澜湾另有一条 S-99 实测在档案中无对应编号（演示对账对不上）。
  const siteSurveys: Array<Omit<SiteSurvey, 'id' | 'createdAt'>> = [
    {
      siteId: 'site_ql_01',
      reefId: 'reef_ql01',
      siteNo: 'S-01',
      measuredLat: 19.5625,
      measuredLng: 110.7928,
      measuredDepthM: 4.5,
      measuredAt: today
    },
    {
      siteId: 'site_ql_02',
      reefId: 'reef_ql01',
      siteNo: 'S-02',
      measuredLat: 19.5577,
      measuredLng: 110.8199,
      measuredDepthM: 9.2,
      measuredAt: today
    },
    {
      siteId: 'site_yr_01',
      reefId: 'reef_yr02',
      siteNo: 'S-01',
      measuredLat: 16.8346,
      measuredLng: 112.329,
      measuredDepthM: 12.1,
      measuredAt: today
    },
    {
      siteId: 'site_dz_01',
      reefId: 'reef_dz03',
      siteNo: 'S-01',
      measuredLat: 18.6716,
      measuredLng: 110.4917,
      measuredDepthM: 7.1,
      measuredAt: today
    },
    {
      siteId: null,
      reefId: 'reef_ql01',
      siteNo: 'S-99',
      measuredLat: 19.57,
      measuredLng: 110.8,
      measuredDepthM: 3.0,
      measuredAt: today
    }
  ]

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  await db.transaction('rw', [db.reefs, db.sites, db.siteSurveys, db.belts, db.corals, db.fishes], async () => {
    const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
      createdAt: now + offset,
      updatedAt: now + offset
    })

    await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
    await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
    await db.siteSurveys.bulkPut(
      siteSurveys.map((survey, index) => ({
        ...survey,
        id: `svy_${String(index + 1).padStart(2, '0')}`,
        createdAt: now + 150 + index
      }))
    )
    await db.belts.bulkPut(
      belts.map((belt, index) => {
        const { corals, fishes, ...rest } = belt
        void corals
        void fishes
        const site = sites.find((item) => item.id === belt.siteId)
        const survey = siteSurveys.find((item) => item.siteId === belt.siteId) ?? null
        const evalResult = site
          ? evaluateBeltPosition(site as Site, survey as SiteSurvey | null, now + 200 + index)
          : null
        const position = evalResult
          ? beltPositionFields(evalResult, now + 200 + index)
          : { lat: null, lng: null, positionStatus: 'held' as const, positionedAt: null }
        return { ...rest, ...position, ...stamp(200 + index) }
      })
    )
    await db.corals.bulkPut(
      belts.flatMap((belt, beltIndex) =>
        belt.corals.map((coral, coralIndex) => ({ ...coral, ...stamp(300 + beltIndex * 100 + coralIndex) }))
      )
    )
    await db.fishes.bulkPut(
      belts.flatMap((belt, beltIndex) =>
        belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
      )
    )
  })
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.reefs, db.sites, db.siteSurveys, db.belts, db.corals, db.fishes], async () => {
    await Promise.all([
      db.reefs.clear(),
      db.sites.clear(),
      db.siteSurveys.clear(),
      db.belts.clear(),
      db.corals.clear(),
      db.fishes.clear()
    ])
  })
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, siteSurveys, belts, corals, fishes] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.siteSurveys.count(),
    db.belts.count(),
    db.corals.count(),
    db.fishes.count()
  ])
  return { reefs, sites, siteSurveys, belts, corals, fishes }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
