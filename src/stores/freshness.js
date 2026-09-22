import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions } from '@/utils/version'
import { REVIEW, PUBLISH, buildTimelineEntry } from '@/utils/review'
import {
  FRESH, FRESH_SOURCE, calcDueAt, isFreshnessEnabled, isFreshTicketOpen,
  canManageFreshness, canManageCategoryFreshPolicy, resolveFreshPolicy, planCategoryFreshness,
  categoryPolicy, ticketRuleChanged,
  buildFreshTimelineEntry
} from '@/utils/freshness'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { canSubmitReview } from '@/utils/review'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { useKbStore } from './kb'

// 知识保鲜 store：
// 负责人（拥有者/管理员）为文档设置复核周期；到期由响应式时钟 + 调度器自动生成复核单，
// 文档立即退出问答引用；编辑者修订（或确认无需修订）送审，复用内容评审单的锁定/审批通道；
// 管理员批准后恢复引用并按周期重算下次到期点，驳回则在同一复核单上继续整改、重新送审。
// 每轮复核单（freshnessTickets）与其 timeline 全程保留，批准通过同步在版本记录上追加保鲜标记。
// 与审批/撤回的联动（syncFreshTicket）在 review store 的同事务内调用，两边状态不会脱节。
export const useFreshnessStore = defineStore('freshness', () => {
  const tickets = ref([])
  const loaded = ref(false)
  // 响应式当前时间：到期判定（isDocCitable/isFreshDue）与调度器统一以它为准，
  // 页面停留期间到点也能即时生成复核单并从问答收回引用，无需刷新
  const now = ref(new Date())
  let dueTimer = null
  const MAX_TIMER_DELAY = 2147483647

  // 事务内查询用户在文档上的有效限时协作授权（送审资格随撤销/到期即时收回）
  async function findCollabGrant(docId, userId) {
    if (!userId || userId === GUEST_ID) return null
    const reqs = await db.accessRequests
      .where('docId').equals(docId)
      .filter((r) => r.applicantId === userId).toArray()
    return reqs.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB) || null
  }

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 历史/关闭页面期间到点的文档补生成复核单（幂等）
    await sweepDue()
  }

  async function reload() {
    tickets.value = await db.freshnessTickets.toArray()
    now.value = new Date()
    scheduleDue()
  }

  // [docId] -> 流转中的复核单，供文档/问答批量判定引用资格
  const activeTicketMap = computed(() => {
    const m = {}
    for (const t of tickets.value) if (isFreshTicketOpen(t)) m[t.docId] = t
    return m
  })

  function activeTicketOf(docId) {
    return activeTicketMap.value[docId] || null
  }

  function ticketsOfDoc(docId) {
    return tickets.value
      .filter((t) => t.docId === docId)
      .sort((a, b) => b.round - a.round || new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 我负责（拥有）的文档上流转中的复核单
  function openTicketsForOwner(userId, role, docs) {
    const docMap = docs && docs.length ? Object.fromEntries(docs.map((d) => [d.id, d])) : null
    return tickets.value
      .filter((t) => isFreshTicketOpen(t))
      .filter((t) => {
        if (role === ROLE.ADMIN) return true
        const doc = docMap ? docMap[t.docId] : null
        return doc && doc.ownerId === userId
      })
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
  }

  // 暂停问答引用的文档数（侧栏角标）
  const pausedCount = computed(() => {
    const ids = new Set()
    for (const t of tickets.value) if (isFreshTicketOpen(t)) ids.add(t.docId)
    return ids.size
  })

  // 待管理员处理（复核送审中）数量
  const submittedCount = computed(() => tickets.value.filter((t) => t.status === FRESH.SUBMITTED).length)

  // ---- 到期调度（与限时授权到期同一套响应式时钟模式）----

  // 调度下一次到点唤醒：仅看「启用保鲜、当前无流转复核单」的文档，
  // 到点推进时钟 → sweepDue 生成复核单 → 问答引用闸门即时关闭
  function scheduleDue() {
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null }
    const activeIds = new Set(tickets.value.filter((t) => isFreshTicketOpen(t)).map((t) => t.docId))
    let next = Infinity
    for (const d of useKbStore().docs || []) {
      if (!isFreshnessEnabled(d) || !d.freshness?.nextDueAt || activeIds.has(d.id)) continue
      const due = new Date(d.freshness.nextDueAt).getTime()
      if (due > now.value.getTime() && due < next) next = due
    }
    if (next === Infinity) return
    const delay = Math.min(Math.max(next - Date.now(), 0) + 50, MAX_TIMER_DELAY)
    dueTimer = setTimeout(onDueTick, delay)
  }

  async function onDueTick() {
    dueTimer = null
    now.value = new Date()
    await sweepDue()
    scheduleDue()
  }

  // 扫描全部启用保鲜的文档：周期到点且尚无流转复核单 → 自动生成复核单并暂停问答引用。
  // 幂等：以 doc.freshness.activeTicket / 既有 open 单判重，重复扫描不会为同一周期建多张单
  async function sweepDue() {
    const kb = useKbStore()
    await kb.loadAll()
    now.value = new Date()
    const nowDate = now.value
    const nowIso = nowDate.toISOString()
    const dueDocs = kb.docs.filter((d) => isFreshnessEnabled(d) && d.freshness?.nextDueAt && new Date(d.freshness.nextDueAt) <= nowDate)
    if (!dueDocs.length) return

    await db.transaction('rw', db.docs, db.reviews, db.freshnessTickets, async () => {
      for (const d0 of dueDocs) {
        const fresh = await db.docs.get(d0.id)
        if (!fresh || !isFreshnessEnabled(fresh) || !fresh.freshness.nextDueAt) continue
        if (new Date(fresh.freshness.nextDueAt) > new Date(nowIso)) continue
        // 库内最新判重：已有本周期流转中复核单（含刚被驳回待整改）则不重复生成
        const dup = await db.freshnessTickets
          .where('docId').equals(fresh.id)
          .filter((t) => isFreshTicketOpen(t)).first()
        if (dup) continue
        // 文档正处于普通内容评审中（锁定）时，等该评审完结后再生成保鲜复核单，避免锁与引用状态交错
        const pendingContentReview = await db.reviews
          .where('docId').equals(fresh.id)
          .filter((rv) => rv.status === REVIEW.PENDING && !rv.freshTicketId).first()
        if (pendingContentReview) continue

        const round = (fresh.freshness.round || 0) + 1
        // 规则快照：建单时固化周期与来源，分类策略/文档覆盖在本轮复核期间调整不影响在途单节奏
        const ticket = {
          id: uid('fr'),
          docId: fresh.id,
          round,
          status: FRESH.OPEN,
          cycleDays: Number(fresh.freshness.cycleDays),
          cycleSource: fresh.freshness.source || FRESH_SOURCE.DOC,
          categoryId: fresh.categoryId || null,
          dueAt: fresh.freshness.nextDueAt, // 本轮到期点（逾期时长据此展示）
          reviewId: null,
          submittedBy: null,
          submittedAt: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: '',
          createdAt: nowIso,
          timeline: [buildFreshTimelineEntry('due', 'system', '复核周期到点，自动生成复核单并暂停问答引用', nowIso)]
        }
        await db.freshnessTickets.add(ticket)
        await db.docs.update(fresh.id, { 'freshness.activeTicket': ticket.id })
      }
    })

    await Promise.all([reload(), kb.reloadDocs()])
  }

  // 解析文档当前生效策略（文档覆盖优先，其次继承所属分类）
  function policyOf(doc) {
    return resolveFreshPolicy(doc, (catId) => useKbStore().catMap[catId] || null)
  }

  // 负责人设置/调整文档单独复核周期（文档覆盖，source='doc'）。
  // - 无流转复核单：立即生效，nextDueAt 自当前起算，保留历史轮次；
  // - 存在流转中复核单：允许提前调整（覆盖配置先落库，作为下一轮规则快照），但本轮在途单
  //   仍按建单时的规则执行；审批通过时按最新生效配置重算到期点，并在复核单上留痕提示。
  // 文档单独覆盖不随所属分类策略的后续调整变化。
  // 返回 { status: 'ok' } | 'denied' | 'guest' | 'missing' | 'deferred' | 'bad-cycle'
  async function setFreshCycle(docId, cycleDays, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const days = Number(cycleDays)
    if (!(days > 0)) return { status: 'bad-cycle' }
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canManageFreshness(doc, userId, role)) { result = { status: 'denied' }; return }

      const nowIso0 = new Date().toISOString()
      const existed = isFreshnessEnabled(doc)
      const wasCategory = doc.freshness?.source === FRESH_SOURCE.CATEGORY
      const prevRound = doc.freshness?.round || 0
      const prevApproved = doc.freshness?.lastApprovedAt || null
      const openT = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).first()

      if (openT) {
        // 在途复核单：覆盖配置仅作为「下一轮规则」落库，不改本轮到期点、不动 activeTicket；
        // 问答引用仍暂停，本轮审批通过时 syncFreshTicket 按新配置重算周期
        await db.docs.update(docId, {
          freshness: {
            cycleDays: days,
            source: FRESH_SOURCE.DOC,
            nextDueAt: doc.freshness?.nextDueAt || openT.dueAt,
            round: prevRound,
            activeTicket: openT.id,
            ...(prevApproved ? { lastApprovedAt: doc.freshness.lastApprovedAt, lastApprovedBy: doc.freshness.lastApprovedBy, lastReviewId: doc.freshness.lastReviewId } : {}),
            overrideUpdatedAt: nowIso0
          }
        })
        const label = (wasCategory ? '文档单独覆盖分类策略，复核周期改为 ' + days + ' 天' : '调整复核周期为 ' + days + ' 天') + '（本轮复核进行中，通过后下一轮生效）'
        await db.freshnessTickets.update(openT.id, {
          timeline: [...(openT.timeline || []), buildFreshTimelineEntry('doc-override', userId, label, nowIso0)]
        })
        result = { status: 'deferred', action: wasCategory ? 'override' : 'change' }
        return
      }

      const patch = {
        cycleDays: days,
        source: FRESH_SOURCE.DOC,
        nextDueAt: calcDueAt(days, nowIso0),
        round: prevRound,
        activeTicket: null,
        overrideUpdatedAt: nowIso0
      }
      await db.docs.update(docId, { freshness: patch })
      // 设置/调整动作留痕到最近一轮终态复核单（无历史单时仅写配置，不凭空建单）
      const lastTicket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => t.status === FRESH.APPROVED || t.status === FRESH.CANCELLED).first()
      if (lastTicket) {
        const label = wasCategory
          ? '文档单独覆盖分类策略，复核周期 ' + days + ' 天'
          : existed ? '调整复核周期为 ' + days + ' 天' : '开启知识保鲜，复核周期 ' + days + ' 天'
        await db.freshnessTickets.update(lastTicket.id, {
          timeline: [...(lastTicket.timeline || []), buildFreshTimelineEntry(wasCategory ? 'doc-override' : (existed ? 'change' : 'setting'), userId, label, nowIso0)]
        })
      }
      result = { status: 'ok', action: wasCategory ? 'override' : (existed ? 'change' : 'setting') }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 取消文档单独覆盖，恢复跟随所属分类策略（仅文档负责人/管理员）。
  // 无在途单时按分类策略立即重算（分类无策略则关闭保鲜）；有在途单时下一轮生效。
  // 返回 { status: 'ok' } | 'denied' | 'guest' | 'missing' | 'no-override'
  async function resetDocFreshCycle(docId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canManageFreshness(doc, userId, role)) { result = { status: 'denied' }; return }
      const isOverride = doc.freshness?.source === FRESH_SOURCE.DOC || (doc.freshness && !doc.freshness.source)
      if (!isOverride) { result = { status: 'no-override' }; return }

      const nowIso0 = new Date().toISOString()
      const policy = categoryPolicy(kb.catMap[doc.categoryId])
      const openT = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).first()

      if (openT) {
        // 本轮仍按在途单规则执行；记录下一轮将回到分类策略（或关闭）
        const label = policy
          ? '取消文档单独覆盖，复核周期恢复跟随分类策略（' + policy.cycleDays + ' 天），本轮通过后下一轮生效'
          : '取消文档单独覆盖（分类未设置策略），本轮通过后关闭知识保鲜'
        await db.freshnessTickets.update(openT.id, {
          timeline: [...(openT.timeline || []), buildFreshTimelineEntry('doc-reset-category', userId, label, nowIso0)]
        })
        // 删除文档侧覆盖：审批通过时按「无生效策略」关闭；审批前的引用状态仍由在途单决定
        await db.docs.update(docId, { freshness: null })
        result = { status: 'deferred' }
        return
      }

      if (!policy) {
        await db.docs.update(docId, { freshness: null })
      } else {
        await db.docs.update(docId, {
          freshness: {
            cycleDays: policy.cycleDays,
            source: FRESH_SOURCE.CATEGORY,
            nextDueAt: calcDueAt(policy.cycleDays, nowIso0),
            round: doc.freshness?.round || 0,
            activeTicket: null,
            policyUpdatedAt: nowIso0
          }
        })
      }
      const lastTicket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => t.status === FRESH.APPROVED || t.status === FRESH.CANCELLED).first()
      if (lastTicket) {
        await db.freshnessTickets.update(lastTicket.id, {
          timeline: [...(lastTicket.timeline || []), buildFreshTimelineEntry('doc-reset-category', userId, policy ? '取消覆盖，恢复跟随分类策略（' + policy.cycleDays + ' 天）' : '取消覆盖，分类未设置策略，关闭知识保鲜', nowIso0)]
        })
      }
      result = { status: 'ok', cycleDays: policy?.cycleDays || null }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 管理员按分类批量设置复核周期（分类策略）。
  // 同事务内：① 更新分类 freshPolicy；② 对该分类下全部文档逐篇重算生效配置
  // （planCategoryFreshness：文档单独覆盖跳过；在途复核单跳过、保留规则快照；其余即时重算到期点）。
  // cycleDays 传 null/0 表示关闭该分类策略（仅清除跟随型配置，文档覆盖保留）。
  // 返回 { status: 'ok', affected, skipped } | 'denied' | 'guest' | 'missing' | 'bad-cycle'
  async function setCategoryFreshPolicy(categoryId, cycleDays, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }
    const days = cycleDays == null || cycleDays === '' ? null : Number(cycleDays)
    if (days !== null && !(days > 0)) return { status: 'bad-cycle' }
    if (!canManageCategoryFreshPolicy(role, userId)) return { status: 'denied' }

    await db.transaction('rw', db.categories, db.docs, db.freshnessTickets, async () => {
      const category = await db.categories.get(categoryId)
      if (!category) { result = { status: 'missing' }; return }
      const nowIso0 = new Date().toISOString()
      const policy = days ? { cycleDays: days, updatedAt: nowIso0, updatedBy: userId } : null
      await db.categories.update(categoryId, { freshPolicy: policy })

      const docs = await db.docs.where('categoryId').equals(categoryId).toArray()
      let affected = 0
      let enabled = 0
      let recalced = 0
      let disabled = 0
      const skipped = { override: 0, open: 0, unchanged: 0 }
      for (const doc of docs) {
        const openT = await db.freshnessTickets
          .where('docId').equals(doc.id)
          .filter((t) => isFreshTicketOpen(t)).first()
        const plan = planCategoryFreshness(doc, policy, nowIso0, !!openT)
        if (plan.action === 'skip') {
          if (plan.reason === 'doc-override') skipped.override++
          else if (plan.reason === 'open-ticket') {
            skipped.open++
            // 在途单保留旧规则快照：仅留痕提示，本轮节奏不变，通过后按新策略重算
            const current = policy ? { cycleDays: days, source: FRESH_SOURCE.CATEGORY } : null
            if (ticketRuleChanged(openT, current)) {
              const label = current
                ? '所属分类复核周期调整为 ' + days + ' 天；本轮复核仍按建单时的 ' + openT.cycleDays + ' 天规则执行，通过后下一轮按新周期'
                : '所属分类已关闭批量复核策略；本轮复核仍按建单时的 ' + openT.cycleDays + ' 天规则执行，通过后文档覆盖继续生效或关闭保鲜'
              await db.freshnessTickets.update(openT.id, {
                timeline: [...(openT.timeline || []), buildFreshTimelineEntry('policy-rule-snap', 'system', label, nowIso0)]
              })
            }
          } else skipped.unchanged++
          continue
        }
        if (plan.action === 'disable') {
          await db.docs.update(doc.id, { freshness: null })
          disabled++
        } else {
          await db.docs.update(doc.id, { freshness: plan.patch })
          plan.action === 'enable' ? enabled++ : recalced++
        }
        affected++
      }
      result = { status: 'ok', affected, enabled, recalced, disabled, skipped, policy }
    })

    await Promise.all([reload(), kb.reloadDocs(), kb.reloadCategories()])
    return result
  }

  // 负责人关闭知识保鲜：当前流转中复核单作废（CANCELLED，记录保留），文档恢复正常引用
  async function disableFreshness(docId, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.freshnessTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (isGuestUser(userId)) { result = { status: 'guest' }; return }
      if (!canManageFreshness(doc, userId, role)) { result = { status: 'denied' }; return }
      // 跟随分类策略的文档不能逐篇关闭：关闭由管理员调整分类策略完成；如需例外先设置文档单独覆盖
      if (doc.freshness?.source === FRESH_SOURCE.CATEGORY) { result = { status: 'managed-by-category' }; return }

      const nowIso = new Date().toISOString()
      const openList = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).toArray()
      for (const t of openList) {
        // 送审中的保鲜复核需先撤回评审单（评审单由评审中心处理）；这里只允许在评审单已撤回/完结时作废
        if (t.status === FRESH.SUBMITTED && t.reviewId) { result = { status: 'in-review', ticket: t }; return }
        await db.freshnessTickets.put({
          ...t,
          status: FRESH.CANCELLED,
          decidedBy: userId,
          decidedAt: nowIso,
          timeline: [...(t.timeline || []), buildFreshTimelineEntry('cancel', userId, '关闭知识保鲜，作废本轮复核单', nowIso)]
        })
      }
      await db.docs.update(docId, { freshness: null })
      result = { status: 'ok' }
    })

    await Promise.all([reload(), useKbStore().reloadDocs()])
    return result
  }

  // 编辑者保鲜复核送审：在同一事务内建内容评审单、锁文档、关联当轮复核单。
  // noChange=true 表示负责人/编辑者确认内容仍然有效、无需修订（快照=当前内容，批准后不回写）。
  // 返回 { status: 'ok', review } | 'missing' | 'denied' | 'guest' | 'duplicate' | 'no-ticket' | 'closed'
  async function submitFreshReview(docId, patch, note, noChange, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const nowIso = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.reviews, db.comments, db.freshnessTickets, db.accessRequests, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      const ticket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t)).first()
      if (!ticket) { result = { status: 'no-ticket' }; return }
      if (ticket.status === FRESH.SUBMITTED) { result = { status: 'duplicate', ticket }; return }
      const existingPending = await db.reviews
        .where('docId').equals(docId)
        .filter((r) => r.status === REVIEW.PENDING).first()
      // 保鲜修订送审同样走文档写入资格：访客/只读/无关系编辑者不可发起，限时协作授权随撤销/到期收回
      if (!canSubmitReview(doc, { userId, role, grant: await findCollabGrant(docId, userId) }, existingPending)) {
        result = isGuestUser(userId) ? { status: 'guest' } : { status: 'denied' }
        return
      }
      if (existingPending) { result = { status: 'duplicate', review: existingPending }; return }

      const snapshot = noChange
        ? { title: doc.title, body: doc.body, categoryId: doc.categoryId, tagIds: [...(doc.tagIds || [])], visibility: doc.visibility }
        : {
          title: patch.title, body: patch.body, categoryId: patch.categoryId,
          tagIds: patch.tagIds || [], visibility: patch.visibility
        }
      const review = {
        id: uid('rev'),
        docId,
        status: REVIEW.PENDING,
        submittedBy: userId,
        submittedAt: nowIso,
        snapshot,
        baseVersion: ensureVersions(doc, nowIso).length,
        freshTicketId: ticket.id,
        freshRound: ticket.round,
        freshNoChange: !!noChange,
        decidedBy: null, decidedAt: null, decisionNote: '',
        timeline: [buildTimelineEntry(noChange ? 'fresh-submit-nochange' : 'fresh-submit', userId, note, nowIso)]
      }
      await db.reviews.add(review)
      await db.docs.update(docId, { publishState: PUBLISH.IN_REVIEW, activeReviewId: review.id })

      const freshAction = ticket.status === FRESH.REJECTED ? 'resubmit' : (noChange ? 'submit-nochange' : 'submit')
      await db.freshnessTickets.put({
        ...ticket,
        status: FRESH.SUBMITTED,
        reviewId: review.id,
        submittedBy: userId,
        submittedAt: nowIso,
        timeline: [...(ticket.timeline || []), buildFreshTimelineEntry(freshAction, userId, note, nowIso)]
      })

      if (note && note.trim()) {
        await db.comments.add({
          id: uid('cmt'), docId, reviewId: review.id, authorId: userId,
          content: note.trim(), mentionIds: [], createdAt: nowIso
        })
      }
      result = { status: 'ok', review, ticket }
    })

    const { useReviewStore: useReview } = await import('./review')
    await Promise.all([reload(), kb.reloadDocs(), useReview().reload()])
    return result
  }

  // 审批/撤回事务内联动复核单（由 review store 在同事务调用，tables 含 db.freshnessTickets）。
  // approve：复核通过 → 恢复引用、按「当前最新生效策略」重算到期点（在途单保留的旧规则仅管本轮；
  //   文档单独覆盖优先，其次继承分类策略，均无则关闭保鲜）、写入版本标记由 review store 完成；
  // reject ：驳回 → 复核单回到待整改，解除与评审单的送审关联，问答引用继续暂停；
  // withdraw：撤回送审 → 同 reject，回到待整改。
  async function syncFreshTicket(review, action, note, userId, nowIso) {
    if (!review?.freshTicketId) return
    const ticket = await db.freshnessTickets.get(review.freshTicketId)
    if (!ticket) return

    if (action === 'approve') {
      // 以库内最新文档 + 分类策略解析下一轮周期（分类批量调整/文档覆盖在本轮复核期间可能已变化）
      const latestDoc = await db.docs.get(review.docId)
      const latestCat = latestDoc?.categoryId ? await db.categories.get(latestDoc.categoryId) : null
      const policy = latestDoc ? resolveFreshPolicy(latestDoc, latestCat) : null
      const nextDueAt = policy ? calcDueAt(policy.cycleDays, nowIso) : null
      const ruleChanged = policy && (policy.cycleDays !== Number(ticket.cycleDays) || policy.source !== (ticket.cycleSource || FRESH_SOURCE.DOC))
      const approved = {
        ...ticket,
        status: FRESH.APPROVED,
        decidedBy: userId,
        decidedAt: nowIso,
        decisionNote: note || '',
        nextCycleDays: policy?.cycleDays || null,
        nextCycleSource: policy?.source || null,
        nextDueAt
      }
      if (ruleChanged) {
        approved.timeline = [
          ...(ticket.timeline || []),
          buildFreshTimelineEntry('policy-rule-snap', 'system', '本轮按建单时的 ' + ticket.cycleDays + ' 天规则完成；下一轮起按' + (policy.source === FRESH_SOURCE.CATEGORY ? '分类策略' : '文档单独设置') + ' ' + policy.cycleDays + ' 天执行', nowIso)
        ]
      }
      await db.freshnessTickets.put(approved)
      if (latestDoc) {
        if (!policy) {
          // 分类策略已关闭且文档无单独覆盖：本轮收尾后关闭保鲜（历史复核记录保留）
          await db.docs.update(review.docId, { freshness: null })
        } else {
          await db.docs.update(review.docId, {
            freshness: {
              cycleDays: policy.cycleDays,
              source: policy.source,
              nextDueAt,
              round: ticket.round,
              activeTicket: null,
              lastApprovedAt: nowIso,
              lastApprovedBy: userId,
              lastReviewId: review.id
            }
          })
        }
      }
    } else {
      const rejected = action === 'reject'
      await db.freshnessTickets.put({
        ...ticket,
        status: rejected ? FRESH.REJECTED : FRESH.OPEN,
        reviewId: null,
        decidedBy: rejected ? userId : null,
        decidedAt: rejected ? nowIso : null,
        decisionNote: rejected ? (note || '') : '',
        timeline: [
          ...(ticket.timeline || []),
          buildFreshTimelineEntry(rejected ? 'reject' : 'withdraw', userId, note, rejected ? nowIso : nowIso)
        ]
      })
      // activeTicket 仍指向本单（open/rejected 都是流转态），文档保持暂停引用
    }
  }

  // 删除文档时连带清理保鲜复核单
  async function deleteFreshnessOfDoc(docId) {
    await db.freshnessTickets.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  return {
    tickets, loaded, now, loadAll, reload,
    activeTicketMap, activeTicketOf, ticketsOfDoc, openTicketsForOwner, policyOf,
    pausedCount, submittedCount,
    sweepDue, setFreshCycle, resetDocFreshCycle, setCategoryFreshPolicy,
    disableFreshness, submitFreshReview, syncFreshTicket, deleteFreshnessOfDoc
  }
})
