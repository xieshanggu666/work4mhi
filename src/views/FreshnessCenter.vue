<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useFreshnessStore } from '@/stores/freshness'
import DocPill from '@/components/common/DocPill.vue'
import { formatFull, avatarColor } from '@/utils/format'
import {
  FRESH, FRESH_CYCLES, freshStatusLabel, freshStatusCls, dueText, freshTimelineLabel,
  cycleDaysLabel, isFreshnessEnabled, categoryPolicy, FRESH_SOURCE
} from '@/utils/freshness'
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const freshness = useFreshnessStore()

const tab = ref('active') // active | mine | all
const busyId = ref('')
const policyMsg = reactive({})
// 各分类批量策略的编辑草稿（天数，0/'' 表示关闭策略）
const drafts = reactive({})

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const isAdmin = computed(() => auth.user?.role === 'admin')

// 分类策略视图：当前策略、草稿、覆盖该分类的文档数统计
const categoryRows = computed(() =>
  kb.categories.map((c) => {
    const policy = categoryPolicy(c)
    const docsInCat = kb.docs.filter((d) => d.categoryId === c.id)
    const overrides = docsInCat.filter((d) => d.freshness?.source === FRESH_SOURCE.DOC || (d.freshness && !d.freshness.source)).length
    const following = docsInCat.filter((d) => d.freshness?.source === FRESH_SOURCE.CATEGORY).length
    const openTickets = docsInCat.filter((d) => freshness.activeTicketOf(d.id)).length
    return { cat: c, policy, days: policy?.cycleDays || null, docs: docsInCat.length, overrides, following, openTickets }
  })
)

function draftOf(row) {
  if (drafts[row.cat.id] === undefined) drafts[row.cat.id] = row.days ? String(row.days) : ''
  return drafts[row.cat.id]
}

async function applyPolicy(row) {
  if (busyId.value) return
  const raw = draftOf(row)
  const days = raw === '' || raw === '0' ? null : Number(raw)
  if (days !== null && !(days > 0)) { alert('请填写有效的复核周期天数'); return }
  const verb = days ? `将分类「${row.cat.name}」下文档的复核周期批量设置为 ${days} 天` : `关闭分类「${row.cat.name}」的批量复核策略`
  const detail = days
    ? '跟随分类策略的文档将立即重算到期点；文档单独覆盖与在途复核单不受影响（在途单保留规则快照，本轮通过后下一轮生效）。'
    : '仅清除跟随分类策略的配置；文档单独覆盖保留。'
  if (!confirm(verb + '？\n' + detail)) return
  busyId.value = row.cat.id
  try {
    const res = await freshness.setCategoryFreshPolicy(row.cat.id, days, auth.user)
    if (res.status === 'ok') {
      const parts = []
      if (res.enabled) parts.push(res.enabled + ' 篇新启用')
      if (res.recalced) parts.push(res.recalced + ' 篇重算到期')
      if (res.disabled) parts.push(res.disabled + ' 篇关闭')
      if (res.skipped.override) parts.push(res.skipped.override + ' 篇文档覆盖保留')
      if (res.skipped.open) parts.push(res.skipped.open + ' 篇在途复核单保留规则快照')
      policyMsg[row.cat.id] = '已生效：' + (parts.join('，') || '无文档需要变更')
      setTimeout(() => { delete policyMsg[row.cat.id] }, 6000)
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('仅管理员可以按分类批量设置复核周期。')
    }
  } finally {
    busyId.value = ''
  }
}

const sorted = computed(() =>
  [...freshness.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

const list = computed(() => {
  if (tab.value === 'active') {
    return sorted.value.filter((t) => t.status === FRESH.OPEN || t.status === FRESH.SUBMITTED || t.status === FRESH.REJECTED)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
  }
  if (tab.value === 'mine') return sorted.value.filter((t) => docById.value[t.docId]?.ownerId === auth.user?.id)
  return sorted.value
})

const counts = computed(() => ({
  active: freshness.tickets.filter((t) => t.status === FRESH.OPEN || t.status === FRESH.SUBMITTED || t.status === FRESH.REJECTED).length,
  submitted: freshness.submittedCount,
  mine: freshness.tickets.filter((t) => docById.value[t.docId]?.ownerId === auth.user?.id).length,
  all: freshness.tickets.length
}))

// 已启用保鲜、尚未到期的文档（周期运行状况一览）
const upcoming = computed(() =>
  kb.docs
    .filter((d) => isFreshnessEnabled(d) && !freshness.activeTicketOf(d.id))
    .sort((a, b) => new Date(a.freshness.nextDueAt) - new Date(b.freshness.nextDueAt))
    .slice(0, 8)
)

onMounted(async () => {
  await Promise.all([kb.loadAll(), freshness.loadAll()])
})
</script>

<template>
  <div class="fc-page">
    <header class="head">
      <h2>🧊 知识保鲜中心</h2>
      <p class="sub">负责人为文档设置复核周期，到期自动生成复核单并暂停问答引用；编辑者修订送审，管理员批准后恢复引用并重算周期，驳回则继续整改，每轮复核全程留痕。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'active' }" @click="tab = 'active'">待处理 <em>{{ counts.active }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我负责的 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部复核记录 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <!-- 管理员：按分类批量设置复核周期 -->
    <section v-if="isAdmin" class="policies card">
      <div class="pol-head">
        <h3>🏷 分类复核策略</h3>
        <span class="dim">按分类批量设置复核周期；文档可在详情页单独覆盖。策略调整即时重算跟随文档的到期计划，在途复核单保留建单时规则快照。</span>
      </div>
      <div v-for="row in categoryRows" :key="row.cat.id" class="pol-row">
        <div class="pol-name">
          <span class="pol-cat">{{ row.cat.name }}</span>
          <span class="pol-stat dim">{{ row.docs }} 篇文档 · {{ row.following }} 篇跟随策略 · {{ row.overrides }} 篇单独覆盖<span v-if="row.openTickets"> · {{ row.openTickets }} 篇复核中</span></span>
        </div>
        <div class="pol-edit">
          <div class="chips">
            <span v-for="c in FRESH_CYCLES" :key="c.days" class="chip" :class="{ on: Number(draftOf(row)) === c.days }" @click="drafts[row.cat.id] = String(c.days)">{{ c.label }}</span>
          </div>
          <input v-model="drafts[row.cat.id]" class="custom" type="number" min="0" placeholder="天，留空关闭" />
          <button class="btn sm primary" :disabled="busyId === row.cat.id" @click="applyPolicy(row)">批量应用</button>
          <span v-if="row.days" class="cur dim">当前：{{ cycleDaysLabel(row.days) }}</span>
        </div>
        <div v-if="policyMsg[row.cat.id]" class="pol-msg">✅ {{ policyMsg[row.cat.id] }}</div>
      </div>
    </section>

    <div v-if="tab === 'active' && upcoming.length" class="upcoming card">
      <div class="up-title">⏳ 临近复核（保鲜运行中）</div>
      <div class="up-list">
        <span v-for="d in upcoming" :key="d.id" class="up-item" @click="router.push('/docs/' + d.id)">
          <span class="up-name">{{ d.title }}</span>
          <span class="up-due">{{ cycleDaysLabel(d.freshness.cycleDays) }} · {{ dueText(d, null, freshness.now) }}</span>
        </span>
      </div>
    </div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🧊</div>
      {{ tab === 'active' ? '暂无待处理的保鲜复核单' : tab === 'mine' ? '你负责的文档还没有复核记录' : '暂无保鲜复核记录' }}
    </div>

    <div v-else class="fr-list">
      <div v-for="t in list" :key="t.id" class="fr card">
        <div class="fr-top" @click="router.push('/docs/' + t.docId)">
          <div class="fr-main">
            <span class="fr-doc-title">{{ docById[t.docId]?.title || '已删除文档' }}</span>
            <DocPill v-if="docById[t.docId]" :doc="docById[t.docId]" />
          </div>
          <div class="fr-side">
            <span class="st" :class="freshStatusCls(t.status)">第 {{ t.round }} 轮 · {{ freshStatusLabel(t.status) }}</span>
            <span class="fr-time">到期点 {{ formatFull(t.dueAt) }}（{{ dueText(docById[t.docId], t, freshness.now) }}）</span>
          </div>
        </div>

        <div class="fr-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(docById[t.docId]?.ownerId || '?') }">{{ (userById[docById[t.docId]?.ownerId]?.avatar || '?') }}</span>
            负责人：{{ userById[docById[t.docId]?.ownerId]?.name || docById[t.docId]?.ownerId || '—' }}
          </span>
          <span class="dim">周期 {{ cycleDaysLabel(t.cycleDays) }}（{{ t.cycleSource === 'category' ? '分类策略' : '文档设置' }}）</span>
          <span v-if="t.submittedBy" class="dim">
            {{ userById[t.submittedBy]?.name || t.submittedBy }} 送审
          </span>
          <span v-if="t.decidedAt" class="dim">
            {{ userById[t.decidedBy]?.name || t.decidedBy }} 于 {{ formatFull(t.decidedAt) }} {{ freshStatusLabel(t.status) }}
          </span>
        </div>

        <div v-if="t.status === 'rejected' && t.decisionNote" class="dnote">驳回意见：“{{ t.decisionNote }}”</div>

        <details class="timeline">
          <summary>查看本轮复核时间线（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(x, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ freshTimelineLabel(x.action) }}</span>
            <span class="tl-who">{{ userById[x.by]?.name || x.by }}</span>
            <span v-if="x.note" class="tl-note">“{{ x.note }}”</span>
            <span class="tl-tm">{{ formatFull(x.at) }}</span>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fc-page { max-width: 920px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: #0e7490; border-color: #0e7490; color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.policies { padding: 16px 20px; margin-bottom: 16px; }
.pol-head { margin-bottom: 12px; }
.pol-head h3 { margin: 0 0 4px; font-size: 15px; }
.pol-row { padding: 12px 0; border-top: 1px dashed var(--border); }
.pol-row:first-of-type { border-top: none; }
.pol-name { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.pol-cat { font-weight: 600; font-size: 14px; }
.pol-stat { font-size: 12px; }
.pol-edit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pol-edit .chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 3px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; font-size: 12.5px; }
.chip.on { background: #0e7490; border-color: #0e7490; color: #fff; }
.pol-edit .custom { width: 110px; padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; }
.pol-msg { margin-top: 8px; font-size: 12.5px; color: #15803d; }
.cur { white-space: nowrap; }
.upcoming { margin-top: 16px; padding: 14px 18px; }
.up-title { font-weight: 600; font-size: 13px; color: var(--text-2); margin-bottom: 10px; }
.up-list { display: flex; flex-wrap: wrap; gap: 8px; }
.up-item { display: inline-flex; flex-direction: column; gap: 2px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--panel-2); }
.up-item:hover { border-color: #0e7490; }
.up-name { font-size: 13px; font-weight: 500; }
.up-due { font-size: 11px; color: var(--text-3); }
.fr-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.fr { padding: 16px 20px; }
.fr-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.fr-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.fr-doc-title { font-weight: 700; font-size: 15px; }
.fr-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #cffafe; color: #0e7490; }
.st-review { background: #fef3c7; color: #b45309; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.fr-time { color: var(--text-3); font-size: 12px; }
.fr-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.dim { color: var(--text-3); font-size: 12px; }
.dnote { margin-top: 8px; font-size: 13px; color: #b91c1c; background: #fee2e2; border-radius: 8px; padding: 8px 12px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: #0e7490; min-width: 180px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
