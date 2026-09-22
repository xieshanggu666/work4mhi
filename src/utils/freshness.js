// 知识保鲜：复核周期、复核单状态、权限判定、到期/引用判定与留痕工具（均为纯函数，便于测试）
// 流转：管理员按分类批量设置复核周期（分类策略）/ 负责人逐篇覆盖（文档策略）→
// 到期自动生成复核单（open，暂停问答引用，在途单保留生效周期快照）→
// 编辑者修订送审（submitted，复用评审单锁定/审批通道）→ 管理员批准（approved，恢复引用并按
// 最新生效策略重算周期）/ 驳回（rejected，继续整改，可修订后重新送审）；每轮复核单与 timeline 全程保留。
import { ROLE } from './permission'

// 复核单状态（每轮一条：驳回不是终态，修订后在同一条复核单上重新送审；approved 为本轮已通过）
export const FRESH = {
  OPEN: 'open', // 待整改：周期到点已生成复核单，问答引用暂停
  SUBMITTED: 'submitted', // 复核送审中：编辑者已修订送审，等待管理员批准
  REJECTED: 'rejected', // 已驳回：管理员驳回，继续整改后重新送审（引用仍暂停）
  APPROVED: 'approved', // 已通过：内容确认有效/已修订，恢复引用并重算周期
  CANCELLED: 'cancelled' // 已取消：负责人关闭保鲜，当前复核单作废（记录保留）
}

export const DAY_MS = 24 * 3600 * 1000

// 可选复核周期（天）
export const FRESH_CYCLES = [
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天（季度）' },
  { days: 180, label: '180 天（半年）' },
  { days: 365, label: '365 天（年度）' }
]

export function cycleDaysLabel(days) {
  const hit = FRESH_CYCLES.find((c) => c.days === days)
  if (hit) return hit.label
  return days ? days + ' 天' : '未设置'
}

// ---- 分类策略与文档覆盖（两级复核周期）----
// 分类记录上的 freshPolicy：{ cycleDays, updatedAt, updatedBy }（未设置/空对象表示该分类不批量启用）
// 文档 freshness.source：
//   'category'   —— 跟随分类策略，周期随策略调整即时重算；
//   'doc'        —— 文档单独覆盖，仅文档负责人/管理员可改，不随分类策略变动。
// 历史逐篇配置（迁移数据）一律标记为 'doc'：不改变线上已有文档的现有周期与到期点。
export const FRESH_SOURCE = {
  CATEGORY: 'category',
  DOC: 'doc'
}

export function categoryPolicy(category) {
  const p = category?.freshPolicy
  return p && Number(p.cycleDays) > 0 ? {
    cycleDays: Number(p.cycleDays),
    updatedAt: p.updatedAt || null,
    updatedBy: p.updatedBy || null
  } : null
}

// 文档当前生效的复核周期与来源：文档单独覆盖优先，其次继承所属分类策略，均无则 null。
// category 可传分类对象或分类 Map 解析结果；无匹配分类（如已删除）时仅有文档覆盖生效。
export function resolveFreshPolicy(doc, category) {
  const f = doc?.freshness
  // 文档单独覆盖：显式标记，或历史逐篇配置（无 source 字段，迁移后通常已补 'doc'，此处兜底）
  if (f && Number(f.cycleDays) > 0 && (f.source === FRESH_SOURCE.DOC || !f.source)) {
    return { cycleDays: Number(f.cycleDays), source: FRESH_SOURCE.DOC }
  }
  const cat = typeof category === 'function' ? category(doc?.categoryId) : category
  const policy = categoryPolicy(cat)
  if (policy) return { cycleDays: policy.cycleDays, source: FRESH_SOURCE.CATEGORY }
  return null
}

export function freshSourceLabel(source) {
  return source === FRESH_SOURCE.CATEGORY ? '分类策略' : source === FRESH_SOURCE.DOC ? '文档单独设置' : ''
}

// 分类策略批量生效时，逐篇计算文档 freshness 配置的变更（纯函数，便于批量写入与测试）。
// policy：该分类的最新策略（{ cycleDays } 或 null 表示分类未设置/已关闭）。
// 仅处理「跟随分类策略」的文档：文档单独覆盖（source='doc'，含迁移的历史逐篇配置）一律跳过；
// 存在流转中复核单的文档跳过——在途单保留规则快照，其到期与审批后的重算均按建单时的周期走，
// 本轮完结（通过/作废）后由后续同步重新落到新策略。
// 返回 { action, patch? }：
//   enable   原未启用 → 按策略开启，nextDueAt 自当前起算；
//   recalc   已跟随分类策略 → 以当前时刻为基准重算到期点（保留历史轮次）；
//   disable  分类策略关闭 → 清除跟随型 freshness 配置；
//   skip     文档覆盖 / 在途复核单 / 无变化，不改动。
export function planCategoryFreshness(doc, policy, nowIso, hasOpenTicket) {
  if (!doc) return { action: 'skip' }
  const f = doc.freshness
  if (hasOpenTicket || f?.activeTicket) return { action: 'skip', reason: 'open-ticket' }
  // 文档单独覆盖（含迁移来的历史逐篇配置）不随分类策略变化
  if (f && (f.source === FRESH_SOURCE.DOC || (!f.source && Number(f.cycleDays) > 0))) {
    return { action: 'skip', reason: 'doc-override' }
  }
  const days = policy && Number(policy.cycleDays) > 0 ? Number(policy.cycleDays) : null
  if (!days) {
    if (f && f.source === FRESH_SOURCE.CATEGORY) return { action: 'disable', patch: null }
    return { action: 'skip', reason: 'no-policy' }
  }
  const base = {
    cycleDays: days,
    source: FRESH_SOURCE.CATEGORY,
    round: f?.round || 0,
    activeTicket: null,
    lastApprovedAt: f?.lastApprovedAt || null,
    lastApprovedBy: f?.lastApprovedBy || null,
    lastReviewId: f?.lastReviewId || null,
    policyUpdatedAt: nowIso
  }
  if (!f) return { action: 'enable', patch: { ...base, nextDueAt: calcDueAt(days, nowIso) } }
  if (Number(f.cycleDays) === days) return { action: 'skip', reason: 'unchanged' }
  return { action: 'recalc', patch: { ...base, nextDueAt: calcDueAt(days, nowIso) } }
}

// 文档跨分类移动时的复核周期处理（纯函数）：
// - 跟随分类策略（source='category'）：离开旧策略，按新分类策略即时重算（无策略则关闭保鲜）；
// - 文档单独覆盖（source='doc'，含迁移的历史逐篇配置）：覆盖跟随文档，周期与到期点不变。
// 返回 { action: 'recalc'|'disable'|'keep', patch? }
export function planCategoryMove(doc, newCategoryId, newPolicy, nowIso) {
  const f = doc?.freshness
  if (!f) return { action: 'keep' }
  const isOverride = f.source === FRESH_SOURCE.DOC || !f.source
  if (isOverride) return { action: 'keep' }
  if (newCategoryId === doc.categoryId) return { action: 'keep' }
  const days = newPolicy && Number(newPolicy.cycleDays) > 0 ? Number(newPolicy.cycleDays) : null
  if (!days) return { action: 'disable', patch: null }
  return {
    action: 'recalc',
    patch: {
      cycleDays: days,
      source: FRESH_SOURCE.CATEGORY,
      nextDueAt: calcDueAt(days, nowIso),
      round: f.round || 0,
      activeTicket: f.activeTicket || null,
      lastApprovedAt: f.lastApprovedAt || null,
      lastApprovedBy: f.lastApprovedBy || null,
      lastReviewId: f.lastReviewId || null,
      policyUpdatedAt: nowIso
    }
  }
}

// 新建文档时继承所属分类的复核周期策略（分类无策略则不启用，返回 null）
export function initialFreshnessForCategory(policy, nowIso) {
  const days = policy && Number(policy.cycleDays) > 0 ? Number(policy.cycleDays) : null
  if (!days) return null
  return {
    cycleDays: days,
    source: FRESH_SOURCE.CATEGORY,
    nextDueAt: calcDueAt(days, nowIso),
    round: 0,
    activeTicket: null
  }
}

export function freshStatusLabel(status) {
  return { open: '待整改', submitted: '复核送审中', rejected: '已驳回待整改', approved: '已通过', cancelled: '已取消' }[status] || status
}

export function freshStatusCls(status) {
  return { open: 'st-open', submitted: 'st-review', rejected: 'st-no', approved: 'st-ok', cancelled: 'st-off' }[status] || ''
}

// 计算下一次复核到期点：基准时间（批准/设置时刻）+ 周期天数
export function calcDueAt(days, from) {
  const n = Number(days)
  if (!n || n <= 0) return null
  return new Date(new Date(from).getTime() + n * DAY_MS).toISOString()
}

// 文档是否启用了知识保鲜（设置了有效周期）。
// 文档记录上的 freshness 是「当前生效配置」的缓存：分类策略调整时由 store 批量重算刷新，
// 因此读取处无需持有分类对象即可判定；策略解析的权威逻辑见 resolveFreshPolicy。
export function isFreshnessEnabled(doc) {
  return !!doc?.freshness && Number(doc.freshness.cycleDays) > 0
}

// 当前流转中的复核单（open/submitted/rejected 均会暂停问答引用；approved/cancelled 为本轮终态）
export function isFreshTicketOpen(ticket) {
  return !!ticket && (ticket.status === FRESH.OPEN || ticket.status === FRESH.SUBMITTED || ticket.status === FRESH.REJECTED)
}

// 复核周期是否已到点（启用且 nextDueAt <= at）
export function isFreshDue(doc, at = new Date()) {
  if (!isFreshnessEnabled(doc) || !doc.freshness.nextDueAt) return false
  return new Date(doc.freshness.nextDueAt).getTime() <= new Date(at).getTime()
}

// 是否已有流转中的复核单（到期生成前判重，保证一个周期一张单）
export function hasOpenFreshTicket(doc, activeTicket) {
  const t = activeTicket ?? doc?.freshness?.activeTicket
  return isFreshTicketOpen(t)
}

// 是否可被问答引用（核心保鲜闸门）：
// 启用保鲜且「周期已到点」或「存在流转中复核单」时一律暂停引用；
// 未启用保鲜、或本轮已通过（周期已重算）的文档正常引用。
// 暂停只影响问答引用：文档详情、搜索、侧边栏入口仍可正常访问。
export function isDocCitable(doc, activeTicket, at = new Date()) {
  if (!doc) return false
  if (!isFreshnessEnabled(doc)) return true
  if (isFreshTicketOpen(activeTicket ?? doc?.freshness?.activeTicket)) return false
  if (isFreshDue(doc, at)) return false
  return true
}

// 设置/调整文档单独复核周期资格：仅文档拥有者或管理员（负责人）。
// 编辑者/只读成员、限时协作者、访客均不能设置他人文档的保鲜周期。
export function canManageFreshness(doc, userId, role) {
  if (!doc || !userId || userId === 'u-guest') return false
  if (role === ROLE.ADMIN) return true
  return doc.ownerId === userId
}

// 按分类批量设置复核周期属于平台级策略：仅管理员可操作
export function canManageCategoryFreshPolicy(role, userId) {
  return role === ROLE.ADMIN && !!userId && userId !== 'u-guest'
}

// 流转中复核单的规则快照：建单时固化的周期与来源，策略调整不影响在途单的本轮节奏
export function ticketRuleSnapshot(ticket) {
  if (!ticket || !Number(ticket.cycleDays)) return null
  return {
    cycleDays: Number(ticket.cycleDays),
    source: ticket.cycleSource || FRESH_SOURCE.CATEGORY,
    categoryId: ticket.categoryId || null
  }
}

// 在途单保留的规则快照与当前生效策略是否不一致（用于时间线提示：本轮按旧规则、下轮按新规则）
export function ticketRuleChanged(ticket, currentPolicy) {
  const snap = ticketRuleSnapshot(ticket)
  if (!snap || !currentPolicy) return false
  return snap.cycleDays !== currentPolicy.cycleDays || snap.source !== currentPolicy.source
}

// 关闭保鲜时是否允许同时作废当前复核单（仅负责人；存在流转中复核单时需要确认）
export function canDisableFreshness(doc, userId, role) {
  return canManageFreshness(doc, userId, role)
}

// 保鲜复核单的审批（通过/驳回）复用内容评审的管理员通道，见 utils/review.canReviewDecision

// 保鲜复核留痕：动作 + 操作人 + 说明 + 时间，复核单 timeline 全程保留
export function buildFreshTimelineEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

export function freshTimelineLabel(action) {
  return {
    due: '周期到点 · 自动生成复核单',
    submit: '修订内容送审',
    'submit-nochange': '确认内容无需修订 · 直接送审',
    approve: '复核通过 · 恢复引用并重算周期',
    reject: '复核驳回 · 继续整改',
    resubmit: '修订后重新送审',
    withdraw: '撤回复核送审 · 继续整改',
    setting: '设置复核周期',
    change: '调整复核周期',
    'doc-override': '文档单独覆盖复核周期',
    'doc-reset-category': '取消覆盖 · 恢复跟随分类策略',
    'policy-batch': '分类策略批量调整复核周期',
    'policy-rule-snap': '策略已调整 · 本轮按建单时规则执行，通过后下一轮按新周期',
    disable: '关闭知识保鲜',
    cancel: '作废复核单',
    handover: '负责人交接 · 保鲜责任转移'
  }[action] || action
}

// 版本记录上的保鲜标记
export function freshVersionBadge(v) {
  if (!v || !v.freshReview) return null
  if (v.freshReview.noChange) return { text: '保鲜确认 v' + v.freshReview.round, cls: 'fresh' }
  return { text: '保鲜修订 v' + v.freshReview.round, cls: 'fresh' }
}

// 距今文案：到期点剩余/逾期描述
export function dueText(doc, activeTicket, at = new Date()) {
  if (!isFreshnessEnabled(doc)) return ''
  const t = isFreshTicketOpen(activeTicket) ? activeTicket : null
  const dueAt = t?.dueAt || doc.freshness.nextDueAt
  if (!dueAt) return ''
  const diff = new Date(dueAt).getTime() - new Date(at).getTime()
  const day = DAY_MS
  const abs = Math.abs(diff)
  const n = Math.floor(abs / day)
  const span = n >= 1 ? n + ' 天' : Math.max(1, Math.floor(abs / (3600 * 1000))) + ' 小时'
  if (t) return '已逾期 ' + span
  return diff <= 0 ? '已到点' : span + '后到期'
}
