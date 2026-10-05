/**
 * 礁区 store：维护礁区与站位列表、当前选中站位与筛选条件。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅，页面只读消费。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, readLastReefId, watchTable, writeLastReefId } from '@/utils/db'
import type { Reef, ReefFilterState } from '@/types/reef'
import { createEmptyReefFilter } from '@/types/reef'
import type { Site, SiteFilterState, SiteSurvey, VerifyStatus } from '@/types/site'
import {
  createEmptySiteFilter,
  latestSurveyOf,
  matchSite,
  reconcileSurveys,
  type ReconcileItem
} from '@/types/site'
import { evaluateBeltPosition, beltPositionFields } from '@/utils/position'
import { bleachIndex, round } from '@/utils/bleach'

export const useReefStore = defineStore('reef', () => {
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  /** 外业实测记录（外业队侧，与海图档案相互独立） */
  const surveys = ref<SiteSurvey[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentReefId = ref<string | null>(readLastReefId())
  const currentSiteId = ref<string | null>(null)
  const filter = ref<ReefFilterState>(createEmptyReefFilter())
  const siteFilter = ref<SiteFilterState>(createEmptySiteFilter())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
      ready.value = true
      error.value = null
      if (currentReefId.value === null && rows.length > 0) selectReef(rows[0].id)
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<SiteSurvey>(() => db.siteSurveys).subscribe((rows) => {
      surveys.value = rows
    })
  }

  const currentReef = computed<Reef | null>(
    () => reefs.value.find((reef) => reef.id === currentReefId.value) ?? null
  )

  const currentSite = computed<Site | null>(
    () => sites.value.find((site) => site.id === currentSiteId.value) ?? null
  )

  /** 某礁区下的站位（按站位编号排序） */
  function sitesOfReef(reefId: string | null | undefined): Site[] {
    if (!reefId) return []
    return sites.value
      .filter((site) => site.reefId === reefId)
      .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
  }

  /** 按筛选条件过滤后的礁区 */
  const filteredReefs = computed<Reef[]>(() =>
    reefs.value.filter((reef) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${reef.name}${reef.location}${reef.manager}${reef.protectStatus}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.protectStatuses.length > 0 && !filter.value.protectStatuses.includes(reef.protectStatus)) {
        return false
      }
      if (filter.value.minAreaKm2 !== null && reef.areaKm2 < filter.value.minAreaKm2) return false
      if (filter.value.maxAreaKm2 !== null && reef.areaKm2 > filter.value.maxAreaKm2) return false
      return true
    })
  )

  /** 按筛选条件过滤后的站位（水深按海图档案值过滤） */
  const filteredSites = computed<Site[]>(() =>
    sites.value.filter((site) => {
      const keyword = siteFilter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${site.no}${site.substrate}`
        if (!haystack.includes(keyword)) return false
      }
      if (siteFilter.value.minDepthM !== null && site.chartDepthM < siteFilter.value.minDepthM) return false
      if (siteFilter.value.maxDepthM !== null && site.chartDepthM > siteFilter.value.maxDepthM) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.protectStatuses.length > 0 ||
      filter.value.minAreaKm2 !== null ||
      filter.value.maxAreaKm2 !== null
  )

  /** 礁区 id → 站位数与总面积 */
  const reefStats = computed<Record<string, { siteCount: number; areaKm2: number }>>(() => {
    const stats: Record<string, { siteCount: number; areaKm2: number }> = {}
    reefs.value.forEach((reef) => {
      stats[reef.id] = {
        siteCount: sites.value.filter((site) => site.reefId === reef.id).length,
        areaKm2: reef.areaKm2
      }
    })
    return stats
  })

  function patchFilter(patch: Partial<ReefFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyReefFilter()
  }

  function patchSiteFilter(patch: Partial<SiteFilterState>): void {
    siteFilter.value = { ...siteFilter.value, ...patch }
  }

  function resetSiteFilter(): void {
    siteFilter.value = createEmptySiteFilter()
  }

  function selectReef(id: string | null): void {
    currentReefId.value = id
    writeLastReefId(id)
  }

  function selectSite(id: string | null): void {
    currentSiteId.value = id
  }

  function reefById(id: string | null | undefined): Reef | null {
    if (!id) return null
    return reefs.value.find((reef) => reef.id === id) ?? null
  }

  function siteById(id: string | null | undefined): Site | null {
    if (!id) return null
    return sites.value.find((site) => site.id === id) ?? null
  }

  /* ------------------------------- 礁区 ------------------------------- */

  async function createReef(payload: Omit<Reef, 'id' | 'createdAt' | 'updatedAt'>): Promise<Reef> {
    const now = Date.now()
    const row: Reef = { ...payload, id: createId('reef'), createdAt: now, updatedAt: now }
    await db.reefs.put(row)
    return row
  }

  async function updateReef(id: string, patch: Partial<Reef>): Promise<void> {
    await db.reefs.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除礁区：级联删除其站位、实测记录、样带、珊瑚记录与鱼类计数 */
  async function removeReef(id: string): Promise<void> {
    await db.transaction('rw', [db.reefs, db.sites, db.siteSurveys, db.belts, db.corals, db.fishes], async () => {
      const siteIds = (await db.sites.where('reefId').equals(id).toArray()).map((row) => row.id)
      if (siteIds.length > 0) {
        const beltIds = (await db.belts.where('siteId').anyOf(siteIds).toArray()).map((row) => row.id)
        if (beltIds.length > 0) {
          await db.corals.where('beltId').anyOf(beltIds).delete()
          await db.fishes.where('beltId').anyOf(beltIds).delete()
          await db.belts.bulkDelete(beltIds)
        }
        await db.siteSurveys.where('reefId').equals(id).delete()
        await db.sites.bulkDelete(siteIds)
      }
      await db.reefs.delete(id)
    })
    if (currentReefId.value === id) selectReef(null)
  }

  /* ------------------------------- 站位（海图档案） ------------------------------- */

  async function createSite(
    payload: Omit<Site, 'id' | 'createdAt' | 'updatedAt' | 'verifyStatus' | 'verifiedAt'>
  ): Promise<Site> {
    const now = Date.now()
    const row: Site = {
      ...payload,
      verifyStatus: '未核对',
      verifiedAt: null,
      id: createId('site'),
      createdAt: now,
      updatedAt: now
    }
    await db.sites.put(row)
    return row
  }

  async function updateSite(id: string, patch: Partial<Site>): Promise<void> {
    await db.sites.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除站位：级联删除其实测记录、样带、珊瑚记录与鱼类计数 */
  async function removeSite(id: string): Promise<void> {
    const site = sites.value.find((item) => item.id === id)
    await db.transaction('rw', [db.sites, db.siteSurveys, db.belts, db.corals, db.fishes], async () => {
      const beltIds = (await db.belts.where('siteId').equals(id).toArray()).map((row) => row.id)
      if (beltIds.length > 0) {
        await db.corals.where('beltId').anyOf(beltIds).delete()
        await db.fishes.where('beltId').anyOf(beltIds).delete()
        await db.belts.bulkDelete(beltIds)
      }
      // 外业实测：删除命中本档案站位的记录，以及按（礁区, 编号）对不上的孤儿记录
      await db.siteSurveys.where('siteId').equals(id).delete()
      if (site) {
        await db.siteSurveys
          .filter((survey) => survey.reefId === site.reefId && survey.siteNo === site.no)
          .delete()
      }
      await db.sites.delete(id)
    })
    if (currentSiteId.value === id) selectSite(null)
  }

  /* ----------------------------- 外业实测（外业队侧） ----------------------------- */

  /** 某站位的全部外业实测记录（按测量时间倒序） */
  function surveysOfSite(siteId: string | null | undefined): SiteSurvey[] {
    if (!siteId) return []
    const site = sites.value.find((item) => item.id === siteId)
    return surveys.value
      .filter(
        (survey) => survey.siteId === siteId || (site && survey.reefId === site.reefId && survey.siteNo === site.no)
      )
      .sort((a, b) => (b.measuredAt || '').localeCompare(a.measuredAt || '') || b.createdAt - a.createdAt)
  }

  /** 某站位最近一次外业实测记录 */
  function latestSurveyOfSite(siteId: string | null | undefined): SiteSurvey | null {
    const site = sites.value.find((item) => item.id === siteId)
    if (!site) return null
    return latestSurveyOf(surveys.value, site)
  }

  /**
   * 外业补测：新增一条实测记录（只写外业队自己的表，不动海图档案）。
   * siteId 按（礁区, 站位编号）对账命中档案；对不上则留空，等测绘组补档案。
   */
  async function createSurvey(
    payload: Omit<SiteSurvey, 'id' | 'createdAt' | 'siteId'> & { siteId?: string | null }
  ): Promise<SiteSurvey> {
    const now = Date.now()
    const matched = payload.siteId
      ? sites.value.find((site) => site.id === payload.siteId) ?? null
      : matchSite(sites.value, payload.reefId, payload.siteNo)
    const row: SiteSurvey = {
      ...payload,
      siteId: matched?.id ?? null,
      id: createId('svy'),
      createdAt: now
    }
    await db.siteSurveys.put(row)
    return row
  }

  /** 两边按站位编号对账，返回逐条核对结果 */
  const reconcileReport = computed<ReconcileItem[]>(() => reconcileSurveys(surveys.value, sites.value))

  /* ------------------------------- 档案核对与落位 ------------------------------- */

  /**
   * 测绘组核对海图档案：只重试着档案侧，外业实测记录原样不动。
   * 核对通过后，把因偏差超限而压住的样带按档案坐标放行落位。
   */
  async function verifySite(siteId: string): Promise<VerifyStatus> {
    const site = await db.sites.get(siteId)
    if (!site) return '核对失败'
    await db.sites.update(siteId, { verifyStatus: '核对中', updatedAt: Date.now() } as never)
    // 模拟核对过程：档案字段完整有效即通过，否则失败（失败后可重试，外业数据不受影响）
    await new Promise((resolve) => setTimeout(resolve, 500))
    const valid =
      Number.isFinite(site.chartLat) &&
      site.chartLat >= -90 &&
      site.chartLat <= 90 &&
      Number.isFinite(site.chartLng) &&
      site.chartLng >= -180 &&
      site.chartLng <= 180 &&
      Number.isFinite(site.chartDepthM) &&
      site.chartDepthM >= 0 &&
      site.substrate.trim().length > 0
    const next: VerifyStatus = valid ? '核对通过' : '核对失败'
    await db.sites.update(
      siteId,
      { verifyStatus: next, verifiedAt: valid ? Date.now() : site.verifiedAt, updatedAt: Date.now() } as never
    )
    if (next === '核对通过') {
      await repositionBelts(siteId)
    }
    return next
  }

  /**
   * 测绘组改准档案坐标后，已布样带按档案值重新落位：
   * 逐条重算落位坐标（认海图档案），偏差超限且未核对通过的继续压住。
   * 直接读库取最新档案，避免 liveQuery 刷新延迟导致放行判定读到旧状态。
   */
  async function repositionBelts(siteId: string): Promise<number> {
    const site = await db.sites.get(siteId)
    if (!site) return 0
    const siteBelts = await db.belts.where('siteId').equals(siteId).toArray()
    const now = Date.now()
    let released = 0
    for (const belt of siteBelts) {
      const survey = latestSurveyOf(surveys.value, site)
      const evalResult = evaluateBeltPosition(site, survey, now)
      const position = beltPositionFields(evalResult, now)
      const changed =
        belt.positionStatus !== position.positionStatus ||
        belt.lat !== position.lat ||
        belt.lng !== position.lng
      if (changed) {
        await db.belts.update(belt.id, { ...position, updatedAt: now } as never)
      }
      if (position.positionStatus === 'positioned') released += 1
    }
    return released
  }

  /** 站位 id → 样带数与平均白化指数（列表回显用） */
  async function siteBleachAverages(): Promise<Record<string, number>> {
    const result: Record<string, number> = {}
    for (const site of sites.value) {
      const beltIds = (await db.belts.where('siteId').equals(site.id).toArray()).map((row) => row.id)
      if (beltIds.length === 0) {
        result[site.id] = 0
        continue
      }
      const corals = await db.corals.where('beltId').anyOf(beltIds).toArray()
      result[site.id] = round(bleachIndex(corals), 2)
    }
    return result
  }

  return {
    reefs,
    sites,
    surveys,
    ready,
    error,
    currentReefId,
    currentReef,
    currentSiteId,
    currentSite,
    filter,
    siteFilter,
    filteredReefs,
    filteredSites,
    reconcileReport,
    hasFilter,
    reefStats,
    start,
    sitesOfReef,
    patchFilter,
    resetFilter,
    patchSiteFilter,
    resetSiteFilter,
    selectReef,
    selectSite,
    reefById,
    siteById,
    surveysOfSite,
    latestSurveyOfSite,
    createReef,
    updateReef,
    removeReef,
    createSite,
    updateSite,
    removeSite,
    createSurvey,
    verifySite,
    repositionBelts,
    siteBleachAverages
  }
})
