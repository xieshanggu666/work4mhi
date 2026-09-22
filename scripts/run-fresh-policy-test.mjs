// 分类批量复核周期端到端回归（fake-indexeddb + 真实 store）
// 覆盖：
// 1. 管理员按分类批量设置周期 → 跟随文档即时重算到期点（enable/recalc）；非管理员拒绝；
// 2. 文档单独覆盖（含迁移来的无 source 历史配置）不被分类策略覆盖；
// 3. 在途复核单保留建单时规则快照：策略调整不改本轮节奏，审批通过后按新策略重算；
// 4. 取消覆盖恢复跟随分类；关闭分类策略只清跟随型文档；
// 5. 文档跨分类移动：跟随者按新分类重算，覆盖者不变；
// 6. 新建文档继承分类策略；问答引用闸门与策略联动；
// 7. 纯函数 planCategoryFreshness / planCategoryMove / resolveFreshPolicy 边界。
// 运行：npm run test:fresh-policy
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useReviewStore } from '@/stores/review'
import { useFreshnessStore } from '@/stores/freshness'
import { uid } from '@/utils/format'
import {
  FRESH, FRESH_SOURCE, isDocCitable, calcDueAt, DAY_MS,
  resolveFreshPolicy, planCategoryFreshness, planCategoryMove,
  initialFreshnessForCategory, categoryPolicy, canManageCategoryFreshPolicy
} from '@/utils/freshness'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const review = useReviewStore(pinia)
const freshness = useFreshnessStore(pinia)

const owner = { id: 'u-owner', role: 'editor', name: '负责人' }
const editor = { id: 'u-editor', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const viewer = { id: 'u-viewer', role: 'viewer', name: '只读' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

await db.categories.bulkAdd([
  { id: 'cat-a', name: '分类甲', icon: 'doc' },
  { id: 'cat-b', name: '分类乙', icon: 'doc' }
])

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '策略文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文 v1</p>', categoryId: 'cat-a', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id, editor.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>正文 v1</p>', categoryId: 'cat-a', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  await kb.reloadCategories()
  return d
}

// ---------- 0. 纯函数边界 ----------
console.log('\n[0] 策略解析与批量计划纯函数')
const cat = { freshPolicy: { cycleDays: 90 } }
assert(resolveFreshPolicy({ freshness: { cycleDays: 30, source: 'doc' } }, cat).source === 'doc', '文档覆盖优先于分类策略')
assert(resolveFreshPolicy({ freshness: { cycleDays: 90, source: 'category' } }, cat).cycleDays === 90, '跟随分类取分类周期')
assert(resolveFreshPolicy({ freshness: { cycleDays: 30 } }, cat).source === 'doc', '无 source 的历史配置视为文档覆盖')
assert(resolveFreshPolicy({}, { freshPolicy: null }) === null, '无覆盖且分类无策略 → null')
assert(categoryPolicy({ freshPolicy: { cycleDays: 0 } }) === null, '周期 0 的策略视为未设置')
assert(canManageCategoryFreshPolicy('editor', owner.id) === false, '编辑者不可管理分类策略')
assert(canManageCategoryFreshPolicy('admin', admin.id) === true, '管理员可管理分类策略')

const now0 = nowIso()
assert(planCategoryFreshness({}, { cycleDays: 30 }, now0, false).action === 'enable', '无保鲜文档 → enable')
assert(planCategoryFreshness({ freshness: { cycleDays: 90, source: 'category' } }, { cycleDays: 30 }, now0, false).action === 'recalc', '跟随文档周期变化 → recalc')
assert(planCategoryFreshness({ freshness: { cycleDays: 30, source: 'doc' } }, { cycleDays: 90 }, now0, false).reason === 'doc-override', '文档覆盖 → skip(doc-override)')
assert(planCategoryFreshness({ freshness: { cycleDays: 90, source: 'category', activeTicket: 'fr' } }, { cycleDays: 30 }, now0, true).reason === 'open-ticket', '在途单 → skip(open-ticket)')
assert(planCategoryFreshness({ freshness: { cycleDays: 30, source: 'category' } }, null, now0, false).action === 'disable', '关闭策略 → 跟随文档 disable')
assert(planCategoryMove({ freshness: { source: 'category', cycleDays: 90, round: 1 }, categoryId: 'cat-a' }, 'cat-b', { cycleDays: 30 }, now0).action === 'recalc', '跨分类跟随者 recalc')
assert(planCategoryMove({ freshness: { source: 'doc', cycleDays: 30, round: 1 }, categoryId: 'cat-a' }, 'cat-b', { cycleDays: 365 }, now0).action === 'keep', '跨分类覆盖者 keep')
assert(initialFreshnessForCategory({ cycleDays: 30 }, now0)?.source === 'category', '新建继承策略标记 source=category')

// ---------- 1. 分类批量设置：权限 + enable/recalc ----------
console.log('\n[1] 管理员按分类批量设置周期')
const da = await mkDoc() // 无保鲜
const db1 = await mkDoc({ freshness: { cycleDays: 90, source: 'category', nextDueAt: calcDueAt(90, now0), round: 0, activeTicket: null } })
const dc = await mkDoc({ freshness: { cycleDays: 30, source: 'doc', nextDueAt: calcDueAt(30, now0), round: 0, activeTicket: null } })
// 迁移来的历史配置（无 source）
const dd = await mkDoc({ freshness: { cycleDays: 180, nextDueAt: calcDueAt(180, now0), round: 0, activeTicket: null } })

let r = await freshness.setCategoryFreshPolicy('cat-a', 60, editor)
assert(r.status === 'denied', '非管理员设置分类策略被拒绝')
r = await freshness.setCategoryFreshPolicy('cat-a', 60, admin)
assert(r.status === 'ok', '管理员设置分类 60 天成功')
assert(r.enabled >= 1 && r.recalced >= 1, `批量统计：新启用 ${r.enabled}、重算 ${r.recalced}`)
assert(r.skipped.override >= 2, '文档覆盖（含无 source 迁移配置）跳过：' + r.skipped.override)
const catA = await db.categories.get('cat-a')
assert(catA.freshPolicy && catA.freshPolicy.cycleDays === 60, '分类策略已写入 freshPolicy')
const da1 = await db.docs.get(da.id)
assert(da1.freshness.source === 'category' && da1.freshness.cycleDays === 60 && da1.freshness.nextDueAt, '原未启用文档继承策略（source=category）')
const db1After = await db.docs.get(db1.id)
assert(db1After.freshness.cycleDays === 60 && new Date(db1After.freshness.nextDueAt) > new Date(), '跟随文档即时重算到期点')
const dc1 = await db.docs.get(dc.id)
assert(dc1.freshness.cycleDays === 30 && dc1.freshness.source === 'doc', '文档单独覆盖不被分类策略改动')
const dd1 = await db.docs.get(dd.id)
assert(dd1.freshness.cycleDays === 180 && !dd1.freshness.source, '迁移的逐篇配置保持不变')

// 同周期重复应用无变化
r = await freshness.setCategoryFreshPolicy('cat-a', 60, admin)
assert(r.affected === 0, '同周期重复应用不产生文档变更')

// ---------- 2. 问答引用闸门：分类策略到期 ----------
console.log('\n[2] 跟随分类策略的文档到期暂停/恢复引用')
const d2 = await mkDoc()
await freshness.setCategoryFreshPolicy('cat-a', 30, admin)
const d2Fresh = await db.docs.get(d2.id)
assert(d2Fresh.freshness.source === 'category', 'd2 已跟随分类策略')
await db.docs.update(d2.id, { 'freshness.nextDueAt': new Date(Date.now() + 300).toISOString() })
await kb.reloadDocs()
await freshness.reload()
assert(isDocCitable(await db.docs.get(d2.id), null, new Date()) === true, '到期前可引用')
await sleep(900)
const t2 = freshness.activeTicketOf(d2.id)
assert(!!t2 && t2.cycleDays === 30 && t2.cycleSource === FRESH_SOURCE.CATEGORY && t2.categoryId === 'cat-a', '到点生成复核单并固化规则快照（30 天/分类策略）')
assert(isDocCitable(await db.docs.get(d2.id), t2, new Date()) === false, '到期后引用暂停')

// ---------- 3. 策略调整：在途单保留快照，本轮审批后按新策略重算 ----------
console.log('\n[3] 在途复核单保留规则快照，通过后下一轮按新策略')
r = await freshness.setCategoryFreshPolicy('cat-a', 365, admin)
const d2Mid = await db.docs.get(d2.id)
// 在途单期间文档 freshness 保留本轮配置（不被重算），activeTicket 不变
assert(d2Mid.freshness.activeTicket === t2.id, '在途文档不被批量重算，activeTicket 保留')
const t2Snap = await db.freshnessTickets.get(t2.id)
assert(t2Snap.cycleDays === 30 && t2Snap.cycleSource === 'category', '在途单规则快照仍为 30 天')
assert((t2Snap.timeline || []).some((x) => x.action === 'policy-rule-snap'), '在途单追加策略变更留痕')

// 编辑者确认无需修订送审 → 管理员批准
r = await freshness.submitFreshReview(d2.id, {}, '内容仍然有效', true, editor)
assert(r.status === 'ok', 'noChange 送审成功')
const rvId = freshness.activeTicketOf(d2.id).reviewId
r = await review.decideReview(rvId, 'approve', '确认有效。', admin)
assert(r.status === 'ok', '管理员批准成功')
const d2Done = await db.docs.get(d2.id)
assert(d2Done.freshness.cycleDays === 365 && d2Done.freshness.source === 'category', '通过后下一轮按新分类策略 365 天')
const t2Done = await db.freshnessTickets.get(t2.id)
assert(t2Done.status === FRESH.APPROVED && t2Done.nextCycleDays === 365 && new Date(t2Done.nextDueAt) > new Date(Date.now() + 300 * DAY_MS), '复核单记录下一轮周期，到期点按 365 天重算')
assert(isDocCitable(d2Done, null, new Date()) === true, '批准后引用恢复')

// ---------- 4. 文档覆盖在途调整 + 取消覆盖 ----------
console.log('\n[4] 在途期间文档覆盖、取消覆盖恢复跟随')
const d4 = await mkDoc()
await db.docs.update(d4.id, { freshness: { cycleDays: 30, source: 'category', nextDueAt: new Date(Date.now() + 300).toISOString(), round: 0, activeTicket: null } })
await kb.reloadDocs()
await freshness.reload()
await sleep(900)
const t4 = freshness.activeTicketOf(d4.id)
assert(!!t4, 'd4 复核单已生成')
// 负责人在途期间改成 7 天文档覆盖
r = await freshness.setFreshCycle(d4.id, 7, owner)
assert(r.status === 'deferred', '在途期间设置文档覆盖返回 deferred')
assert((await db.freshnessTickets.get(t4.id)).cycleDays === 30, '本轮仍按 30 天快照执行')
// 取消覆盖恢复跟随（在途）
r = await freshness.resetDocFreshCycle(d4.id, owner)
assert(r.status === 'deferred', '在途期间取消覆盖返回 deferred')
r = await freshness.submitFreshReview(d4.id, {}, '确认', true, editor)
assert(r.status === 'ok', 'd4 送审成功')
r = await review.decideReview(freshness.activeTicketOf(d4.id).reviewId, 'approve', '通过', admin)
assert(r.status === 'ok', 'd4 批准成功')
const d4Done = await db.docs.get(d4.id)
assert(d4Done.freshness.source === 'category' && d4Done.freshness.cycleDays === 365, '取消覆盖后通过 → 跟随当前分类策略 365 天')
// 非负责人不能取消覆盖
r = await freshness.resetDocFreshCycle(d4Done.id, editor)
assert(r.status === 'denied', '非负责人取消覆盖被拒绝')

// ---------- 5. 关闭分类策略：跟随者关闭，覆盖者保留 ----------
console.log('\n[5] 关闭分类批量策略')
const d5a = await mkDoc({ freshness: { cycleDays: 365, source: 'category', nextDueAt: calcDueAt(365, now0), round: 0, activeTicket: null } })
const d5b = await mkDoc({ freshness: { cycleDays: 30, source: 'doc', nextDueAt: calcDueAt(30, now0), round: 0, activeTicket: null } })
r = await freshness.setCategoryFreshPolicy('cat-a', null, admin)
assert(r.status === 'ok', '关闭分类策略成功')
assert(!(await db.docs.get(d5a.id)).freshness, '跟随型文档配置被清除')
assert((await db.docs.get(d5b.id)).freshness.cycleDays === 30, '文档覆盖保留')
assert(!(await db.categories.get('cat-a')).freshPolicy, '分类 freshPolicy 已清空')

// ---------- 6. 跨分类移动 & 新建继承 ----------
console.log('\n[6] 文档跨分类移动与新建继承')
await freshness.setCategoryFreshPolicy('cat-a', 90, admin)
await freshness.setCategoryFreshPolicy('cat-b', 30, admin)
const d6a = await mkDoc({ freshness: { cycleDays: 90, source: 'category', nextDueAt: calcDueAt(90, now0), round: 0, activeTicket: null } })
const d6b = await mkDoc({ freshness: { cycleDays: 365, source: 'doc', nextDueAt: calcDueAt(365, now0), round: 0, activeTicket: null } })
let saved = await kb.updateDoc(d6a.id, { categoryId: 'cat-b' }, owner, '移动到分类乙')
assert(saved.status === 'saved', '跟随文档跨分类保存成功')
const d6aMoved = await db.docs.get(d6a.id)
assert(d6aMoved.categoryId === 'cat-b' && d6aMoved.freshness.source === 'category' && d6aMoved.freshness.cycleDays === 30, '跟随者按新分类策略重算为 30 天')
assert(saved.crossFreshNote.includes('30'), '保存结果返回跨分类复核提示')
saved = await kb.updateDoc(d6b.id, { categoryId: 'cat-b' }, owner, '移动到分类乙')
const d6bMoved = await db.docs.get(d6b.id)
assert(d6bMoved.freshness.cycleDays === 365 && d6bMoved.freshness.source === 'doc', '覆盖文档周期不随分类变化')
// 新建文档继承分类策略
const d6c = await kb.createDoc({ title: '新建继承', body: '<p>x</p>', categoryId: 'cat-b' }, owner)
assert(d6c.freshness && d6c.freshness.source === 'category' && d6c.freshness.cycleDays === 30, '新建文档继承分类策略 30 天')
const d6d = await kb.createDoc({ title: '新建无策略', body: '<p>x</p>', categoryId: 'cat-none' }, owner)
assert(!d6d.freshness, '分类无策略时新建文档不启用保鲜')

// ---------- 7. 负责人交接不改变规则快照（联动回归） ----------
console.log('\n[7] 负责人交接：在途规则快照随复核单保留')
const d7 = await mkDoc({ categoryId: 'cat-a', ownerId: owner.id })
await db.docs.update(d7.id, { freshness: { cycleDays: 90, source: 'category', nextDueAt: new Date(Date.now() + 300).toISOString(), round: 0, activeTicket: null } })
await kb.reloadDocs()
await freshness.reload()
await sleep(900)
const t7 = freshness.activeTicketOf(d7.id)
assert(!!t7 && t7.cycleSource === 'category', 'd7 在途单为分类策略快照')
// 交接在 handover store 覆盖较重，这里直接断言交接依赖的快照字段稳定：
// 调整分类策略不影响 t7 本轮，审批后下一轮按新策略（与 [3] 同一代码路径）
await freshness.setCategoryFreshPolicy('cat-a', 180, admin)
const t7Still = await db.freshnessTickets.get(t7.id)
assert(t7Still.cycleDays === 90, '交接前后在途单规则快照不变（90 天）')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
