<script setup lang="ts">
/**
 * 模块 2：/reefs/:id/sites 站位档案、外业实测与编号对账
 * 测绘组维护海图经纬度、海图水深和底质；外业队维护实测经纬度、实测水深和测量时间。
 * 样带只认档案站位；实测坐标超差时压住新样带，等测绘组核对后再放。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, Delete, Edit, Plus, RefreshRight, Right, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import { buildQuery, queryToNumber } from '@/types/filter'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useSiteMeasurementStore } from '@/stores/siteMeasurementStore'
import {
  SITE_COORDINATE_HOLD_THRESHOLD_M,
  SITE_RECONCILE_STATUS_LABEL,
  SUBSTRATES,
  formatLatLng,
  getSiteCoordinateGap,
  isSiteDeploymentBlocked,
  validateLatLng
} from '@/types/site'
import type { Site, SiteMeasurement, SiteReconcileStatus } from '@/types/site'
import { bleachGrade, bleachIndex } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const measurementStore = useSiteMeasurementStore()

const reefId = computed(() => String(route.params.id ?? ''))
const reef = computed(() => reefStore.reefById(reefId.value))

const archiveDialogVisible = ref(false)
const measurementDialogVisible = ref(false)
const editingSiteId = ref<string | null>(null)
const editingMeasurementId = ref<string | null>(null)
const submitting = ref(false)

const archiveForm = reactive({
  no: '',
  chartLat: 18.5,
  chartLng: 110.5,
  chartDepthM: 5,
  substrate: SUBSTRATES[0]
})

const measurementForm = reactive({
  no: '',
  measuredLat: 18.5,
  measuredLng: 110.5,
  measuredDepthM: 5,
  measuredAt: `${new Date().toISOString().slice(0, 10)} 09:00`
})

interface SiteRow {
  site: Site
  measurement: SiteMeasurement | null
  distanceM: number | null
  depthGapM: number | null
  blocked: boolean
  beltCount: number
  beltLengthM: number
  coralCount: number
  bleachIndex: number
  grade: ReturnType<typeof bleachGrade>
}

const rows = computed<SiteRow[]>(() => {
  const sites = reefStore.sitesOfReef(reefId.value).filter((site) => {
    const keyword = reefStore.siteFilter.keyword.trim()
    if (keyword.length > 0 && !`${site.no}${site.substrate}`.includes(keyword)) return false
    if (reefStore.siteFilter.minDepthM !== null && site.chartDepthM < reefStore.siteFilter.minDepthM) return false
    if (reefStore.siteFilter.maxDepthM !== null && site.chartDepthM > reefStore.siteFilter.maxDepthM) return false
    return true
  })

  return sites.map((site) => {
    const measurement = measurementStore.measurementForSite(site)
    const gap = measurement ? getSiteCoordinateGap(site, measurement) : null
    const belts = beltStore.beltsOfSite(site.id)
    const beltIds = new Set(belts.map((belt) => belt.id))
    const corals = surveyStore.corals.filter((coral) => beltIds.has(coral.beltId))
    const index = bleachIndex(corals)
    return {
      site,
      measurement,
      distanceM: gap ? Math.round(gap.distanceM) : null,
      depthGapM: gap ? Number(gap.depthGapM.toFixed(1)) : null,
      blocked: isSiteDeploymentBlocked(site, measurement),
      beltCount: belts.length,
      beltLengthM: belts.reduce((sum, belt) => sum + belt.lengthM, 0),
      coralCount: corals.length,
      bleachIndex: index,
      grade: bleachGrade(index)
    }
  })
})

/** 外业有实测、测绘无档案：各查各的，不能挂到任意站位上。 */
const unmatchedMeasurements = computed(() => {
  const archiveKeys = new Set(
    reefStore.sitesOfReef(reefId.value).map((site) => `${site.reefId}::${site.no}`)
  )
  return measurementStore.measurements
    .filter((measurement) => measurement.reefId === reefId.value)
    .filter((measurement) => !archiveKeys.has(`${measurement.reefId}::${measurement.no}`))
    .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
})

const filterModel = computed<FilterModel>(() => ({
  keyword: reefStore.siteFilter.keyword,
  minDepthM: reefStore.siteFilter.minDepthM,
  maxDepthM: reefStore.siteFilter.maxDepthM
}))

const stats = computed(() => {
  const sites = reefStore.sitesOfReef(reefId.value)
  const depths = sites.map((site) => site.chartDepthM)
  const belts = beltStore.belts.filter((belt) => sites.some((site) => site.id === belt.siteId))
  const measuredSiteKeys = new Set(
    measurementStore.measurements
      .filter((measurement) => measurement.reefId === reefId.value)
      .map((measurement) => measurement.no)
  )
  return {
    siteCount: sites.length,
    beltCount: belts.length,
    minDepthM: depths.length ? Math.min(...depths) : null,
    maxDepthM: depths.length ? Math.max(...depths) : null,
    avgDepthM: depths.length ? Number((depths.reduce((sum, value) => sum + value, 0) / depths.length).toFixed(2)) : null,
    pendingCount: sites.filter((site) => site.reconcileStatus === 'pending' || site.reconcileStatus === 'failed').length,
    measuredCount: sites.filter((site) => measuredSiteKeys.has(site.no)).length,
    unmatchedCount: unmatchedMeasurements.value.length
  }
})

function statusTagType(status: SiteReconcileStatus): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'verified') return 'success'
  if (status === 'pending') return 'warning'
  if (status === 'failed') return 'danger'
  return 'info'
}

function reconcileLabel(status: SiteReconcileStatus): string {
  return SITE_RECONCILE_STATUS_LABEL[status]
}

function openCreateArchive(): void {
  editingSiteId.value = null
  const existing = reefStore.sitesOfReef(reefId.value)
  archiveForm.no = `S-${String(existing.length + 1).padStart(2, '0')}`
  archiveForm.chartLat = Number((18.5 + existing.length * 0.01).toFixed(4))
  archiveForm.chartLng = Number((110.5 + existing.length * 0.01).toFixed(4))
  archiveForm.chartDepthM = 5
  archiveForm.substrate = SUBSTRATES[0]
  archiveDialogVisible.value = true
}

function openEditArchive(site: Site): void {
  editingSiteId.value = site.id
  archiveForm.no = site.no
  archiveForm.chartLat = site.chartLat
  archiveForm.chartLng = site.chartLng
  archiveForm.chartDepthM = site.chartDepthM
  archiveForm.substrate = site.substrate
  archiveDialogVisible.value = true
}

function openCreateMeasurement(no = ''): void {
  editingMeasurementId.value = null
  const defaultSite = no ? reefStore.sitesOfReef(reefId.value).find((site) => site.no === no) : null
  measurementForm.no = no || `S-${String(reefStore.sitesOfReef(reefId.value).length + 1).padStart(2, '0')}`
  measurementForm.measuredLat = defaultSite?.chartLat ?? 18.5
  measurementForm.measuredLng = defaultSite?.chartLng ?? 110.5
  measurementForm.measuredDepthM = defaultSite?.chartDepthM ?? 5
  measurementForm.measuredAt = `${new Date().toISOString().slice(0, 10)} 09:00`
  measurementDialogVisible.value = true
}

function openEditMeasurement(measurement: SiteMeasurement): void {
  editingMeasurementId.value = measurement.id
  measurementForm.no = measurement.no
  measurementForm.measuredLat = measurement.measuredLat
  measurementForm.measuredLng = measurement.measuredLng
  measurementForm.measuredDepthM = measurement.measuredDepthM
  measurementForm.measuredAt = measurement.measuredAt
  measurementDialogVisible.value = true
}

function openCreateArchiveForNo(no: string): void {
  openCreateArchive()
  archiveForm.no = no
}

async function submitArchiveForm(): Promise<void> {
  if (!archiveForm.no.trim()) {
    ElMessage.warning('请填写站位编号')
    return
  }
  const errors = validateLatLng(archiveForm.chartLat, archiveForm.chartLng)
  if (errors.length > 0) {
    ElMessage.warning(`海图经纬度校验未通过：${errors.join('；')}`)
    return
  }
  if (!Number.isFinite(archiveForm.chartDepthM) || archiveForm.chartDepthM < 0) {
    ElMessage.warning('海图水深应为非负数字（m）')
    return
  }
  const duplicated = reefStore
    .sitesOfReef(reefId.value)
    .some((site) => site.no === archiveForm.no.trim() && site.id !== editingSiteId.value)
  if (duplicated) {
    ElMessage.warning(`站位编号「${archiveForm.no.trim()}」在本礁区档案中已存在`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      reefId: reefId.value,
      no: archiveForm.no.trim(),
      chartLat: archiveForm.chartLat,
      chartLng: archiveForm.chartLng,
      chartDepthM: archiveForm.chartDepthM,
      substrate: archiveForm.substrate
    }
    if (editingSiteId.value) {
      await reefStore.updateSiteArchive(editingSiteId.value, payload)
      ElMessage.success('测绘档案已更新；已布样带已按新档案坐标重新落位')
    } else {
      const created = await reefStore.createSite(payload)
      ElMessage.success(`站位档案 ${created.no} 已建立（${formatLatLng(created.chartLat, created.chartLng)}）`)
    }
    archiveDialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function submitMeasurementForm(): Promise<void> {
  if (!measurementForm.no.trim()) {
    ElMessage.warning('请填写站位编号')
    return
  }
  const errors = validateLatLng(measurementForm.measuredLat, measurementForm.measuredLng)
  if (errors.length > 0) {
    ElMessage.warning(`实测经纬度校验未通过：${errors.join('；')}`)
    return
  }
  if (!Number.isFinite(measurementForm.measuredDepthM) || measurementForm.measuredDepthM < 0) {
    ElMessage.warning('实测水深应为非负数字（m）')
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(measurementForm.measuredAt.trim())) {
    ElMessage.warning('测量时间格式应为 YYYY-MM-DD HH:mm')
    return
  }
  submitting.value = true
  try {
    await measurementStore.upsertMeasurement(
      reefId.value,
      measurementForm.no.trim(),
      {
        measuredLat: measurementForm.measuredLat,
        measuredLng: measurementForm.measuredLng,
        measuredDepthM: measurementForm.measuredDepthM,
        measuredAt: measurementForm.measuredAt.trim().replace('T', ' ')
      },
      editingMeasurementId.value
    )
    ElMessage.success('外业实测已保存；档案坐标和已布样带未被顶掉')
    measurementDialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSite(site: Site): Promise<void> {
  const beltCount = beltStore.beltsOfSite(site.id).length
  try {
    await ElMessageBox.confirm(
      `删除测绘档案「${site.no}」将同时删除其 ${beltCount} 条样带及全部珊瑚与鱼类记录；外业实测保留并进入编号对账异常，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除档案', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reefStore.removeSite(site.id)
  ElMessage.success('档案及样带已删除，外业实测保留待编号对账')
}

async function removeMeasurement(measurement: SiteMeasurement): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `仅删除外业队站位「${measurement.no}」的实测记录，测绘档案与样带不会变化，确认删除？`,
      '删除实测',
      { type: 'warning', confirmButtonText: '删除实测', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await measurementStore.removeMeasurement(measurement.id)
  ElMessage.success('外业实测已删除，档案侧未改动')
}

async function markVerified(site: Site): Promise<void> {
  await reefStore.setSiteReconcileStatus(site.id, 'verified')
  ElMessage.success(`站位 ${site.no} 已核对通过，样带可按档案坐标布设`)
}

async function markFailed(site: Site): Promise<void> {
  await reefStore.setSiteReconcileStatus(site.id, 'failed')
  ElMessage.warning(`站位 ${site.no} 已标记核对失败，新样带继续压住；外业实测未改动`)
}

async function retryArchive(site: Site): Promise<void> {
  const status = await reefStore.retrySiteArchiveReconcile(site.id)
  if (status === 'verified') ElMessage.success(`站位 ${site.no} 档案重试通过，已放行为可布设`)
  else ElMessage.warning(`站位 ${site.no} 档案重试后仍为「${SITE_RECONCILE_STATUS_LABEL[status]}」，继续压住`)
}

function gotoBelts(site: Site): void {
  reefStore.selectSite(site.id)
  void router.push(`/sites/${site.id}/belts`)
}

function handleFilterChange(): void {
  const query = buildQuery({
    kw: reefStore.siteFilter.keyword,
    minDepth: reefStore.siteFilter.minDepthM,
    maxDepth: reefStore.siteFilter.maxDepthM
  })
  void router.replace({ query })
}

function handleReset(): void {
  reefStore.resetSiteFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  reefStore.start()
  beltStore.start()
  surveyStore.start()
  measurementStore.start()
  if (reefStore.reefs.length === 0) void initDatabase()
  const query = route.query
  reefStore.patchSiteFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    minDepthM: queryToNumber(query.minDepth),
    maxDepthM: queryToNumber(query.maxDepth)
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!reefStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!reef"
      entity-label="礁区"
      :missing-id="reefId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        reefStore.reefs.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的站位`,
          path: `/reefs/${item.id}/sites`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ reef.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>站位档案与实测对账</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ reef.name }} · 站位档案与实测对账
            <el-tag size="small" effect="plain">{{ reef.protectStatus }}</el-tag>
            <el-tag size="small" type="info" effect="plain">面积 {{ reef.areaKm2 }} km²</el-tag>
          </h2>
          <p class="gb-hint">
            样带只认测绘组海图档案；实测经纬度与档案相差超过 {{ SITE_COORDINATE_HOLD_THRESHOLD_M }} m 时先压住，等测绘组核对。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Aim" @click="openCreateMeasurement()">录入外业实测</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreateArchive">新增测绘档案</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="档案站位" :value="stats.siteCount" suffix="个" icon="Grid" />
        <StatBadge label="已布样带" :value="stats.beltCount" suffix="条" tone="success" icon="Files" />
        <StatBadge label="待测绘核对" :value="stats.pendingCount" suffix="个" tone="warning" icon="WarningFilled" />
        <StatBadge label="外业已测" :value="stats.measuredCount" suffix="个" tone="info" icon="Histogram" />
        <StatBadge label="编号对不上" :value="stats.unmatchedCount" suffix="条" tone="danger" icon="WarningFilled" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :number-ranges="[
          { key: 'minDepthM', label: '档案水深不低于', placeholder: '不限', unit: 'm' },
          { key: 'maxDepthM', label: '档案水深不超过', placeholder: '不限', unit: 'm' }
        ]"
        keyword-placeholder="搜索站位编号 / 底质"
        @change="handleFilterChange"
        @reset="handleReset"
      />

      <el-alert
        v-if="unmatchedMeasurements.length > 0"
        type="error"
        show-icon
        :closable="false"
        :title="`有 ${unmatchedMeasurements.length} 条外业实测在本礁区档案中找不到同编号站位，测绘组查档案编号、外业队查实测编号`"
        class="page__alert"
      >
        <template #default>
          <div v-for="measurement in unmatchedMeasurements" :key="measurement.id" class="page__unmatched">
            <span>{{ measurement.no }} · {{ measurement.measuredLat.toFixed(4) }}, {{ measurement.measuredLng.toFixed(4) }} · {{ measurement.measuredAt }}</span>
            <el-button size="small" type="primary" @click="openCreateArchiveForNo(measurement.no)">按编号补档案</el-button>
            <el-button size="small" @click="openEditMeasurement(measurement)">外业自查</el-button>
            <el-button size="small" type="danger" plain @click="removeMeasurement(measurement)">删除实测</el-button>
          </div>
        </template>
      </el-alert>

      <EmptyPanel
        v-if="rows.length === 0"
        :title="reefStore.sitesOfReef(reefId).length === 0 ? '该礁区还没有测绘站位档案' : '没有符合条件的站位'"
        description="先由测绘组建立海图档案；外业实测可单独录入，编号对不上时两边各查各的。"
        action-text="新增测绘档案"
        secondary-text="录入外业实测"
        @action="openCreateArchive"
        @secondary="openCreateMeasurement()"
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column prop="site.no" label="站位编号" width="100" fixed />
        <el-table-column label="测绘档案（海图）" min-width="220">
          <template #header>
            <span>测绘档案（海图）<br /><small>经纬度 / 水深 / 底质</small></span>
          </template>
          <template #default="{ row }">
            <div class="gb-mono">{{ row.site.chartLat.toFixed(4) }}, {{ row.site.chartLng.toFixed(4) }}</div>
            <div class="gb-hint gb-mono">{{ formatLatLng(row.site.chartLat, row.site.chartLng) }}</div>
            <div class="gb-hint">水深 {{ row.site.chartDepthM.toFixed(1) }} m · {{ row.site.substrate }}</div>
          </template>
        </el-table-column>
        <el-table-column label="外业实测" min-width="220">
          <template #default="{ row }">
            <template v-if="row.measurement">
              <div class="gb-mono">
                {{ row.measurement.measuredLat.toFixed(4) }}, {{ row.measurement.measuredLng.toFixed(4) }}
              </div>
              <div class="gb-hint">实测水深 {{ row.measurement.measuredDepthM.toFixed(1) }} m</div>
              <div class="gb-hint">{{ row.measurement.measuredAt }}</div>
            </template>
            <span v-else class="gb-hint">尚未录入实测</span>
          </template>
        </el-table-column>
        <el-table-column label="对账差值" width="130" align="center">
          <template #default="{ row }">
            <template v-if="row.distanceM !== null">
              <el-tag size="small" :type="row.blocked ? 'danger' : 'success'">
                {{ row.blocked ? '超差压住' : '距离内' }}
              </el-tag>
              <div class="gb-hint gb-mono">{{ row.distanceM }} m</div>
              <div class="gb-hint gb-mono">水深差 {{ row.depthGapM }} m</div>
            </template>
            <span class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="核对状态" width="125" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.site.reconcileStatus)">
              {{ reconcileLabel(row.site.reconcileStatus) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="样带" width="130" align="center">
          <template #default="{ row }">
            <el-button
              text
              :type="row.blocked ? 'danger' : 'primary'"
              size="small"
              @click="!row.blocked && gotoBelts(row.site)"
            >
              {{ row.beltCount }} 条 / {{ row.beltLengthM }} m
            </el-button>
            <div v-if="row.blocked" class="gb-hint">已压住，等核对</div>
          </template>
        </el-table-column>
        <el-table-column label="平均白化" width="145">
          <template #default="{ row }">
            <BleachTag :level="row.grade" size="small" />
            <span class="gb-hint gb-mono"> {{ row.bleachIndex }}</span>
          </template>
        </el-table-column>
        <el-table-column label="测绘 / 外业操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" :disabled="row.blocked" @click="gotoBelts(row.site)">样带</el-button>
            <el-button size="small" :icon="Edit" @click="openEditArchive(row.site)">档案</el-button>
            <el-button size="small" :icon="Aim" @click="openCreateMeasurement(row.site.no)">补测</el-button>
            <el-dropdown v-if="row.blocked" trigger="click" @command="(cmd: string) => cmd === 'pass' ? markVerified(row.site) : markFailed(row.site)">
              <el-button size="small" type="warning">核对<el-icon class="el-icon--right"><arrow-down /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="pass">核对通过，放行</el-dropdown-item>
                  <el-dropdown-item command="fail">核对失败，压住并重试档案</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button
              v-if="row.site.reconcileStatus === 'failed'"
              size="small"
              type="warning"
              plain
              :icon="RefreshRight"
              @click="retryArchive(row.site)"
            >
              重试档案
            </el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSite(row.site)">删档案</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无站位" description="先建立测绘组档案，再按档案布设样带。" compact />
        </template>
      </el-table>

      <p class="gb-hint">
        规则：测绘组保存海图经纬度、海图水深和底质；外业队补测只更新实测经纬度、实测水深和测量时间，不顶档案。档案坐标改准后，已布样带自动按档案值重新落位。
      </p>
    </template>

    <el-dialog
      v-model="archiveDialogVisible"
      :title="editingSiteId ? '编辑测绘组站位档案' : '新增测绘组站位档案'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-alert type="info" :closable="false" show-icon title="本表单属于测绘组海图档案；样带布设与重新落位均使用这里的坐标。" class="page__dialog-alert" />
      <el-form label-width="112px">
        <el-form-item label="站位编号" required>
          <el-input v-model="archiveForm.no" placeholder="如：S-01，按编号与外业对账" maxlength="24" />
        </el-form-item>
        <el-form-item label="海图纬度" required>
          <el-input-number v-model="archiveForm.chartLat" :min="-90" :max="90" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">°N</span>
        </el-form-item>
        <el-form-item label="海图经度" required>
          <el-input-number v-model="archiveForm.chartLng" :min="-180" :max="180" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">°E</span>
        </el-form-item>
        <el-form-item label="海图水深" required>
          <el-input-number v-model="archiveForm.chartDepthM" :min="0" :max="200" :step="0.1" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="底质类型">
          <el-select v-model="archiveForm.substrate" class="page__full">
            <el-option v-for="item in SUBSTRATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="archiveDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitArchiveForm">保存档案</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="measurementDialogVisible"
      :title="editingMeasurementId ? '编辑外业实测' : '录入外业实测'"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-alert type="warning" :closable="false" show-icon title="本表单属于外业队；补测不会覆盖测绘档案，也不会移动已布样带。" class="page__dialog-alert" />
      <el-form label-width="112px">
        <el-form-item label="站位编号" required>
          <el-input v-model="measurementForm.no" placeholder="如：S-01，必须与档案编号一致才能对账" maxlength="24" />
        </el-form-item>
        <el-form-item label="实测纬度" required>
          <el-input-number v-model="measurementForm.measuredLat" :min="-90" :max="90" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">°N</span>
        </el-form-item>
        <el-form-item label="实测经度" required>
          <el-input-number v-model="measurementForm.measuredLng" :min="-180" :max="180" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">°E</span>
        </el-form-item>
        <el-form-item label="实测水深" required>
          <el-input-number v-model="measurementForm.measuredDepthM" :min="0" :max="200" :step="0.1" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测量时间" required>
          <el-date-picker
            v-model="measurementForm.measuredAt"
            type="datetime"
            format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DD HH:mm"
            placeholder="选择测量时间"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="measurementDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitMeasurementForm">保存实测</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__full {
  width: 100%;
}

.page__alert {
  margin-top: -2px;
}

.page__unmatched {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.page__dialog-alert {
  margin-bottom: 14px;
}
</style>
