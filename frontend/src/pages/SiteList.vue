<script setup lang="ts">
/**
 * 模块 2：/reefs/:id/sites 站位列表与海图档案 / 外业实测管理
 * 站位坐标以测绘组海图档案为准，外业实测另存一份（补测不覆盖档案）；
 * 样带认档案站位，实测与档案偏差超限则压住不布，等测绘组核对后放行；
 * 两边按站位编号对账，对不上各查各的。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Warning, Check, RefreshLeft } from '@element-plus/icons-vue'
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
import {
  distanceMeters,
  formatLatLng,
  SURVEY_DISTANCE_LIMIT_M,
  SUBSTRATES,
  validateLatLng,
  type Site,
  type VerifyStatus,
  type ReconcileItem
} from '@/types/site'
import { bleachGrade, bleachIndex } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()

const reefId = computed(() => String(route.params.id ?? ''))
const reef = computed(() => reefStore.reefById(reefId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  no: '',
  chartLat: 18.5,
  chartLng: 110.5,
  chartDepthM: 5,
  substrate: SUBSTRATES[0]
})

/** 外业补测弹窗 */
const surveyDialogVisible = ref(false)
const surveySubmitting = ref(false)
const surveyForm = reactive({
  siteId: '',
  siteNo: '',
  measuredLat: 18.5,
  measuredLng: 110.5,
  measuredDepthM: 5,
  measuredAt: ''
})

/** 对账弹窗 */
const reconcileVisible = ref(false)

const verifyingId = ref<string | null>(null)

/** 站位行：汇总样带数、珊瑚记录数、平均白化指数、最近实测与偏差 */
const rows = computed(() => {
  const sites = reefStore.sitesOfReef(reefId.value).filter((site) => {
    const keyword = reefStore.siteFilter.keyword.trim()
    if (keyword.length > 0 && !`${site.no}${site.substrate}`.includes(keyword)) return false
    if (reefStore.siteFilter.minDepthM !== null && site.chartDepthM < reefStore.siteFilter.minDepthM) return false
    if (reefStore.siteFilter.maxDepthM !== null && site.chartDepthM > reefStore.siteFilter.maxDepthM) return false
    return true
  })
  return sites.map((site) => {
    const belts = beltStore.beltsOfSite(site.id)
    const heldCount = belts.filter((belt) => belt.positionStatus === 'held').length
    const beltIds = new Set(belts.map((belt) => belt.id))
    const corals = surveyStore.corals.filter((coral) => beltIds.has(coral.beltId))
    const index = bleachIndex(corals)
    const latestSurvey = reefStore.latestSurveyOfSite(site.id)
    const distance = latestSurvey
      ? distanceMeters(
          { lat: latestSurvey.measuredLat, lng: latestSurvey.measuredLng },
          { lat: site.chartLat, lng: site.chartLng }
        )
      : null
    return {
      site,
      latestSurvey,
      distance,
      heldCount,
      beltCount: belts.length,
      beltLengthM: belts.reduce((sum, belt) => sum + belt.lengthM, 0),
      coralCount: corals.length,
      bleachIndex: index,
      grade: bleachGrade(index)
    }
  })
})

/** 本礁区对账结果（两边按站位编号对账） */
const reconcileRows = computed(() =>
  reefStore.reconcileReport
    .filter((item) => item.survey.reefId === reefId.value)
    .slice()
    .sort((a, b) => a.survey.siteNo.localeCompare(b.survey.siteNo, 'zh-Hans-CN'))
)

const reconcileSummary = computed(() => ({
  matched: reconcileRows.value.filter((item) => item.status === 'matched').length,
  tooFar: reconcileRows.value.filter((item) => item.status === 'too-far').length,
  missing: reconcileRows.value.filter((item) => item.status === 'missing-archive').length
}))

const filterModel = computed<FilterModel>(() => ({
  keyword: reefStore.siteFilter.keyword,
  minDepthM: reefStore.siteFilter.minDepthM,
  maxDepthM: reefStore.siteFilter.maxDepthM
}))

const stats = computed(() => {
  const sites = reefStore.sitesOfReef(reefId.value)
  const depths = sites.map((site) => site.chartDepthM)
  const belts = beltStore.belts.filter((belt) => sites.some((site) => site.id === belt.siteId))
  const heldBelts = belts.filter((belt) => belt.positionStatus === 'held').length
  return {
    siteCount: sites.length,
    beltCount: belts.length,
    heldBelts,
    minDepthM: depths.length ? Math.min(...depths) : null,
    maxDepthM: depths.length ? Math.max(...depths) : null,
    avgDepthM: depths.length ? Number((depths.reduce((sum, value) => sum + value, 0) / depths.length).toFixed(2)) : null
  }
})

function openCreate(): void {
  editingId.value = null
  const existing = reefStore.sitesOfReef(reefId.value)
  form.no = `S-${String(existing.length + 1).padStart(2, '0')}`
  form.chartLat = Number((18.5 + existing.length * 0.01).toFixed(4))
  form.chartLng = Number((110.5 + existing.length * 0.01).toFixed(4))
  form.chartDepthM = 5
  form.substrate = SUBSTRATES[0]
  dialogVisible.value = true
}

function openEdit(site: Site): void {
  editingId.value = site.id
  form.no = site.no
  form.chartLat = site.chartLat
  form.chartLng = site.chartLng
  form.chartDepthM = site.chartDepthM
  form.substrate = site.substrate
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.no.trim()) {
    ElMessage.warning('请填写站位编号')
    return
  }
  const errors = validateLatLng(form.chartLat, form.chartLng)
  if (errors.length > 0) {
    ElMessage.warning(`经纬度校验未通过：${errors.join('；')}`)
    return
  }
  if (!Number.isFinite(form.chartDepthM) || form.chartDepthM < 0) {
    ElMessage.warning('海图水深应为非负数字（m）')
    return
  }
  const duplicated = reefStore
    .sitesOfReef(reefId.value)
    .some((site) => site.no === form.no.trim() && site.id !== editingId.value)
  if (duplicated) {
    ElMessage.warning(`站位编号「${form.no.trim()}」在本礁区已存在`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      reefId: reefId.value,
      no: form.no.trim(),
      chartLat: form.chartLat,
      chartLng: form.chartLng,
      chartDepthM: form.chartDepthM,
      substrate: form.substrate
    }
    if (editingId.value) {
      await reefStore.updateSite(editingId.value, payload)
      ElMessage.success('海图档案已更新')
    } else {
      const created = await reefStore.createSite(payload)
      reefStore.selectSite(created.id)
      ElMessage.success(`站位 ${created.no} 海图档案已建立（${formatLatLng(created.chartLat, created.chartLng)}）`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/** 打开外业补测弹窗：实测坐标默认带出档案值，外业在此基础上改 */
function openSurvey(site: Site): void {
  surveyForm.siteId = site.id
  surveyForm.siteNo = site.no
  surveyForm.measuredLat = site.chartLat
  surveyForm.measuredLng = site.chartLng
  surveyForm.measuredDepthM = site.chartDepthM
  surveyForm.measuredAt = new Date().toISOString().slice(0, 10)
  surveyDialogVisible.value = true
}

async function submitSurvey(): Promise<void> {
  const errors = validateLatLng(surveyForm.measuredLat, surveyForm.measuredLng)
  if (errors.length > 0) {
    ElMessage.warning(`实测经纬度校验未通过：${errors.join('；')}`)
    return
  }
  if (!Number.isFinite(surveyForm.measuredDepthM) || surveyForm.measuredDepthM < 0) {
    ElMessage.warning('实测水深应为非负数字（m）')
    return
  }
  if (!surveyForm.measuredAt) {
    ElMessage.warning('请选择测量时间')
    return
  }
  surveySubmitting.value = true
  try {
    const created = await reefStore.createSurvey({
      siteId: surveyForm.siteId,
      reefId: reefId.value,
      siteNo: surveyForm.siteNo.trim(),
      measuredLat: surveyForm.measuredLat,
      measuredLng: surveyForm.measuredLng,
      measuredDepthM: surveyForm.measuredDepthM,
      measuredAt: surveyForm.measuredAt
    })
    const site = reefStore.siteById(created.siteId)
    const dist = site
      ? distanceMeters(
          { lat: created.measuredLat, lng: created.measuredLng },
          { lat: site.chartLat, lng: site.chartLng }
        )
      : null
    if (dist !== null && dist > SURVEY_DISTANCE_LIMIT_M) {
      ElMessage.warning(
        `补测已保存（外业队留底）：实测与海图偏差 ${Math.round(dist)} m 超限差，样带将压住不布，等测绘组核对档案后放行`
      )
    } else if (!site) {
      ElMessage.warning('补测已保存：档案中无此站位编号，对不上，请测绘组补登海图档案')
    } else {
      ElMessage.success('补测已保存（外业队留底），未超差，样带按档案落位')
    }
    surveyDialogVisible.value = false
  } finally {
    surveySubmitting.value = false
  }
}

/** 测绘组核对档案：失败只重试档案侧，外业实测原样不动 */
async function handleVerify(site: Site): Promise<void> {
  verifyingId.value = site.id
  try {
    const result = await reefStore.verifySite(site.id)
    if (result === '核对通过') {
      ElMessage.success(`站位 ${site.no} 档案核对通过，已按档案坐标重新落位样带`)
    } else {
      ElMessage.warning(`站位 ${site.no} 档案核对失败，可重新核对（外业实测数据未受影响）`)
    }
  } finally {
    verifyingId.value = null
  }
}

async function removeSite(site: Site): Promise<void> {
  const beltCount = beltStore.beltsOfSite(site.id).length
  try {
    await ElMessageBox.confirm(
      `删除站位「${site.no}」将同时删除其海图档案、外业实测记录及 ${beltCount} 条样带（含珊瑚与鱼类记录），确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reefStore.removeSite(site.id)
  ElMessage.success('站位档案及下级数据已删除')
}

function gotoBelts(site: Site): void {
  reefStore.selectSite(site.id)
  void router.push(`/sites/${site.id}/belts`)
}

function verifyTagType(status: VerifyStatus): 'info' | 'warning' | 'success' | 'danger' {
  switch (status) {
    case '核对通过':
      return 'success'
    case '核对失败':
      return 'danger'
    case '核对中':
      return 'warning'
    default:
      return 'info'
  }
}

function reconcileTagType(item: ReconcileItem): 'success' | 'warning' | 'danger' {
  if (item.status === 'matched') return 'success'
  if (item.status === 'too-far') return 'warning'
  return 'danger'
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
            <el-breadcrumb-item>站位列表</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ reef.name }} · 站位列表与海图档案
            <el-tag size="small" effect="plain">{{ reef.protectStatus }}</el-tag>
            <el-tag size="small" type="info" effect="plain">面积 {{ reef.areaKm2 }} km²</el-tag>
          </h2>
          <p class="gb-hint">
            海图坐标与底质归测绘组档案，外业实测另存一份；样带认档案站位，实测偏差超限则压住不布。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Warning" @click="reconcileVisible = true">站位对账</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增站位</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="站位总数" :value="stats.siteCount" suffix="个" icon="Grid" />
        <StatBadge label="样带总数" :value="stats.beltCount" suffix="条" tone="success" icon="Files" />
        <StatBadge
          label="压住待核"
          :value="stats.heldBelts"
          suffix="条"
          :tone="stats.heldBelts > 0 ? 'warning' : 'info'"
          icon="Warning"
        />
        <StatBadge
          label="平均海图水深"
          :value="stats.avgDepthM === null ? '—' : stats.avgDepthM"
          suffix="m"
          tone="info"
          icon="Odometer"
        />
      </div>

      <FilterBar
        :model-value="filterModel"
        :number-ranges="[
          { key: 'minDepthM', label: '海图水深不低于', placeholder: '不限', unit: 'm' },
          { key: 'maxDepthM', label: '海图水深不超过', placeholder: '不限', unit: 'm' }
        ]"
        keyword-placeholder="搜索站位编号 / 底质"
        @change="handleFilterChange"
        @reset="handleReset"
      />

      <EmptyPanel
        v-if="rows.length === 0"
        :title="reefStore.sitesOfReef(reefId).length === 0 ? '该礁区还没有站位' : '没有符合条件的站位'"
        description="新增站位海图档案并录入坐标与水深后，即可布设样带；外业补测数据与档案分开留存。"
        action-text="新增站位"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column prop="site.no" label="站位编号" width="100" fixed />
        <el-table-column label="海图档案（测绘组）" min-width="230">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.site.chartLat.toFixed(4) }}, {{ row.site.chartLng.toFixed(4) }}</div>
            <div class="gb-hint gb-mono">{{ formatLatLng(row.site.chartLat, row.site.chartLng) }}</div>
            <div class="gb-hint">
              海图水深 {{ row.site.chartDepthM.toFixed(1) }} m · {{ row.site.substrate }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="核对状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="verifyTagType(row.site.verifyStatus)" effect="plain">
              {{ row.site.verifyStatus }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="外业实测（外业队）" min-width="230">
          <template #default="{ row }">
            <template v-if="row.latestSurvey">
              <div class="gb-mono">
                {{ row.latestSurvey.measuredLat.toFixed(4) }}, {{ row.latestSurvey.measuredLng.toFixed(4) }}
              </div>
              <div class="gb-hint">
                实测水深 {{ row.latestSurvey.measuredDepthM.toFixed(1) }} m · {{ row.latestSurvey.measuredAt }}
              </div>
            </template>
            <span v-else class="gb-hint">暂无实测记录</span>
          </template>
        </el-table-column>
        <el-table-column label="实测/海图偏差" width="120">
          <template #default="{ row }">
            <template v-if="row.distance !== null">
              <span :class="{ 'gb-mono': true, 'gb-text-warn': row.distance > SURVEY_DISTANCE_LIMIT_M }">
                {{ Math.round(row.distance) }} m
              </span>
              <div v-if="row.distance > SURVEY_DISTANCE_LIMIT_M" class="gb-hint gb-text-warn">超限差</div>
            </template>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="样带" width="110" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoBelts(row.site)">
              {{ row.beltCount }} 条 / {{ row.beltLengthM }} m
            </el-button>
            <el-tag v-if="row.heldCount > 0" size="small" type="warning" effect="plain">压住 {{ row.heldCount }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoBelts(row.site)">样带</el-button>
            <el-button
              size="small"
              type="success"
              plain
              :icon="Check"
              :loading="verifyingId === row.site.id"
              @click="handleVerify(row.site)"
            >
              {{ row.site.verifyStatus === '核对失败' ? '重新核对' : '核对' }}
            </el-button>
            <el-button size="small" :icon="RefreshLeft" @click="openSurvey(row.site)">补测</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row.site)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSite(row.site)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无站位" description="点击右上角「新增站位」开始布设。" compact />
        </template>
      </el-table>

      <p class="gb-hint">
        提示：海图坐标按十进制度录入（纬度 -90 ~ 90、经度 -180 ~ 180），保存时自动校验；同礁区内站位编号不可重复。
        外业补测只写实测记录，不覆盖海图档案；偏差超过 {{ SURVEY_DISTANCE_LIMIT_M }} m 时样带压住不布。
      </p>
    </template>

    <!-- 海图档案编辑弹窗（测绘组侧） -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑海图档案' : '新增站位（海图档案）'" width="540px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="站位编号" required>
          <el-input v-model="form.no" placeholder="如：S-01" maxlength="24" />
        </el-form-item>
        <el-form-item label="海图纬度" required>
          <el-input-number v-model="form.chartLat" :min="-90" :max="90" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">°N</span>
        </el-form-item>
        <el-form-item label="海图经度" required>
          <el-input-number v-model="form.chartLng" :min="-180" :max="180" :step="0.0001" :precision="4" controls-position="right" />
          <span class="page__unit">°E</span>
        </el-form-item>
        <el-form-item label="海图水深" required>
          <el-input-number v-model="form.chartDepthM" :min="0" :max="200" :step="0.1" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="底质类型">
          <el-select v-model="form.substrate" class="page__full">
            <el-option v-for="item in SUBSTRATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存档案' : '建立档案并布设样带' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 外业补测弹窗（外业队侧） -->
    <el-dialog v-model="surveyDialogVisible" title="外业补测（实测记录）" width="540px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        title="实测记录归外业队留存，保存后不会覆盖测绘组的海图档案；偏差超限时样带将压住不布。"
        class="page__alert"
      />
      <el-form label-width="104px">
        <el-form-item label="站位编号">
          <el-input v-model="surveyForm.siteNo" maxlength="24" disabled />
        </el-form-item>
        <el-form-item label="实测纬度" required>
          <el-input-number
            v-model="surveyForm.measuredLat"
            :min="-90"
            :max="90"
            :step="0.0001"
            :precision="4"
            controls-position="right"
          />
          <span class="page__unit">°N</span>
        </el-form-item>
        <el-form-item label="实测经度" required>
          <el-input-number
            v-model="surveyForm.measuredLng"
            :min="-180"
            :max="180"
            :step="0.0001"
            :precision="4"
            controls-position="right"
          />
          <span class="page__unit">°E</span>
        </el-form-item>
        <el-form-item label="实测水深" required>
          <el-input-number
            v-model="surveyForm.measuredDepthM"
            :min="0"
            :max="200"
            :step="0.1"
            :precision="1"
            controls-position="right"
          />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测量时间" required>
          <el-date-picker v-model="surveyForm.measuredAt" type="date" value-format="YYYY-MM-DD" placeholder="选择测量时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="surveyDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="surveySubmitting" @click="submitSurvey">保存补测记录</el-button>
      </template>
    </el-dialog>

    <!-- 站位对账弹窗 -->
    <el-dialog v-model="reconcileVisible" title="站位对账（两边按站位编号各查各的）" width="820px">
      <div class="reconcile__summary">
        <el-tag type="success" effect="plain">吻合 {{ reconcileSummary.matched }}</el-tag>
        <el-tag type="warning" effect="plain">偏差超限 {{ reconcileSummary.tooFar }}</el-tag>
        <el-tag type="danger" effect="plain">对不上 {{ reconcileSummary.missing }}</el-tag>
      </div>
      <el-table :data="reconcileRows" border stripe class="gb-table-compact" max-height="460">
        <el-table-column label="站位编号" width="100">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.survey.siteNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="外业实测（外业队）" min-width="200">
          <template #default="{ row }">
            <div class="gb-mono">
              {{ row.survey.measuredLat.toFixed(4) }}, {{ row.survey.measuredLng.toFixed(4) }}
            </div>
            <div class="gb-hint">
              水深 {{ row.survey.measuredDepthM.toFixed(1) }} m · {{ row.survey.measuredAt }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="海图档案（测绘组）" min-width="200">
          <template #default="{ row }">
            <template v-if="row.site">
              <div class="gb-mono">{{ row.site.chartLat.toFixed(4) }}, {{ row.site.chartLng.toFixed(4) }}</div>
              <div class="gb-hint">
                水深 {{ row.site.chartDepthM.toFixed(1) }} m · {{ row.site.substrate }} · {{ row.site.verifyStatus }}
              </div>
            </template>
            <span v-else class="gb-hint">档案中无此编号</span>
          </template>
        </el-table-column>
        <el-table-column label="偏差" width="90">
          <template #default="{ row }">
            <span v-if="row.distanceM !== null" class="gb-mono">{{ Math.round(row.distanceM) }} m</span>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态/归责" min-width="240">
          <template #default="{ row }">
            <el-tag size="small" :type="reconcileTagType(row)" effect="plain">
              {{ row.status === 'matched' ? '吻合' : row.status === 'too-far' ? '偏差超限' : '对不上' }}
            </el-tag>
            <div class="gb-hint reconcile__hint">{{ row.hint }}</div>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无外业实测记录" description="外业补测后即可在此与海图档案对账。" compact />
        </template>
      </el-table>
      <template #footer>
        <el-button @click="reconcileVisible = false">关闭</el-button>
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

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
  margin-bottom: 12px;
}

.gb-text-warn {
  color: #e6a23c;
  font-weight: 600;
}

.reconcile__summary {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.reconcile__hint {
  margin-top: 4px;
  line-height: 1.5;
}
</style>
