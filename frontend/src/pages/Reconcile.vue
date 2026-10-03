<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { VideoPause, RefreshRight, Download, Upload } from '@element-plus/icons-vue';
import { useSyncStore } from '../stores/syncStore';
import type { RingRecord } from '../types/ring-record';
import type { ReconcileSide, SideRunStatus } from '../types/center-archive';
import { formatDate, formatDateTime } from '../utils/format';

const syncStore = useSyncStore();
const fileInput = ref<HTMLInputElement>();

onMounted(() => {
  void syncStore.hydrate();
});

const statusMeta: Record<SideRunStatus, { label: string; type: '' | 'success' | 'warning' | 'info' | 'danger' }> = {
  idle: { label: '空闲', type: 'info' },
  running: { label: '比对中', type: '' },
  stopped: { label: '已停止（可续传）', type: 'warning' },
  error: { label: '出错（可重试）', type: 'danger' },
  done: { label: '已完成', type: 'success' },
};

const comparePct = computed(() => pct(syncStore.compareStats.done, syncStore.compareStats.total));
const reportPct = computed(() => pct(syncStore.reportStats.done, syncStore.reportStats.total));

function pct(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

function compareResult(record: RingRecord) {
  if (syncStore.progress.compare.done.includes(record.id)) return { label: '已核', type: 'success' as const };
  if (syncStore.progress.compare.failed.includes(record.id)) return { label: '失败', type: 'danger' as const };
  return { label: '待核', type: 'info' as const };
}

function reportResult(record: RingRecord) {
  if (syncStore.progress.report.done.includes(record.id)) return { label: '已编译', type: 'success' as const };
  if (syncStore.progress.report.failed.includes(record.id)) return { label: '失败', type: 'danger' as const };
  return { label: '待编译', type: 'info' as const };
}

function sideRunning(side: ReconcileSide) {
  return syncStore.runStatus[side] === 'running';
}

function triggerImport() {
  fileInput.value?.click();
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await syncStore.loadArchiveText(text);
    ElMessage.success('中心档案包导入成功');
  } catch (error) {
    ElMessage.error(`档案包导入失败：${(error as Error).message}`);
  } finally {
    input.value = '';
  }
}

async function loadSample() {
  await syncStore.loadSampleArchive();
  ElMessage.success('已载入示例档案包');
}

async function clearArchive() {
  await syncStore.clearArchive();
  ElMessage.info('已清除缓存档案');
}
</script>

<template>
  <div v-loading="!syncStore.hydrated" element-loading-text="正在装载比对进度…">
    <h2 class="page-title">外站环志档案比对与上报</h2>
    <p class="page-desc">
      中心每季度下发一包外站环志与回收档案；本站新捕到的带环个体逐只比对。
      <strong>鸟种与原环志日期以中心为准</strong>，本站实测的量度与鸟点生境不被覆盖；
      比对中断网后已核进度留住、可续传，比对 / 上报两侧可分别重来，重捕次数不会因再核一次而多算。
    </p>

    <!-- 档案包 -->
    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-header">
          <span>中心档案包</span>
          <el-tag v-if="syncStore.archive" type="success" effect="plain">已缓存</el-tag>
        </div>
      </template>

      <div v-if="!syncStore.archive" class="archive-empty">
        <el-empty description="尚未载入中心下发的外站环志与回收档案包" :image-size="80">
          <el-button type="primary" :icon="Download" @click="loadSample">载入示例档案</el-button>
          <el-button :icon="Upload" @click="triggerImport">导入档案文件</el-button>
        </el-empty>
      </div>

      <div v-else>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="季度">{{ syncStore.archive.quarter }}</el-descriptions-item>
          <el-descriptions-item label="下发时间">{{ formatDateTime(syncStore.archive.issuedAt) }}</el-descriptions-item>
          <el-descriptions-item label="档案条数">{{ syncStore.archive.records.length }} 条</el-descriptions-item>
          <el-descriptions-item label="来源" :span="3">{{ syncStore.archive.source }}</el-descriptions-item>
        </el-descriptions>
        <div class="toolbar">
          <el-button :icon="Upload" @click="triggerImport">导入其他档案</el-button>
          <el-button @click="loadSample">换成示例档案</el-button>
          <el-button type="danger" plain @click="clearArchive">清除档案</el-button>
        </div>
      </div>

      <input ref="fileInput" type="file" accept=".json,application/json" style="display: none" @change="onFileChange" />
    </el-card>

    <!-- 两侧：比对 / 上报 -->
    <el-row :gutter="16" class="side-row">
      <!-- 比对侧 -->
      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="block side-card">
          <template #header>
            <div class="card-header">
              <span>① 比对侧（档案 → 本站）</span>
              <el-tag :type="statusMeta[syncStore.runStatus.compare].type" effect="plain" size="small">
                {{ statusMeta[syncStore.runStatus.compare].label }}
              </el-tag>
            </div>
          </template>

          <p class="side-desc">
            逐只核对本站带环个体（重捕 / 回收）与中心档案：鸟种、学名、原环志日期以中心为准；
            本站量度（按环号关联）与鸟点生境保留不动。
          </p>

          <div class="progress-line">
            <el-progress :percentage="comparePct" :stroke-width="10" />
            <span class="progress-text">
              已核 {{ syncStore.compareStats.done }} / {{ syncStore.compareStats.total }}
              <template v-if="syncStore.compareStats.failed"> · 失败 {{ syncStore.compareStats.failed }}</template>
            </span>
          </div>
          <div v-if="sideRunning('compare')" class="current-line">正在比对：{{ syncStore.current.compare }} …</div>
          <div v-if="syncStore.runStatus.compare === 'error'" class="error-line">出错：{{ syncStore.error.compare }}（已核进度已留住，可重试或重新来过）</div>

          <div class="toolbar">
            <el-button
              v-if="!sideRunning('compare')"
              type="primary"
              :disabled="!syncStore.archive || syncStore.targets.length === 0"
              @click="syncStore.runCompare()"
            >
              {{ syncStore.runStatus.compare === 'idle' ? '开始比对' : '继续比对' }}
            </el-button>
            <el-button v-else type="warning" :icon="VideoPause" @click="syncStore.stopSide('compare')">断网（停止）</el-button>
            <el-button :icon="RefreshRight" :disabled="sideRunning('compare')" @click="syncStore.resetSide('compare')">重新来过</el-button>
            <el-checkbox v-model="syncStore.flaky" :disabled="sideRunning('compare')">模拟网络抖动</el-checkbox>
          </div>

          <el-table :data="syncStore.targets" size="small" border max-height="320">
            <el-table-column prop="ringNo" label="环号" width="100" />
            <el-table-column prop="speciesCn" label="本站鸟种" width="110" />
            <el-table-column label="原环志日期（中心）" width="130">
              <template #default="scope">{{ scope.row.originalRingDate ? formatDate(scope.row.originalRingDate) : '—' }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80" />
            <el-table-column label="结果" width="80">
              <template #default="scope">
                <el-tag :type="compareResult(scope.row).type" size="small">{{ compareResult(scope.row).label }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <!-- 上报侧 -->
      <el-col :xs="24" :md="12">
        <el-card shadow="never" class="block side-card">
          <template #header>
            <div class="card-header">
              <span>② 上报侧（本站 → 档案）</span>
              <el-tag :type="statusMeta[syncStore.runStatus.report].type" effect="plain" size="small">
                {{ statusMeta[syncStore.runStatus.report].label }}
              </el-tag>
            </div>
          </template>

          <p class="side-desc">
            将本站带环个体（重捕 / 回收）逐只编译成上报包回传中心。只编译、不新增记录，
            重捕次数不会因为再核一次而多算。
          </p>

          <div class="progress-line">
            <el-progress :percentage="reportPct" :stroke-width="10" />
            <span class="progress-text">
              已编译 {{ syncStore.reportStats.done }} / {{ syncStore.reportStats.total }}
              <template v-if="syncStore.reportStats.failed"> · 失败 {{ syncStore.reportStats.failed }}</template>
            </span>
          </div>
          <div v-if="sideRunning('report')" class="current-line">正在编译：{{ syncStore.current.report }} …</div>
          <div v-if="syncStore.runStatus.report === 'error'" class="error-line">出错：{{ syncStore.error.report }}（已编译进度已留住，可重试或重新来过）</div>

          <div class="toolbar">
            <el-button
              v-if="!sideRunning('report')"
              type="primary"
              :disabled="syncStore.targets.length === 0"
              @click="syncStore.runReport()"
            >
              {{ syncStore.runStatus.report === 'idle' ? '开始上报' : '继续上报' }}
            </el-button>
            <el-button v-else type="warning" :icon="VideoPause" @click="syncStore.stopSide('report')">断网（停止）</el-button>
            <el-button :icon="RefreshRight" :disabled="sideRunning('report')" @click="syncStore.resetSide('report')">重新来过</el-button>
            <el-button type="success" plain :icon="Download" :disabled="syncStore.targets.length === 0" @click="syncStore.downloadReport()">下载上报包</el-button>
          </div>

          <el-table :data="syncStore.targets" size="small" border max-height="320">
            <el-table-column prop="ringNo" label="环号" width="100" />
            <el-table-column prop="speciesCn" label="鸟种" width="110" />
            <el-table-column label="本站捕获日期" width="120">
              <template #default="scope">{{ formatDate(scope.row.ringDate) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80" />
            <el-table-column label="结果" width="80">
              <template #default="scope">
                <el-tag :type="reportResult(scope.row).type" size="small">{{ reportResult(scope.row).label }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 档案有、本站无 -->
    <el-card v-if="syncStore.unmatchedArchive.length" shadow="never" class="block">
      <template #header>
        <div class="card-header">
          <span>档案中有、本站未捕获（{{ syncStore.unmatchedArchive.length }}）</span>
          <el-tag type="info" effect="plain" size="small">不写入本站台账</el-tag>
        </div>
      </template>
      <el-table :data="syncStore.unmatchedArchive" size="small" border>
        <el-table-column prop="ringNo" label="环号" width="110" />
        <el-table-column prop="speciesCn" label="鸟种" width="120" />
        <el-table-column prop="speciesSci" label="学名" min-width="180" show-overflow-tooltip />
        <el-table-column label="原环志日期" width="130">
          <template #default="scope">{{ formatDate(scope.row.originalRingDate) }}</template>
        </el-table-column>
        <el-table-column prop="bandingSite" label="环志地点" width="160" />
        <el-table-column prop="kind" label="类别" width="100" />
      </el-table>
    </el-card>

    <!-- 日志 -->
    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-header">
          <span>处理日志</span>
          <el-tag size="small" effect="plain">断网续传 · 进度持久化</el-tag>
        </div>
      </template>
      <div v-if="syncStore.log.length === 0" class="log-empty">暂无日志</div>
      <ul v-else class="log-list">
        <li v-for="(line, index) in syncStore.log" :key="index" class="log-item">{{ line }}</li>
      </ul>
    </el-card>
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
  margin-top: 12px;
  flex-wrap: wrap;
}
.block {
  border-radius: 8px;
  margin-bottom: 16px;
}
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.archive-empty {
  padding: 12px 0;
}
.side-row {
  margin-bottom: 0;
}
.side-card {
  min-height: 420px;
}
.side-desc {
  margin: 0 0 12px;
  color: #6f8480;
  font-size: 12px;
  line-height: 1.7;
}
.progress-line {
  display: flex;
  align-items: center;
  gap: 12px;
}
.progress-text {
  white-space: nowrap;
  font-size: 12px;
  color: #4a5a56;
}
.current-line {
  margin-top: 8px;
  font-size: 12px;
  color: #b88230;
}
.error-line {
  margin-top: 8px;
  font-size: 12px;
  color: #c45656;
}
.log-empty {
  color: #9aa8a4;
  font-size: 13px;
  text-align: center;
  padding: 8px 0;
}
.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
.log-item {
  font-size: 12px;
  color: #4a5a56;
  padding: 3px 0;
  border-bottom: 1px dashed #e3ece9;
}
</style>
