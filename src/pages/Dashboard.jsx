import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, FileText, Download, RotateCcw, X, ChevronRight, BarChart3, Eye, GitCompare, Layers, ShieldAlert, MessageCircle, Send, ChevronUp, BookOpen, Pencil, Check, HelpCircle, Crosshair, Package, Rows3 } from 'lucide-react'
import { SYSTEM_PROMPT, QA_SYSTEM_PROMPT, SCREENING_PROMPT, GEOTECH_PROMPT } from '../utils/prompts'
import { parseTakeoffFile } from '../utils/parseTakeoff'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
import { exportTakeoffCSV, exportQACSV, exportXLSX, buildTakeoffReportHTML, buildQAReportHTML, printReport, buildRFQReportHTML } from '../utils/exporters'
import OnboardingFlow from '../components/OnboardingFlow'
import ReferenceBank from '../components/ReferenceBank'
import './Dashboard.css'

// localStorage throws in Safari private mode / blocked-storage contexts — a
// bare call inside useState initializers took down the whole route.
const ls = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, val) { try { localStorage.setItem(key, val) } catch { /* unavailable */ } },
}

export default function Dashboard() {
  const { user } = useAuth()
  const [images, setImages] = useState([])
  const [activeImage, setActiveImage] = useState(0)
  const [results, setResults] = useState({})
  const [loading, setLoading] = useState(false)
  const [loadingSheet, setLoadingSheet] = useState(null)
  const [error, setError] = useState(null)
  const [comparisonData, setComparisonData] = useState('')
  const [activeTab, setActiveTab] = useState('takeoff')
  const [processingAll, setProcessingAll] = useState(false)
  const [screenings, setScreenings] = useState({})
  const [screeningSheet, setScreeningSheet] = useState(null)
  const [geotechResult, setGeotechResult] = useState(null)
  const [geotechLoading, setGeotechLoading] = useState(false)
  const [geotechError, setGeotechError] = useState(null)
  const [geotechFileName, setGeotechFileName] = useState(null)
  const [showOnboarding, setShowOnboarding] = useState(!ls.get('tc_onboarded'))
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [clarifyPrompt, setClarifyPrompt] = useState(null) // { count } — post-analysis "AI has questions" popup
  const [editingItem, setEditingItem] = useState(null)     // item_no being edited inline
  const [editDraft, setEditDraft] = useState({})           // { description, quantity, unit }
  const [credits, setCredits] = useState(null)             // takeoff credits; null = billing off / unknown
  const [billingOn, setBillingOn] = useState(false)
  const [paywall, setPaywall] = useState(null)             // { projectId, imgIdx } when a purchase is needed
  const [buying, setBuying] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [priceBook, setPriceBook] = useState({})           // key -> { unit_cost, unit, label }
  const [showPricing, setShowPricing] = useState(false)    // reveal the estimate view
  const [locate, setLocate] = useState(null)               // { sheet_id, region, region_page } click-to-verify
  const [groupBySheet, setGroupBySheet] = useState(false)  // phase/area breakdown
  const [revisionModal, setRevisionModal] = useState(false)
  const [revisionDiff, setRevisionDiff] = useState(null)   // { added, removed, changed }
  const [onboardName, setOnboardName] = useState('')
  const [onboardCompany, setOnboardCompany] = useState('')
  const [onboardPhone, setOnboardPhone] = useState('')
  const [jobHistory, setJobHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [activeJobId, setActiveJobId] = useState(null)
  const [feedbackModal, setFeedbackModal] = useState(null)
  const [feedbackRating, setFeedbackRating] = useState(0)
  const [feedbackComments, setFeedbackComments] = useState('')
  const [feedbackCorrections, setFeedbackCorrections] = useState('')
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackDone, setFeedbackDone] = useState({})
  const [qaMode, setQaMode] = useState(() => ls.get('tc_qa_mode') !== '0')
  const [uploadedTakeoffName, setUploadedTakeoffName] = useState(null)
  const [uploadedTakeoffData, setUploadedTakeoffData] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [jobType, setJobType] = useState(() => ls.get('tc_job_type') || 'private')
  const [boreMethod, setBoreMethod] = useState('unknown')
  const [scopeNotes, setScopeNotes] = useState('')
  const [specsFileId, setSpecsFileId] = useState(null)
  const [specsFileName, setSpecsFileName] = useState(null)
  const [specsUploading, setSpecsUploading] = useState(false)
  const fileInputRef = useRef(null)
  const geotechInputRef = useRef(null)
  const takeoffInputRef = useRef(null)
  const specsInputRef = useRef(null)
  const compareInputRef = useRef(null)
  const workerRef = useRef(null)
  const pendingRef = useRef({})
  const chatScrollRef = useRef(null)
  const [sheetMaps, setSheetMaps] = useState({})    // { project_id: { sheets, loaded } }
  const [proceedingAnalysis, setProceedingAnalysis] = useState(false)
  const [materialsMap, setMaterialsMap] = useState({})   // slug -> material row
  const [materialCard, setMaterialCard] = useState(null) // open material slug
  const [compareParsing, setCompareParsing] = useState(false)
  const [takeoffParsing, setTakeoffParsing] = useState(false)
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveMsgs, setResolveMsgs] = useState([])
  const [resolveInput, setResolveInput] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const resolveScrollRef = useRef(null)
  const imagesRef = useRef([])
  useEffect(() => { imagesRef.current = images }, [images])

  // Spin up a Web Worker for API calls — workers are exempt from background-tab throttling
  useEffect(() => {
    const worker = new Worker(new URL('../workers/apiWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = ({ data: { id, success, result, error } }) => {
      const pending = pendingRef.current[id]
      if (!pending) return
      delete pendingRef.current[id]
      if (success) pending.resolve(result)
      else pending.reject(new Error(error))
    }
    // A worker crash or unmount must reject every in-flight promise —
    // otherwise their finally blocks never run and spinners hang forever.
    const rejectAllPending = (reason) => {
      for (const id of Object.keys(pendingRef.current)) {
        pendingRef.current[id].reject(new Error(reason))
        delete pendingRef.current[id]
      }
    }
    worker.onerror = (e) => {
      console.error('Worker error:', e)
      rejectAllPending('The analysis worker crashed — try again.')
    }
    return () => {
      rejectAllPending('Page closed')
      worker.terminate()
    }
  }, [])

  // Reset chat when switching sheets, and land on a tab the new sheet's
  // result shape actually supports — rendering the Takeoff tab against a QA
  // result (no items array) used to white-screen the dashboard.
  useEffect(() => {
    setChatOpen(false)
    setChatMessages([])
    setResolveOpen(false)
    setResolveMsgs([])
    const r = results[activeImage]
    if (r) setActiveTab(r.executive_risk_summary ? 'report' : 'takeoff')
  }, [activeImage]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (resolveScrollRef.current) resolveScrollRef.current.scrollTop = resolveScrollRef.current.scrollHeight
  }, [resolveMsgs])

  // Auto-scroll chat to latest message
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages])

  // Loads a project's classified sheets (with signed thumbnail URLs) into
  // sheetMaps. Returns the page-1 preview URL. Shared by the Realtime handler
  // and the restore-on-load effect.
  const loadSheetMap = useCallback(async (projectId) => {
    const { data: sheets, error: shErr } = await supabase
      .from('sheets')
      .select('id, page_number, classification, included_in_analysis, storage_path, sheet_number, sheet_title')
      .eq('project_id', projectId)
      .order('page_number')
    if (shErr) {
      // A failed query must not masquerade as "0 sheets classified".
      setSheetMaps(prev => ({ ...prev, [projectId]: { sheets: [], loaded: false, error: shErr.message } }))
      return null
    }
    const sheetsWithUrls = await Promise.all((sheets || []).map(async (sheet) => {
      if (!sheet.storage_path) return { ...sheet, preview_url: null }
      const { data: signed } = await supabase.storage
        .from('plan-uploads')
        .createSignedUrl(sheet.storage_path, 86400)
      return { ...sheet, preview_url: signed?.signedUrl || null }
    }))
    setSheetMaps(prev => ({ ...prev, [projectId]: { sheets: sheetsWithUrls, loaded: true } }))
    return sheetsWithUrls.find(s => s.page_number === 1)?.preview_url || null
  }, [])

  // Restore in-flight projects on load. The sidebar is in-memory state, so a
  // refresh or navigation used to orphan uploads mid-triage/mid-analysis even
  // though the server kept working. Rebuild entries for any project whose
  // latest job (last 48h) hasn't completed; Realtime picks them up from there.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const restore = async () => {
      const { data: jobRows } = await supabase
        .from('processing_jobs')
        .select('id, project_id, kind, stage, progress, stage_detail, error, config, created_at, projects!inner(name)')
        .gt('created_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(30)
      if (cancelled || !jobRows?.length) return

      // Latest job per project decides what to show; completed runs are
      // already reachable via Recent Jobs, so only in-flight (or errored)
      // work gets restored. Calibration experiments stay out of the sidebar.
      const byProject = new Map()
      for (const j of jobRows) if (!byProject.has(j.project_id)) byProject.set(j.project_id, j)
      const toRestore = [...byProject.values()].filter(j =>
        j.stage !== 'complete' && j.stage !== 'ready' && !(j.config && j.config.calibration)
      )
      if (!toRestore.length) return

      const entries = []
      for (const j of toRestore) {
        let preview = null
        if (j.stage === 'triage_complete') {
          preview = await loadSheetMap(j.project_id)
        } else {
          const { data: sheet } = await supabase
            .from('sheets').select('storage_path')
            .eq('project_id', j.project_id).eq('page_number', 1).maybeSingle()
          if (sheet?.storage_path) {
            const { data: signed } = await supabase.storage
              .from('plan-uploads').createSignedUrl(sheet.storage_path, 86400)
            preview = signed?.signedUrl || null
          }
        }
        entries.push({
          name: j.projects?.name || 'Plan Set',
          mediaType: 'application/pdf',
          preview,
          project_id: j.project_id,
          job_id: j.id,
          jobStage: j.stage,
          jobProgress: j.progress,
          jobDetail: j.stage_detail,
          jobError: j.error,
        })
      }
      if (!cancelled && entries.length) {
        setImages(prev => {
          const known = new Set(prev.map(i => i.project_id).filter(Boolean))
          const fresh = entries.filter(e => !known.has(e.project_id))
          return fresh.length ? [...prev, ...fresh] : prev
        })
      }
    }
    restore()
    return () => { cancelled = true }
  }, [user, loadSheetMap])

  // Shared job-update handler — fed by both Realtime events and the polling
  // fallback below, so a dropped websocket can never permanently freeze
  // progress or lose a completion.
  const handleJobUpdate = useCallback(async (row) => {
    const { id: jobId, stage, progress, error: jobError, project_id, stage_detail } = row
    // Only react to jobs this session is actually tracking — an unfiltered
    // subscription otherwise triggers history reloads and signed-URL fetches
    // for unrelated events.
    const tracked = imagesRef.current.some(img => img?.job_id === jobId)
    if (!tracked) return

    if (stage === 'complete') {
      // The stage flip and the analysis_results insert are separate writes —
      // retry briefly so a replication gap doesn't silently drop the result.
      let ar = null
      for (let attempt = 0; attempt < 4 && !ar; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt))
        const { data } = await supabase
          .from('analysis_results')
          .select('result_json')
          .eq('job_id', jobId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        ar = data
      }

      const idx = imagesRef.current.findIndex(img => img?.job_id === jobId)
      setImages(prev => prev.map(img =>
        img?.job_id === jobId ? { ...img, jobStage: stage, jobProgress: 100, jobDetail: stage_detail } : img
      ))
      if (ar?.result_json && idx !== -1) {
        setResults(prev => ({ ...prev, [idx]: ar.result_json }))
        setActiveImage(idx)
        setActiveTab('takeoff')
        // The AI has questions — surface them loudly, not as a buried tab.
        const open = (ar.result_json.clarifications || []).filter(c => !c.resolution)
        if (open.length) setClarifyPrompt({ count: open.length })
      } else if (idx !== -1) {
        setImages(prev => prev.map(img =>
          img?.job_id === jobId
            ? { ...img, jobError: 'Analysis finished but the result could not be loaded — open it from Recent Jobs or retry.' }
            : img
        ))
      }
      // History is written server-side on completion; refresh the list.
      loadHistory()
      return
    }

    if (stage === 'triage_complete') {
      const page1Url = await loadSheetMap(project_id)
      setImages(prev => prev.map(img =>
        img?.job_id === jobId
          ? { ...img, jobStage: stage, jobProgress: progress, jobError, preview: page1Url }
          : img
      ))
    } else {
      setImages(prev => prev.map(img =>
        img?.job_id === jobId ? { ...img, jobStage: stage, jobProgress: progress, jobError, jobDetail: stage_detail } : img
      ))
      // Legacy: handle 'ready' stage for any jobs processed before triage was added
      if (stage === 'ready') {
        const { data: sheet } = await supabase
          .from('sheets')
          .select('storage_path, file_id')
          .eq('project_id', project_id)
          .eq('page_number', 1)
          .maybeSingle()
        if (sheet?.storage_path) {
          const { data: signedData } = await supabase.storage
            .from('plan-uploads')
            .createSignedUrl(sheet.storage_path, 86400)
          setImages(prev => prev.map(img =>
            img?.job_id === jobId
              ? { ...img, preview: signedData?.signedUrl || null, file_id: sheet.file_id }
              : img
          ))
        } else if (sheet?.file_id) {
          setImages(prev => prev.map(img =>
            img?.job_id === jobId ? { ...img, file_id: sheet.file_id } : img
          ))
        }
      }
    }
  }, [loadSheetMap]) // eslint-disable-line react-hooks/exhaustive-deps

  // Supabase Realtime: watch processing_jobs for this user and update image state
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel(`jobs-${user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'processing_jobs',
      }, (payload) => handleJobUpdate(payload.new))
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [user, handleJobUpdate])

  // Polling fallback: Realtime events are lost when the tab sleeps or the
  // websocket drops (no replay on reconnect). Every 20s, re-fetch any job the
  // sidebar still shows as in-flight and feed changes through the same handler.
  useEffect(() => {
    if (!user) return
    const TERMINAL = new Set(['complete', 'ready', 'error'])
    const timer = setInterval(async () => {
      const inFlight = imagesRef.current.filter(img => img?.job_id && !TERMINAL.has(img.jobStage))
      if (!inFlight.length) return
      const { data: rows } = await supabase
        .from('processing_jobs')
        .select('id, project_id, stage, progress, stage_detail, error')
        .in('id', inFlight.map(i => i.job_id))
      for (const row of rows || []) {
        const img = inFlight.find(i => i.job_id === row.id)
        if (img && (img.jobStage !== row.stage || img.jobProgress !== row.progress)) {
          handleJobUpdate(row)
        }
      }
    }, 20000)
    return () => clearInterval(timer)
  }, [user, handleJobUpdate])

  // Assistant action protocol — the chat can EDIT the takeoff. The model
  // appends `ACTION: {json}` on its own line; we parse, validate, apply, and
  // persist through the same path as manual edits and clarification answers.
  const CHAT_ACTION_RULES = `

TAKEOFF EDITING:
When the estimator asks you to change the takeoff (fix a quantity, unit, or description; add a missed item; remove a wrong item; or note something on a line), do BOTH of these:
1. Reply with one short confirmation sentence.
2. On the FINAL line of your reply, output exactly one action as: ACTION: {"type":"update_item"|"add_item"|"remove_item"|"add_note","item_no":number|null,"description":"string|null","quantity":number|null,"unit":"string|null","category":"PIPE|STRUCTURE|FITTING|EXCAVATION|SERVICE|TESTING|OTHER|null","note":"string|null"}
Rules: reference items by their item_no from the takeoff data. For add_item, item_no is null and description+quantity+unit are required. NEVER invent a change the estimator didn't ask for. If their request is ambiguous (which item? what value?), ask a clarifying question INSTEAD of emitting an action. If they ask something that would change bid risk (excluding scope, overriding a flagged mismatch), confirm once before acting.`

  const buildTakeoffChatSystemPrompt = (res) => {
    const items = (res.items || []).map(it =>
      `#${it.item_no} [${it.category}] ${it.description} — ${it.quantity ?? '—'} ${it.unit} (${it.confidence}${it.depth_max != null ? `, depth max ${it.depth_max} ft` : ''}${it.edited ? ', estimator-edited' : ''})`
    ).join('\n')
    const clar = (res.clarifications || []).map(c =>
      `- [${c.resolution ? 'RESOLVED' : 'OPEN'}] ${c.question}`
    ).join('\n')
    const variance = (res.variance_table || []).filter(v => v.status === 'VARIANCE').map(v =>
      `- ${v.engineer_description}: engineer ${v.engineer_quantity} ${v.unit} vs ours ${v.our_quantity} (${v.pct_difference}%)`
    ).join('\n')
    const q = res.quality || {}
    return `You are the Takeoff Copilot assistant for a wet-utility estimator. A multi-pass AI takeoff has been generated for this plan set. Answer questions about it, explain how numbers were derived (plan view, profiles, engineer table, depth engine), flag risks, and make edits when asked.

TAKEOFF (${(res.items || []).length} line items):
${items || 'None'}

SUMMARY: ${res.summary?.key_observations || '—'}

DEPTH: trench safety ${res.depth_summary?.trench_safety_lf ?? 0} LF (≥5 ft); deep runs: ${(res.depth_summary?.deep_runs || []).map(r => `${r.run_id} (${r.depth_max} ft)`).join(', ') || 'none'}; depth-unavailable runs: ${(res.depth_summary?.unavailable_runs || []).map(r => r.run_id).join(', ') || 'none'}

ENGINEER VARIANCES (>5%):
${variance || 'None'}

OPEN ITEMS:
${clar || 'None'}

RUN QUALITY: ${q.failed_tiles?.length ? `${q.failed_tiles.length} sheet areas NOT analyzed (${q.failed_tiles.slice(0, 4).join('; ')}) — treat those areas as unverified. ` : ''}${res.text_layer?.mode === 'raster-only' ? 'Raster-only set (no text layer) — all reads are vision-based. ' : ''}${q.merge_degraded ? 'Overlap dedupe degraded — duplicates possible. ' : ''}

INSTRUCTIONS:
- Be direct and concrete; cite item numbers and quantities. The estimator is a utility contractor.
- When you don't know something (it isn't in the data above), say so and tell them where to verify on the plans — never guess.
- Proactively ask about OPEN items when relevant.
- 2–4 sentences per reply unless asked for a breakdown.${CHAT_ACTION_RULES}`
  }

  const buildChatSystemPrompt = (res) => {
    const questions = res.clarification_questions || []
    const misses = res.high_risk_misses || []
    const gaps = (res.scope_gaps || []).filter(s => s.status === 'MISSING')
    return `You are Takeoff Brain v2.0 operating in CHAT MODE. A QA Bid Risk Report has already been generated for this bid package. Your role is to resolve the open clarification questions by conversing with the estimator — one question at a time — so the bid can be finalized with confidence.

REPORT SUMMARY:
${res.executive_risk_summary}

CLARIFICATION QUESTIONS (${questions.length} total — work through these in order, HIGH priority first):
${questions.map((q, i) => `${i + 1}. [${q.priority}] ${q.question}${q.context ? `\n   Context: ${q.context}` : ''}`).join('\n') || 'None'}

HIGH RISK MISSES:
${misses.map(m => `- [${m.risk_level}] ${m.item}: ${m.note}`).join('\n') || 'None'}

MISSING SCOPE ITEMS:
${gaps.map(g => `- ${g.item}: ${g.note}`).join('\n') || 'None'}

CURRENT CONFIDENCE: ${res.estimator_confidence_score?.score ?? '—'}/100 (Grade ${res.estimator_confidence_score?.grade ?? '—'})

INSTRUCTIONS:
- Ask one question at a time. Do not list all questions at once.
- When the estimator answers, state whether the flag is RESOLVED or STILL FLAGGED, then immediately ask the next unanswered question.
- If an answer introduces new risk or ambiguity, ask a follow-up before moving on.
- Reference specific items from the report (quantities, depths, pipe sizes) to keep questions concrete.
- Keep each response to 2–4 sentences unless giving a final summary.
- When all questions are answered or dismissed, give a revised 2–3 sentence risk summary and an updated confidence score out of 100.
- Be direct. The estimator is a utility contractor, not a software user. Skip filler language.`
  }

  const getInitialChatMessage = (res) => {
    const questions = res.clarification_questions || []
    if (!questions.length) {
      return `Report complete — no open clarification questions. The plan set was clear enough to assess everything. Current confidence: ${res.estimator_confidence_score?.score ?? '—'}/100 (Grade ${res.estimator_confidence_score?.grade ?? '—'}). Any questions about the flags I raised?`
    }
    const first = questions.find(q => q.priority === 'HIGH') || questions[0]
    const count = questions.length
    return `Report complete. I have ${count} clarification question${count > 1 ? 's' : ''} before this bid is solid.\n\nFirst (${first.priority} priority): ${first.question}${first.context ? `\n\n${first.context}` : ''}`
  }

  const callChatApi = async (systemPrompt, messages) => {
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now()
      pendingRef.current[id] = { resolve, reject }
      workerRef.current.postMessage({ id, systemPrompt, messages, accessToken, maxTokens: 1024 })
    })
  }

  // Applies a chat-emitted action to the active takeoff. Returns a short
  // human-readable summary of what changed, or null if nothing was applied.
  const applyChatAction = (action) => {
    const res = results[activeImage]
    if (!res || !action || typeof action !== 'object') return null
    const items = res.items || []
    let newItems = items
    let summary = null

    if (action.type === 'add_item' && action.description && isFinite(Number(action.quantity))) {
      const nextNo = items.reduce((m, it) => Math.max(m, it.item_no || 0), 0) + 1
      newItems = [...items, {
        item_no: nextNo,
        category: ['PIPE', 'STRUCTURE', 'FITTING', 'EXCAVATION', 'SERVICE', 'TESTING', 'OTHER'].includes(action.category) ? action.category : 'OTHER',
        description: String(action.description).slice(0, 500),
        quantity: Number(action.quantity),
        unit: String(action.unit || 'EA').toUpperCase().slice(0, 8),
        confidence: 'HIGH',
        edited: true,
        notes: `✎ Added by estimator via assistant. ${action.note || ''}`.slice(0, 600),
      }]
      summary = `Added #${nextNo} ${action.description}`
    } else if (action.type === 'update_item' && action.item_no != null) {
      const target = items.find(it => it.item_no === action.item_no)
      if (!target) return null
      const qty = action.quantity != null && isFinite(Number(action.quantity)) ? Number(action.quantity) : null
      newItems = items.map(it => it.item_no !== action.item_no ? it : {
        ...it,
        ...(action.description ? { description: String(action.description).slice(0, 500) } : {}),
        ...(qty != null ? { quantity: qty } : {}),
        ...(action.unit ? { unit: String(action.unit).toUpperCase().slice(0, 8) } : {}),
        confidence: 'HIGH',
        edited: true,
        notes: `✎ Estimator updated via assistant${action.note ? ` — ${action.note}` : ''}. ${it.notes || ''}`.slice(0, 600),
      })
      summary = `Updated #${action.item_no}`
    } else if (action.type === 'remove_item' && action.item_no != null) {
      if (!items.some(it => it.item_no === action.item_no)) return null
      newItems = items.filter(it => it.item_no !== action.item_no)
      summary = `Removed #${action.item_no}`
    } else if (action.type === 'add_note' && action.item_no != null && action.note) {
      if (!items.some(it => it.item_no === action.item_no)) return null
      newItems = items.map(it => it.item_no !== action.item_no ? it
        : { ...it, notes: `✎ ${action.note} ${it.notes || ''}`.slice(0, 600) })
      summary = `Noted on #${action.item_no}`
    } else {
      return null
    }

    const newResult = { ...res, items: newItems }
    setResults(prev => ({ ...prev, [activeImage]: newResult }))
    persistResolvedResult(newResult)
    recordCorrections([{
      item_no: action.item_no ?? null,
      description: action.description || null,
      field: action.type === 'update_item' ? 'quantity' : action.type === 'add_item' ? 'added' : action.type === 'remove_item' ? 'removed' : 'note',
      original: null,
      corrected: action.quantity ?? action.note ?? action.description ?? null,
    }], 'chat')
    return summary
  }

  const sendChatMessage = async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return
    setChatInput('')
    const history = [...chatMessages, { role: 'user', text }]
    setChatMessages([...history, { role: 'assistant', text: null, loading: true }])
    setChatLoading(true)
    try {
      const res = results[activeImage]
      const systemPrompt = res?.executive_risk_summary
        ? buildChatSystemPrompt(res) + CHAT_ACTION_RULES
        : buildTakeoffChatSystemPrompt(res)
      const apiMessages = history.map(m => ({ role: m.role, content: m.text }))
      let reply = await callChatApi(systemPrompt, apiMessages)

      // Apply an ACTION line if the model emitted one, and replace it with a
      // visible confirmation chip in the transcript.
      let applied = null
      const actionMatch = (reply || '').match(/^ACTION:\s*(\{[\s\S]*\})\s*$/m)
      if (actionMatch) {
        try { applied = applyChatAction(JSON.parse(actionMatch[1])) } catch { applied = null }
        reply = reply.replace(actionMatch[0], '').trim()
        if (applied) reply = `${reply}\n\n✓ ${applied} — saved to the takeoff.`
        else reply = `${reply}\n\n(I couldn't apply that change — tell me the item number and exact value.)`
      }
      setChatMessages([...history, { role: 'assistant', text: reply }])
    } catch (err) {
      setChatMessages([...history, { role: 'assistant', text: `Error: ${err.message}` }])
    } finally {
      setChatLoading(false)
    }
  }

  // ── Resolve flow: one clarification at a time ─────────────────
  // The pipeline flags what it caught but couldn't pin down (a manhole with no
  // readable depth, plan/profile length disagreements, shaky big quantities).
  // The estimator answers one question at a time; answers write back into the
  // takeoff and persist, and skipped ones are marked for field verification.
  const openClarifications = (res) => (res?.clarifications || []).filter(c => !c.resolution)

  const resolveQuestionText = (c) =>
    `${c.question}${c.context ? `\n\n${c.context}` : ''}\n\n(Type your answer, or "skip" to mark it for field verification.)`

  const openResolvePanel = () => {
    setResolveOpen(true)
    if (!resolveMsgs.length) {
      const open = openClarifications(result)
      if (open.length) {
        setResolveMsgs([{
          role: 'assistant',
          text: `I caught ${open.length} item${open.length > 1 ? 's' : ''} I couldn't fully pin down — mostly depths. One at a time:\n\n${resolveQuestionText(open[0])}`,
        }])
      }
    }
  }

  const persistResolvedResult = async (newResult) => {
    const img = images[activeImage]
    const problems = []
    if (img?.job_id) {
      const { error } = await supabase.from('analysis_results').update({ result_json: newResult }).eq('job_id', img.job_id)
      if (error) problems.push(error.message)
    }
    // Scope the jobs update to ONE row — updating by project_id rewrote
    // result_json on every historical job for the project.
    let jobRowId = activeJobId
    if (!jobRowId && img?.project_id) {
      const { data: jr } = await supabase
        .from('jobs').select('id').eq('project_id', img.project_id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      jobRowId = jr?.id || null
    }
    if (jobRowId) {
      const { error } = await supabase.from('jobs').update({ result_json: newResult }).eq('id', jobRowId)
      if (error) problems.push(error.message)
    }
    if (problems.length) {
      console.warn('Resolution persist failed:', problems.join('; '))
      setError('Your answer was applied on screen but could not be saved — check your connection and answer again.')
    }
  }

  const applyResolution = (c, verdict, rawAnswer) => {
    const res = results[activeImage]
    const corrections = []
    const target = c.item_no != null ? (res.items || []).find(i => i.item_no === c.item_no) : null
    if (target && verdict.depth_ft != null) corrections.push({ item_no: c.item_no, description: target.description, field: 'depth', original: target.depth_max ?? null, corrected: verdict.depth_ft })
    if (target && verdict.quantity != null) corrections.push({ item_no: c.item_no, description: target.description, field: 'quantity', original: target.quantity ?? null, corrected: verdict.quantity })
    const newItems = (res.items || []).map(it => {
      if (c.item_no == null || it.item_no !== c.item_no) return it
      const upd = { ...it }
      if (verdict.depth_ft != null) {
        upd.depth_avg = verdict.depth_ft
        upd.depth_max = verdict.depth_ft
        upd.depth_unavailable = false
        upd.notes = `Depth ${verdict.depth_ft} ft — estimator provided. ${upd.notes || ''}`.slice(0, 600)
      }
      if (verdict.quantity != null) {
        upd.quantity = verdict.quantity
        upd.notes = `Qty ${verdict.quantity} ${upd.unit} — estimator verified. ${upd.notes || ''}`.slice(0, 600)
      }
      if (verdict.depth_ft == null && verdict.quantity == null && verdict.note) {
        upd.notes = `${verdict.note} ${upd.notes || ''}`.slice(0, 600)
      }
      return upd
    })
    // Reference equality fallback: if ids are missing, `undefined === undefined`
    // would stamp the resolution onto EVERY open clarification at once.
    const newClar = (res.clarifications || []).map(x =>
      (c.id != null ? x.id === c.id : x === c)
        ? { ...x, resolution: { status: verdict.status, answer: rawAnswer, depth_ft: verdict.depth_ft ?? null, quantity: verdict.quantity ?? null } } : x
    )
    const newResult = { ...res, items: newItems, clarifications: newClar }
    setResults(prev => ({ ...prev, [activeImage]: newResult }))
    persistResolvedResult(newResult)
    recordCorrections(corrections, 'clarification')
    return newResult
  }

  // Records estimator corrections structurally (not just in the result blob)
  // so accuracy is measurable and corrections seed future Brain rules.
  const recordCorrections = (list, source) => {
    if (!user || !list?.length) return
    const img = images[activeImage]
    const grade = screenings[activeImage]?.grade || results[activeImage]?.plan_screening?.grade || null
    const rows = list.map(c => ({
      user_id: user.id,
      project_id: img?.project_id || null,
      job_id: activeJobId || null,
      item_no: c.item_no ?? null,
      description: (c.description || '').slice(0, 300) || null,
      field: c.field,
      original_value: c.original == null ? null : String(c.original).slice(0, 200),
      corrected_value: c.corrected == null ? null : String(c.corrected).slice(0, 200),
      source,
      screening_grade: grade,
    }))
    supabase.from('corrections').insert(rows).then(({ error }) => {
      if (error) console.warn('correction log failed:', error.message)
    })
  }

  // ── Inline line-item editing ──────────────────────────────────
  // Estimator corrections write into the result, persist server-side, and are
  // marked so exports and history show what was human-verified.
  const startItemEdit = (item) => {
    setEditingItem(item.item_no)
    setEditDraft({ description: item.description, quantity: item.quantity ?? '', unit: item.unit || '' })
  }

  const saveItemEdit = (itemNo) => {
    const res = results[activeImage]
    if (!res) return
    const qty = editDraft.quantity === '' ? null : Number(editDraft.quantity)
    if (qty != null && (!isFinite(qty) || qty < 0)) {
      setError('Quantity must be a non-negative number.')
      return
    }
    const corrections = []
    const newItems = (res.items || []).map(it => {
      if (it.item_no !== itemNo) return it
      const changed = []
      const newUnit = (editDraft.unit || it.unit || '').toUpperCase().slice(0, 8)
      if (qty !== it.quantity) { changed.push(`qty ${it.quantity ?? '—'} → ${qty ?? '—'}`); corrections.push({ item_no: itemNo, description: it.description, field: 'quantity', original: it.quantity, corrected: qty }) }
      if (newUnit !== it.unit) { changed.push(`unit ${it.unit} → ${newUnit}`); corrections.push({ item_no: itemNo, description: it.description, field: 'unit', original: it.unit, corrected: newUnit }) }
      if (editDraft.description !== it.description) { changed.push('description'); corrections.push({ item_no: itemNo, description: it.description, field: 'description', original: it.description, corrected: editDraft.description }) }
      if (!changed.length) return it
      return {
        ...it,
        description: editDraft.description,
        quantity: qty,
        unit: newUnit,
        confidence: 'HIGH',
        edited: true,
        notes: `✎ Estimator edited (${changed.join(', ')}). ${it.notes || ''}`.slice(0, 600),
      }
    })
    const newResult = { ...res, items: newItems }
    setResults(prev => ({ ...prev, [activeImage]: newResult }))
    persistResolvedResult(newResult)
    recordCorrections(corrections, 'inline_edit')
    setEditingItem(null)
  }

  const sendResolveAnswer = async () => {
    const text = resolveInput.trim()
    if (!text || resolveBusy) return
    const res = results[activeImage]
    const open = openClarifications(res)
    if (!open.length) return
    const c = open[0]
    setResolveInput('')
    const history = [...resolveMsgs, { role: 'user', text }]
    setResolveMsgs([...history, { role: 'assistant', text: null, loading: true }])
    setResolveBusy(true)
    try {
      let verdict
      if (/^(skip|later|pass|n\/?a)\b/i.test(text)) {
        verdict = { status: 'skipped', note: '⏳ Pending field verify — estimator to confirm.' }
      } else {
        const item = c.item_no != null ? res.items.find(i => i.item_no === c.item_no) : null
        const sys = `You extract structured resolutions from an estimator's answer to a takeoff clarification question. Respond ONLY with JSON, no prose: {"status":"resolved"|"unclear","depth_ft":number|null,"quantity":number|null,"note":"one short sentence for the line item, or null"}. Set depth_ft or quantity ONLY when the answer clearly states the number (convert units to feet for depth). If the answer doesn't actually resolve the question, use status "unclear".`
        const reply = await callChatApi(sys, [{
          role: 'user',
          content: `QUESTION: ${c.question}\nITEM: ${JSON.stringify(item || {})}\nESTIMATOR ANSWER: ${text}`,
        }])
        const m = (reply || '').match(/\{[\s\S]*\}/)
        verdict = m ? JSON.parse(m[0]) : { status: 'unclear' }
      }

      if (verdict.status === 'unclear') {
        setResolveMsgs([...history, { role: 'assistant', text: `I couldn't pull a clear answer from that. ${c.question}\n\nA number works best — e.g. "8.5 ft" — or say "skip" to flag it for field verification.` }])
      } else {
        const newResult = applyResolution(c, verdict, text)
        const remaining = openClarifications(newResult)
        const ack = verdict.status === 'skipped'
          ? 'Flagged for field verification — it stays marked on the takeoff so it can\'t slip through.'
          : verdict.depth_ft != null
            ? `Got it — depth set to ${verdict.depth_ft} ft and noted on the line item.`
            : verdict.quantity != null
              ? `Updated — quantity set to ${verdict.quantity}.`
              : 'Noted on the line item.'
        setResolveMsgs([...history, {
          role: 'assistant',
          text: remaining.length
            ? `${ack}\n\nNext:\n\n${resolveQuestionText(remaining[0])}`
            : `${ack}\n\nThat's all of them — every open item is resolved or flagged. The takeoff is updated and saved.`,
        }])
      }
    } catch (err) {
      setResolveMsgs([...history, { role: 'assistant', text: `Error: ${err.message}` }])
    } finally {
      setResolveBusy(false)
    }
  }

  useEffect(() => { ls.set('tc_job_type', jobType) }, [jobType])
  useEffect(() => { ls.set('tc_qa_mode', qaMode ? '1' : '0') }, [qaMode])

  // Materials catalog (reference data) — fetched once, keyed by slug for thumbnails.
  useEffect(() => {
    supabase.from('materials').select('slug, name, category, image_path, spec_summary').then(({ data }) => {
      if (data) setMaterialsMap(Object.fromEntries(data.map(m => [m.slug, m])))
    })
  }, [])

  // Takeoff-credit balance. Billing is "on" only when a user_credits row exists
  // (created on first purchase); until then the server decides free vs paid, and
  // the UI just shows the balance when there is one.
  const loadCredits = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.from('user_credits').select('balance').eq('user_id', user.id).maybeSingle()
    if (data) { setCredits(data.balance); setBillingOn(true) }
  }, [user])
  useEffect(() => { loadCredits() }, [loadCredits])

  // ── Price book (bid-ready pricing) ────────────────────────────
  // A unit cost entered once auto-prices that item on every future takeoff.
  const loadPriceBook = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.from('price_book').select('key, label, unit, unit_cost').eq('user_id', user.id)
    if (data) setPriceBook(Object.fromEntries(data.map(r => [r.key, r])))
  }, [user])
  useEffect(() => { loadPriceBook() }, [loadPriceBook])

  const priceKeyOf = (item) =>
    item.material_slug ? `mat:${item.material_slug}`
      : `desc:${(item.description || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`

  const unitCostOf = (item) => priceBook[priceKeyOf(item)]?.unit_cost ?? null
  const extendedOf = (item) => {
    const c = unitCostOf(item)
    return c != null && item.quantity != null ? c * item.quantity : null
  }

  const saveUnitCost = async (item, raw) => {
    const key = priceKeyOf(item)
    const val = raw === '' ? null : Number(raw)
    if (raw !== '' && (!isFinite(val) || val < 0)) { setError('Unit cost must be a non-negative number.'); return }
    if (val == null) {
      setPriceBook(prev => { const n = { ...prev }; delete n[key]; return n })
      await supabase.from('price_book').delete().eq('user_id', user.id).eq('key', key)
      return
    }
    const row = { user_id: user.id, key, label: item.description?.slice(0, 200) || null, unit: item.unit || null, unit_cost: val }
    setPriceBook(prev => ({ ...prev, [key]: row }))
    const { error } = await supabase.from('price_book').upsert(row, { onConflict: 'user_id,key' })
    if (error) setError('Could not save that unit cost — check your connection.')
  }

  const fmtUSD = (n) => n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

  // ── Click-to-verify: jump to the sheet region an item was read from ──
  const locateItem = (item) => {
    if (!item?.region || !item?.source_sheet_id) return
    setLocate({ sheet_id: item.source_sheet_id, region: item.region, region_page: item.region_page, item_no: item.item_no })
    setActiveTab('plan')
  }

  // ── Revision diff (addendum comparison) ──────────────────────
  // Compact token matcher mirroring the server's variance matcher so a re-run
  // of a revised plan set can be compared against a prior takeoff.
  const DIFF_STOP = new Set(['prop', 'proposed', 'ex', 'existing', 'new', 'the', 'of', 'and', 'with', 'for', 'per'])
  const DIFF_SYN = { inch: 'in', inches: 'in', dia: 'in', diameter: 'in', sanitary: 'san', ss: 'san', sewer: 'swr', storm: 'stm', water: 'wtr', manhole: 'mh', hydrant: 'hyd', cleanout: 'co', linear: 'lf', ft: 'lf', feet: 'lf' }
  const diffTokens = (s) => {
    const out = new Set()
    for (let t of (s || '').toLowerCase().replace(/["']/g, ' in ').split(/[^a-z0-9.]+/)) {
      if (t.length < 2 && !/^\d$/.test(t)) continue
      t = DIFF_SYN[t] || t
      if (!DIFF_STOP.has(t)) out.add(t)
    }
    return out
  }
  const diffTakeoffs = (baseItems, newItems) => {
    const base = (baseItems || []).map(it => ({ it, tk: diffTokens(it.description) }))
    const used = new Set()
    const changed = [], added = []
    for (const n of (newItems || [])) {
      const ntk = diffTokens(n.description)
      let best = -1, bestScore = 0
      base.forEach((b, i) => {
        if (used.has(i)) return
        if (n.unit && b.it.unit && n.unit !== b.it.unit) return
        let overlap = 0; ntk.forEach(t => { if (b.tk.has(t)) overlap++ })
        const score = overlap / Math.max(ntk.size, 1)
        if (score > bestScore) { bestScore = score; best = i }
      })
      if (best >= 0 && bestScore >= 0.4) {
        used.add(best)
        const b = base[best].it
        const delta = (n.quantity ?? 0) - (b.quantity ?? 0)
        if (Math.abs(delta) > 0.5) changed.push({ description: n.description, unit: n.unit, was: b.quantity, now: n.quantity, delta })
      } else {
        added.push(n)
      }
    }
    const removed = base.filter((_, i) => !used.has(i)).map(b => b.it)
    return { changed, added, removed }
  }

  const runRevisionDiff = (baselineJob) => {
    const cur = results[activeImage]
    if (!cur?.items || !baselineJob?.result_json?.items) return
    setRevisionDiff({ baseline: baselineJob.plan_filename || 'Previous version', ...diffTakeoffs(baselineJob.result_json.items, cur.items) })
    setRevisionModal(false)
  }

  // ── Phase / area breakdown: group items by their source sheet ──
  const groupedBySheet = (items) => {
    const sheetName = (id) => {
      for (const map of Object.values(sheetMaps)) {
        const s = map.sheets?.find(x => x.id === id)
        if (s) return [s.sheet_number, s.sheet_title].filter(Boolean).join(' — ') || `Page ${s.page_number}`
      }
      return 'Unassigned'
    }
    const groups = {}
    for (const it of (items || [])) {
      const key = it.source_sheet_id || 'unassigned'
      if (!groups[key]) groups[key] = { name: sheetName(it.source_sheet_id), items: [] }
      groups[key].items.push(it)
    }
    return Object.values(groups)
  }

  // Estimate rollup for a takeoff: grand total, by-category subtotals, and how
  // many items still need a unit cost.
  const estimateFor = (res) => {
    const items = res?.items || []
    let total = 0, priced = 0, unpriced = 0
    const byCat = {}
    for (const it of items) {
      const ext = extendedOf(it)
      if (ext == null) { unpriced++; continue }
      priced++
      total += ext
      byCat[it.category] = (byCat[it.category] || 0) + ext
    }
    return { total, priced, unpriced, byCat, count: items.length }
  }

  // Handle the return trip from Stripe Checkout (?checkout=success|cancel).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get('checkout')
    if (!status) return
    window.history.replaceState({}, '', window.location.pathname)
    if (status === 'success') {
      setBillingOn(true)
      // The webhook grants the credit; poll briefly until the balance reflects it.
      let tries = 0
      const poll = setInterval(async () => {
        tries++
        const { data } = await supabase.from('user_credits').select('balance').eq('user_id', user?.id).maybeSingle()
        if (data) setCredits(data.balance)
        if ((data && data.balance > 0) || tries >= 8) clearInterval(poll)
      }, 1500)
    }
  }, [user])

  const startCheckout = async () => {
    setBuying(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ return_to: '/dashboard' }),
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout unavailable')
      window.location.href = data.url   // redirect to Stripe-hosted checkout
    } catch (err) {
      setError(`Could not start checkout: ${err.message}`)
      setBuying(false)
    }
  }

  // Skip onboarding for users who already have a Supabase profile
  useEffect(() => {
    if (!user || !showOnboarding) return
    supabase.from('profiles').select('id').eq('id', user.id).maybeSingle().then(({ data }) => {
      if (data) { localStorage.setItem('tc_onboarded', '1'); setShowOnboarding(false) }
    }).catch(() => {})
  }, [user, showOnboarding])

  const formatHistoryDate = (ts) => {
    if (!ts) return ''
    const diffDays = Math.floor((Date.now() - new Date(ts)) / 86400000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const loadHistory = useCallback(async () => {
    if (!user) return
    setHistoryLoading(true)
    const { data } = await supabase
      .from('jobs')
      .select('id, project_id, plan_filename, screening_grade, line_item_count, created_at, result_json')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(15)
    setJobHistory(data || [])
    setHistoryLoading(false)
  }, [user])

  useEffect(() => { loadHistory() }, [loadHistory])

  // Restoring a past job APPENDS to the workspace — replacing the whole array
  // used to discard any uploads still mid-triage or mid-analysis.
  const restoreJob = (job) => {
    if (!job.result_json) return
    const entry = { name: job.plan_filename || 'Past Job', preview: null, project_id: job.project_id || null, restoredJobRow: job.id }
    // Index decided from the committed state (imagesRef mirrors it) — state
    // updaters run at render time, so they can't safely assign it.
    const existing = imagesRef.current.findIndex(img => img?.restoredJobRow === job.id)
    const idx = existing !== -1 ? existing : imagesRef.current.length
    if (existing === -1) setImages(prev => [...prev, entry])
    setResults(prev => ({ ...prev, [idx]: job.result_json }))
    setScreenings(prev => job.screening_grade
      ? { ...prev, [idx]: { grade: job.screening_grade, rationale: job.result_json?.plan_screening?.grade_rationale } }
      : prev)
    setActiveImage(idx)
    setActiveTab('takeoff')
    setActiveJobId(job.id)
    // Load sheet thumbnails so Plan View works on restored jobs.
    if (job.project_id) {
      loadSheetMap(job.project_id).then(page1 => {
        if (page1) setImages(prev => prev.map((img, i) => i === idx && img ? { ...img, preview: page1 } : img))
      })
    }
  }

  const submitFeedback = async () => {
    if (!feedbackModal || !user || !feedbackRating) return
    setFeedbackSubmitting(true)
    const { error } = await supabase.from('feedback').insert({
      job_id: feedbackModal.id,
      user_id: user.id,
      rating: feedbackRating,
      comments: feedbackComments.trim() || null,
      corrections: feedbackCorrections.trim() || null,
    })
    if (!error) setFeedbackDone(prev => ({ ...prev, [feedbackModal.id]: true }))
    else setError('Feedback could not be sent — check your connection and try again.')
    setFeedbackSubmitting(false)
    setFeedbackModal(null)
    setFeedbackRating(0)
    setFeedbackComments('')
    setFeedbackCorrections('')
  }

  const finishOnboarding = (profile) => {
    ls.set('tc_onboarded', '1')
    setShowOnboarding(false)
    // Persist when ANY field was entered — the old name/company gate silently
    // discarded a phone number entered alone.
    const p = profile || {}
    if (user && (p.full_name?.trim() || p.company?.trim() || p.phone?.trim())) {
      supabase.from('profiles').upsert({
        id: user.id,
        email: user.email,
        full_name: p.full_name?.trim() || null,
        company: p.company?.trim() || null,
        phone: p.phone?.trim() || null,
      }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.warn('Profile save failed:', error.message)
      })
    }
  }

  // Uploads a PDF to the Anthropic Files API via Supabase Storage — the file
  // goes straight to Storage (100 MB limit), never through Netlify, which caps
  // request bodies and 500s on large PDFs.
  const uploadDocToFiles = async (file) => {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }

    const signRes = await fetch('/api/doc-upload', {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'sign', filename: file.name }),
    })
    if (!signRes.ok) throw new Error(`Could not get upload URL (${signRes.status})`)
    const { upload_url, storage_path } = await signRes.json()

    const putRes = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    })
    if (!putRes.ok) throw new Error(`Storage upload failed (${putRes.status})`)

    const regRes = await fetch('/api/doc-upload', {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'register', storage_path }),
    })
    if (!regRes.ok) {
      const msg = await regRes.text()
      throw new Error(`Register failed (${regRes.status}): ${msg.slice(0, 120)}`)
    }
    const { file_id } = await regRes.json()
    return file_id
  }

  const uploadSpecs = async (file) => {
    setSpecsUploading(true)
    try {
      const file_id = await uploadDocToFiles(file)
      setSpecsFileId(file_id)
      setSpecsFileName(file.name)
    } catch (err) {
      setError(`Specs upload failed: ${err.message}`)
    } finally {
      setSpecsUploading(false)
    }
  }

  const buildJobContext = () => {
    const lines = []

    if (jobType === 'public') {
      lines.push('JOB TYPE: PUBLIC — city/municipality-funded project.')
      lines.push('Apply public contracting standards:')
      lines.push('  - Flag if prevailing wage / Davis-Bacon rates are not accounted for in the bid.')
      lines.push('  - City inspector coordination is typically required — flag if not in scope.')
      lines.push('  - City standard details and uploaded project specs OVERRIDE plan callouts. Where conflicts exist, the specs govern.')
      lines.push('  - TxDOT or municipal right-of-way permit required for any work in public ROW — flag if not in scope.')
      lines.push('  - Public projects typically require bid bond, performance bond, and payment bond — note if not addressed.')
      lines.push('  - Mandatory acceptance testing (CCTV, mandrel, pressure, bacteriological) is enforced — flag any missing.')
    } else {
      lines.push('JOB TYPE: PRIVATE — private developer or property owner project. Apply standard utility sub assumptions.')
    }

    if (specsFileId) {
      lines.push(`SUPPLEMENTAL SPECS DOCUMENT UPLOADED: A ${jobType === 'public' ? 'city/project' : 'project'} specifications document has been provided as the second attached document. Cross-reference all plan items against it. Flag any conflicts where the specs require a different pipe class, bedding standard, testing frequency, or scope item than what the plans show. The specs take precedence over plan defaults.`)
    }

    const boreLabels = { wet: 'WET BORE', dry: 'DRY BORE', mixed: 'MIXED (wet and dry)', none: 'NONE', unknown: 'UNKNOWN' }
    if (boreMethod === 'wet') {
      lines.push('BORE METHOD CONFIRMED: WET BORE — do NOT include steel casing on any bore crossings. Wet bores use drilling fluid for hole stability; casing is not used.')
    } else if (boreMethod === 'dry') {
      lines.push('BORE METHOD CONFIRMED: DRY BORE — steel casing IS required on all bore crossings. Include casing as a separate line item at the correct diameter.')
    } else if (boreMethod === 'mixed') {
      lines.push('BORE METHOD: MIXED — this job has both wet and dry bores. Check each bore crossing individually for casing. The plans or notes should indicate which method applies to each crossing.')
    } else if (boreMethod === 'none') {
      lines.push('BORE METHOD: NO BORE CROSSINGS — the estimator has confirmed there are no bore crossings on this job. Do not flag missing casing.')
    } else {
      lines.push('BORE METHOD: NOT CONFIRMED — if bore crossings appear on the plans, flag them and ask the estimator to confirm wet vs. dry method before pricing casing.')
    }

    if (scopeNotes.trim()) {
      lines.push(`SCOPE NOTES (confirmed by estimator): ${scopeNotes.trim()}`)
      lines.push('Apply these scope notes when identifying misses — do not flag items the estimator has confirmed are excluded from their scope.')
    }

    return `\nJOB CONTEXT (confirmed by estimator before analysis):\n${lines.join('\n')}\n\n---\n\n`
  }

  const handleFileUpload = useCallback(async (e) => {
    const files = Array.from(e.target.files)
    e.target.value = ''
    await processFiles(files)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const processFiles = useCallback(async (files) => {
    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      if (isPdf) {
        const tempId = Math.random().toString(36).slice(2)
        setImages(prev => [...prev, { name: file.name, mediaType: 'application/pdf', preview: null, uploading: true, tempId }])
        try {
          const { data: { session } } = await supabase.auth.getSession()
          const token = session?.access_token

          // Step 1: Get signed upload URL + create DB records
          const urlRes = await fetch('/api/get-upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ filename: file.name }),
          })
          if (!urlRes.ok) {
            const msg = await urlRes.text()
            throw new Error(`Could not get upload URL (${urlRes.status}): ${msg.slice(0, 120)}`)
          }
          const { upload_url, storage_path, project_id, sheet_id, job_id } = await urlRes.json()

          // Step 2: Upload directly to Supabase Storage (no server hop — fast)
          const putRes = await fetch(upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/pdf' },
            body: file,
          })
          if (!putRes.ok) throw new Error(`Storage upload failed (${putRes.status})`)

          // Step 3: Confirm upload → kicks off background processing. An
          // unchecked failure here left the sidebar at "Processing 10%" forever.
          const confirmRes = await fetch('/api/confirm-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ job_id, sheet_id, storage_path, project_id }),
          })
          if (!confirmRes.ok) {
            const msg = await confirmRes.text()
            throw new Error(`Processing could not start (${confirmRes.status}): ${msg.slice(0, 120)}`)
          }

          // Step 4: Update image state — Realtime will fill in file_id + preview when ready
          setImages(prev => prev.map(img =>
            img?.tempId === tempId
              ? {
                  name: file.name,
                  mediaType: 'application/pdf',
                  preview: null,
                  file_id: null,
                  project_id,
                  sheet_id,
                  job_id,
                  jobStage: 'uploaded',
                  jobProgress: 10,
                }
              : img
          ))
        } catch (err) {
          setImages(prev => prev.filter(img => img?.tempId !== tempId))
          setError(`Failed to upload ${file.name}: ${err.message}`)
        }
      } else {
        const reader = new FileReader()
        reader.onload = (ev) => {
          const base64 = ev.target.result.split(',')[1]
          setImages(prev => [...prev, {
            name: file.name,
            base64,
            mediaType: file.type || 'image/png',
            preview: ev.target.result,
          }])
        }
        reader.readAsDataURL(file)
      }
    }
  }, [])

  // Renames a project — updates the server row and the sidebar entry.
  const renameProject = async (idx) => {
    const img = images[idx]
    if (!img) return
    const name = window.prompt('Project name:', img.name || '')
    if (!name?.trim() || name.trim() === img.name) return
    const clean = name.trim().slice(0, 120)
    setImages(prev => prev.map((im, i) => (i === idx && im ? { ...im, name: clean } : im)))
    if (img.project_id) {
      const { error } = await supabase.from('projects').update({ name: clean }).eq('id', img.project_id)
      if (!error) loadHistory()
    }
  }

  // Removal TOMBSTONES the slot instead of filtering the array. results and
  // screenings are keyed by index, and Realtime/analyzeAll handlers hold
  // captured indices — shifting the array after a removal re-labeled every
  // later sheet's takeoff with the wrong plan's numbers.
  // Server-side projects are actually DELETED (plans, thumbnails, line items) —
  // the old behavior only hid them locally and orphaned the storage forever.
  const removeImage = async (idx) => {
    const img = images[idx]
    if (img?.project_id && !img.restoredJobRow) {
      const sure = window.confirm(`Delete "${img.name}" and its uploaded plan files? Completed reports stay available under Recent Jobs.`)
      if (!sure) return
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch('/api/delete-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ project_id: img.project_id }),
        })
        if (!res.ok) throw new Error(`delete failed (${res.status})`)
      } catch (err) {
        setError(`Could not delete the project on the server: ${err.message}. It was removed from this workspace only.`)
      }
    }
    setImages(prev => prev.map((im, i) => (i === idx ? null : im)))
    const newResults = { ...results }
    delete newResults[idx]
    setResults(newResults)
    const newScreenings = { ...screenings }
    delete newScreenings[idx]
    setScreenings(newScreenings)
    if (activeImage === idx) {
      const remaining = imagesRef.current.map((img, i) => (img && i !== idx ? i : null)).filter(v => v != null)
      setActiveImage(remaining.length ? remaining[remaining.length - 1] : 0)
    }
  }

  const callApi = async (img, prompt, maxTokens = 4096, systemPrompt = undefined) => {
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token

    if (img.file_id) {
      // PDF already uploaded — reference by file_id (no base64 transfer)
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2) + Date.now()
        pendingRef.current[id] = { resolve, reject }
        workerRef.current.postMessage({ id, file_id: img.file_id, specs_file_id: specsFileId || undefined, prompt, systemPrompt, accessToken, maxTokens })
      })
    }

    // Image: resize if needed, then send as base64
    let base64Data = img.base64
    let mType = img.mediaType

    if (base64Data && base64Data.length > 5 * 1024 * 1024) {
      const resizeCanvas = document.createElement('canvas')
      const resizeCtx = resizeCanvas.getContext('2d')
      const tempImg = new Image()
      await new Promise((resolve, reject) => {
        tempImg.onload = resolve
        tempImg.onerror = reject
        tempImg.src = img.preview
      })
      const maxDim = 2000
      let w = tempImg.width, h = tempImg.height
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h)
        w = Math.round(w * ratio)
        h = Math.round(h * ratio)
      }
      resizeCanvas.width = w
      resizeCanvas.height = h
      resizeCtx.drawImage(tempImg, 0, 0, w, h)
      const resizedUrl = resizeCanvas.toDataURL('image/jpeg', 0.85)
      base64Data = resizedUrl.split(',')[1]
      mType = 'image/jpeg'
    }

    const fileBlock = { type: 'image', source: { type: 'base64', media_type: mType, data: base64Data } }

    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now()
      pendingRef.current[id] = { resolve, reject }
      workerRef.current.postMessage({ id, fileBlock, specs_file_id: specsFileId || undefined, prompt, systemPrompt, accessToken, maxTokens })
    })
  }

  const processGeotech = async (file) => {
    setGeotechLoading(true)
    setGeotechError(null)
    setGeotechFileName(file.name)
    setGeotechResult(null)
    try {
      const file_id = await uploadDocToFiles(file)
      const result = await callApi(
        { file_id, name: file.name, mediaType: 'application/pdf' },
        GEOTECH_PROMPT + '\n\nExtract all geotechnical data from this report. Respond ONLY with the JSON object, no other text.',
        2048
      )
      setGeotechResult(result)
    } catch (err) {
      console.error('Geotech error:', err)
      setGeotechError(err.message)
    } finally {
      setGeotechLoading(false)
    }
  }

  const handleGeotechUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    processGeotech(file)
  }

  // Compare tab: fill the paste box from an uploaded CSV/Excel takeoff.
  const handleCompareUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    setCompareParsing(true)
    try {
      const rows = await parseTakeoffFile(file)
      setComparisonData(rows.map(r => `${r.description}, ${r.unit || '—'}, ${r.quantity}`).join('\n'))
    } catch (err) {
      setError(`Could not read takeoff file: ${err.message}`)
    } finally {
      setCompareParsing(false)
    }
  }

  const handleTakeoffUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    setUploadedTakeoffName(file.name)
    setTakeoffParsing(true)
    try {
      const rows = await parseTakeoffFile(file)
      setUploadedTakeoffData(rows)
      if (rows.dropped > 0) {
        setError(`${rows.length} takeoff rows parsed — ${rows.dropped} row${rows.dropped === 1 ? '' : 's'} had unreadable quantities and were skipped. The QA comparison covers only the parsed rows.`)
      }
    } catch (err) {
      console.error('Takeoff parse error:', err)
      setError(`Could not read takeoff: ${err.message}`)
      setUploadedTakeoffData(null)
      setUploadedTakeoffName(null)
    } finally {
      setTakeoffParsing(false)
    }
  }

  const geotechCrossRef = (geo, takeoffResults) => {
    const flags = []
    const allItems = Object.values(takeoffResults).flatMap(r => r?.items || [])
    const descriptions = allItems.map(i => (i.description + ' ' + (i.notes || '')).toLowerCase())
    const hasItem = (...keywords) => descriptions.some(d => keywords.some(k => d.includes(k)))

    const { flags: f, summary: s } = geo
    if (!f) return flags

    if (f.dewatering_required) {
      const inScope = hasItem('dewat')
      flags.push({ severity: inScope ? 'OK' : 'MISS', label: 'Dewatering', note: f.dewatering_note || `Groundwater at ${s?.shallowest_groundwater_ft ?? '?'} ft`, inScope })
    }
    if (f.lime_stabilization_required) {
      const inScope = hasItem('lime', 'stabiliz')
      flags.push({ severity: inScope ? 'OK' : 'MISS', label: 'Lime Stabilization', note: f.lime_note || 'High-PI soils require subgrade treatment', inScope })
    }
    if (f.rock_excavation_required) {
      const inScope = hasItem('rock', 'drill', 'blast', 'chip')
      flags.push({ severity: inScope ? 'OK' : 'MISS', label: 'Rock Excavation', note: f.rock_note || `Rock at ${s?.shallowest_rock_ft ?? '?'} ft`, inScope })
    }
    if (f.select_fill_required) {
      const inScope = hasItem('select fill', 'import', 'select backfill', 'borrow')
      flags.push({ severity: inScope ? 'OK' : 'MISS', label: 'Imported Select Fill', note: f.select_fill_note || 'Native soils unsuitable for backfill', inScope })
    }
    if (f.spoil_removal_required) {
      const inScope = hasItem('spoil', 'haul', 'disposal', 'truck')
      flags.push({ severity: inScope ? 'OK' : 'MISS', label: 'Spoil Removal / Haul-Off', note: f.spoil_note || 'Unsuitable native soil must be hauled off site', inScope })
    }
    ;(f.other_flags || []).forEach(({ item, note }) => {
      flags.push({ severity: 'INFO', label: item, note, inScope: null })
    })
    return flags
  }

  const screenSheet = async (idx) => {
    const img = images[idx]
    if (!img || img.uploading) return
    setScreeningSheet(idx)
    setError(null)

    try {
      const parsed = await callApi(img, SCREENING_PROMPT + '\n\nGrade this construction plan sheet. Respond ONLY with the JSON object, no other text.', 512)
      const screening = parsed.plan_screening || parsed
      setScreenings(prev => ({ ...prev, [idx]: screening }))
      setScreeningSheet(null)

      if (screening.grade !== 'C') {
        // Pass the screening directly — the `screenings` state in this closure
        // is still pre-update, which used to log null grades to job history.
        await analyzeSheet(idx, screening)
      }
    } catch (err) {
      console.error('Screening error:', err)
      setError(`Screening failed for sheet ${idx + 1}: ${err.message}`)
    } finally {
      setScreeningSheet(null)
    }
  }

  const analyzeSheet = async (idx, screeningOverride = null) => {
    const img = images[idx]
    if (!img || img.uploading) return
    // PDFs are analyzed by the server-side multi-pass pipeline — the single-call
    // path has no pixels to send for them (file_id-less PDFs produced a
    // guaranteed-failing request with an undefined image payload).
    if (img.mediaType === 'application/pdf' && !img.file_id && !img.base64) {
      setError('This plan set runs through the multi-pass pipeline — use the sheet map and "Proceed with N sheets".')
      return
    }
    setLoading(true)
    setLoadingSheet(idx)
    setError(null)

    try {
      const jobCtx = buildJobContext()
      // System-grade instructions ride the API's system param (via callApi's
      // systemPrompt) — sharing the user turn with untrusted plan/takeoff
      // content let document text override the instructions.
      let systemPrompt, prompt
      if (qaMode && uploadedTakeoffData) {
        systemPrompt = QA_SYSTEM_PROMPT + jobCtx
        prompt = `ESTIMATOR'S SUBMITTED TAKEOFF (${uploadedTakeoffName}):\n` +
          JSON.stringify(uploadedTakeoffData, null, 2) +
          `\n\n---\n\nReview the plan sheet above against the estimator's takeoff. Produce the full Bid Risk Report. Respond ONLY with the JSON object, no other text.`
      } else if (qaMode) {
        systemPrompt = QA_SYSTEM_PROMPT + jobCtx
        prompt = `No estimator takeoff was uploaded. Read the plan sheet and produce the Bid Risk Report based on plan review alone. Flag all scope gaps and items an estimator should not miss. Respond ONLY with the JSON object, no other text.`
      } else {
        systemPrompt = SYSTEM_PROMPT + jobCtx
        prompt = `Analyze this construction plan sheet and produce a complete quantity takeoff. Extract every identifiable item. Be thorough but honest about confidence levels. Respond ONLY with the JSON object, no other text.`
      }

      // 8192 tokens — the full takeoff schema on a busy sheet overflows 4096
      // and died with "Could not parse response as JSON".
      const parsed = await callApi(img, prompt, 8192, systemPrompt)
      if (!parsed || typeof parsed !== 'object' || (!Array.isArray(parsed.items) && !parsed.estimator_confidence_score && !parsed.quantity_items_to_recheck)) {
        throw new Error('The AI response was not a recognizable report — try again.')
      }
      setResults(prev => ({ ...prev, [idx]: parsed }))
      setActiveImage(idx)
      setActiveTab(qaMode ? 'report' : 'takeoff')

      // In QA mode, open the proactive chat with the first clarification question
      if (qaMode && parsed?.clarification_questions !== undefined) {
        setChatMessages([{ role: 'assistant', text: getInitialChatMessage(parsed) }])
        setChatOpen(true)
      }

      // Fire-and-forget: log the completed job to Supabase for beta tracking
      if (user) {
        const rm = parsed?.risk_and_misses || {}
        // Count fields the prompts actually emit — the old reads
        // (geotech_concerns/missed_items/bid_risk_items, screening.rationale)
        // don't exist in any schema, so grades and risk counts logged null/0.
        const riskCount = qaMode
          ? (parsed?.high_risk_misses?.length || 0) + (parsed?.scope_gaps?.filter(s => s.status === 'MISSING').length || 0)
          : (rm.scope_gaps?.filter(s => s.status === 'MISSING' || s.status === 'PARTIAL').length || 0) +
            (typeof rm.top_risks === 'string' && rm.top_risks.trim() ? 1 : 0) +
            (rm.geotech?.geotech_flags ? 1 : 0)
        const screening = screeningOverride || screenings[idx] || parsed?.plan_screening || null
        supabase.from('jobs').insert({
          user_id: user.id,
          plan_filename: images[idx]?.name || null,
          geotech_filename: geotechFileName || null,
          screening_grade: screening?.grade || null,
          screening_rationale: screening?.grade_rationale || screening?.rationale || null,
          line_item_count: qaMode ? (parsed?.high_risk_misses?.length || 0) : (parsed?.items?.length || 0),
          risk_flag_count: riskCount,
          result_json: parsed,
        }).select('id').then(({ data, error }) => {
          if (error) { console.warn('Job log failed:', error.message); return }
          if (data?.[0]?.id) setActiveJobId(data[0].id)
          loadHistory()
        })
      }
    } catch (err) {
      console.error('Analysis error:', err)
      setError(`Sheet ${idx + 1}: ${err.message}`)
    } finally {
      setLoading(false)
      setLoadingSheet(null)
    }
  }

  const analyzeAll = async () => {
    setProcessingAll(true)
    for (let i = 0; i < imagesRef.current.length; i++) {
      if (imagesRef.current[i] && !results[i]) await analyzeSheet(i)
    }
    setProcessingAll(false)
  }

  // ── Exports: hardened module (utils/exporters.js) ────────────
  // CSV cells are quote+formula-injection safe, XLSX is a real workbook, and
  // "PDF" prints through a hidden iframe — no popups, no CDN fonts.
  const exportMeta = (idx = activeImage) => {
    const res = results[idx]
    const sc = screenings[idx] || res?.plan_screening
    return {
      filename: images[idx]?.name || 'takeoff',
      gradeLabel: sc ? `${sc.grade}${sc.grade_label ? ` — ${sc.grade_label}` : ''}` : null,
      gradeRationale: sc?.grade_rationale || sc?.rationale || null,
    }
  }

  const exportCSV = (allSheets = false) => {
    if (allSheets) {
      const combined = { items: [] }
      Object.entries(results).forEach(([idx, res]) => {
        (res?.items || []).forEach(item => combined.items.push({
          ...item,
          description: `[${images[+idx]?.name || `Sheet ${+idx + 1}`}] ${item.description}`,
        }))
      })
      if (!combined.items.length) { setError('No takeoff line items to export yet.'); return }
      exportTakeoffCSV(combined, { ...exportMeta(), filename: 'all_sheets' })
      return
    }
    const res = results[activeImage]
    if (res?.items?.length) exportTakeoffCSV(res, exportMeta())
    else if (res) exportQACSV(res, exportMeta())
    else setError('Nothing to export for this sheet yet.')
  }

  const exportExcel = () => {
    const res = results[activeImage]
    if (!res) { setError('Nothing to export for this sheet yet.'); return }
    exportXLSX(res, exportMeta())
  }

  const exportPDF = () => {
    const res = results[activeImage]
    if (!res) return
    printReport(buildTakeoffReportHTML(res, exportMeta()))
  }

  const exportQAPDF = () => {
    const res = results[activeImage]
    if (!res?.executive_risk_summary) return
    printReport(buildQAReportHTML(res, exportMeta()))
  }

  // ── Sheet triage helpers ─────────────────────────────────────
  const TRIAGE_ANALYSIS_TYPES = new Set(['utility_plan', 'plan_profile', 'storm', 'sanitary', 'water', 'details', 'unclassified'])

  const formatClassification = (cls) => {
    const labels = {
      cover: 'Cover', sheet_index: 'Sheet Index', general_notes: 'Gen. Notes',
      demo: 'Demo', grading: 'Grading', paving: 'Paving',
      utility_plan: 'Utility Plan', plan_profile: 'Plan-Profile',
      storm: 'Storm', sanitary: 'Sanitary', water: 'Water',
      details: 'Details', erosion_control: 'Erosion Ctrl',
      landscape: 'Landscape', electrical: 'Electrical', other: 'Other',
      unclassified: 'Unclassified',
    }
    return labels[cls] || cls || 'Unknown'
  }

  const toggleSheetAnalysis = async (projectId, sheetId, currentValue) => {
    const newValue = !currentValue
    setSheetMaps(prev => ({
      ...prev,
      [projectId]: {
        ...prev[projectId],
        sheets: prev[projectId].sheets.map(s =>
          s.id === sheetId ? { ...s, included_in_analysis: newValue } : s
        ),
      },
    }))
    await supabase.from('sheets').update({ included_in_analysis: newValue }).eq('id', sheetId)
  }

  // Kicks off the server-side tiled multi-pass analysis pipeline.
  // Progress flows back through the processing_jobs Realtime subscription.
  const proceedWithAnalysis = async (projectId, imgIdx) => {
    const map = sheetMaps[projectId]
    if (!map?.loaded) return
    setProceedingAnalysis(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      // If a geotech report is loaded, pass rock/groundwater depths so the depth
      // engine can cross-reference run depths against them.
      let geotech = null
      if (geotechResult) {
        const gs = geotechResult.summary || {}
        const rock = gs.rock_encountered ? gs.shallowest_rock_ft : null
        const gw = gs.shallowest_groundwater_ft
        if (rock != null || gw != null) {
          geotech = {
            rock_depth_ft: rock ?? null,
            groundwater_depth_ft: gw ?? null,
            summary: geotechFileName || 'Geotech report',
          }
        }
      }
      const res = await fetch('/api/start-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ project_id: projectId, geotech }),
      })
      // 402 → out of takeoff credits. Open the paywall instead of erroring.
      if (res.status === 402) {
        setBillingOn(true)
        setCredits(0)
        setPaywall({ projectId, imgIdx })
        return
      }
      if (!res.ok) {
        let msg = `start-analysis failed (${res.status})`
        try { const j = await res.json(); if (j.error) msg = j.error } catch { /* text */ }
        throw new Error(msg)
      }
      const { job_id } = await res.json()
      loadCredits()   // a credit may have been spent — refresh the badge
      setImages(prev => prev.map((img, i) =>
        i === imgIdx
          ? { ...img, job_id, jobStage: 'analysis_queued', jobProgress: 0, jobDetail: 'Queued for analysis', jobError: null }
          : img
      ))
    } catch (err) {
      setError(`Could not start analysis: ${err.message}`)
    } finally {
      setProceedingAnalysis(false)
    }
  }

  const ANALYSIS_PASSES = [
    ['analysis_pass_1', 'Plan quantities', 'Opus extracts every pipe, structure, fitting, valve, hydrant, and service from plan-view tiles'],
    ['analysis_pass_2', 'Profiles', 'Reads rim/invert elevations, slopes, and run lengths from plan-profile sheets'],
    ['analysis_pass_3', 'Merge + reconcile', 'Dedupes tile overlap zones; plan vs profile length mismatches >5% get flagged, never averaged'],
    ['analysis_pass_4', 'Small-diameter sweep', 'Dedicated pass for 2" and smaller lines — domestic services, irrigation taps, small fire lines'],
    ['analysis_pass_5', 'Engineer table check', 'Parses engineer quantity tables and builds a variance comparison'],
  ]

  // Re-runs a failed server-side pipeline job — triage errors re-fire
  // confirm-upload; analysis errors start a fresh analysis run.
  const retryPipeline = async (idx) => {
    const img = images[idx]
    if (!img?.project_id) return
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }
      let kind = 'plan_processing'
      if (img.job_id) {
        const { data: jobRow } = await supabase.from('processing_jobs').select('kind').eq('id', img.job_id).maybeSingle()
        kind = jobRow?.kind || kind
      }
      if (kind === 'analysis') {
        const res = await fetch('/api/start-analysis', { method: 'POST', headers, body: JSON.stringify({ project_id: img.project_id }) })
        if (!res.ok) throw new Error((await res.text()).slice(0, 160))
        const { job_id } = await res.json()
        setImages(prev => prev.map((im, i) => i === idx && im ? { ...im, job_id, jobStage: 'analysis_queued', jobProgress: 0, jobError: null, jobDetail: 'Queued for analysis' } : im))
      } else {
        let sheetId = img.sheet_id
        if (!sheetId) {
          const { data: sheet } = await supabase.from('sheets').select('id').eq('project_id', img.project_id).eq('page_number', 1).maybeSingle()
          sheetId = sheet?.id
        }
        if (!sheetId || !img.job_id) throw new Error('Could not find the uploaded plan to retry — re-upload the PDF')
        const res = await fetch('/api/confirm-upload', { method: 'POST', headers, body: JSON.stringify({ job_id: img.job_id, sheet_id: sheetId, project_id: img.project_id }) })
        if (!res.ok) throw new Error((await res.text()).slice(0, 160))
        setImages(prev => prev.map((im, i) => i === idx && im ? { ...im, jobStage: 'uploaded', jobProgress: 10, jobError: null } : im))
      }
    } catch (err) {
      setError(`Retry failed: ${err.message}`)
    }
  }

  const result = results[activeImage]
  const isQAResult = !!(result && result.executive_risk_summary)
  const analyzedCount = Object.keys(results).length
  const sheetCount = images.filter(Boolean).length

  const confidenceColor = (level) => {
    if (level === 'HIGH') return 'badge-high'
    if (level === 'MEDIUM') return 'badge-medium'
    return 'badge-low'
  }

  const categoryIcon = (cat) => {
    const icons = { PIPE: '║', STRUCTURE: '◆', FITTING: '◎', EXCAVATION: '▽', SERVICE: '→', TESTING: '✓', OTHER: '•' }
    return icons[cat] || '•'
  }

  return (
    <div className="dashboard">
      {/* MATERIAL CARD MODAL */}
      {materialCard && materialsMap[materialCard] && (() => {
        const mat = materialsMap[materialCard]
        const usedBy = (result?.items || []).filter(it => it.material_slug === materialCard)
        return (
          <div className="modal-overlay" onClick={() => setMaterialCard(null)}>
            <div className="modal card material-card" onClick={e => e.stopPropagation()}>
              <button className="material-card-close" onClick={() => setMaterialCard(null)}><X size={16} /></button>
              <div className="material-card-head">
                <img src={mat.image_path} className="material-card-img" alt={mat.name} />
                <div>
                  <div className="material-card-cat">{mat.category}</div>
                  <div className="material-card-name">{mat.name}</div>
                  <div className="material-card-spec">{mat.spec_summary}</div>
                </div>
              </div>
              <div className="material-card-usage-label">
                On this job — {usedBy.length} line item{usedBy.length === 1 ? '' : 's'}
              </div>
              <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
                <table className="titan-table">
                  <thead><tr>{['Description', 'Qty', 'Unit', 'Conf'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {usedBy.map((it, i) => (
                      <tr key={i}>
                        <td style={{ maxWidth: 360 }}>{it.description}</td>
                        <td className="text-mono" style={{ fontWeight: 600 }}>{it.quantity}</td>
                        <td className="text-mono text-dim">{it.unit}</td>
                        <td><span className={`badge ${confidenceColor(it.confidence)}`}>{it.confidence}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="material-card-note">Placeholder illustration — swap <code>{mat.image_path}</code> for a product photo anytime.</div>
            </div>
          </div>
        )
      })()}

      {/* ONBOARDING SEQUENCE */}
      <OnboardingFlow
        open={showOnboarding}
        initialProfile={{ full_name: onboardName, company: onboardCompany, phone: onboardPhone }}
        onComplete={(profile) => {
          setOnboardName(profile.full_name || '')
          setOnboardCompany(profile.company || '')
          setOnboardPhone(profile.phone || '')
          finishOnboarding(profile)
        }}
        onSkip={() => finishOnboarding(null)}
      />

      {/* REFERENCE BANK (help slide-over) */}
      <ReferenceBank open={referenceOpen} onClose={() => setReferenceOpen(false)} />

      {/* REVISION DIFF — pick a prior takeoff to compare this one against */}
      {revisionModal && (
        <div className="modal-overlay" onClick={() => setRevisionModal(false)}>
          <div className="modal card" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <button className="material-card-close" onClick={() => setRevisionModal(false)}><X size={16} /></button>
            <h3 style={{ marginBottom: 6 }}>Compare to a previous version</h3>
            <p className="text-dim" style={{ fontSize: '0.82rem', lineHeight: 1.5, marginBottom: 14 }}>
              Pick an earlier takeoff to see what changed — added, removed, and quantity deltas. Re-upload the revised plan set, run it, then diff it against the prior revision to catch a moved storm line or a resized main.
            </p>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {jobHistory.filter(j => j.id !== activeJobId && j.result_json?.items).length === 0 ? (
                <div className="text-dim" style={{ fontSize: '0.82rem', padding: 12 }}>No earlier takeoffs to compare against yet.</div>
              ) : jobHistory.filter(j => j.id !== activeJobId && j.result_json?.items).map(j => (
                <button key={j.id} className="btn btn-secondary" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 6, textAlign: 'left' }} onClick={() => runRevisionDiff(j)}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.plan_filename || 'Untitled'}</span>
                  <span className="text-dim" style={{ fontSize: '0.72rem' }}>{j.line_item_count || j.result_json.items.length} items · {formatHistoryDate(j.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* REVISION DIFF RESULTS */}
      {revisionDiff && (
        <div className="modal-overlay" onClick={() => setRevisionDiff(null)}>
          <div className="modal card" style={{ maxWidth: 720, maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <button className="material-card-close" onClick={() => setRevisionDiff(null)}><X size={16} /></button>
            <h3 style={{ marginBottom: 4 }}>Revision diff</h3>
            <p className="text-dim" style={{ fontSize: '0.8rem', marginBottom: 16 }}>
              This takeoff vs <strong>{revisionDiff.baseline}</strong> — {revisionDiff.added.length} added, {revisionDiff.removed.length} removed, {revisionDiff.changed.length} changed.
            </p>
            {revisionDiff.changed.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div className="titan-label" style={{ color: 'var(--flag-medium)', marginBottom: 6 }}>Changed quantities</div>
                <table className="titan-table" style={{ fontSize: '0.78rem' }}>
                  <thead><tr>{['Item', 'Was', 'Now', 'Δ'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {revisionDiff.changed.map((c, i) => (
                      <tr key={i}>
                        <td style={{ maxWidth: 340 }}>{c.description}</td>
                        <td className="text-mono text-dim">{c.was ?? '—'} {c.unit}</td>
                        <td className="text-mono" style={{ fontWeight: 600 }}>{c.now ?? '—'} {c.unit}</td>
                        <td className="text-mono" style={{ color: c.delta > 0 ? 'var(--flag-high)' : 'var(--flag-low)', fontWeight: 600 }}>{c.delta > 0 ? '+' : ''}{Math.round(c.delta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {revisionDiff.added.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div className="titan-label" style={{ color: 'var(--flag-high)', marginBottom: 6 }}>Added in this version ({revisionDiff.added.length})</div>
                {revisionDiff.added.map((a, i) => <div key={i} style={{ fontSize: '0.8rem', padding: '3px 0' }}>+ {a.description} — <span className="text-mono">{a.quantity} {a.unit}</span></div>)}
              </div>
            )}
            {revisionDiff.removed.length > 0 && (
              <div>
                <div className="titan-label" style={{ color: 'var(--flag-low)', marginBottom: 6 }}>Removed since {revisionDiff.baseline} ({revisionDiff.removed.length})</div>
                {revisionDiff.removed.map((r, i) => <div key={i} style={{ fontSize: '0.8rem', padding: '3px 0' }}>− {r.description} — <span className="text-mono">{r.quantity} {r.unit}</span></div>)}
              </div>
            )}
            {!revisionDiff.changed.length && !revisionDiff.added.length && !revisionDiff.removed.length && (
              <p className="text-dim">No differences detected between the two takeoffs.</p>
            )}
          </div>
        </div>
      )}

      {/* PAYWALL — one takeoff = $97, charged once per plan set */}
      {paywall && (
        <div className="modal-overlay" onClick={() => setPaywall(null)}>
          <div className="modal card" style={{ maxWidth: 460, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
            <button className="material-card-close" onClick={() => setPaywall(null)}><X size={16} /></button>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '2.4rem', color: 'var(--titan-red)', lineHeight: 1 }}>$97</div>
            <div className="titan-label" style={{ marginTop: 4 }}>Per takeoff // one plan set</div>
            <h3 style={{ marginTop: 14, marginBottom: 8 }}>Run the full takeoff</h3>
            <p className="text-dim" style={{ fontSize: '0.85rem', lineHeight: 1.6, marginBottom: 8 }}>
              You've reviewed the sheet map for free. Unlock the complete multi-pass
              analysis for this plan set — every pipe, structure, depth, trench-safety
              LF, engineer-table variance, and the exportable report.
            </p>
            <p className="text-dim" style={{ fontSize: '0.78rem', lineHeight: 1.6, marginBottom: 18 }}>
              One-time charge. Re-runs, edits, and exports of this same plan set are included —
              you only pay again for a <em>new</em> plan set. Your account and past takeoffs are always free.
            </p>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={buying} onClick={startCheckout}>
              {buying ? 'Opening checkout…' : 'Buy this takeoff — $97'}
            </button>
            <button className="btn btn-ghost" style={{ marginTop: 8, fontSize: '0.78rem' }} onClick={() => setPaywall(null)}>
              Maybe later
            </button>
            <p className="text-muted" style={{ fontSize: '0.68rem', marginTop: 12 }}>
              Secure checkout by Stripe. Need volume pricing? <a href="mailto:hello@6signal.co" style={{ color: 'var(--titan-red)' }}>Contact us</a>.
            </p>
          </div>
        </div>
      )}

      {/* AI-HAS-QUESTIONS POPUP — surfaces pipeline clarifications loudly */}
      {clarifyPrompt && (
        <div className="modal-overlay" onClick={() => setClarifyPrompt(null)}>
          <div className="modal card" style={{ maxWidth: 460, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
            <div style={{
              width: 48, height: 48, margin: '0 auto 14px', borderRadius: '50%',
              background: 'var(--titan-red-glow)', border: '1px solid var(--titan-red)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--titan-red)',
            }}>
              <HelpCircle size={24} />
            </div>
            <h3 style={{ marginBottom: 8 }}>The AI has {clarifyPrompt.count} question{clarifyPrompt.count === 1 ? '' : 's'}</h3>
            <p className="text-dim" style={{ fontSize: '0.85rem', lineHeight: 1.6, marginBottom: 18 }}>
              Your takeoff is ready, but a few things couldn't be pinned down from the plans —
              depths, mismatched lengths, or low-confidence quantities. Answering them
              tightens the takeoff before you price it.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={() => setClarifyPrompt(null)}>Later</button>
              <button
                className="btn btn-primary"
                onClick={() => { setClarifyPrompt(null); openResolvePanel() }}
              >Answer Now</button>
            </div>
          </div>
        </div>
      )}


      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-header">
          {/* Hidden on the empty state — the main-panel CTA is the single upload
              entry point there; this appears once a plan set is loaded. */}
          {sheetCount > 0 && (
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} /> Upload Sheets
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.pdf,application/pdf" multiple onChange={handleFileUpload} style={{ display: 'none' }} />

          {sheetCount > 1 && (
            <button className="btn btn-secondary" style={{ width: '100%', marginTop: 6 }} onClick={analyzeAll} disabled={processingAll || loading}>
              {processingAll ? 'Processing...' : 'Analyze All'}
            </button>
          )}
        </div>

        <div className="sidebar-sheets">
          {sheetCount === 0 && (
            <div className="sidebar-empty">
              <FileText size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
              <span>Upload PDF or image<br/>plan sheets to begin</span>
            </div>
          )}
          {images.map((img, i) => img && (
            <div key={i} className={`sheet-item ${activeImage === i ? 'active' : ''}`} onClick={() => setActiveImage(i)}>
              <img src={img.preview} alt="" className="sheet-thumb" />
              <div className="sheet-info">
                <div className="sheet-name">{img.name}</div>
                <div className="sheet-status">
                  {img.uploading ? (
                    <span className="text-dim">Uploading...</span>
                  ) : img.jobStage === 'triage_complete' ? (
                    <span className="text-green">
                      ✓ {sheetMaps[img.project_id]?.sheets?.length || 0} sheets classified
                    </span>
                  ) : img.jobStage === 'error' ? (
                    <span className="text-red" title={img.jobError}>
                      ⚠ {(img.jobError || 'Processing error').slice(0, 60)}
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: '0.62rem', padding: '1px 6px', marginLeft: 6 }}
                        onClick={(e) => { e.stopPropagation(); retryPipeline(i) }}
                      >Retry</button>
                    </span>
                  ) : img.jobStage === 'analysis_queued' || img.jobStage?.startsWith('analysis_pass') ? (
                    <span className="text-dim" title={img.jobDetail}>
                      {img.jobStage === 'analysis_queued' ? 'Analysis queued' : `Pass ${img.jobStage.slice(-1)}/5 — ${img.jobProgress || 0}%`}
                    </span>
                  ) : img.jobStage && img.jobStage !== 'ready' && img.jobStage !== 'complete' ? (
                    <span className="text-dim">Processing {img.jobProgress || 0}%</span>
                  ) : results[i] ? (
                    <span className="text-green">✓ {results[i].items ? `${results[i].items.length} items` : 'QA report'}</span>
                  ) : screeningSheet === i ? (
                    <span className="text-dim">Screening...</span>
                  ) : loadingSheet === i ? (
                    <span className="text-red">Analyzing...</span>
                  ) : screenings[i]?.grade === 'C' ? (
                    <span className="text-red">Grade C — declined</span>
                  ) : screenings[i] ? (
                    <span className="text-dim">Grade {screenings[i].grade} — analyzing</span>
                  ) : 'Not analyzed'}
                </div>
              </div>
              <button className="sheet-remove" title="Rename project" onClick={(e) => { e.stopPropagation(); renameProject(i) }}>
                <Pencil size={12} />
              </button>
              <button className="sheet-remove" title="Delete project" onClick={(e) => { e.stopPropagation(); removeImage(i) }}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* GEOTECH SECTION */}
        <div className="sidebar-geotech">
          <div className="sidebar-geotech-header">
            <span className="sidebar-geotech-title">Geotech Report</span>
          </div>
          <div className="sidebar-geotech-body">
            {!geotechResult && !geotechLoading && !geotechError && (
              <div className="geotech-empty" />
            )}
            {geotechLoading && (
              <div className="geotech-loading">
                <div className="spinner spinner-sm" />
                <span>Reading report...</span>
              </div>
            )}
            {geotechError && (
              <div className="geotech-error">
                <span>{geotechError}</span>
                <button className="btn btn-ghost" style={{ fontSize: '0.65rem', marginTop: 4 }} onClick={() => setGeotechError(null)}>Dismiss</button>
              </div>
            )}
            {geotechResult && !geotechLoading && (
              <div className="geotech-loaded">
                <div className="geotech-chip geotech-chip-ok">
                  ✓ {geotechFileName?.replace(/\.pdf$/i, '') || 'Report loaded'}
                </div>
                <div className="geotech-mini-facts">
                  {geotechResult.lab_summary?.dominant_uscs && (
                    <div className="geotech-mini-row">
                      <span>Soil class</span><strong>{geotechResult.lab_summary.dominant_uscs}</strong>
                    </div>
                  )}
                  {geotechResult.lab_summary?.pi_max != null && (
                    <div className="geotech-mini-row">
                      <span>Max PI</span><strong>{geotechResult.lab_summary.pi_max}</strong>
                    </div>
                  )}
                  {geotechResult.summary?.shallowest_groundwater_ft != null && (
                    <div className="geotech-mini-row">
                      <span>GW depth</span><strong>{geotechResult.summary.shallowest_groundwater_ft} ft</strong>
                    </div>
                  )}
                  {geotechResult.summary?.rock_encountered != null && (
                    <div className="geotech-mini-row">
                      <span>Rock</span><strong>{geotechResult.summary.rock_encountered ? `${geotechResult.summary.shallowest_rock_ft ?? '?'} ft` : 'Not encountered'}</strong>
                    </div>
                  )}
                  <div className="geotech-mini-row">
                    <span>Backfill</span>
                    <strong className={
                      geotechResult.summary?.backfill_suitability === 'SUITABLE' ? 'text-green' :
                      geotechResult.summary?.backfill_suitability === 'MARGINAL' ? 'text-yellow' : 'text-red'
                    }>{geotechResult.summary?.backfill_suitability || '—'}</strong>
                  </div>
                </div>
                <button className="btn btn-ghost" style={{ width: '100%', fontSize: '0.65rem', marginTop: 6 }} onClick={() => { setGeotechResult(null); setGeotechFileName(null) }}>
                  × Remove
                </button>
              </div>
            )}
          </div>
          <button className="btn btn-secondary sidebar-upload-btn"
            onClick={() => geotechInputRef.current?.click()} disabled={geotechLoading}>
            <Upload size={12} /> {geotechResult ? 'Replace Geotech PDF' : 'Geotech PDF'}
          </button>
          <input ref={geotechInputRef} type="file" accept=".pdf,application/pdf" onChange={handleGeotechUpload} style={{ display: 'none' }} />
        </div>

        {/* CITY / PROJECT SPECS UPLOAD */}
        <div className="sidebar-geotech">
          <div className="sidebar-geotech-header">
            <span className="sidebar-geotech-title">City / Project Specs</span>
          </div>
          <div className="sidebar-geotech-body">
            {!specsFileId && !specsUploading && (
              <div className="geotech-empty" />
            )}
            {specsUploading && (
              <div className="geotech-loading">
                <div className="spinner spinner-sm" />
                <span>Uploading specs...</span>
              </div>
            )}
            {specsFileId && !specsUploading && (
              <div className="geotech-loaded">
                <div className="geotech-chip geotech-chip-ok">
                  ✓ {specsFileName?.replace(/\.pdf$/i, '') || 'Specs loaded'}
                </div>
                <div className="geotech-mini-facts">
                  <div className="geotech-mini-row">
                    <span>Type</span>
                    <strong>{jobType === 'public' ? 'City / Public Specs' : 'Project Specs'}</strong>
                  </div>
                </div>
                <button className="btn btn-ghost" style={{ width: '100%', fontSize: '0.65rem', marginTop: 6 }}
                  onClick={() => { setSpecsFileId(null); setSpecsFileName(null) }}>
                  × Remove
                </button>
              </div>
            )}
          </div>
          <button
            className="btn btn-secondary sidebar-upload-btn"
            onClick={() => specsInputRef.current?.click()}
            disabled={specsUploading}
          >
            <Upload size={12} /> {specsFileId ? 'Replace Specs PDF' : 'Specs PDF'}
          </button>
          <input ref={specsInputRef} type="file" accept=".pdf,application/pdf"
            onChange={e => { const f = e.target.files[0]; if (f) { e.target.value = ''; uploadSpecs(f) } }}
            style={{ display: 'none' }} />
          <div style={{ padding: '0 8px 8px', fontSize: '0.68rem', color: 'var(--titan-text-muted)' }}>
            City specs, project specs, or owner requirements. AI cross-references plans against this doc.
          </div>
        </div>

        {/* QA TAKEOFF UPLOAD — only in QA Mode */}
        {qaMode && (
          <div className="sidebar-geotech">
            <div className="sidebar-geotech-header">
              <span className="sidebar-geotech-title">Completed Takeoff</span>
            </div>
            <div className="sidebar-geotech-body">
              {uploadedTakeoffData && (
                <div className="geotech-result-summary">
                  <div className="geotech-result-name">{uploadedTakeoffName}</div>
                  <div className="geotech-result-meta">{uploadedTakeoffData.length} rows parsed</div>
                </div>
              )}
            </div>
            <button
              className="btn btn-secondary sidebar-upload-btn"
              onClick={() => takeoffInputRef.current?.click()}
            >
              <Upload size={12} /> {takeoffParsing ? 'Reading…' : uploadedTakeoffData ? 'Replace Takeoff' : 'Takeoff (PDF/CSV/Excel)'}
            </button>
            <input
              ref={takeoffInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              onChange={handleTakeoffUpload}
              style={{ display: 'none' }}
            />
            <div style={{ padding: '0 8px 8px', fontSize: '0.68rem', color: 'var(--titan-text-muted)' }}>
              Your completed takeoff (PDF, CSV, or Excel)
            </div>
          </div>
        )}

        {/* JOB CONTEXT */}
        <div className="sidebar-job-context">
          <div className="sidebar-geotech-header">
            <span className="sidebar-geotech-title">Job Context</span>
          </div>
          <div className="job-context-body">
            <div className="job-context-row">
              <span className="job-context-label">Job Type</span>
              <div className="job-type-toggle">
                <button
                  className={`job-type-btn ${jobType === 'private' ? 'active' : ''}`}
                  onClick={() => setJobType('private')}
                >Private</button>
                <button
                  className={`job-type-btn ${jobType === 'public' ? 'active' : ''}`}
                  onClick={() => setJobType('public')}
                >Public</button>
              </div>
            </div>
            <div className="job-context-row">
              <span className="job-context-label">Bore Method</span>
              <select
                className="job-context-select"
                value={boreMethod}
                onChange={e => setBoreMethod(e.target.value)}
              >
                <option value="unknown">Unknown</option>
                <option value="none">No Bore Crossings</option>
                <option value="wet">Wet Bore</option>
                <option value="dry">Dry Bore</option>
                <option value="mixed">Mixed (Wet + Dry)</option>
              </select>
            </div>
            <div className="job-context-row job-context-row-col">
              <span className="job-context-label">Scope Exclusions</span>
              <textarea
                className="job-context-textarea"
                placeholder="e.g. not bidding grease trap, no pavement restoration"
                value={scopeNotes}
                onChange={e => setScopeNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        </div>

        {/* JOB HISTORY */}
        {user && (
          <div className="sidebar-history">
            <div className="sidebar-history-header">
              <span className="sidebar-section-title">Recent Jobs</span>
              {historyLoading && <div className="spinner spinner-sm" />}
            </div>
            {!historyLoading && jobHistory.length === 0 ? (
              <div className="history-empty">No past jobs yet.</div>
            ) : (
              jobHistory.map(job => (
                <div key={job.id} className={`history-item ${activeJobId === job.id ? 'history-item-active' : ''}`} onClick={() => restoreJob(job)}>
                  <div className="history-name">{job.plan_filename || 'Untitled Job'}</div>
                  <div className="history-meta">
                    {job.screening_grade && (
                      <span className={`history-grade history-grade-${job.screening_grade.toLowerCase()}`}>
                        {job.screening_grade}
                      </span>
                    )}
                    {job.line_item_count > 0 && <span>{job.line_item_count} items</span>}
                    <span>{formatHistoryDate(job.created_at)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <div className="sidebar-footer">
          <span className="titan-label" style={{ fontSize: '0.6rem' }}>Takeoff Copilot // 6 Signal</span>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main-content">
        {/* MODE TOGGLE */}
        <div className="mode-toggle-bar">
          <button
            className={`mode-toggle-btn ${!qaMode ? 'active' : ''}`}
            onClick={() => setQaMode(false)}
          >
            Takeoff Mode
          </button>
          <button
            className={`mode-toggle-btn ${qaMode ? 'active' : ''}`}
            onClick={() => setQaMode(true)}
          >
            QA Mode
          </button>
          {billingOn && (
            <button
              className="btn btn-ghost"
              style={{ marginLeft: 'auto', fontSize: '0.75rem' }}
              onClick={() => setPaywall({ projectId: null, imgIdx: null })}
              title="Takeoff credits — click to buy more"
            >
              {credits ?? 0} takeoff{(credits ?? 0) === 1 ? '' : 's'} left
            </button>
          )}
          <button
            className="btn btn-ghost"
            style={{ marginLeft: billingOn ? 8 : 'auto', fontSize: '0.75rem' }}
            onClick={() => setReferenceOpen(true)}
            title="Reference Bank — how everything works"
          >
            <BookOpen size={14} /> Reference
          </button>
        </div>

        {sheetCount === 0 ? (
          <div className="empty-state">
            <div
              className={`upload-dropzone ${dragActive ? 'drag-active' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); if (!dragActive) setDragActive(true) }}
              onDragLeave={(e) => { e.preventDefault(); setDragActive(false) }}
              onDrop={(e) => {
                e.preventDefault(); setDragActive(false)
                const files = Array.from(e.dataTransfer.files || [])
                if (files.length) processFiles(files)
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
            >
              <div className="empty-icon">
                <Upload size={34} strokeWidth={1.5} />
              </div>
              <h2>Drop your plan set to start</h2>
              <p className="dropzone-sub">
                Drag a PDF plan set here, or <span className="dropzone-link">browse your files</span>.
                Storm, sanitary &amp; water — plan and profile.
              </p>
              <div className="dropzone-formats">PDF up to 100 MB · or PNG / JPG single sheets</div>
            </div>

            <div className="empty-capabilities">
              <div className="cap-chip"><Layers size={15} /><span>Quantities by size &amp; material</span></div>
              <div className="cap-chip"><BarChart3 size={15} /><span>Depths &amp; OSHA trench safety</span></div>
              <div className="cap-chip"><ShieldAlert size={15} /><span>Bid-risk &amp; scope-gap flags</span></div>
            </div>

            <div className="empty-scope">
              <span className="scope-tag scope-tag-fit">Best fit</span>
              Single-level pad sites, commercial site development &amp; subdivision utility plans. Every plan is
              graded A/B/C before you commit — not built for vertical/multi-level building risers.
              <button className="scope-more" onClick={(e) => { e.stopPropagation(); setReferenceOpen(true) }}>
                What works best →
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* SHEET HEADER */}
            <div className="sheet-header">
              <div className="sheet-header-info">
                <img src={images[activeImage]?.preview} alt="" className="sheet-header-thumb" onClick={() => { const u = images[activeImage]?.preview; if (u) window.open(u, '_blank') }} />
                <div>
                  <div className="sheet-header-name">{images[activeImage]?.name}</div>
                  <div className="sheet-header-meta">
                    Sheet {activeImage + 1} of {images.length}
                    {result && (isQAResult
                      ? ` // QA Bid Risk Report // ${result.high_risk_misses?.length || 0} risk flags`
                      : ` // ${result.items?.length || 0} items // ${result.summary?.high_confidence_count || 0} high confidence`)}
                  </div>
                </div>
              </div>
              <div className="sheet-header-actions">
                {!results[activeImage] && screenings[activeImage]?.grade !== 'C' &&
                  images[activeImage]?.jobStage !== 'triage_complete' &&
                  images[activeImage]?.jobStage !== 'analysis_queued' &&
                  !images[activeImage]?.jobStage?.startsWith('analysis_pass') &&
                  images[activeImage]?.jobStage !== 'complete' && (
                  <button
                    className="btn btn-primary"
                    onClick={() => screenings[activeImage] ? analyzeSheet(activeImage) : screenSheet(activeImage)}
                    disabled={
                      loading ||
                      screeningSheet === activeImage ||
                      images[activeImage]?.uploading ||
                      (images[activeImage]?.job_id &&
                        !['ready', 'error', 'triage_complete', 'complete'].includes(images[activeImage]?.jobStage))
                    }
                  >
                    {images[activeImage]?.uploading
                      ? 'Uploading...'
                      : images[activeImage]?.job_id &&
                        !['ready', 'error', 'triage_complete', 'complete'].includes(images[activeImage]?.jobStage)
                        ? `Processing ${images[activeImage]?.jobProgress || 0}%…`
                        : screeningSheet === activeImage
                          ? 'Screening...'
                          : loadingSheet === activeImage
                            ? 'Analyzing...'
                            : 'Analyze Sheet'}
                  </button>
                )}
                {results[activeImage] && (
                  <>
                    <button className="btn btn-ghost" onClick={() => {
                      const r = { ...results }; delete r[activeImage]; setResults(r)
                      const s = { ...screenings }; delete s[activeImage]; setScreenings(s)
                      setChatOpen(false); setChatMessages([])
                    }}>
                      <RotateCcw size={14} /> Re-analyze
                    </button>
                    {!isQAResult && (
                      <>
                        <button className={`btn btn-ghost ${groupBySheet ? 'btn-active' : ''}`} title="Group the takeoff by sheet / area" onClick={() => setGroupBySheet(g => !g)}>
                          <Rows3 size={14} /> By Sheet
                        </button>
                        <button className="btn btn-ghost" title="Compare this takeoff to a previous version (addendum diff)" onClick={() => setRevisionModal(true)}>
                          <GitCompare size={14} /> Revisions
                        </button>
                        <button className="btn btn-secondary" title="Supplier Request for Quote (printable)" onClick={() => {
                          const meta = { filename: images[activeImage]?.name, company: onboardCompany, contactName: onboardName, phone: onboardPhone, email: user?.email }
                          const html = buildRFQReportHTML(result, materialsMap, meta)
                          if (html) printReport(html); else setError('No purchasable materials to quote on this takeoff.')
                        }}>
                          <Package size={14} /> RFQ
                        </button>
                        <button className="btn btn-secondary" onClick={() => exportCSV(false)}>
                          <Download size={14} /> CSV
                        </button>
                        <button className="btn btn-secondary" onClick={exportExcel}>
                          <Download size={14} /> Excel
                        </button>
                        <button className="btn btn-primary" onClick={exportPDF}>
                          <FileText size={14} /> PDF Report
                        </button>
                      </>
                    )}
                    {isQAResult && (
                      <button className="btn btn-secondary" onClick={() => exportQACSV(result, exportMeta())}>
                        <Download size={14} /> CSV
                      </button>
                    )}
                    {activeJobId && (
                      feedbackDone[activeJobId]
                        ? <span className="feedback-submitted">✓ Feedback received</span>
                        : <button className="btn btn-ghost" style={{ fontSize: '0.75rem' }} onClick={() => setFeedbackModal({ id: activeJobId })}>
                            Rate Result
                          </button>
                    )}
                  </>
                )}
                {analyzedCount > 1 && (
                  <button className="btn btn-secondary" onClick={() => exportCSV(true)}>
                    <Download size={14} /> All CSV
                  </button>
                )}
              </div>
            </div>

            {/* TABS */}
            <div className="tab-bar">
              {(isQAResult || (!result && qaMode)
                ? [['report', 'Bid Risk Report', ShieldAlert], ['plan', 'Plan View', Eye]]
                : [['takeoff', 'Takeoff', Layers], ['plan', 'Plan View', Eye], ['compare', 'Compare', GitCompare], ['summary', 'Summary', BarChart3]]
              ).map(([key, label, Icon]) => (
                <button key={key} className={`tab ${activeTab === key ? 'active' : ''}`} onClick={() => setActiveTab(key)}>
                  <Icon size={14} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* TAB CONTENT */}
            <div className="tab-content">

              {/* SHEET MAP — shown after triage, before analysis pass */}
              {images[activeImage]?.jobStage === 'triage_complete' && (() => {
                const projectId = images[activeImage]?.project_id
                const map = sheetMaps[projectId]
                if (!map?.loaded) {
                  return (
                    <div className="loading-state">
                      <div className="spinner" />
                      <p>Building sheet map...</p>
                    </div>
                  )
                }
                const selectedCount = map.sheets.filter(s => s.included_in_analysis).length
                return (
                  <div className="sheet-map animate-fade">
                    <div className="sheet-map-header">
                      <div>
                        <div className="sheet-map-title">Sheet Triage Complete</div>
                        <div className="sheet-map-subtitle">
                          {map.sheets.length} page{map.sheets.length !== 1 ? 's' : ''} classified —&nbsp;
                          <span className="sheet-map-accent">{selectedCount} queued for analysis</span>
                          <span className="text-dim"> (click thumbnails to toggle)</span>
                        </div>
                      </div>
                      <div className="sheet-map-legend">
                        <span className="sml-item sml-analyze"><span className="sml-dot" /> Analyze</span>
                        <span className="sml-item sml-skip"><span className="sml-dot sml-dot-skip" /> Skip</span>
                      </div>
                    </div>

                    <div className="sheet-map-grid">
                      {map.sheets.map((sheet) => {
                        const isAnalysis = TRIAGE_ANALYSIS_TYPES.has(sheet.classification)
                        return (
                          <div
                            key={sheet.id}
                            className={`smi ${sheet.included_in_analysis ? 'smi-on' : 'smi-off'}`}
                            onClick={() => toggleSheetAnalysis(projectId, sheet.id, sheet.included_in_analysis)}
                            title={`Page ${sheet.page_number}${sheet.sheet_number ? ` — ${sheet.sheet_number}` : ''}${sheet.sheet_title ? `: ${sheet.sheet_title}` : ''}\nClick to ${sheet.included_in_analysis ? 'exclude' : 'include'}`}
                          >
                            <div className="smi-thumb-wrap">
                              {sheet.preview_url
                                ? <img src={sheet.preview_url} alt="" className="smi-thumb" />
                                : <div className="smi-thumb smi-thumb-empty">{sheet.page_number}</div>
                              }
                              <div className={`smi-check ${sheet.included_in_analysis ? 'smi-check-on' : 'smi-check-off'}`}>
                                {sheet.included_in_analysis ? '✓' : '—'}
                              </div>
                            </div>
                            <div className="smi-info">
                              <span className={`cls-badge cls-${sheet.classification || 'other'} ${isAnalysis ? 'cls-analysis' : ''}`}>
                                {formatClassification(sheet.classification)}
                              </span>
                              {sheet.sheet_number && (
                                <span className="smi-num">{sheet.sheet_number}</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    <div className="proceed-bar">
                      <div className="proceed-info">
                        {selectedCount === 0
                          ? <span className="text-dim">No sheets selected — toggle some above</span>
                          : <><strong>{selectedCount}</strong> sheet{selectedCount !== 1 ? 's' : ''} will be analyzed</>
                        }
                      </div>
                      <button
                        className="btn btn-primary"
                        disabled={selectedCount === 0 || proceedingAnalysis}
                        onClick={() => proceedWithAnalysis(projectId, images.findIndex(img => img.project_id === projectId && img.jobStage === 'triage_complete'))}
                      >
                        {proceedingAnalysis
                          ? 'Loading sheets...'
                          : `Proceed with ${selectedCount} sheet${selectedCount !== 1 ? 's' : ''}`
                        }
                      </button>
                    </div>
                  </div>
                )
              })()}

              {/* ANALYSIS PIPELINE PROGRESS — server-side tiled multi-pass */}
              {(images[activeImage]?.jobStage === 'analysis_queued' || images[activeImage]?.jobStage?.startsWith('analysis_pass')) && (() => {
                const img = images[activeImage]
                const currentPassIdx = ANALYSIS_PASSES.findIndex(([key]) => key === img.jobStage)
                return (
                  <div className="analysis-progress animate-fade">
                    <div className="analysis-progress-head">
                      <div className="spinner" />
                      <div>
                        <div className="analysis-progress-title">Deep Analysis Running</div>
                        <div className="analysis-progress-sub">{img.jobDetail || 'Queued — the pipeline tiles each sheet and runs five extraction passes'}</div>
                      </div>
                      <div className="analysis-progress-pct">{img.jobProgress || 0}%</div>
                    </div>
                    <div className="analysis-progress-bar">
                      <div className="analysis-progress-fill" style={{ width: `${img.jobProgress || 0}%` }} />
                    </div>
                    <div className="analysis-pass-list">
                      {ANALYSIS_PASSES.map(([key, label, desc], i) => {
                        const state = currentPassIdx === -1 ? 'pending' : i < currentPassIdx ? 'done' : i === currentPassIdx ? 'active' : 'pending'
                        return (
                          <div key={key} className={`pass-row pass-${state}`}>
                            <span className="pass-marker">{state === 'done' ? '✓' : state === 'active' ? '●' : i + 1}</span>
                            <div>
                              <div className="pass-label">Pass {i + 1} — {label}</div>
                              <div className="pass-desc">{desc}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <p className="analysis-progress-note">
                      You can leave this page — results save to your project and will be here when you come back.
                    </p>
                  </div>
                )
              })()}

              {/* LOADING — SCREENING */}
              {screeningSheet === activeImage && (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>Screening plan quality...</p>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>Evaluating callout quality, scale, and plan complexity</span>
                </div>
              )}

              {/* LOADING — ANALYSIS */}
              {loadingSheet === activeImage && (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>Analyzing plan sheet...</p>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>Reading callouts, identifying materials, counting structures</span>
                </div>
              )}

              {/* GRADE C DECLINE */}
              {screenings[activeImage]?.grade === 'C' && !results[activeImage] && screeningSheet !== activeImage && (
                <div className="grade-c-decline animate-fade">
                  <div className="grade-c-icon">C</div>
                  <h3>Plan Grade C — Analysis Declined</h3>
                  <p className="grade-c-reason">{screenings[activeImage].grade_rationale}</p>
                  <div className="grade-c-detail">
                    <p>
                      Based on our calibration data, dense or poorly-labeled plan sets produce AI takeoffs with less than 50% accuracy — unreliable for pricing. Submitting a Grade C output for bid would expose you to significant change order risk.
                    </p>
                    <p style={{ marginTop: 10 }}>
                      <strong>What to submit instead:</strong> Single-story pad site plans with labeled pipe profiles, explicit size and material callouts, a visible scale bar, and a complete title block. Clean Pape-Dawson style plans routinely score 100% accuracy.
                    </p>
                  </div>
                  <div className="grade-c-actions">
                    <button className="btn btn-ghost" onClick={() => {
                      const s = { ...screenings }; delete s[activeImage]; setScreenings(s)
                    }}>
                      <RotateCcw size={14} /> Try Different Sheet
                    </button>
                    <button className="btn btn-secondary" onClick={() => analyzeSheet(activeImage)} disabled={loading}>
                      Run Anyway (not recommended)
                    </button>
                  </div>
                </div>
              )}

              {/* ERROR */}
              {error && loadingSheet !== activeImage && screeningSheet !== activeImage && (
                <div className="error-bar">
                  <strong>Error:</strong> {error}
                  <button className="btn btn-primary" style={{ marginLeft: 12 }} onClick={() => { setError(null); screenSheet(activeImage) }}>Retry</button>
                </div>
              )}

              {/* TAKEOFF TAB */}
              {activeTab === 'takeoff' && result && (
                <div className="takeoff-content animate-fade">
                  {/* TEXT-LAYER / EXTRACTABILITY BANNER */}
                  {result.text_layer && (
                    <div className={`textlayer-banner ${result.text_layer.mode === 'raster-only' ? 'textlayer-raster' : 'textlayer-hybrid'}`}>
                      <span className="textlayer-badge">
                        {result.text_layer.mode === 'raster-only' ? '⚠ Raster-only — vision mode' : '✓ Hybrid — text layer used'}
                      </span>
                      <span className="textlayer-detail">
                        {result.text_layer.mode === 'raster-only'
                          ? `No PDF text layer on the analyzed sheets — all quantities are vision reads. Treat extractability as lower and field-verify numbers.`
                          : `${result.text_layer.total_runs} embedded text runs across ${result.text_layer.sheets_with_text}/${result.text_layer.sheets_total} sheets used as ground truth for numbers, sizes, and materials.${result.text_layer.tables_detected ? ` ${result.text_layer.tables_detected} schedule/quantity table${result.text_layer.tables_detected === 1 ? '' : 's'} parsed from text${result.text_layer.table_rows_to_pass5 ? ` (${result.text_layer.table_rows_to_pass5} rows fed to the engineer check).` : '.'}` : ''}`}
                      </span>
                    </div>
                  )}
                  {/* PLAN GRADE BANNER */}
                  {(screenings[activeImage] || result.plan_screening) && (() => {
                    const sc = screenings[activeImage] || result.plan_screening
                    const gradeClass = sc.grade === 'A' ? 'grade-banner-a' : sc.grade === 'B' ? 'grade-banner-b' : 'grade-banner-c'
                    return (
                      <div className={`grade-banner ${gradeClass}`}>
                        <div className="grade-banner-left">
                          <span className="grade-badge">{sc.grade}</span>
                          <div>
                            <div className="grade-banner-label">{sc.grade_label}</div>
                            <div className="grade-banner-accuracy">Expected accuracy: {sc.expected_accuracy_range}</div>
                          </div>
                        </div>
                        <div className="grade-banner-rationale">{sc.grade_rationale}</div>
                      </div>
                    )
                  })()}
                  {result.sheet_info && (
                    <div className="sheet-meta-bar">
                      {[['Project', result.sheet_info.project_name], ['Sheet', result.sheet_info.sheet_number], ['Title', result.sheet_info.sheet_title], ['Scale', result.sheet_info.scale], ['Engineer', result.sheet_info.engineer]]
                        .filter(([,v]) => v)
                        .map(([label, val]) => (
                          <div key={label} className="meta-item">
                            <span className="text-muted">{label}:</span> {val}
                          </div>
                        ))}
                    </div>
                  )}
                  {(result.quality?.failed_tiles?.length > 0 || result.quality?.merge_degraded || result.quality?.small_diameter_dedupe_degraded) && (
                    <div style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px',
                      border: '1px solid var(--flag-low)', background: 'var(--flag-low-bg)',
                      borderRadius: 3, margin: '10px 0', fontSize: '0.8rem', lineHeight: 1.5,
                    }}>
                      <ShieldAlert size={16} style={{ color: 'var(--flag-low)', flexShrink: 0, marginTop: 1 }} />
                      <div>
                        {result.quality.failed_tiles?.length > 0 && (
                          <div><strong>Coverage gap:</strong> {result.quality.failed_tiles.length} sheet area{result.quality.failed_tiles.length === 1 ? '' : 's'} could not be analyzed after retries ({result.quality.failed_tiles.slice(0, 4).join('; ')}{result.quality.failed_tiles.length > 4 ? '; …' : ''}). Quantities there may be missing — verify manually or re-run.</div>
                        )}
                        {result.quality.merge_degraded && (
                          <div><strong>Dedupe degraded:</strong> automated overlap merging fell back to a conservative pass — watch for duplicate line items.</div>
                        )}
                        {result.quality.small_diameter_dedupe_degraded && (
                          <div><strong>Small-line dedupe degraded:</strong> ≤2" sweep items are marked LOW confidence — check them against the main takeoff.</div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* ── BID ESTIMATE summary bar (surface the total before detail) ── */}
                  {(() => {
                    const est = estimateFor(result)
                    return (
                      <div className="estimate-bar">
                        <div className="estimate-bar-total">
                          <span className="estimate-bar-label">Bid estimate</span>
                          <span className="estimate-bar-amt">{est.priced ? fmtUSD(est.total) : '—'}</span>
                          <span className="estimate-bar-sub">
                            {est.priced} of {est.count} items priced{est.unpriced ? ` · ${est.unpriced} need a unit cost` : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-secondary" onClick={() => setShowPricing(s => !s)}>
                            {showPricing ? 'Hide pricing' : est.priced ? 'Edit pricing' : 'Price this takeoff'}
                          </button>
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── BID ESTIMATE editor ── */}
                  {showPricing && (
                    <div className="estimate-panel">
                      <div className="risk-flags-header">
                        <span className="risk-flags-title">Bid Estimate</span>
                        <span className="risk-flags-subtitle">Enter your unit costs — saved to your price book and auto-applied to future takeoffs. Extended = quantity × unit cost.</span>
                      </div>
                      <div className="table-wrap">
                        <table className="titan-table estimate-table">
                          <thead><tr>{['#', 'Description', 'Qty', 'Unit', 'Unit $', 'Extended', ''].map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                          <tbody>
                            {(result.items || []).map((item, i) => {
                              const cost = unitCostOf(item)
                              const ext = extendedOf(item)
                              return (
                                <tr key={i}>
                                  <td className="text-muted">{item.item_no}</td>
                                  <td style={{ maxWidth: 320 }}>{item.description}</td>
                                  <td className="text-mono" style={{ fontWeight: 600 }}>{item.quantity ?? '—'}</td>
                                  <td className="text-mono text-dim">{item.unit}</td>
                                  <td>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                      <span className="text-dim" style={{ fontSize: '0.8rem' }}>$</span>
                                      <input
                                        className="input text-mono"
                                        type="number" min="0" step="0.01"
                                        style={{ width: 92, fontSize: '0.82rem' }}
                                        defaultValue={cost ?? ''}
                                        placeholder="0.00"
                                        onBlur={e => { if (e.target.value !== String(cost ?? '')) saveUnitCost(item, e.target.value) }}
                                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                                      />
                                    </div>
                                  </td>
                                  <td className="text-mono" style={{ fontWeight: 700, color: ext != null ? 'var(--titan-red)' : 'var(--titan-text-muted)' }}>
                                    {ext != null ? fmtUSD(ext) : '—'}
                                  </td>
                                  <td className="text-dim" style={{ fontSize: '0.7rem' }}>{cost != null ? 'from price book' : ''}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                          <tfoot>
                            {(() => {
                              const est = estimateFor(result)
                              return (
                                <>
                                  {Object.entries(est.byCat).map(([cat, sub]) => (
                                    <tr key={cat} className="estimate-subtotal">
                                      <td></td><td colSpan={4} className="text-dim">{cat} subtotal</td>
                                      <td className="text-mono" style={{ fontWeight: 600 }}>{fmtUSD(sub)}</td><td></td>
                                    </tr>
                                  ))}
                                  <tr className="estimate-grand">
                                    <td></td>
                                    <td colSpan={4} style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                      Grand total{est.unpriced ? ` (${est.unpriced} unpriced)` : ''}
                                    </td>
                                    <td className="text-mono" style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--titan-red)' }}>{fmtUSD(est.total)}</td>
                                    <td></td>
                                  </tr>
                                </>
                              )
                            })()}
                          </tfoot>
                        </table>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn btn-secondary" onClick={() => exportTakeoffCSV(result, { ...exportMeta(), priceBook, priced: true })}>
                          <Download size={14} /> Priced CSV
                        </button>
                        <button className="btn btn-primary" onClick={() => exportXLSX(result, { ...exportMeta(), priceBook, priced: true })}>
                          <Download size={14} /> Priced Excel
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="table-wrap">
                    <table className="titan-table">
                      <thead>
                        <tr>
                          {(result.depth_summary
                            ? ['#', 'Cat', 'Mat', 'Description', 'Unit', 'Qty', 'Conf', 'Depth Avg', 'Depth Max', 'Notes', '']
                            : ['#', 'Cat', 'Description', 'Unit', 'Qty', 'Conf', 'Notes', '']
                          ).map((h, hi) => (
                            <th key={hi}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(groupBySheet
                          ? groupedBySheet(result.items).flatMap(g => [{ _header: g.name, _count: g.items.length }, ...g.items])
                          : (result.items || [])
                        ).map((item, i) => (
                          item._header ? (
                            <tr key={`h${i}`} className="group-header-row">
                              <td colSpan={result.depth_summary ? 11 : 8} style={{ fontWeight: 700, background: '#eef2ff', color: 'var(--titan-red)', fontSize: '0.78rem', letterSpacing: '0.5px' }}>
                                {item._header} <span className="text-dim" style={{ fontWeight: 400 }}>· {item._count} item{item._count === 1 ? '' : 's'}</span>
                              </td>
                            </tr>
                          ) :
                          editingItem === item.item_no ? (
                            <tr key={i} style={{ background: 'rgba(0,87,255,0.06)' }}>
                              <td className="text-muted">{item.item_no}</td>
                              <td><span className="cat-badge">{categoryIcon(item.category)} {item.category}</span></td>
                              {result.depth_summary && <td className="mat-cell" />}
                              <td style={{ maxWidth: 320 }}>
                                <input className="input" style={{ width: '100%', fontSize: '0.8rem' }}
                                  value={editDraft.description}
                                  onChange={e => setEditDraft(d => ({ ...d, description: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') saveItemEdit(item.item_no); if (e.key === 'Escape') setEditingItem(null) }}
                                  autoFocus />
                              </td>
                              <td>
                                <input className="input text-mono" style={{ width: 56, fontSize: '0.8rem' }}
                                  value={editDraft.unit}
                                  onChange={e => setEditDraft(d => ({ ...d, unit: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') saveItemEdit(item.item_no); if (e.key === 'Escape') setEditingItem(null) }} />
                              </td>
                              <td>
                                <input className="input text-mono" type="number" min="0" style={{ width: 90, fontSize: '0.85rem', fontWeight: 600 }}
                                  value={editDraft.quantity}
                                  onChange={e => setEditDraft(d => ({ ...d, quantity: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') saveItemEdit(item.item_no); if (e.key === 'Escape') setEditingItem(null) }} />
                              </td>
                              <td><span className={`badge ${confidenceColor(item.confidence)}`}>{item.confidence}</span></td>
                              {result.depth_summary && <td colSpan={2} className="text-dim" style={{ fontSize: '0.72rem' }}>—</td>}
                              <td className="text-dim" style={{ fontSize: '0.72rem' }}>Enter to save · Esc to cancel</td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <button className="btn btn-primary" style={{ padding: '3px 8px', fontSize: '0.7rem' }} onClick={() => saveItemEdit(item.item_no)}><Check size={12} /></button>
                                <button className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: '0.7rem', marginLeft: 4 }} onClick={() => setEditingItem(null)}><X size={12} /></button>
                              </td>
                            </tr>
                          ) : (
                          <tr key={i}>
                            <td className="text-muted">{item.item_no}</td>
                            <td><span className="cat-badge">{categoryIcon(item.category)} {item.category}</span></td>
                            {result.depth_summary && (
                              <td className="mat-cell">
                                {item.material_slug && materialsMap[item.material_slug] ? (
                                  <img
                                    src={materialsMap[item.material_slug].image_path}
                                    className="mat-thumb"
                                    alt={materialsMap[item.material_slug].name}
                                    title={`${materialsMap[item.material_slug].name} — click for details`}
                                    onClick={() => setMaterialCard(item.material_slug)}
                                  />
                                ) : <span className="mat-thumb-empty">—</span>}
                              </td>
                            )}
                            <td style={{ maxWidth: 320 }}>{item.edited && <span title="Edited by estimator" style={{ color: 'var(--titan-red)', marginRight: 4 }}>✎</span>}{item.description}</td>
                            <td className="text-mono text-dim">{item.unit}</td>
                            <td className="text-mono" style={{ fontWeight: 600, color: 'var(--titan-white)', fontSize: '0.9rem' }}>{item.quantity}</td>
                            <td><span className={`badge ${confidenceColor(item.confidence)}`}>{item.confidence}</span></td>
                            {result.depth_summary && (
                              item.depth_unavailable ? (
                                <td colSpan={2} className="depth-unavail">DEPTH UNAVAILABLE — verify from profiles</td>
                              ) : (
                                <>
                                  <td className="text-mono text-dim">{item.depth_avg != null ? `${item.depth_avg} ft` : '—'}</td>
                                  <td className="text-mono" style={{ fontWeight: item.depth_max > 10 ? 700 : 400, color: item.depth_max > 10 ? 'var(--titan-red)' : 'inherit' }}>{item.depth_max != null ? `${item.depth_max} ft` : '—'}</td>
                                </>
                              )
                            )}
                            <td className="text-dim" style={{ maxWidth: 240, fontSize: '0.75rem', lineHeight: 1.4 }}>{item.notes}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {item.region && item.source_sheet_id && (
                                <button className="btn btn-ghost" style={{ padding: '2px 6px' }} title="Show where this was read on the plan"
                                  onClick={() => locateItem(item)}>
                                  <Crosshair size={12} />
                                </button>
                              )}
                              <button className="btn btn-ghost" style={{ padding: '2px 6px' }} title="Edit this line item"
                                onClick={() => startItemEdit(item)}>
                                <Pencil size={12} />
                              </button>
                            </td>
                          </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ── DEPTH SUMMARY (depth engine) ── */}
                  {result.depth_summary && (() => {
                    const ds = result.depth_summary
                    const order = ds.bucket_order || ['0-6', '6-8', '8-10', '10+']
                    return (
                      <div className="depth-section">
                        <div className="risk-flags-header">
                          <span className="risk-flags-title">Depth Summary</span>
                          <span className="risk-flags-subtitle">Excavation depths from profile elevations — trench safety, deep runs, and geotech cross-reference</span>
                        </div>

                        {/* Headline stats */}
                        <div className="depth-stats-row">
                          <div className="depth-stat">
                            <div className="depth-stat-num">{ds.trench_safety_lf || 0}<span className="depth-stat-unit"> LF</span></div>
                            <div className="depth-stat-label">Trench Safety (&gt;5 ft, OSHA)</div>
                          </div>
                          <div className="depth-stat">
                            <div className="depth-stat-num" style={{ color: ds.deep_runs?.length ? 'var(--titan-red)' : undefined }}>{ds.deep_runs?.length || 0}</div>
                            <div className="depth-stat-label">Deep Runs (&gt;10 ft)</div>
                          </div>
                          {ds.geotech && (
                            <div className="depth-stat">
                              <div className="depth-stat-num" style={{ color: ds.geotech.rock_excavation_total_lf ? 'var(--titan-red)' : undefined }}>
                                {ds.geotech.rock_excavation_total_lf || 0}<span className="depth-stat-unit"> LF</span>
                              </div>
                              <div className="depth-stat-label">Est. Rock Excavation{ds.geotech.rock_depth_ft != null ? ` (rock @ ${ds.geotech.rock_depth_ft} ft)` : ''}</div>
                            </div>
                          )}
                          {ds.crossings?.length > 0 && (
                            <div className="depth-stat">
                              <div className="depth-stat-num">{ds.crossings.length}</div>
                              <div className="depth-stat-label">Utility Crossings</div>
                            </div>
                          )}
                        </div>

                        {/* Per-run depth buckets */}
                        {ds.runs?.length > 0 && (
                          <div className="table-wrap">
                            <table className="titan-table">
                              <thead>
                                <tr>
                                  {['Run', 'Utility', 'Avg', 'Max', ...order.map(o => `${o} ft`), 'LF >5'].map(h => <th key={h}>{h}</th>)}
                                </tr>
                              </thead>
                              <tbody>
                                {ds.runs.map((r, i) => (
                                  <tr key={i}>
                                    <td>{r.run_id}</td>
                                    <td className="text-dim">{r.utility}</td>
                                    <td className="text-mono">{r.depth_avg != null ? `${r.depth_avg}` : '—'}</td>
                                    <td className="text-mono" style={{ fontWeight: r.depth_max > 10 ? 700 : 400, color: r.depth_max > 10 ? 'var(--titan-red)' : 'inherit' }}>{r.depth_max != null ? `${r.depth_max}` : '—'}</td>
                                    {order.map(o => <td key={o} className="text-mono text-dim">{r.buckets?.[o] ? `${r.buckets[o]}` : '—'}</td>)}
                                    <td className="text-mono">{r.lf_over_5 != null ? r.lf_over_5 : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Geotech cross-reference flags */}
                        {ds.geotech?.groundwater_runs?.length > 0 && (
                          <div className="depth-flag depth-flag-warn">
                            <strong>Groundwater:</strong> {ds.geotech.groundwater_runs.length} run{ds.geotech.groundwater_runs.length > 1 ? 's' : ''} reach the water table at {ds.geotech.groundwater_depth_ft} ft — dewatering likely required ({ds.geotech.groundwater_runs.map(r => r.run_id).join(', ')}).
                          </div>
                        )}

                        {/* Crossings */}
                        {ds.crossings?.length > 0 && (
                          <div className="depth-crossings">
                            {ds.crossings.map((c, i) => (
                              <div key={i} className="depth-flag">
                                <strong>Crossing @ {c.structure}:</strong> {c.utilities.join(' × ')} — controlling depth {c.controlling_depth} ft.
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Depth-unavailable runs */}
                        {ds.unavailable_runs?.length > 0 && (
                          <div className="depth-flag depth-flag-muted">
                            <strong>Depth unavailable</strong> for {ds.unavailable_runs.length} run{ds.unavailable_runs.length > 1 ? 's' : ''} (profile missing/illegible — verify): {ds.unavailable_runs.map(r => r.run_id).join(', ')}.
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* ── MEASURED GEOMETRY (beta): scale-aware vector cross-check ── */}
                  {result.measurement?.sheets?.length > 0 && (
                    <div className="depth-section">
                      <div className="risk-flags-header">
                        <span className="risk-flags-title">Measured Geometry <span style={{ fontSize: '0.6rem', color: 'var(--titan-red)', letterSpacing: '1px' }}>BETA</span></span>
                        <span className="risk-flags-subtitle">Runs measured straight from the drawing's vector geometry at its detected scale — cross-check your mains, especially where callouts are missing</span>
                      </div>
                      {result.measurement.possible_missed_runs && (
                        <div style={{
                          display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px',
                          border: '1px solid var(--flag-medium)', background: 'var(--flag-medium-bg)',
                          borderRadius: 3, marginBottom: 10, fontSize: '0.8rem', lineHeight: 1.5,
                        }}>
                          <ShieldAlert size={16} style={{ color: 'var(--flag-medium)', flexShrink: 0, marginTop: 1 }} />
                          <div>
                            <strong>Possible missed runs:</strong> the takeoff captured ~{result.measurement.extracted_pipe_lf.toLocaleString()} LF of pipe, but the drawn geometry measures ~{result.measurement.measured_candidate_lf.toLocaleString()} LF of linework. On a poorly-labeled sheet that gap can mean unlabeled runs — review the longest measured runs below against your mains.
                          </div>
                        </div>
                      )}
                      <div className="table-wrap">
                        <table className="titan-table">
                          <thead><tr>{['Sheet', 'Scale', 'Longest measured runs (LF)', 'Candidate runs'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                          <tbody>
                            {result.measurement.sheets.map((s, i) => (
                              <tr key={i}>
                                <td className="text-mono">{s.sheet}</td>
                                <td className="text-mono text-dim">{s.scale}</td>
                                <td className="text-mono">{s.longest_runs_lf?.length ? s.longest_runs_lf.map(v => v.toLocaleString()).join(' · ') : '—'}</td>
                                <td className="text-mono text-dim">{s.candidate_runs}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-dim" style={{ fontSize: '0.72rem', lineHeight: 1.6, marginTop: 8 }}>
                        {result.measurement.note}
                      </p>
                    </div>
                  )}

                  {/* ── ENGINEER QUANTITY VARIANCE (Pass 5 sanity check) ── */}
                  {result.variance_table?.length > 0 && (
                    <div className="variance-section">
                      <div className="risk-flags-header">
                        <span className="risk-flags-title">Engineer Quantity Comparison</span>
                        <span className="risk-flags-subtitle">Our takeoff vs the engineer's printed quantity table</span>
                      </div>
                      <div className="table-wrap">
                        <table className="titan-table">
                          <thead>
                            <tr>{['Status', 'Engineer Item', 'Engineer Qty', 'Our Qty', 'Unit', 'Diff'].map(h => <th key={h}>{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {result.variance_table.map((v, i) => (
                              <tr key={i}>
                                <td>
                                  <span className={`badge ${v.status === 'MATCHED' ? 'badge-high' : v.status === 'VARIANCE' ? 'badge-medium' : 'badge-low'}`}>
                                    {v.status === 'MISSING_FROM_OURS' ? 'NOT IN OURS' : v.status}
                                  </span>
                                </td>
                                <td style={{ maxWidth: 300 }}>{v.engineer_description}</td>
                                <td className="text-mono">{v.engineer_quantity}</td>
                                <td className="text-mono">{v.our_quantity ?? '—'}</td>
                                <td className="text-mono text-dim">{v.unit}</td>
                                <td className="text-mono" style={{ fontWeight: 600, color: v.pct_difference != null && Math.abs(v.pct_difference) > 5 ? 'var(--titan-red)' : 'inherit' }}>
                                  {v.pct_difference != null ? `${v.pct_difference > 0 ? '+' : ''}${v.pct_difference}%` : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── RISK FLAGS ── */}
                  {(() => {
                    const rm = result.risk_and_misses
                    const lowItems = (result.items || []).filter(it => it.confidence === 'LOW')

                    // Build geotech flags from AI output + loaded report
                    const geotechFlags = []
                    if (rm?.geotech) {
                      const g = rm.geotech
                      if (g.groundwater_notes === 'YES') geotechFlags.push({ sev: 'WARN', label: 'Groundwater Present', note: 'Plans reference groundwater. Verify dewatering is in scope and budget.' })
                      if (g.rock_excavation_required === true || (rm.scope_gaps || []).some(s => /rock/i.test(s.item) && s.status === 'MISSING')) geotechFlags.push({ sev: 'WARN', label: 'Rock / Hard Excavation', note: 'Rock conditions noted or cannot be ruled out. Rock removal line item may be missing.' })
                      if (g.geotech_report_referenced === 'NO' || g.geotech_report_referenced === 'NOT SHOWN') geotechFlags.push({ sev: 'WARN', label: 'No Geotech Report on Plans', note: 'Ground conditions are unverified. Soil type, groundwater depth, and bearing capacity are unknown — all excavation costs are estimated blind.' })
                      if (g.geotech_flags) geotechFlags.push({ sev: 'INFO', label: 'AI Geotech Observation', note: g.geotech_flags })
                    }
                    // Supplement with loaded geotech report
                    if (geotechResult) {
                      const gf = geotechResult.flags
                      if (gf?.dewatering_required) geotechFlags.push({ sev: 'WARN', label: `Dewatering — GW at ${geotechResult.summary?.shallowest_groundwater_ft ?? '?'} ft`, note: gf.dewatering_note || 'Dewatering required per geotech report.' })
                      if (gf?.rock_excavation_required) geotechFlags.push({ sev: 'WARN', label: `Rock at ${geotechResult.summary?.shallowest_rock_ft ?? '?'} ft`, note: gf.rock_note || 'Rock excavation required per geotech report.' })
                      if (gf?.lime_stabilization_required) geotechFlags.push({ sev: 'WARN', label: 'Lime / Cement Stabilization Required', note: gf.lime_note || 'High-PI subgrade soils require treatment.' })
                      if (gf?.select_fill_required) geotechFlags.push({ sev: 'WARN', label: 'Imported Select Fill Required', note: gf.select_fill_note || 'Native soils are unsuitable for structural backfill.' })
                      if (gf?.spoil_removal_required) geotechFlags.push({ sev: 'WARN', label: 'Spoil Haul-Off Required', note: gf.spoil_note || 'Unsuitable excavated material must leave the site.' })
                    }
                    if (!geotechResult && !rm?.geotech) geotechFlags.push({ sev: 'INFO', label: 'No Geotech Data Loaded', note: 'Upload a geotech report in the sidebar to flag soil risks specific to this site.' })

                    // Build scope gap flags from AI output
                    const scopeGaps = []
                    const ALWAYS_CHECK = [
                      { key: 'trench_safety', label: 'Trench Safety (OSHA >5 ft)', hint: 'Required on any trench deeper than 5 ft. Often excluded from utility scopes and added as a change order.' },
                      { key: 'erosion_control', label: 'Erosion Control / SWPPP', hint: 'SWPPP, silt fence, rock check dams, and inlet protection. Required on most permitted sites — commonly missed on fast bids.' },
                      { key: 'testing', label: 'Testing & Inspection', hint: 'Mandrel, pressure, leakage, video inspection, and compaction testing. Some specs require third-party inspection at contractor expense.' },
                      { key: 'traffic_control', label: 'Traffic Control', hint: 'TxDOT or city ROW work requires a stamped TCP. TC setup, flaggers, and signs can run $5–15K depending on road class.' },
                      { key: 'mobilization', label: 'Mobilization / Demobilization', hint: 'Equipment move-in/out, site setup, temporary facilities. Commonly omitted when estimating pipe and fittings only.' },
                      { key: 'permits', label: 'Permit & Inspection Fees', hint: 'City, county, or TxDOT construction permits. Tap fees and inspection deposits can be significant on utility work.' },
                    ]
                    const aiScopeGaps = rm?.scope_gaps || []
                    ALWAYS_CHECK.forEach(({ key, label, hint }) => {
                      const aiMatch = aiScopeGaps.find(s => s.item?.toLowerCase().includes(key.replace('_', ' ').split('/')[0]))
                      const inScope = (result.items || []).some(it =>
                        (it.description + ' ' + (it.notes || '')).toLowerCase().includes(key.replace('_', ' '))
                      )
                      if (aiMatch?.status === 'OK' || inScope) {
                        scopeGaps.push({ sev: 'OK', label, note: aiMatch?.note || 'Item appears to be in scope.' })
                      } else if (aiMatch?.status === 'NOT APPLICABLE') {
                        // skip
                      } else {
                        scopeGaps.push({ sev: 'MISS', label, note: aiMatch?.note || hint })
                      }
                    })
                    // Add any AI-detected MISSING gaps not in the always-check list
                    aiScopeGaps
                      .filter(s => s.status === 'MISSING' || s.status === 'PARTIAL')
                      .filter(s => !ALWAYS_CHECK.some(c => s.item?.toLowerCase().includes(c.key.replace('_', ' '))))
                      .forEach(s => scopeGaps.push({ sev: s.status === 'PARTIAL' ? 'WARN' : 'MISS', label: s.item, note: s.note }))

                    // Top risk summary
                    const topRisks = rm?.top_risks

                    const hasSomething = geotechFlags.length > 0 || scopeGaps.some(f => f.sev !== 'OK') || lowItems.length > 0 || topRisks

                    if (!hasSomething) return null

                    return (
                      <div className="risk-flags-section">
                        <div className="risk-flags-header">
                          <span className="risk-flags-title">⚠ Risk Flags</span>
                          <span className="risk-flags-subtitle">Items that turn a 60% accurate takeoff into a 100% useful one</span>
                        </div>

                        {/* TOP RISK CALLOUT */}
                        {topRisks && (
                          <div className="risk-callout">
                            <div className="risk-callout-label">AI Top Risks</div>
                            <p>{topRisks}</p>
                          </div>
                        )}

                        <div className="risk-flags-grid">
                          {/* GEOTECH COLUMN */}
                          <div className="risk-flags-col">
                            <div className="risk-col-header risk-col-header-geo">Geotech Warnings</div>
                            {geotechFlags.map((f, i) => (
                              <div key={i} className={`risk-flag-row risk-flag-${f.sev.toLowerCase()}`}>
                                <span className="risk-flag-icon">{f.sev === 'WARN' ? '▲' : 'ℹ'}</span>
                                <div>
                                  <div className="risk-flag-label">{f.label}</div>
                                  <div className="risk-flag-note">{f.note}</div>
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* SCOPE GAPS COLUMN */}
                          <div className="risk-flags-col">
                            <div className="risk-col-header risk-col-header-scope">Commonly Missed Scope</div>
                            {scopeGaps.map((f, i) => (
                              <div key={i} className={`risk-flag-row risk-flag-${f.sev.toLowerCase()}`}>
                                <span className="risk-flag-icon">
                                  {f.sev === 'OK' ? '✓' : f.sev === 'MISS' ? '✗' : '▲'}
                                </span>
                                <div>
                                  <div className="risk-flag-label">{f.label}</div>
                                  <div className="risk-flag-note">{f.note}</div>
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* AI INFERRED COLUMN */}
                          {lowItems.length > 0 && (
                            <div className="risk-flags-col">
                              <div className="risk-col-header risk-col-header-infer">AI Inferred — Verify Before Pricing</div>
                              {lowItems.map((item, i) => (
                                <div key={i} className="risk-flag-row risk-flag-infer">
                                  <span className="risk-flag-icon">?</span>
                                  <div>
                                    <div className="risk-flag-label">{item.description}</div>
                                    <div className="risk-flag-note">{item.notes}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* BID RISK REPORT TAB — QA Mode */}
              {activeTab === 'report' && isQAResult && (
                <div className="qa-report animate-fade">
                  {/* DOWNLOAD BAR */}
                  <div className="qa-download-bar">
                    <span className="qa-download-label">Bid Risk Report</span>
                    <button className="btn btn-primary" onClick={exportQAPDF}>
                      <FileText size={14} /> Download as PDF
                    </button>
                  </div>

                  {/* PLAN GRADE BANNER */}
                  {(screenings[activeImage] || result.plan_screening) && (() => {
                    const sc = screenings[activeImage] || result.plan_screening
                    const gradeClass = sc.grade === 'A' ? 'grade-banner-a' : sc.grade === 'B' ? 'grade-banner-b' : 'grade-banner-c'
                    return (
                      <div className={`grade-banner ${gradeClass}`}>
                        <div className="grade-banner-left">
                          <span className="grade-badge">{sc.grade}</span>
                          <div>
                            <div className="grade-banner-label">{sc.grade_label}</div>
                            <div className="grade-banner-accuracy">Expected accuracy: {sc.expected_accuracy_range}</div>
                          </div>
                        </div>
                        <div className="grade-banner-rationale">{sc.grade_rationale}</div>
                      </div>
                    )
                  })()}

                  {/* EXECUTIVE SUMMARY + CONFIDENCE SCORE */}
                  <div className="qa-top-row">
                    <div className="card qa-exec-card">
                      <div className="qa-section-label">Executive Risk Summary</div>
                      <p className="qa-exec-text">{result.executive_risk_summary}</p>
                    </div>
                    {result.estimator_confidence_score && (
                      <div className={`card qa-score-card qa-score-${(result.estimator_confidence_score.grade || 'c').toLowerCase()}`}>
                        <div className="qa-score-num">{result.estimator_confidence_score.score}</div>
                        <div className="qa-score-grade">Grade {result.estimator_confidence_score.grade}</div>
                        <div className="qa-score-label">Estimator Confidence</div>
                        <div className="qa-score-rationale">{result.estimator_confidence_score.rationale}</div>
                        <div className={`qa-bid-ready ${result.estimator_confidence_score.ready_to_bid ? 'qa-bid-yes' : 'qa-bid-no'}`}>
                          {result.estimator_confidence_score.ready_to_bid ? '✓ Ready to Bid' : '✗ Needs Revision'}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* HIGH RISK MISSES */}
                  {result.high_risk_misses?.length > 0 && (
                    <div className="card qa-section">
                      <div className="qa-section-label qa-label-danger">High Risk Misses — {result.high_risk_misses.length} flagged</div>
                      <div className="table-wrap">
                        <table className="titan-table">
                          <thead>
                            <tr>{['Risk', 'Item', 'Estimator Had', 'Plan Shows', 'Notes'].map(h => <th key={h}>{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {result.high_risk_misses.map((m, i) => (
                              <tr key={i}>
                                <td><span className={`badge ${m.risk_level === 'HIGH' ? 'badge-low' : m.risk_level === 'MEDIUM' ? 'badge-medium' : 'badge-high'}`}>{m.risk_level}</span></td>
                                <td style={{ maxWidth: 220, fontWeight: 600 }}>{m.item}</td>
                                <td className="text-mono text-dim">{m.estimator_quantity}</td>
                                <td className="text-mono">{m.plan_read_quantity}</td>
                                <td className="text-dim" style={{ maxWidth: 280, fontSize: '0.75rem', lineHeight: 1.4 }}>{m.note}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* QUANTITY ITEMS TO RECHECK */}
                  {result.quantity_items_to_recheck?.length > 0 && (
                    <div className="card qa-section">
                      <div className="qa-section-label">Quantity Items to Recheck — {result.quantity_items_to_recheck.length} flagged</div>
                      <div className="table-wrap">
                        <table className="titan-table">
                          <thead>
                            <tr>{['Status', 'Item', 'Estimator Had', 'Plan Shows', 'Notes'].map(h => <th key={h}>{h}</th>)}</tr>
                          </thead>
                          <tbody>
                            {result.quantity_items_to_recheck.map((q, i) => {
                              const sc = q.qa_status === 'CONFIRMED' ? 'badge-high' : q.qa_status === 'APPEARS HIGH' ? 'badge-medium' : 'badge-low'
                              return (
                                <tr key={i}>
                                  <td><span className={`badge ${sc}`} style={{ fontSize: '0.65rem', whiteSpace: 'nowrap' }}>{q.qa_status}</span></td>
                                  <td style={{ maxWidth: 220 }}>{q.item}</td>
                                  <td className="text-mono text-dim">{q.estimator_quantity}</td>
                                  <td className="text-mono">{q.plan_read_quantity}</td>
                                  <td className="text-dim" style={{ maxWidth: 260, fontSize: '0.75rem', lineHeight: 1.4 }}>{q.note}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* SCOPE GAPS */}
                  {result.scope_gaps?.length > 0 && (
                    <div className="card qa-section">
                      <div className="qa-section-label">Scope Gaps — {result.scope_gaps.filter(s => s.status === 'MISSING').length} missing</div>
                      <div className="qa-scope-grid">
                        {result.scope_gaps.map((s, i) => (
                          <div key={i} className={`qa-scope-row qa-scope-${s.status.toLowerCase()}`}>
                            <span className="qa-scope-icon">{s.status === 'PRESENT' ? '✓' : s.status === 'MISSING' ? '✗' : '?'}</span>
                            <div className="qa-scope-body">
                              <div className="qa-scope-item">{s.item}</div>
                              <div className="qa-scope-note">{s.note}</div>
                            </div>
                            {s.risk_level && s.status !== 'PRESENT' && (
                              <span className={`badge ${s.risk_level === 'HIGH' ? 'badge-low' : s.risk_level === 'MEDIUM' ? 'badge-medium' : 'badge-high'}`}>{s.risk_level}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* GEOTECH & PLAN CONFLICTS */}
                  {result.geotech_and_plan_conflicts?.length > 0 && (
                    <div className="card qa-section">
                      <div className="qa-section-label">Geotech & Plan Conflicts</div>
                      {result.geotech_and_plan_conflicts.map((c, i) => (
                        <div key={i} className="qa-conflict-row">
                          <div className="qa-conflict-top">
                            <span className={`badge ${c.risk_level === 'HIGH' ? 'badge-low' : c.risk_level === 'MEDIUM' ? 'badge-medium' : 'badge-high'}`}>{c.risk_level}</span>
                            <span className="qa-conflict-label">{c.conflict}</span>
                          </div>
                          <div className="qa-conflict-details">
                            <div><span className="text-muted">Geotech: </span>{c.geotech_finding}</div>
                            <div><span className="text-muted">Takeoff: </span>{c.estimator_response}</div>
                          </div>
                          <div className="qa-conflict-note">{c.note}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* CLARIFICATION QUESTIONS + ASSUMPTIONS */}
                  <div className="qa-bottom-row">
                    {result.clarification_questions?.length > 0 && (
                      <div className="card qa-section">
                        <div className="qa-section-label">Clarification Questions</div>
                        {result.clarification_questions.map((q, i) => (
                          <div key={i} className="qa-question-row">
                            <div className="qa-question-top">
                              <span className={`badge ${q.priority === 'HIGH' ? 'badge-low' : q.priority === 'MEDIUM' ? 'badge-medium' : 'badge-high'}`}>{q.priority}</span>
                              <span className="qa-question-text">{q.question}</span>
                            </div>
                            {q.context && <div className="qa-question-context">{q.context}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                    {result.assumptions_needing_approval?.length > 0 && (
                      <div className="card qa-section">
                        <div className="qa-section-label">Assumptions Needing Approval</div>
                        {result.assumptions_needing_approval.map((a, i) => (
                          <div key={i} className="qa-assumption-row">
                            <div className="qa-assumption-text">{a.assumption}</div>
                            <div className="qa-assumption-sub"><strong>Risk:</strong> {a.risk_if_wrong}</div>
                            <div className="qa-assumption-sub"><strong>Action:</strong> {a.recommended_action}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* RECOMMENDED BID NOTES */}
                  {result.recommended_bid_notes?.length > 0 && (
                    <div className="card qa-section">
                      <div className="qa-section-label">Recommended Bid Notes & Exclusions</div>
                      <p className="text-dim" style={{ fontSize: '0.78rem', marginBottom: 10 }}>Copy these into your bid letter to protect against scope creep.</p>
                      <ul className="qa-bid-notes">
                        {result.recommended_bid_notes.map((note, i) => (
                          <li key={i}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* PLAN VIEW TAB */}
              {activeTab === 'plan' && images[activeImage] && (() => {
                const img = images[activeImage]
                const map = img.project_id ? sheetMaps[img.project_id] : null
                const locSheet = locate && map?.sheets?.find(s => s.id === locate.sheet_id && s.preview_url)
                const overlay = locSheet && locate.region && locate.region_page && (() => {
                  const [px0, py0, px1, py1] = locate.region_page
                  const [rx0, ry0, rx1, ry1] = locate.region
                  const pw = (px1 - px0) || 1, ph = (py1 - py0) || 1
                  return {
                    left: `${((rx0 - px0) / pw) * 100}%`, top: `${((ry0 - py0) / ph) * 100}%`,
                    width: `${((rx1 - rx0) / pw) * 100}%`, height: `${((ry1 - ry0) / ph) * 100}%`,
                  }
                })()
                const hasGrid = map?.loaded && map.sheets.some(s => s.preview_url)
                return (
                  <div className="plan-view animate-fade">
                    {locSheet && overlay && (
                      <div className="locate-panel">
                        <div className="locate-head">
                          <span><Crosshair size={13} /> Item #{locate.item_no} — read from {locSheet.sheet_number || `page ${locSheet.page_number}`}</span>
                          <button className="btn btn-ghost" style={{ fontSize: '0.72rem' }} onClick={() => setLocate(null)}><X size={13} /> Clear</button>
                        </div>
                        <div className="locate-image-wrap">
                          <img src={locSheet.preview_url} alt={locSheet.sheet_number || 'Located sheet'} />
                          <div className="locate-box" style={overlay} />
                        </div>
                        <p className="text-dim" style={{ fontSize: '0.72rem', marginTop: 6 }}>
                          The highlight is the tile region the AI read this item from — verify the callout against the drawing before you price it.
                        </p>
                      </div>
                    )}
                    {hasGrid ? (
                      <div className="plan-sheet-grid">
                        {map.sheets.filter(s => s.preview_url).map(s => (
                          <a key={s.id} className={`plan-sheet-cell ${locate?.sheet_id === s.id ? 'plan-sheet-cell-active' : ''}`} href={s.preview_url} target="_blank" rel="noopener noreferrer" title="Open full size">
                            <img src={s.preview_url} alt={s.sheet_number || `Page ${s.page_number}`} loading="lazy" />
                            <span className="plan-sheet-label">
                              {s.sheet_number || `Pg ${s.page_number}`}{s.included_in_analysis ? ' ✓' : ''}
                            </span>
                          </a>
                        ))}
                      </div>
                    ) : img.preview ? (
                      <img src={img.preview} alt="Plan sheet" className="plan-image" />
                    ) : (
                      <div className="loading-state"><p className="text-dim">No sheet previews available for this job.</p></div>
                    )}
                  </div>
                )
              })()}

              {/* COMPARE TAB */}
              {activeTab === 'compare' && (
                <div className="compare-content animate-fade">
                  <div className="card" style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <h4 style={{ color: 'var(--titan-red)' }}>Your Actual Takeoff</h4>
                      <button className="btn btn-secondary" style={{ fontSize: '0.72rem' }} onClick={() => compareInputRef.current?.click()}>
                        <Upload size={12} /> {compareParsing ? 'Reading takeoff…' : 'Upload PDF / CSV / Excel'}
                      </button>
                      <input ref={compareInputRef} type="file" accept=".csv,.xlsx,.xls,.pdf" onChange={handleCompareUpload} style={{ display: 'none' }} />
                    </div>
                    <p className="text-dim" style={{ fontSize: '0.78rem', marginBottom: 12 }}>
                      Upload your takeoff file, or paste it — one item per line: description, unit, quantity.
                    </p>
                    <textarea className="input" value={comparisonData} onChange={e => setComparisonData(e.target.value)}
                      placeholder={`Example:\n8" PVC SDR-35, LF, 450\n48" Precast Manhole, EA, 3\n8" 45° Bend PVC, EA, 6`}
                    />
                  </div>
                  {result && comparisonData && (
                    <div className="compare-panels">
                      <div className="compare-panel">
                        <div className="compare-panel-header" style={{ color: 'var(--titan-red)' }}>AI Output</div>
                        <div className="compare-panel-body text-mono">
                          {(result.items || []).map((item, i) => (
                            <div key={i}>[{item.confidence?.[0] || "?"}] {item.description}, {item.unit}, {item.quantity}</div>
                          ))}
                        </div>
                      </div>
                      <div className="compare-panel">
                        <div className="compare-panel-header" style={{ color: 'var(--titan-blue)' }}>Actual Takeoff</div>
                        <div className="compare-panel-body text-mono" style={{ whiteSpace: 'pre-wrap' }}>{comparisonData}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* SUMMARY TAB */}
              {activeTab === 'summary' && result && (
                <div className="summary-content animate-fade">
                  <div className="stats-grid">
                    {[
                      ['Total Items', result.summary?.total_items || result.items?.length || 0, ''],
                      ['High Confidence', result.summary?.high_confidence_count || 0, 'high'],
                      ['Medium Confidence', result.summary?.medium_confidence_count || 0, 'medium'],
                      ['Low Confidence', result.summary?.low_confidence_count || 0, 'low']
                    ].map(([label, val, type]) => (
                      <div key={label} className="stat-card">
                        <div className={`stat-value ${type ? `text-${type}` : ''}`}>{val}</div>
                        <div className="stat-label">{label}</div>
                      </div>
                    ))}
                  </div>
                  {result.summary?.key_observations && (
                    <div className="card card-highlight" style={{ marginTop: 16 }}>
                      <h4 style={{ color: 'var(--titan-red)', marginBottom: 8 }}>AI Observations</h4>
                      <p style={{ lineHeight: 1.7, fontSize: '0.85rem' }}>{result.summary.key_observations}</p>
                    </div>
                  )}
                  <div className="card" style={{ marginTop: 16 }}>
                    <h4 style={{ marginBottom: 12 }}>Items by Category</h4>
                    {Object.entries((result.items || []).reduce((acc, item) => { acc[item.category] = (acc[item.category] || 0) + 1; return acc }, {}))
                      .sort((a, b) => b[1] - a[1])
                      .map(([cat, count]) => (
                        <div key={cat} className="category-row">
                          <span><span className="text-muted">{categoryIcon(cat)}</span> {cat}</span>
                          <span className="text-mono text-red" style={{ fontWeight: 600 }}>{count}</span>
                        </div>
                      ))}
                  </div>

                  {/* GEOTECH FLAGS PANEL */}
                  {geotechResult ? (() => {
                    const xref = geotechCrossRef(geotechResult, results)
                    const geo = geotechResult
                    return (
                      <div className="card geotech-panel" style={{ marginTop: 16 }}>
                        <div className="geotech-panel-header">
                          <h4>Geotech Flags</h4>
                          <span className="geotech-panel-source">{geotechFileName || 'Geotech Report'}</span>
                        </div>

                        {/* SOIL DATA GRID */}
                        <div className="geotech-data-grid">
                          {[
                            ['Dominant Soil', geo.lab_summary?.dominant_uscs || '—'],
                            ['Max PI', geo.lab_summary?.pi_max != null ? String(geo.lab_summary.pi_max) : '—'],
                            ['PI Range', geo.lab_summary?.pi_min != null ? `${geo.lab_summary.pi_min}–${geo.lab_summary.pi_max}` : '—'],
                            ['GW Depth', geo.summary?.shallowest_groundwater_ft != null ? `${geo.summary.shallowest_groundwater_ft} ft` : 'Not enc.'],
                            ['Rock', geo.summary?.rock_encountered ? `${geo.summary.shallowest_rock_ft ?? '?'} ft` : 'Not enc.'],
                            ['Backfill', geo.summary?.backfill_suitability || '—'],
                          ].map(([label, val]) => (
                            <div key={label} className="geotech-data-cell">
                              <div className="geotech-data-label">{label}</div>
                              <div className={`geotech-data-val ${
                                label === 'Backfill' && val === 'SUITABLE' ? 'text-green' :
                                label === 'Backfill' && val === 'MARGINAL' ? 'text-yellow' :
                                label === 'Backfill' && val === 'UNSUITABLE' ? 'text-red' : ''
                              }`}>{val}</div>
                            </div>
                          ))}
                        </div>

                        {/* BACKFILL NOTE */}
                        {geo.summary?.backfill_notes && (
                          <p className="geotech-backfill-note">{geo.summary.backfill_notes}</p>
                        )}

                        {/* CROSS-REF FLAGS */}
                        {xref.length > 0 && (
                          <div className="geotech-xref">
                            <div className="geotech-xref-title">Scope Cross-Reference</div>
                            {xref.map((flag, i) => (
                              <div key={i} className={`geotech-flag geotech-flag-${flag.severity.toLowerCase()}`}>
                                <div className="geotech-flag-top">
                                  <span className={`geotech-flag-badge geotech-flag-badge-${flag.severity.toLowerCase()}`}>
                                    {flag.severity === 'OK' ? '✓ In Scope' : flag.severity === 'MISS' ? '✗ Missing' : 'ℹ Info'}
                                  </span>
                                  <span className="geotech-flag-label">{flag.label}</span>
                                </div>
                                <div className="geotech-flag-note">{flag.note}</div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* BORING SUMMARY */}
                        {geo.borings?.length > 0 && (
                          <div style={{ marginTop: 16 }}>
                            <div className="geotech-xref-title">Boring Log Summary</div>
                            <div className="geotech-boring-list">
                              {geo.borings.map((b, i) => (
                                <div key={i} className="geotech-boring-row">
                                  <span className="geotech-boring-id">{b.boring_id}</span>
                                  <span className="geotech-boring-layers">
                                    {b.soil_layers?.map(l => l.uscs_class).filter(Boolean).join(', ') || '—'}
                                  </span>
                                  <span className="geotech-boring-gw">
                                    {b.groundwater_depth_ft != null ? `GW @${b.groundwater_depth_ft}ft` : 'No GW'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })() : (
                    <div className="card geotech-panel-empty" style={{ marginTop: 16 }}>
                      <div className="geotech-panel-empty-inner">
                        <FileText size={20} style={{ opacity: 0.2 }} />
                        <span>Upload a geotech report in the sidebar to flag soil risks and cross-reference against this takeoff</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* EMPTY STATES */}
              {(activeTab === 'takeoff' || activeTab === 'report') && !result && loadingSheet !== activeImage && screeningSheet !== activeImage && screenings[activeImage]?.grade !== 'C' && (
                <div className="loading-state">
                  <ChevronRight size={32} style={{ opacity: 0.2 }} />
                  <p>Click &ldquo;Analyze Sheet&rdquo; to {qaMode ? 'run the QA review' : 'run the AI takeoff'}</p>
                </div>
              )}
              {activeTab === 'summary' && !result && (
                <div className="loading-state"><p className="text-muted">Analyze a sheet to see the summary</p></div>
              )}
            </div>
          </>
        )}

        {/* ASSISTANT CHAT PANEL — any result. QA results run the bid-clarification
            persona; takeoff results run the project-aware assistant that can
            answer questions, ask its own, and edit the takeoff on request. */}
        {result && (
          <div className={`chat-panel ${chatOpen ? 'chat-open' : 'chat-collapsed'}`}>
            <button
              className="chat-panel-header"
              onClick={() => {
                if (chatOpen) { setChatOpen(false); return }
                if (!chatMessages.length && !isQAResult) {
                  const open = openClarifications(result)
                  setChatMessages([{
                    role: 'assistant',
                    text: `I have the full takeoff loaded — ${result.items?.length || 0} line items${open.length ? `, ${open.length} still open` : ''}. Ask me why a quantity is what it is, what to verify before pricing, or tell me to change something ("set item 12 to 480 LF") and I'll update the takeoff.`,
                  }])
                }
                setChatOpen(true)
              }}
              aria-label={chatOpen ? 'Collapse chat' : 'Open assistant chat'}
            >
              <div className="chat-header-left">
                <MessageCircle size={14} />
                <span className="chat-header-title">{isQAResult ? 'Bid Clarification' : 'Ask the Copilot'}</span>
                {!chatOpen && chatMessages.length > 0 && (
                  <span className="chat-unread-badge">{chatMessages.filter(m => m.role === 'assistant').length}</span>
                )}
              </div>
              <div className="chat-header-right">
                {!chatOpen && chatMessages.length > 0 && (
                  <span className="chat-header-preview">
                    {chatMessages[chatMessages.length - 1]?.text?.slice(0, 60)}…
                  </span>
                )}
                {chatOpen ? <ChevronUp size={14} /> : <ChevronRight size={14} />}
              </div>
            </button>

            {chatOpen && (
              <div className="chat-body">
                <div className="chat-messages" ref={chatScrollRef}>
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
                      {msg.role === 'assistant' && (
                        <div className="chat-msg-avatar">AI</div>
                      )}
                      <div className="chat-msg-bubble">
                        {msg.loading
                          ? <div className="chat-typing"><span /><span /><span /></div>
                          : (msg.text || '').split('\n').map((line, j) => (
                              <span key={j}>{line}{j < msg.text.split('\n').length - 1 && <br />}</span>
                            ))
                        }
                      </div>
                    </div>
                  ))}
                </div>
                <div className="chat-input-row">
                  <input
                    className="chat-input"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage() } }}
                    placeholder={isQAResult ? 'Answer or ask a follow-up...' : 'Ask about the takeoff, or tell me what to change…'}
                    disabled={chatLoading}
                    autoFocus
                  />
                  <button
                    className="btn btn-primary chat-send-btn"
                    onClick={sendChatMessage}
                    disabled={chatLoading || !chatInput.trim()}
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* RESOLVE PANEL — one clarification at a time (analysis results) */}
        {!isQAResult && result?.clarifications?.length > 0 && (() => {
          const total = result.clarifications.length
          const done = total - openClarifications(result).length
          return (
            <div className={`chat-panel ${resolveOpen ? 'chat-open' : 'chat-collapsed'}`}>
              <button
                className="chat-panel-header"
                onClick={() => (resolveOpen ? setResolveOpen(false) : openResolvePanel())}
                aria-label={resolveOpen ? 'Collapse resolve panel' : 'Open resolve panel'}
              >
                <div className="chat-header-left">
                  <MessageCircle size={14} />
                  <span className="chat-header-title">Resolve Open Items</span>
                  <span className="resolve-progress-label">{done}/{total}</span>
                  <span className="resolve-progress-track"><span className="resolve-progress-fill" style={{ width: `${(done / total) * 100}%` }} /></span>
                </div>
                <div className="chat-header-right">
                  {!resolveOpen && done < total && (
                    <span className="chat-header-preview">{openClarifications(result)[0]?.question?.slice(0, 60)}…</span>
                  )}
                  {resolveOpen ? <ChevronUp size={14} /> : <ChevronRight size={14} />}
                </div>
              </button>

              {resolveOpen && (
                <div className="chat-body">
                  <div className="chat-messages" ref={resolveScrollRef}>
                    {resolveMsgs.map((msg, i) => (
                      <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
                        {msg.role === 'assistant' && <div className="chat-msg-avatar">AI</div>}
                        <div className="chat-msg-bubble">
                          {msg.loading
                            ? <div className="chat-typing"><span /><span /><span /></div>
                            : (msg.text || '').split('\n').map((line, j, arr) => (
                                <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
                              ))
                          }
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="chat-input-row">
                    <input
                      className="chat-input"
                      value={resolveInput}
                      onChange={e => setResolveInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendResolveAnswer() } }}
                      placeholder={done < total ? 'Answer (e.g. "8.5 ft"), or "skip"…' : 'All items resolved'}
                      disabled={resolveBusy || done >= total}
                    />
                    <button
                      className="btn btn-primary chat-send-btn"
                      onClick={sendResolveAnswer}
                      disabled={resolveBusy || !resolveInput.trim() || done >= total}
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })()}
      </main>

      {/* FEEDBACK MODAL */}
      {feedbackModal && (
        <div className="modal-overlay" onClick={() => setFeedbackModal(null)}>
          <div className="modal card feedback-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3>Rate This Takeoff</h3>
              <button className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={() => setFeedbackModal(null)}>
                <X size={16} />
              </button>
            </div>
            <p className="text-dim" style={{ fontSize: '0.82rem', marginBottom: 20, lineHeight: 1.6 }}>
              Your feedback goes directly to our team and is used to improve accuracy. Be specific — exact quantities help most.
            </p>

            <div style={{ marginBottom: 18 }}>
              <label className="titan-label" style={{ display: 'block', marginBottom: 10 }}>Overall Accuracy</label>
              <div className="feedback-stars">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} className={`feedback-star ${feedbackRating >= n ? 'active' : ''}`} onClick={() => setFeedbackRating(n)}>★</button>
                ))}
                {feedbackRating > 0 && (
                  <span className="feedback-star-label">
                    {['', 'Way off', 'Mostly wrong', 'Roughly right', 'Good', 'Excellent'][feedbackRating]}
                  </span>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label className="titan-label" style={{ display: 'block', marginBottom: 6 }}>What Was Wrong or Missing</label>
              <textarea
                className="input"
                rows={3}
                placeholder={'e.g. Missed 6" force main on sheet 3, 8" PVC should be 450 LF not 380 LF'}
                value={feedbackCorrections}
                onChange={e => setFeedbackCorrections(e.target.value)}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label className="titan-label" style={{ display: 'block', marginBottom: 6 }}>Other Comments</label>
              <textarea
                className="input"
                rows={2}
                placeholder="Anything else — plan quality, tool behavior, suggestions..."
                value={feedbackComments}
                onChange={e => setFeedbackComments(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setFeedbackModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitFeedback} disabled={!feedbackRating || feedbackSubmitting}>
                {feedbackSubmitting ? 'Submitting...' : 'Submit Feedback'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
