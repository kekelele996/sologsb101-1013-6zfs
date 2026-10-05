/**
 * 外业实测 store：维护实测经纬度、实测水深与测量时间。
 * 实测数据按 reefId + 站位编号与测绘组站位档案对账，不覆盖档案坐标。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Site, SiteMeasurement } from '@/types/site'
import { reconcileStatusFromGap } from '@/types/site'

export type SiteMeasurementPayload = Omit<SiteMeasurement, 'id' | 'createdAt' | 'updatedAt'>

export const useSiteMeasurementStore = defineStore('siteMeasurement', () => {
  const measurements = ref<SiteMeasurement[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SiteMeasurement>(() => db.siteMeasurements).subscribe((rows) => {
      measurements.value = rows
      ready.value = true
      error.value = null
    })
  }

  function measurementForSite(site: Pick<Site, 'reefId' | 'no'> | null | undefined): SiteMeasurement | null {
    if (!site) return null
    return (
      measurements.value.find((item) => item.reefId === site.reefId && item.no === site.no) ?? null
    )
  }

  function measurementByReefAndNo(reefId: string, no: string): SiteMeasurement | null {
    return measurements.value.find((item) => item.reefId === reefId && item.no === no.trim()) ?? null
  }

  /** 新增或更新外业实测；补测只写外业表，并重新计算档案核对状态，不移动已布样带。 */
  async function upsertMeasurement(
    reefId: string,
    no: string,
    payload: Omit<SiteMeasurementPayload, 'reefId' | 'no'>,
    existingId: string | null = null
  ): Promise<SiteMeasurement> {
    const now = Date.now()
    const normalizedNo = no.trim()
    const existing =
      measurements.value.find((item) => item.id === existingId) ??
      measurements.value.find((item) => item.reefId === reefId && item.no === normalizedNo) ??
      null

    const row: SiteMeasurement = existing
      ? {
          ...existing,
          reefId,
          no: normalizedNo,
          ...payload,
          updatedAt: now
        }
      : {
          id: createId('meas'),
          reefId,
          no: normalizedNo,
          ...payload,
          createdAt: now,
          updatedAt: now
        }

    await db.transaction('rw', [db.siteMeasurements, db.sites], async () => {
      await db.siteMeasurements.put(row)

      // 若实测记录改挂到别的站位编号，原档案回到“未录实测”；新档案按距离重算。
      if (existing && (existing.reefId !== reefId || existing.no !== normalizedNo)) {
        const previous = await db.sites
          .where('reefId')
          .equals(existing.reefId)
          .toArray()
          .then((rows) => rows.find((item) => item.no === existing.no))
        if (previous) {
          await db.sites.update(previous.id, {
            reconcileStatus: 'unmeasured',
            reconciledAt: null,
            updatedAt: now
          })
        }
      }

      const matchedSites = await db.sites.where('reefId').equals(reefId).toArray()
      const matchedSite = matchedSites.find((item) => item.no === normalizedNo)
      if (matchedSite) {
        await db.sites.update(matchedSite.id, {
          reconcileStatus: reconcileStatusFromGap(matchedSite, row),
          reconciledAt: reconcileStatusFromGap(matchedSite, row) === 'verified' ? now : null,
          updatedAt: now
        })
      }
    })

    return row
  }

  async function removeMeasurement(id: string): Promise<void> {
    const measurement = measurements.value.find((item) => item.id === id)
    await db.transaction('rw', [db.siteMeasurements, db.sites], async () => {
      await db.siteMeasurements.delete(id)
      if (measurement) {
        const matchedSites = await db.sites.where('reefId').equals(measurement.reefId).toArray()
        const matchedSite = matchedSites.find((item) => item.no === measurement.no)
        if (matchedSite) {
          await db.sites.update(matchedSite.id, {
            reconcileStatus: 'unmeasured',
            reconciledAt: null,
            updatedAt: Date.now()
          })
        }
      }
    })
  }

  return {
    measurements,
    ready,
    error,
    start,
    measurementForSite,
    measurementByReefAndNo,
    upsertMeasurement,
    removeMeasurement
  }
})
