import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import RingBoard from '../pages/RingBoard.vue';
import RingList from '../pages/RingList.vue';
import MeasureEntry from '../pages/MeasureEntry.vue';
import SiteList from '../pages/SiteList.vue';
import SessionList from '../pages/SessionList.vue';
import Reconcile from '../pages/Reconcile.vue';

/** 全部路由：统计台 + 环志记录 / 量度 / 鸟点 / 调查批次 / 外站比对 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'board', component: RingBoard, meta: { title: '统计台' } },
  { path: '/rings', name: 'rings', component: RingList, meta: { title: '环志记录' } },
  { path: '/measure', name: 'measure', component: MeasureEntry, meta: { title: '量度测量' } },
  { path: '/sites', name: 'sites', component: SiteList, meta: { title: '鸟点台账' } },
  { path: '/sessions', name: 'sessions', component: SessionList, meta: { title: '调查批次' } },
  { path: '/reconcile', name: 'reconcile', component: Reconcile, meta: { title: '外站比对' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('../pages/NotFound.vue'), meta: { title: '页面不存在' } },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.afterEach((to) => {
  const title = (to.meta?.title as string) ?? '';
  document.title = title ? `${title} · 鸟类环志记录与鸟点地图` : '鸟类环志记录与鸟点地图';
});

export default router;
