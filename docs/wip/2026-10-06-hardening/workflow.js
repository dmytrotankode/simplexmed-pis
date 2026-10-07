export const meta = {
  name: 'pis-release-hardening',
  description: 'Implement, review, verify and fix web/mobile/deploy findings for the Плексі PIS, then sync docs',
  phases: [
    { title: 'Implement', detail: 'one agent per area (web, mobile, deploy+docs) on disjoint files' },
    { title: 'Review', detail: '3 lenses per area' },
    { title: 'Verify', detail: 'skeptic per reported issue' },
    { title: 'Fix', detail: 'apply confirmed issues, rerun checks' },
    { title: 'Docs', detail: 'sync compliance matrix and READMEs with final code' },
  ],
}

const COMMON = args.common

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    changed_files: { type: 'array', items: { type: 'string' } },
    done: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, reason: { type: 'string' } }, required: ['item', 'reason'] } },
    checks: { type: 'string' },
  },
  required: ['summary', 'changed_files', 'done', 'skipped', 'checks'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      title: { type: 'string' }, detail: { type: 'string' }, fix: { type: 'string' },
    }, required: ['id', 'file', 'severity', 'title', 'detail', 'fix'] } },
  },
  required: ['issues'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['real', 'reason'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    not_fixed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    checks: { type: 'string' },
  },
  required: ['fixed', 'not_fixed', 'checks'],
}

const AREAS = args.areas

const results = await pipeline(
  AREAS,
  // Stage 1: implement
  (area) => agent(
    `${COMMON}\n\nYOUR AREA: ${area.name}. You OWN ONLY these paths (do not edit anything else): ${area.owns}\n\n` +
    `TASK: implement every item of the specification below completely and carefully. Read the relevant code first. ` +
    `Keep the existing code style (Ukrainian comments with ТВ ПІС item references, existing naming and idioms). ` +
    `After implementing, run the checks listed and fix what they reveal.\n\nSPECIFICATION:\n${area.spec}\n\nCHECKS:\n${area.checks}\n\n` +
    `Return: summary, changed_files, done (item ids), skipped (item id + concrete reason — only if truly impossible), checks (exact command results).`,
    { label: `implement:${area.key}`, phase: 'Implement', schema: IMPL_SCHEMA }),
  // Stage 2: review with distinct lenses
  async (impl, area) => {
    const reviews = await parallel(area.lenses.map((lens) => () => agent(
      `${COMMON}\n\nREAD-ONLY REVIEW. Do not edit any files. AREA: ${area.name} (paths: ${area.owns}).\n` +
      `An implementer just changed this area to satisfy the specification below. Implementer report: ${JSON.stringify(impl)}\n\n` +
      `SPECIFICATION that had to be implemented:\n${area.spec}\n\nYOUR LENS: ${lens}\n\n` +
      `Find concrete defects through your lens: spec items not implemented or implemented wrongly, regressions, broken flows, ` +
      `syntax/type errors, security problems, requirement (ТВ ПІС) violations. Verify each by reading the code (quote file:line). ` +
      `Report only real, specific problems with an exact fix. Use ids like ${area.key}-<lens-word>-<n>. If nothing is wrong, return an empty list.`,
      { label: `review:${area.key}:${lens.split(':')[0]}`, phase: 'Review', schema: REVIEW_SCHEMA })))
    const issues = reviews.filter(Boolean).flatMap((r) => r.issues || [])
    // dedup by file+title prefix
    const seen = new Set()
    const unique = issues.filter((i) => {
      const k = `${i.file}|${(i.title || '').toLowerCase().slice(0, 60)}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return { impl, issues: unique }
  },
  // Stage 3: adversarial verification of each issue, then fix confirmed ones
  async (rev, area) => {
    const verdicts = await parallel(rev.issues.map((issue) => () => agent(
      `${COMMON}\n\nREAD-ONLY. Do not edit files. A reviewer claims this defect in ${area.name}:\n${JSON.stringify(issue)}\n\n` +
      `Try hard to REFUTE it by reading the actual code and the requirement/specification. ` +
      `Return real=true only if the defect truly exists now and the proposed fix is correct or clearly needed; otherwise real=false. ` +
      `If uncertain after checking, return real=false with the reason.`,
      { label: `verify:${issue.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then((v) => ({ issue, verdict: v }))))
    const confirmed = verdicts.filter(Boolean).filter((x) => x.verdict && x.verdict.real).map((x) => ({ ...x.issue, why: x.verdict.reason }))
    const rejected = verdicts.filter(Boolean).filter((x) => !(x.verdict && x.verdict.real)).length
    log(`${area.key}: ${rev.issues.length} reported, ${confirmed.length} confirmed, ${rejected} refuted`)
    if (!confirmed.length) return { area: area.key, impl: rev.impl, confirmed: [], fix: null }
    const fix = await agent(
      `${COMMON}\n\nYOUR AREA: ${area.name}. You OWN ONLY: ${area.owns}\n\nFix every confirmed defect below (verified by an independent skeptic). ` +
      `Then run the checks and make sure everything passes.\n\nCONFIRMED DEFECTS:\n${JSON.stringify(confirmed, null, 1)}\n\nCHECKS:\n${area.checks}`,
      { label: `fix:${area.key}`, phase: 'Fix', schema: FIX_SCHEMA })
    return { area: area.key, impl: rev.impl, confirmed, fix }
  },
)

phase('Docs')
const docs = await agent(
  `${COMMON}\n\nYOUR TASK: documentation sync. You OWN ONLY: C:\\SIMPLEX_2.1\\pis\\docs\\compliance_matrix.md, C:\\SIMPLEX_2.1\\pis\\README.md, ` +
  `C:\\SIMPLEX_2.1\\pis\\mobile\\README.md, C:\\SIMPLEX_2.1\\pis\\docs\\submission\\README.md (do not edit code).\n` +
  `The web cabinet, mobile app, backend and deploy configs were just changed. Results of each area: ${JSON.stringify(results.filter(Boolean).map((r) => ({ area: r.area, done: r.impl && r.impl.done, skipped: r.impl && r.impl.skipped, fixed: r.fix && r.fix.fixed, not_fixed: r.fix && r.fix.not_fixed })))}\n` +
  `Backend changes made earlier: ${args.backendChanges}\n\n` +
  `Update these documents so every statement matches the CURRENT code (verify claims by reading code, do not trust old text): ` +
  `compliance matrix rows (web/Android/BFF columns, where implemented), the security section, mobile auth flow description (server-side code exchange + one-time handle redeemed with code_verifier), ` +
  `local accounts disabled by default (PIS_LOCAL_ACCOUNTS), account deletion, Annex 1 table generation (373 rows) and test, sandbox (pis/tools/sandbox), iOS/Huawei/Google Play build and store notes, ` +
  `and the operator checklist in docs/submission/README.md (keep it limited to what NHSU requires plus what the operator must do: deploy redirect-ehealth.js, mailboxes, ЄДР, PIS_LEGAL_CAPACITY_DOCUMENT_TYPES and NHSU support URL values to obtain, server version scan, signing key backup, PreProd checks incl. sign-up state echo). Keep Ukrainian language and the existing tone. ` +
  `Return a short summary of what you changed.`,
  { label: 'docs-sync', phase: 'Docs' })

return { results, docs }
