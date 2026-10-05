/**
 * 礁区 store：维护礁区与测绘组站位档案列表、当前选中站位与筛选条件。
 * 数据经 utils/db.ts 的 Dexie liveQuery 订阅，页面只读消费。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, readLastReefId, watchTable, writeLastReefId } from '@/utils/db'
import type { Reef, ReefFilterState } from '@/types/reef'
import { createEmptyReefFilter } from '@/types/reef'
import type { Site, SiteFilterState, SiteReconcileStatus } from '@/types/site'
import { createEmptySiteFilter, reconcileStatusFromGap } from '@/types/site'
import { bleachIndex, round } from '@/utils/bleach'

export type SiteArchiveInput = Omit<
  Site,
  'id' | 'createdAt' | 'updatedAt' | 'reconcileStatus' | 'reconciledAt'
>
export type SiteArchivePatch = Partial<
  Pick<Site, 'reefId' | 'no' | 'chartLat' | 'chartLng' | 'chartDepthM' | 'substrate'>
>

export const useReefStore = defineStore('reef', () => {
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
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
  }

  const currentReef = computed<Reef | null>(
    () => reefs.value.find((reef) => reef.id === currentReefId.value) ?? null
  )

  const currentSite = computed<Site | null>(
    () => sites.value.find((site) => site.id === currentSiteId.value) ?? null
  )

  /** 某礁区下的站位档案（按站位编号排序） */
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

  /** 按筛选条件过滤后的站位（水深筛选使用测绘组档案水深） */
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

  /** 删除礁区：级联删除档案站位、外业实测、样带、珊瑚记录与鱼类计数 */
  async function removeReef(id: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.reefs, db.sites, db.siteMeasurements, db.belts, db.corals, db.fishes],
      async () => {
        const siteIds = (await db.sites.where('reefId').equals(id).toArray()).map((row) => row.id)
        if (siteIds.length > 0) {
          const beltIds = (await db.belts.where('siteId').anyOf(siteIds).toArray()).map((row) => row.id)
          if (beltIds.length > 0) {
            await db.corals.where('beltId').anyOf(beltIds).delete()
            await db.fishes.where('beltId').anyOf(beltIds).delete()
            await db.belts.bulkDelete(beltIds)
          }
          await db.sites.bulkDelete(siteIds)
        }
        await db.siteMeasurements.where('reefId').equals(id).delete()
        await db.reefs.delete(id)
      }
    )
    if (currentReefId.value === id) selectReef(null)
  }

  /* ----------------------------- 测绘站位档案 ----------------------------- */

  async function createSite(payload: SiteArchiveInput): Promise<Site> {
    const now = Date.now()
    const base: Site = {
      ...payload,
      id: createId('site'),
      reconcileStatus: 'unmeasured',
      reconciledAt: null,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.sites, db.siteMeasurements], async () => {
      const measurement = (await db.siteMeasurements
        .where('reefId')
        .equals(base.reefId)
        .toArray()
      ).find((item) => item.no === base.no)
      if (measurement) {
        base.reconcileStatus = reconcileStatusFromGap(base, measurement)
        base.reconciledAt = base.reconcileStatus === 'verified' ? now : null
      }
      await db.sites.put(base)
    })
    return base
  }

  /**
   * 修改测绘组档案。
   * 档案坐标改准后，已布样带按新的档案坐标重新落位；核对状态按当前外业实测重算。
   */
  async function updateSiteArchive(id: string, patch: SiteArchivePatch): Promise<void> {
    await db.transaction('rw', [db.sites, db.siteMeasurements, db.belts], async () => {
      const before = await db.sites.get(id)
      if (!before) return
      const now = Date.now()
      const next: Site = {
        ...before,
        ...patch,
        updatedAt: now
      }
      const coordinateChanged =
        patch.chartLat !== undefined ||
        patch.chartLng !== undefined ||
        patch.chartDepthM !== undefined ||
        patch.reefId !== undefined ||
        patch.no !== undefined

      if (
        (patch.chartLat !== undefined && patch.chartLat !== before.chartLat) ||
        (patch.chartLng !== undefined && patch.chartLng !== before.chartLng)
      ) {
        await db.belts.where('siteId').equals(id).modify((belt) => {
          belt.anchorLat = next.chartLat
          belt.anchorLng = next.chartLng
          belt.updatedAt = now
        })
      }

      if (coordinateChanged) {
        const measurement = (await db.siteMeasurements
          .where('reefId')
          .equals(next.reefId)
          .toArray()
        ).find((item) => item.no === next.no)
        next.reconcileStatus = reconcileStatusFromGap(next, measurement)
        next.reconciledAt = next.reconcileStatus === 'verified' ? now : null
      }

      await db.sites.put(next)

      // 站位编号或所属礁区变更后，旧编号下的实测记录不再与本档案对账；
      // 若旧编号仍有另一份档案，则按那份档案重新计算。
      if (coordinateChanged && (before.reefId !== next.reefId || before.no !== next.no)) {
        const oldMeasurement = (await db.siteMeasurements
          .where('reefId')
          .equals(before.reefId)
          .toArray()
        ).find((item) => item.no === before.no)
        if (oldMeasurement) {
          const oldSites = await db.sites.where('reefId').equals(before.reefId).toArray()
          const oldSite = oldSites.find((item) => item.no === before.no)
          if (oldSite) {
            const status = reconcileStatusFromGap(oldSite, oldMeasurement)
            await db.sites.update(oldSite.id, {
              reconcileStatus: status,
              reconciledAt: status === 'verified' ? now : null,
              updatedAt: now
            })
          }
        }
      }
    })
  }

  /** 测绘组人工标记核对结果；不会改动外业实测数据。 */
  async function setSiteReconcileStatus(id: string, status: SiteReconcileStatus): Promise<void> {
    const now = Date.now()
    await db.sites.update(id, {
      reconcileStatus: status,
      reconciledAt: status === 'verified' ? now : null,
      updatedAt: now
    })
  }

  /** 测绘组核对失败后只重试档案侧：根据当前档案值与外业实测重新计算，不改外业表。 */
  async function retrySiteArchiveReconcile(id: string): Promise<SiteReconcileStatus> {
    let status: SiteReconcileStatus = 'unmeasured'
    await db.transaction('rw', [db.sites, db.siteMeasurements], async () => {
      const site = await db.sites.get(id)
      if (!site) return
      const measurement = (await db.siteMeasurements
        .where('reefId')
        .equals(site.reefId)
        .toArray()
      ).find((item) => item.no === site.no)
      status = reconcileStatusFromGap(site, measurement)
      const now = Date.now()
      await db.sites.update(id, {
        reconcileStatus: status,
        reconciledAt: status === 'verified' ? now : null,
        updatedAt: now
      })
    })
    return status
  }

  /** 删除站位档案：级联删除其样带、珊瑚记录与鱼类计数；外业实测保留，列入编号对账异常。 */
  async function removeSite(id: string): Promise<void> {
    await db.transaction('rw', [db.sites, db.belts, db.corals, db.fishes], async () => {
      const beltIds = (await db.belts.where('siteId').equals(id).toArray()).map((row) => row.id)
      if (beltIds.length > 0) {
        await db.corals.where('beltId').anyOf(beltIds).delete()
        await db.fishes.where('beltId').anyOf(beltIds).delete()
        await db.belts.bulkDelete(beltIds)
      }
      await db.sites.delete(id)
    })
    if (currentSiteId.value === id) selectSite(null)
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
    createReef,
    updateReef,
    removeReef,
    createSite,
    updateSiteArchive,
    setSiteReconcileStatus,
    retrySiteArchiveReconcile,
    removeSite,
    siteBleachAverages
  }
})
