<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Connection, Download, Refresh } from '@element-plus/icons-vue';
import StatBadge from '../components/common/StatBadge.vue';
import { useSyncStore } from '../stores/syncStore';
import { useRingStore } from '../stores/ringStore';
import { useMeasureStore } from '../stores/measureStore';
import { useSiteStore } from '../stores/siteStore';
import { downloadText } from '../utils/export';
import { SAMPLE_ARCHIVE_JSON } from '../utils/sampleArchive';
import { formatDate, formatDateTime } from '../utils/format';
import type { SideCheck, SyncItem } from '../types/archive';

const router = useRouter();
const syncStore = useSyncStore();
const ringStore = useRingStore();
const measureStore = useMeasureStore();
const siteStore = useSiteStore();

const importVisible = ref(false);
const importText = ref('');
const importing = ref(false);
const detailId = ref('');
const detailVisible = ref(false);
const fileInputRef = ref<HTMLInputElement>();
const filter = ref<'全部' | '待处理' | '可合并' | '外站档案' | '问题'>('全部');

const cancelSignal = ref({ cancelled: false });

/** 本地核验上下文：量度 / 鸟点是本站权威，来自本站台账 */
const context = computed(() => ({
  rings: ringStore.rings,
  morphs: measureStore.morphs,
  sites: siteStore.sites,
}));

const currentBatch = computed(() => syncStore.archives.find((batch) => batch.id === syncStore.currentArchiveId));
const items = computed(() => (currentBatch.value ? syncStore.itemsOf(currentBatch.value.id) : []));
const progress = computed(() => (currentBatch.value ? syncStore.progressOf(currentBatch.value.id) : undefined));

const filtered = computed(() => {
  switch (filter.value) {
    case '待处理':
      return items.value.filter((item) => item.station.status === 'pending' || item.center.status === 'pending');
    case '可合并':
      return items.value.filter((item) => item.localRingIds.length > 0 && item.station.status === 'pass' && item.center.status === 'pass' && !item.merged);
    case '外站档案':
      return items.value.filter((item) => item.localRingIds.length === 0);
    case '问题':
      return items.value.filter((item) => item.station.status === 'fail' || item.center.status === 'fail');
    default:
      return items.value;
  }
});

const detail = computed(() => items.value.find((item) => item.id === detailId.value) ?? null);

function openDetail(item: SyncItem) {
  detailId.value = item.id;
  detailVisible.value = true;
}

function closeDetail() {
  detailVisible.value = false;
}

/** 详情抽屉里本站命中的台账行（合并后随 ringStore 刷新） */
const detailLocalRings = computed(() =>
  detail.value ? ringStore.rings.filter((record) => detail.value!.localRingIds.includes(record.id)) : [],
);
const detailPreview = computed(() => (detail.value && !detail.value.merged ? syncStore.previewChanges(detail.value, ringStore.rings) : []));

function sideTagType(side: SideCheck): 'info' | 'success' | 'danger' | 'warning' {
  if (side.status === 'pass') return 'success';
  if (side.status === 'fail') return 'danger';
  return 'info';
}
function sideText(side: SideCheck): string {
  return side.status === 'pass' ? '通过' : side.status === 'fail' ? '有问题' : '未核';
}

function openImport() {
  importText.value = '';
  importVisible.value = true;
}

function triggerPick() {
  fileInputRef.value?.click();
}

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importText.value = await file.text();
  input.value = '';
}

async function submitImport() {
  if (!importText.value.trim()) {
    ElMessage.warning('请粘贴档案 JSON 或选择档案文件');
    return;
  }
  importing.value = true;
  try {
    const { batch, reused } = await syncStore.importArchive(importText.value);
    if (reused) ElMessage.info(`批次 ${batch.batchNo} 已导入，保留此前核验结论，可直接继续比对`);
    else ElMessage.success(`已导入档案 ${batch.batchNo}（${batch.quarter}），共 ${batch.recordCount} 只，逐只配对完成`);
    importVisible.value = false;
  } catch (error) {
    ElMessage.error(`档案导入失败：${(error as Error).message}`);
  } finally {
    importing.value = false;
  }
}

function downloadSample() {
  downloadText('gbbirdring-archive-ARC-2024-Q3.json', SAMPLE_ARCHIVE_JSON);
}

async function runAll() {
  if (!currentBatch.value) return;
  cancelSignal.value = { cancelled: false };
  const { processed, failed } = await syncStore.runAll(currentBatch.value.id, context.value, { signal: cancelSignal.value });
  if (cancelSignal.value.cancelled) ElMessage.warning('已停止；已核完的结论均已保留，可随时继续');
  else ElMessage.success(`逐只比对完成：处理 ${processed} 只${failed ? `，${failed} 只存在未通过的核验侧` : ''}`);
}

async function mergeAll() {
  if (!currentBatch.value) return;
  const ready = items.value.filter((item) => item.localRingIds.length > 0 && item.station.status === 'pass' && item.center.status === 'pass' && !item.merged);
  if (ready.length === 0) {
    ElMessage.warning('暂无两侧核验均通过且未合并的个体');
    return;
  }
  const confirmed = await ElMessageBox.confirm(
    `将把 ${ready.length} 只的鸟种、原环志日期、原环志站以中心档案为准并入本站台账；本站捕获日期、量度、鸟点生境不变，且不新增台账行（重捕次数不变）。继续？`,
    '批量合并确认',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  const result = await syncStore.mergeAllReady(currentBatch.value.id, context.value);
  await ringStore.hydrate();
  ElMessage.success(`合并完成：新并入 ${result.merged} 只，跳过（已合并或未通过）${result.skipped} 只`);
}

async function mergeOne(item: SyncItem) {
  try {
    const result = await syncStore.mergeItem(item.id, context.value);
    await ringStore.hydrate();
    ElMessage.success(result.changedRows === 0 ? '档案与台账一致，无字段变更' : `已按中心档案更新 ${result.changedRows} 行台账的核准字段`);
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

/** 出问题的一侧重新来过：强制重跑单侧，另一侧结论不动 */
async function recheckSide(item: SyncItem, side: 'station' | 'center') {
  try {
    const next = await syncStore.checkSide(item.id, side, context.value, { force: true });
    const label = side === 'station' ? '站侧' : '中心侧';
    if (next[side].status === 'pass') ElMessage.success(`${label}核验通过`);
    else ElMessage.warning(`${label}仍有问题：${next[side].issues.join('；')}`);
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function removeBatch() {
  if (!currentBatch.value) return;
  const confirmed = await ElMessageBox.confirm(
    `删除档案批次 ${currentBatch.value.batchNo} 及其全部核验记录？已并入台账的中心核准字段不会回退。`,
    '删除档案',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await syncStore.removeArchive(currentBatch.value.id);
  detailVisible.value = false;
  detailId.value = '';
  ElMessage.success('档案批次已删除');
}

function gotoMeasure() {
  router.push('/measure');
}

/** 本站该环号的重捕行数（用于在界面上明示"再核不会多算"） */
function recaptureCountOf(item: SyncItem): number {
  return ringStore.rings.filter((record) => item.localRingIds.includes(record.id) && record.status === '重捕').length;
}
</script>

<template>
  <div>
    <h2 class="page-title">中心档案逐只比对</h2>
    <p class="page-desc">
      导入候鸟环志中心季度下发的外站环志 / 回收档案，与本站本地捕获台账逐只比对。
      <b>鸟种与原环志日期以中心档案为准</b>，本站实测的量度、鸟点生境、本站捕获日期不会被覆盖；
      断网后已核好的一侧自动保留，出问题的一侧可单独重核，重复合并不增加重捕次数。
    </p>

    <div class="toolbar">
      <el-button type="primary" @click="openImport">导入中心档案包</el-button>
      <el-button :icon="Download" @click="downloadSample">下载示例档案</el-button>
      <template v-if="currentBatch">
        <el-button type="success" :loading="syncStore.running" @click="runAll">
          {{ syncStore.running ? '逐只比对中…' : '开始 / 继续比对' }}
        </el-button>
        <el-button v-if="syncStore.running" type="info" @click="cancelSignal.cancelled = true">停止（保留已核结论）</el-button>
        <el-button type="warning" :disabled="syncStore.running" @click="mergeAll">全部合并已通过</el-button>
      </template>
      <el-tag :type="syncStore.online ? 'success' : 'danger'" effect="dark" class="net-tag">
        <el-icon style="margin-right: 4px"><Connection /></el-icon>
        {{ syncStore.online ? '中心网络：在线' : '中心网络：中断（仅可核站侧）' }}
      </el-tag>
      <el-switch
        :model-value="syncStore.online"
        active-text="联网"
        inactive-text="断网"
        inline-prompt
        @update:model-value="syncStore.setOnline(!syncStore.online)"
      />
    </div>

    <el-empty v-if="syncStore.archives.length === 0" description="还没有导入过中心季度档案" :image-size="90">
      <el-button type="primary" @click="openImport">导入第一包档案</el-button>
      <el-button @click="downloadSample">先下载示例档案试试</el-button>
    </el-empty>

    <template v-else>
      <div class="batch-bar">
        <el-select :model-value="syncStore.currentArchiveId" style="width: 300px" @update:model-value="syncStore.selectArchive">
          <el-option
            v-for="batch in syncStore.archives"
            :key="batch.id"
            :label="`${batch.batchNo} · ${batch.quarter}（${batch.recordCount} 只）`"
            :value="batch.id"
          />
        </el-select>
        <span v-if="currentBatch" class="batch-meta">
          中心下发于 {{ formatDate(currentBatch.issuedAt) }} · 本站导入于 {{ formatDateTime(currentBatch.importedAt) }}
        </span>
        <el-button link type="danger" style="margin-left: auto" @click="removeBatch">删除本批</el-button>
      </div>

      <el-row :gutter="12" class="stat-row">
        <el-col :xs="12" :md="6"><StatBadge label="档案总数 / 本站命中" :value="`${progress?.total ?? 0} / ${progress?.matched ?? 0}`" unit="只" /></el-col>
        <el-col :xs="12" :md="6"><StatBadge label="站侧核验通过" :value="progress?.stationPass ?? 0" unit="只" status="success" /></el-col>
        <el-col :xs="12" :md="6"><StatBadge label="中心侧核验通过" :value="progress?.centerPass ?? 0" unit="只" status="success" /></el-col>
        <el-col :xs="12" :md="6"><StatBadge label="已合并（幂等）" :value="progress?.merged ?? 0" unit="只" status="warning" /></el-col>
      </el-row>

      <el-radio-group v-model="filter" size="small" class="filter-group">
        <el-radio-button label="全部">全部</el-radio-button>
        <el-radio-button label="待处理">待处理</el-radio-button>
        <el-radio-button label="可合并">可合并</el-radio-button>
        <el-radio-button label="问题">有问题</el-radio-button>
        <el-radio-button label="外站档案">外站档案</el-radio-button>
      </el-radio-group>

      <el-card shadow="never" class="block">
        <el-table :data="filtered" size="small" border row-key="id">
          <el-table-column label="金属环号" width="110">
            <template #default="{ row }">
              <el-link type="primary" @click="openDetail(row)">{{ row.archive.ringNo }}</el-link>
              <div v-if="row.localRingIds.length > 1" class="cell-sub">本站 {{ row.localRingIds.length }} 行 · 重捕 {{ recaptureCountOf(row) }} 次</div>
            </template>
          </el-table-column>
          <el-table-column label="归属" width="100">
            <template #default="{ row }">
              <el-tag :type="row.localRingIds.length > 0 ? 'success' : 'info'" size="small">
                {{ row.localRingIds.length > 0 ? '本站命中' : '外站档案' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="中心鸟种" min-width="150">
            <template #default="{ row }">
              {{ row.archive.speciesCn }}
              <span class="cell-sub">{{ row.archive.speciesSci }}</span>
            </template>
          </el-table-column>
          <el-table-column label="原环志" width="180">
            <template #default="{ row }">
              {{ formatDate(row.archive.originRingDate) }}
              <div class="cell-sub">{{ row.archive.originStation }}</div>
            </template>
          </el-table-column>
          <el-table-column label="站侧核验（量度/生境）" width="150">
            <template #default="{ row }">
              <el-tag v-if="row.localRingIds.length === 0" size="small" type="info">不适用</el-tag>
              <el-tooltip v-else :disabled="row.station.issues.length === 0" :content="row.station.issues.join('；')" placement="top">
                <el-tag :type="sideTagType(row.station)" size="small">{{ sideText(row.station) }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="中心侧核验（联网）" width="140">
            <template #default="{ row }">
              <el-tooltip :disabled="row.center.issues.length === 0" :content="row.center.issues.join('；')" placement="top">
                <el-tag :type="sideTagType(row.center)" size="small">{{ sideText(row.center) }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="合并" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.merged" size="small" type="warning">已并入</el-tag>
              <span v-else class="cell-sub">未合并</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">详情</el-button>
              <el-button
                v-if="row.localRingIds.length > 0"
                link
                type="success"
                :disabled="row.station.status !== 'pass' || row.center.status !== 'pass' || row.merged"
                @click="mergeOne(row)"
              >合并</el-button>
              <el-button v-if="row.localRingIds.length > 0" link type="warning" :icon="Refresh" @click="recheckSide(row, 'station')">重核站侧</el-button>
              <el-button link type="warning" :icon="Refresh" @click="recheckSide(row, 'center')">重核中心侧</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <!-- 导入档案弹窗 -->
    <el-dialog v-model="importVisible" title="导入中心季度档案包" width="640px">
      <el-alert type="info" :closable="false" show-icon class="import-tip">
        档案为中心下发的 JSON（app = gbbirdring-archive）。同一批次号重复导入不会重置已核结论。
      </el-alert>
      <el-input v-model="importText" type="textarea" :rows="10" placeholder='{"app":"gbbirdring-archive","batchNo":"ARC-2024-Q3", …}' />
      <div class="import-actions">
        <el-button @click="downloadSample">下载示例档案</el-button>
        <el-button @click="triggerPick">选择 JSON 文件</el-button>
        <input ref="fileInputRef" hidden type="file" accept=".json,application/json" @change="pickFile" />
      </div>
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="submitImport">导入并逐只配对</el-button>
      </template>
    </el-dialog>

    <!-- 逐只详情抽屉 -->
    <el-drawer v-if="detail" :model-value="detailVisible" @close="closeDetail" :title="`比对详情 · ${detail.archive.ringNo}`" size="560px">
      <div class="detail-section">
        <div class="detail-title">中心档案（鸟种 / 原环志日期以此为准）</div>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="环号 / 彩环">{{ detail.archive.ringNo }} · {{ detail.archive.colorRing || '无' }}</el-descriptions-item>
          <el-descriptions-item label="鸟种">{{ detail.archive.speciesCn }}（{{ detail.archive.speciesSci }}）</el-descriptions-item>
          <el-descriptions-item label="原环志日期 / 站">{{ formatDate(detail.archive.originRingDate) }} · {{ detail.archive.originStation }}</el-descriptions-item>
          <el-descriptions-item label="事件">{{ detail.archive.eventType }} · {{ formatDate(detail.archive.eventDate) }}<span v-if="detail.archive.recoverPlace"> · {{ detail.archive.recoverPlace }}</span></el-descriptions-item>
          <el-descriptions-item v-if="detail.archive.remark" label="档案备注">{{ detail.archive.remark }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="detail-section">
        <div class="detail-title">本站台账（捕获日期 / 量度 / 鸟点生境本站权威，不被覆盖）</div>
        <el-empty v-if="detailLocalRings.length === 0" :image-size="70" description="本站台账无此环号：外站环志 / 回收，只登记备查，不并账" />
        <el-table v-else :data="detailLocalRings" size="small" border>
          <el-table-column label="本站捕获日期" width="120">
            <template #default="{ row }">{{ formatDate(row.ringDate) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="70">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === '重捕' ? 'warning' : row.status === '回收' ? 'danger' : 'success'">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="鸟点 / 网号">
            <template #default="{ row }">{{ siteStore.siteName(row.siteId) }} · {{ row.netNo }}</template>
          </el-table-column>
          <el-table-column label="中心核准原环志日" width="120">
            <template #default="{ row }">{{ row.originRingDate ? formatDate(row.originRingDate) : '—' }}</template>
          </el-table-column>
        </el-table>
        <div v-if="detailLocalRings.length > 0" class="detail-actions">
          <el-button size="small" @click="gotoMeasure">去补本站量度</el-button>
          <el-button size="small" type="warning" @click="recheckSide(detail, 'station')">重核站侧</el-button>
          <el-button size="small" type="warning" @click="recheckSide(detail, 'center')">重核中心侧</el-button>
          <el-button
            size="small"
            type="success"
            :disabled="detail.station.status !== 'pass' || detail.center.status !== 'pass' || detail.merged"
            @click="mergeOne(detail)"
          >合并本只</el-button>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-title">核验结论</div>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="站侧">
            <el-tag :type="sideTagType(detail.station)" size="small">{{ sideText(detail.station) }}</el-tag>
            <span v-if="detail.station.checkedAt" class="cell-sub"> · {{ formatDateTime(detail.station.checkedAt) }}</span>
            <ul v-if="detail.station.issues.length" class="issue-list">
              <li v-for="(issue, i) in detail.station.issues" :key="i">{{ issue }}</li>
            </ul>
          </el-descriptions-item>
          <el-descriptions-item label="中心侧">
            <el-tag :type="sideTagType(detail.center)" size="small">{{ sideText(detail.center) }}</el-tag>
            <span v-if="detail.center.checkedAt" class="cell-sub"> · {{ formatDateTime(detail.center.checkedAt) }}</span>
            <ul v-if="detail.center.issues.length" class="issue-list">
              <li v-for="(issue, i) in detail.center.issues" :key="i">{{ issue }}</li>
            </ul>
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="detail-section">
        <div class="detail-title">
          字段合并计划
          <el-tag v-if="detail.merged" size="small" type="warning" style="margin-left: 8px">已于 {{ formatDateTime(detail.mergedAt) }} 并入</el-tag>
        </div>
        <el-empty
          v-if="detail.merged && detail.appliedChanges.length === 0"
          :image-size="60"
          :description="detail.note || '无字段变更'"
        />
        <el-table v-else :data="detail.merged ? detail.appliedChanges : detailPreview" size="small" border>
          <el-table-column prop="label" label="字段（均为中心权威字段）" width="180" />
          <el-table-column label="本站现值 → 中心档案值">
            <template #default="{ row }">
              <span :class="{ 'value-old': row.from }">{{ row.from || '（空）' }}</span>
              <span style="margin: 0 6px">→</span>
              <span class="value-new">{{ row.to }}</span>
            </template>
          </el-table-column>
        </el-table>
        <p class="guard-note">本站捕获日期、网号网次、鸟点生境、实测量度不在合并范围内；合并只覆盖既有台账行，不新增 / 删除记录。</p>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #1f4a44;
}
.page-desc {
  margin: 0 0 12px;
  color: #6f8480;
  font-size: 13px;
  line-height: 1.7;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.net-tag {
  margin-left: 8px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.batch-meta {
  font-size: 12px;
  color: #8a99a5;
}
.stat-row {
  margin-bottom: 12px;
}
.stat-row .el-col {
  margin-bottom: 12px;
}
.filter-group {
  margin-bottom: 10px;
}
.block {
  border-radius: 8px;
}
.cell-sub {
  display: block;
  font-size: 12px;
  color: #97a8a2;
}
.import-tip {
  margin-bottom: 10px;
}
.import-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.detail-section {
  margin-bottom: 18px;
}
.detail-title {
  font-weight: 600;
  color: #1f4a44;
  margin-bottom: 8px;
  font-size: 14px;
}
.detail-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.issue-list {
  margin: 6px 0 0;
  padding-left: 18px;
  color: #c62828;
  font-size: 12px;
}
.value-old {
  color: #c77700;
  text-decoration: line-through;
}
.value-new {
  color: #2f7d32;
  font-weight: 600;
}
.guard-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: #8a99a5;
}
</style>
