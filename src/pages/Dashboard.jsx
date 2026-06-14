import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, FileText, Download, RotateCcw, X, ChevronRight, BarChart3, Eye, GitCompare, Layers, ShieldAlert, MessageCircle, Send, ChevronUp } from 'lucide-react'
import { SYSTEM_PROMPT, QA_SYSTEM_PROMPT, SCREENING_PROMPT, GEOTECH_PROMPT } from '../utils/prompts'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
import * as XLSX from 'xlsx'
import './Dashboard.css'

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
  const [showOnboarding, setShowOnboarding] = useState(!localStorage.getItem('tc_onboarded'))
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
  const [qaMode, setQaMode] = useState(true)
  const [uploadedTakeoffName, setUploadedTakeoffName] = useState(null)
  const [uploadedTakeoffData, setUploadedTakeoffData] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [jobType, setJobType] = useState(() => localStorage.getItem('tc_job_type') || 'private')
  const [boreMethod, setBoreMethod] = useState('unknown')
  const [scopeNotes, setScopeNotes] = useState('')
  const [specsFileId, setSpecsFileId] = useState(null)
  const [specsFileName, setSpecsFileName] = useState(null)
  const [specsUploading, setSpecsUploading] = useState(false)
  const fileInputRef = useRef(null)
  const geotechInputRef = useRef(null)
  const takeoffInputRef = useRef(null)
  const specsInputRef = useRef(null)
  const workerRef = useRef(null)
  const pendingRef = useRef({})
  const chatScrollRef = useRef(null)
  const [sheetMaps, setSheetMaps] = useState({})    // { project_id: { sheets, loaded } }
  const [proceedingAnalysis, setProceedingAnalysis] = useState(false)
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
    worker.onerror = (e) => {
      console.error('Worker error:', e)
    }
    return () => worker.terminate()
  }, [])

  // Reset chat when switching sheets
  useEffect(() => {
    setChatOpen(false)
    setChatMessages([])
  }, [activeImage])

  // Auto-scroll chat to latest message
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [chatMessages])

  // Supabase Realtime: watch processing_jobs for this user and update image state
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel(`jobs-${user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'processing_jobs',
      }, async (payload) => {
        const { id: jobId, stage, progress, error: jobError, project_id, stage_detail } = payload.new

        if (stage === 'complete') {
          // Tiled multi-pass analysis finished — fetch the consolidated result
          const { data: ar } = await supabase
            .from('analysis_results')
            .select('result_json')
            .eq('job_id', jobId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          const idx = imagesRef.current.findIndex(img => img.job_id === jobId)
          setImages(prev => prev.map(img =>
            img.job_id === jobId ? { ...img, jobStage: stage, jobProgress: 100, jobDetail: stage_detail } : img
          ))
          if (ar?.result_json && idx !== -1) {
            setResults(prev => ({ ...prev, [idx]: ar.result_json }))
            setActiveImage(idx)
            setActiveTab('takeoff')
          }
          // History is written server-side on completion; refresh the list.
          loadHistory()
          return
        }

        if (stage === 'triage_complete') {
          // Fetch all classified sheets and their signed thumbnail URLs
          const { data: sheets } = await supabase
            .from('sheets')
            .select('id, page_number, classification, included_in_analysis, storage_path, sheet_number, sheet_title')
            .eq('project_id', project_id)
            .order('page_number')

          const sheetsWithUrls = await Promise.all((sheets || []).map(async (sheet) => {
            if (!sheet.storage_path) return { ...sheet, preview_url: null }
            const { data: signed } = await supabase.storage
              .from('plan-uploads')
              .createSignedUrl(sheet.storage_path, 7200)
            return { ...sheet, preview_url: signed?.signedUrl || null }
          }))

          const page1 = sheetsWithUrls.find(s => s.page_number === 1)
          setSheetMaps(prev => ({ ...prev, [project_id]: { sheets: sheetsWithUrls, loaded: true } }))
          setImages(prev => prev.map(img =>
            img.job_id === jobId
              ? { ...img, jobStage: stage, jobProgress: progress, jobError, preview: page1?.preview_url }
              : img
          ))
        } else {
          setImages(prev => prev.map(img =>
            img.job_id === jobId ? { ...img, jobStage: stage, jobProgress: progress, jobError, jobDetail: stage_detail } : img
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
                .createSignedUrl(sheet.storage_path, 7200)
              setImages(prev => prev.map(img =>
                img.job_id === jobId
                  ? { ...img, preview: signedData?.signedUrl || null, file_id: sheet.file_id }
                  : img
              ))
            } else if (sheet?.file_id) {
              setImages(prev => prev.map(img =>
                img.job_id === jobId ? { ...img, file_id: sheet.file_id } : img
              ))
            }
          }
        }
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [user])

  const buildChatSystemPrompt = (res) => {
    const questions = res.clarification_questions || []
    const misses = res.high_risk_misses || []
    const gaps = (res.scope_gaps || []).filter(s => s.status === 'MISSING')
    return `You are Takeoff Brain v1.0 operating in CHAT MODE. A QA Bid Risk Report has already been generated for this bid package. Your role is to resolve the open clarification questions by conversing with the estimator — one question at a time — so the bid can be finalized with confidence.

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

  const sendChatMessage = async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return
    setChatInput('')
    const history = [...chatMessages, { role: 'user', text }]
    setChatMessages([...history, { role: 'assistant', text: null, loading: true }])
    setChatLoading(true)
    try {
      const res = results[activeImage]
      const systemPrompt = buildChatSystemPrompt(res)
      const apiMessages = history.map(m => ({ role: m.role, content: m.text }))
      const reply = await callChatApi(systemPrompt, apiMessages)
      setChatMessages([...history, { role: 'assistant', text: reply }])
    } catch (err) {
      setChatMessages([...history, { role: 'assistant', text: `Error: ${err.message}` }])
    } finally {
      setChatLoading(false)
    }
  }

  useEffect(() => { localStorage.setItem('tc_job_type', jobType) }, [jobType])

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
      .select('id, plan_filename, screening_grade, line_item_count, created_at, result_json')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(15)
    setJobHistory(data || [])
    setHistoryLoading(false)
  }, [user])

  useEffect(() => { loadHistory() }, [loadHistory])

  const restoreJob = (job) => {
    if (!job.result_json) return
    setImages([{ name: job.plan_filename || 'Past Job', preview: null }])
    setResults({ 0: job.result_json })
    setScreenings(job.screening_grade ? { 0: { grade: job.screening_grade } } : {})
    setActiveImage(0)
    setActiveTab('takeoff')
    setActiveJobId(job.id)
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
    setFeedbackSubmitting(false)
    setFeedbackModal(null)
    setFeedbackRating(0)
    setFeedbackComments('')
    setFeedbackCorrections('')
  }

  const dismissOnboarding = () => {
    localStorage.setItem('tc_onboarded', '1')
    setShowOnboarding(false)

    if (user && (onboardName.trim() || onboardCompany.trim())) {
      supabase.from('profiles').upsert({
        id: user.id,
        email: user.email,
        full_name: onboardName.trim() || null,
        company: onboardCompany.trim() || null,
        phone: onboardPhone.trim() || null,
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

          // Step 3: Confirm upload → kicks off background processing
          await fetch('/api/confirm-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ job_id, sheet_id, storage_path, project_id }),
          })

          // Step 4: Update image state — Realtime will fill in file_id + preview when ready
          setImages(prev => prev.map(img =>
            img.tempId === tempId
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
          setImages(prev => prev.filter(img => img.tempId !== tempId))
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

  const removeImage = (idx) => {
    setImages(prev => prev.filter((_, i) => i !== idx))
    const newResults = { ...results }
    delete newResults[idx]
    setResults(newResults)
    const newScreenings = { ...screenings }
    delete newScreenings[idx]
    setScreenings(newScreenings)
    if (activeImage >= idx && activeImage > 0) setActiveImage(activeImage - 1)
  }

  const callApi = async (img, prompt, maxTokens = 4096) => {
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token

    if (img.file_id) {
      // PDF already uploaded — reference by file_id (no base64 transfer)
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2) + Date.now()
        pendingRef.current[id] = { resolve, reject }
        workerRef.current.postMessage({ id, file_id: img.file_id, specs_file_id: specsFileId || undefined, prompt, accessToken, maxTokens })
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
      workerRef.current.postMessage({ id, fileBlock, specs_file_id: specsFileId || undefined, prompt, accessToken, maxTokens })
    })
  }

  const callApiMulti = async (imgArray, prompt, maxTokens = 4096) => {
    const { data: { session } } = await supabase.auth.getSession()
    const imageBlocks = imgArray.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
    }))

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...imageBlocks]
        }],
        maxTokens,
      })
    })

    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`API ${response.status}: ${errBody.substring(0, 200)}`)
    }

    const data = await response.json()
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    const text = data.content.map(b => b.type === 'text' ? b.text : '').join('')
    let parsed
    try {
      parsed = JSON.parse(text.replace(/```json\s?|```/g, '').trim())
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
      else throw new Error('Could not parse response as JSON')
    }
    return parsed
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

  const handleTakeoffUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    setUploadedTakeoffName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const workbook = XLSX.read(ev.target.result, { type: 'array' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
        setUploadedTakeoffData(rows)
      } catch (err) {
        console.error('Takeoff parse error:', err)
        setUploadedTakeoffData(null)
      }
    }
    reader.readAsArrayBuffer(file)
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

      if (screening.grade !== 'C') {
        await analyzeSheet(idx)
      }
    } catch (err) {
      console.error('Screening error:', err)
      setError(`Screening failed for sheet ${idx + 1}: ${err.message}`)
    } finally {
      setScreeningSheet(null)
    }
  }

  const analyzeSheet = async (idx) => {
    const img = images[idx]
    if (!img || img.uploading) return
    setLoading(true)
    setLoadingSheet(idx)
    setError(null)

    try {
      const jobCtx = buildJobContext()
      let prompt
      if (qaMode && uploadedTakeoffData) {
        prompt = QA_SYSTEM_PROMPT + jobCtx +
          `ESTIMATOR'S SUBMITTED TAKEOFF (${uploadedTakeoffName}):\n` +
          JSON.stringify(uploadedTakeoffData, null, 2) +
          `\n\n---\n\nReview the plan sheet above against the estimator's takeoff. Produce the full Bid Risk Report. Respond ONLY with the JSON object, no other text.`
      } else if (qaMode) {
        prompt = QA_SYSTEM_PROMPT + jobCtx +
          `No estimator takeoff was uploaded. Read the plan sheet and produce the Bid Risk Report based on plan review alone. Flag all scope gaps and items an estimator should not miss. Respond ONLY with the JSON object, no other text.`
      } else {
        prompt = SYSTEM_PROMPT + jobCtx +
          `Analyze this construction plan sheet and produce a complete quantity takeoff. Extract every identifiable item. Be thorough but honest about confidence levels. Respond ONLY with the JSON object, no other text.`
      }

      const parsed = await callApi(img, prompt)
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
        const riskCount = qaMode
          ? (parsed?.high_risk_misses?.length || 0) + (parsed?.scope_gaps?.filter(s => s.status === 'MISSING').length || 0)
          : (rm.geotech_concerns?.length || 0) + (rm.missed_items?.length || 0) + (rm.bid_risk_items?.length || 0)
        supabase.from('jobs').insert({
          user_id: user.id,
          plan_filename: images[idx]?.name || null,
          geotech_filename: geotechFileName || null,
          screening_grade: screenings[idx]?.grade || null,
          screening_rationale: screenings[idx]?.rationale || null,
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
    for (let i = 0; i < images.length; i++) {
      if (!results[i]) await analyzeSheet(i)
    }
    setProcessingAll(false)
  }

  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`

  const buildRiskFlagsForExport = (result, geo) => {
    const lines = []
    const rm = result?.risk_and_misses
    // geotech
    if (geo?.flags) {
      const gf = geo.flags
      if (gf.dewatering_required)       lines.push(['GEOTECH', 'WARN', 'Dewatering Required',          gf.dewatering_note || ''])
      if (gf.rock_excavation_required)  lines.push(['GEOTECH', 'WARN', 'Rock Excavation Required',      gf.rock_note || ''])
      if (gf.lime_stabilization_required) lines.push(['GEOTECH', 'WARN', 'Lime Stabilization Required', gf.lime_note || ''])
      if (gf.select_fill_required)      lines.push(['GEOTECH', 'WARN', 'Imported Select Fill Required', gf.select_fill_note || ''])
      if (gf.spoil_removal_required)    lines.push(['GEOTECH', 'WARN', 'Spoil Haul-Off Required',       gf.spoil_note || ''])
    }
    if (rm?.geotech?.geotech_flags) lines.push(['GEOTECH', 'INFO', 'AI Geotech Note', rm.geotech.geotech_flags])
    // scope gaps
    const CHECKS = [
      ['trench safety', 'Trench Safety (OSHA >5 ft)', 'Required on trenches deeper than 5 ft. Often excluded.'],
      ['erosion control', 'Erosion Control / SWPPP', 'Silt fence, rock dams, inlet protection. Required on permitted sites.'],
      ['testing', 'Testing & Inspection', 'Mandrel, pressure, leakage, video, compaction. May be at contractor expense.'],
      ['traffic control', 'Traffic Control', 'Required for ROW work. TCP, flaggers, signs — $5–15K depending on road class.'],
      ['mobilization', 'Mobilization / Demobilization', 'Equipment move-in, site setup. Commonly omitted.'],
      ['permits', 'Permit & Inspection Fees', 'City/county/TxDOT permits and tap fees.'],
    ]
    const allItems = result?.items || []
    CHECKS.forEach(([key, label, hint]) => {
      const inScope = allItems.some(it => (it.description + ' ' + (it.notes || '')).toLowerCase().includes(key))
      const aiGap = (rm?.scope_gaps || []).find(s => s.item?.toLowerCase().includes(key.split(' ')[0]))
      if (aiGap?.status === 'NOT APPLICABLE') return
      lines.push(['SCOPE', inScope || aiGap?.status === 'OK' ? 'OK' : 'MISSING', label, inScope ? 'In scope' : aiGap?.note || hint])
    })
    // low confidence
    allItems.filter(it => it.confidence === 'LOW').forEach(it => {
      lines.push(['INFERRED', 'VERIFY', it.description, it.notes || ''])
    })
    return lines
  }

  const exportCSV = (allSheets = false) => {
    const date = new Date().toISOString().split('T')[0]
    const entries = allSheets ? Object.entries(results) : [[activeImage, results[activeImage]]]
    const firstResult = entries[0]?.[1]
    const sc = screenings[activeImage] || firstResult?.plan_screening
    const si = firstResult?.sheet_info || {}

    const lines = []
    // header block
    lines.push(['TITAN AI TAKEOFF REPORT'])
    lines.push(['Generated:', date, '', 'takeoffcopilot.com'])
    lines.push([])
    lines.push(['Project:', q(si.project_name || '—')])
    lines.push(['Engineer:', q(si.engineer || '—')])
    if (geotechResult?.report_info?.engineer_firm) lines.push(['Geotech Firm:', q(geotechResult.report_info.engineer_firm)])
    if (sc) lines.push(['Plan Grade:', `${sc.grade} — ${sc.grade_label}`, '', q(sc.grade_rationale)])
    lines.push([])
    // data
    lines.push([allSheets ? 'Sheet' : '', 'Item No', 'Category', 'Description', 'Unit', 'Quantity', 'Confidence', 'Notes'].filter((_, i) => allSheets || i > 0))
    entries.forEach(([idx, res]) => {
      if (!res) return
      res.items.forEach(item => {
        const row = allSheets ? [images[+idx]?.name || `Sheet ${+idx + 1}`] : []
        row.push(item.item_no, item.category, q(item.description), item.unit, item.quantity, item.confidence, q(item.notes || ''))
        lines.push(row)
      })
    })
    // risk flags footer
    const flagRows = buildRiskFlagsForExport(firstResult, geotechResult)
    if (flagRows.length > 0) {
      lines.push([])
      lines.push(['RISK FLAGS'])
      lines.push(['Section', 'Status', 'Item', 'Note'])
      flagRows.forEach(r => lines.push(r.map(q)))
    }

    const csv = lines.map(r => Array.isArray(r) ? r.join(',') : r).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `takeoff_${allSheets ? 'all_sheets' : images[activeImage]?.name?.replace(/[^a-z0-9]/gi, '_') || 'sheet'}_${date}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportPDF = () => {
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const res = results[activeImage]
    if (!res) return
    const sc = screenings[activeImage] || res.plan_screening
    const si = res.sheet_info || {}
    const flagRows = buildRiskFlagsForExport(res, geotechResult)

    const gradeColor = sc?.grade === 'A' ? '#2ECC71' : sc?.grade === 'B' ? '#F1C40F' : '#E8372C'
    const confColor = c => c === 'HIGH' ? '#2ECC71' : c === 'MEDIUM' ? '#F1C40F' : '#E8372C'

    const itemRows = res.items.map(item => `
      <tr>
        <td class="mono muted">${item.item_no}</td>
        <td><span class="cat">${item.category}</span></td>
        <td>${item.description}</td>
        <td class="mono center">${item.unit}</td>
        <td class="mono bold center">${item.quantity}</td>
        <td class="center"><span class="conf" style="color:${confColor(item.confidence)};border-color:${confColor(item.confidence)}20">${item.confidence}</span></td>
        <td class="small muted">${item.notes || ''}</td>
      </tr>`).join('')

    const riskSections = { GEOTECH: [], SCOPE: [], INFERRED: [] }
    flagRows.forEach(([section, status, label, note]) => {
      riskSections[section]?.push({ status, label, note })
    })

    const riskIcon = s => s === 'OK' ? '✓' : s === 'MISSING' || s === 'WARN' ? s === 'WARN' ? '▲' : '✗' : s === 'VERIFY' ? '?' : 'ℹ'
    const riskColor = s => s === 'OK' ? '#2ECC71' : s === 'MISSING' ? '#E8372C' : s === 'WARN' ? '#F1C40F' : '#888888'

    const renderRiskCol = (title, items, accent) => items.length === 0 ? '' : `
      <div class="risk-col">
        <div class="risk-col-head" style="color:${accent}">${title}</div>
        ${items.map(f => `
          <div class="risk-item">
            <span class="risk-icon" style="color:${riskColor(f.status)}">${riskIcon(f.status)}</span>
            <div>
              <div class="risk-label" style="color:${riskColor(f.status)}">${f.label}</div>
              <div class="risk-note">${f.note}</div>
            </div>
          </div>`).join('')}
      </div>`

    const geotechBlock = geotechResult ? `
      <div class="section">
        <div class="section-head">Geotech Data — ${geotechFileName || 'Report'}</div>
        <div class="geo-grid">
          ${[
            ['Dominant Soil', geotechResult.lab_summary?.dominant_uscs],
            ['Max PI', geotechResult.lab_summary?.pi_max],
            ['GW Depth', geotechResult.summary?.shallowest_groundwater_ft != null ? `${geotechResult.summary.shallowest_groundwater_ft} ft` : null],
            ['Rock', geotechResult.summary?.rock_encountered ? `${geotechResult.summary.shallowest_rock_ft ?? '?'} ft` : 'Not enc.'],
            ['Backfill', geotechResult.summary?.backfill_suitability],
          ].filter(([,v]) => v != null).map(([k,v]) => `
            <div class="geo-cell">
              <div class="geo-label">${k}</div>
              <div class="geo-val" style="color:${k === 'Backfill' ? (v === 'SUITABLE' ? '#2ECC71' : v === 'MARGINAL' ? '#F1C40F' : '#E8372C') : '#F5F5F0'}">${v}</div>
            </div>`).join('')}
        </div>
        ${geotechResult.summary?.backfill_notes ? `<p class="geo-note">${geotechResult.summary.backfill_notes}</p>` : ''}
      </div>` : ''

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>6 Signal Takeoff Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Outfit',sans-serif; background:#fff; color:#111; font-size:10pt; line-height:1.5; }
  .page { max-width:1100px; margin:0 auto; padding:32px 40px; }

  /* HEADER */
  .report-header { display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:16px; border-bottom:3px solid #E8372C; margin-bottom:20px; }
  .brand { font-family:'Bebas Neue',sans-serif; font-size:28pt; letter-spacing:3px; color:#111; line-height:1; }
  .brand span { color:#E8372C; }
  .brand-sub { font-family:'JetBrains Mono',monospace; font-size:7pt; letter-spacing:2px; color:#888; text-transform:uppercase; margin-top:2px; }
  .report-meta { text-align:right; font-size:8pt; color:#555; font-family:'JetBrains Mono',monospace; }
  .report-meta strong { color:#111; }

  /* PROJECT BLOCK */
  .project-block { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:16px; }
  .proj-cell { background:#f5f5f5; border-left:3px solid #E8372C; padding:8px 12px; }
  .proj-label { font-size:7pt; letter-spacing:1.5px; text-transform:uppercase; color:#888; font-family:'JetBrains Mono',monospace; margin-bottom:2px; }
  .proj-val { font-size:10pt; font-weight:600; color:#111; }

  /* GRADE BADGE */
  .grade-block { display:flex; align-items:center; gap:16px; padding:12px 16px; border:1px solid #ddd; border-left:4px solid ${gradeColor}; margin-bottom:20px; background:#fafafa; }
  .grade-circle { width:44px; height:44px; border-radius:50%; border:2px solid ${gradeColor}; display:flex; align-items:center; justify-content:center; font-family:'Bebas Neue',sans-serif; font-size:20pt; color:${gradeColor}; flex-shrink:0; }
  .grade-info-label { font-size:9pt; font-weight:700; color:${gradeColor}; }
  .grade-info-sub { font-size:8pt; color:#555; font-family:'JetBrains Mono',monospace; }
  .grade-rationale { font-size:9pt; color:#444; flex:1; line-height:1.5; border-left:1px solid #ddd; padding-left:16px; }

  /* SECTION */
  .section { margin-bottom:24px; }
  .section-head { font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#E8372C; padding:6px 0; border-bottom:1px solid #E8372C; margin-bottom:10px; }

  /* TABLE */
  table { width:100%; border-collapse:collapse; font-size:8.5pt; }
  thead { background:#111; }
  th { padding:6px 10px; text-align:left; font-family:'JetBrains Mono',monospace; font-size:7pt; letter-spacing:1px; text-transform:uppercase; color:#E8372C; white-space:nowrap; }
  td { padding:6px 10px; border-bottom:1px solid #eee; vertical-align:top; }
  tr:nth-child(even) td { background:#fafafa; }
  .mono { font-family:'JetBrains Mono',monospace; }
  .muted { color:#888; }
  .bold { font-weight:700; }
  .center { text-align:center; }
  .small { font-size:7.5pt; color:#666; }
  .cat { display:inline-block; font-family:'JetBrains Mono',monospace; font-size:7pt; background:#f0f0f0; border:1px solid #ddd; padding:1px 6px; border-radius:2px; color:#444; }
  .conf { display:inline-block; font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:700; padding:1px 8px; border:1px solid; border-radius:2px; letter-spacing:0.5px; }

  /* RISK FLAGS */
  .risk-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:0; border:1px solid #ddd; }
  .risk-col { border-right:1px solid #ddd; padding:12px; }
  .risk-col:last-child { border-right:none; }
  .risk-col-head { font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding-bottom:8px; margin-bottom:8px; border-bottom:1px solid #eee; }
  .risk-item { display:flex; gap:8px; margin-bottom:8px; align-items:flex-start; }
  .risk-icon { font-size:9pt; width:14px; flex-shrink:0; margin-top:1px; font-family:'JetBrains Mono',monospace; }
  .risk-label { font-size:8.5pt; font-weight:600; line-height:1.3; }
  .risk-note { font-size:7.5pt; color:#666; line-height:1.4; margin-top:1px; }

  /* TOP RISKS */
  .top-risk-block { background:#FFF8E1; border-left:4px solid #F1C40F; padding:10px 14px; margin-bottom:16px; font-size:9pt; color:#444; line-height:1.6; }
  .top-risk-label { font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#B8860B; margin-bottom:4px; }

  /* GEOTECH */
  .geo-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:10px; }
  .geo-cell { background:#f5f5f5; padding:8px 10px; }
  .geo-label { font-family:'JetBrains Mono',monospace; font-size:7pt; color:#888; letter-spacing:1px; text-transform:uppercase; margin-bottom:3px; }
  .geo-val { font-size:10pt; font-weight:700; }
  .geo-note { font-size:8.5pt; color:#555; line-height:1.5; background:#f9f9f9; padding:8px 12px; border-left:3px solid #ddd; }

  /* FOOTER */
  .report-footer { margin-top:32px; padding-top:12px; border-top:1px solid #ddd; display:flex; justify-content:space-between; font-size:7.5pt; color:#999; font-family:'JetBrains Mono',monospace; }

  @media print {
    body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .page { padding:16px 20px; }
    .no-print { display:none !important; }
  }
</style>
</head>
<body>
<div class="page">

  <div class="report-header">
    <div>
      <div class="brand">TITAN <span>AI</span></div>
      <div class="brand-sub">Takeoff Copilot // Quantity Report</div>
    </div>
    <div class="report-meta">
      <div><strong>${date}</strong></div>
      <div>takeoffcopilot.com</div>
      ${si.sheet_number ? `<div>Sheet ${si.sheet_number}</div>` : ''}
    </div>
  </div>

  <div class="project-block">
    <div class="proj-cell">
      <div class="proj-label">Project</div>
      <div class="proj-val">${si.project_name || '—'}</div>
    </div>
    <div class="proj-cell">
      <div class="proj-label">Engineer</div>
      <div class="proj-val">${si.engineer || '—'}</div>
    </div>
    <div class="proj-cell">
      <div class="proj-label">Sheet Title</div>
      <div class="proj-val">${si.sheet_title || images[activeImage]?.name || '—'}</div>
    </div>
  </div>

  ${sc ? `
  <div class="grade-block">
    <div class="grade-circle">${sc.grade}</div>
    <div>
      <div class="grade-info-label">${sc.grade_label}</div>
      <div class="grade-info-sub">Expected accuracy: ${sc.expected_accuracy_range}</div>
    </div>
    <div class="grade-rationale">${sc.grade_rationale}</div>
  </div>` : ''}

  ${res.risk_and_misses?.top_risks ? `
  <div class="top-risk-block">
    <div class="top-risk-label">Top Risks</div>
    ${res.risk_and_misses.top_risks}
  </div>` : ''}

  <div class="section">
    <div class="section-head">Quantity Takeoff — ${res.items.length} Items // ${res.summary?.high_confidence_count || 0} High // ${res.summary?.medium_confidence_count || 0} Medium // ${res.summary?.low_confidence_count || 0} Low</div>
    <table>
      <thead>
        <tr><th>#</th><th>Cat</th><th>Description</th><th>Unit</th><th>Qty</th><th>Conf</th><th>Notes</th></tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>

  ${(flagRows.length > 0) ? `
  <div class="section">
    <div class="section-head">Risk Flags</div>
    <div class="risk-grid">
      ${renderRiskCol('Geotech Warnings', riskSections.GEOTECH, '#E8372C')}
      ${renderRiskCol('Commonly Missed Scope', riskSections.SCOPE, '#B8860B')}
      ${renderRiskCol('AI Inferred — Verify', riskSections.INFERRED, '#888')}
    </div>
  </div>` : ''}

  ${geotechBlock}

  <div class="report-footer">
    <span>Generated by 6 Signal Takeoff Copilot</span>
    <span>This report is AI-generated. Verify all quantities before pricing.</span>
    <span>${date}</span>
  </div>

</div>
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank', 'width=1100,height=900')
    win.onload = () => { URL.revokeObjectURL(url); win.focus(); win.print() }
  }

  const exportQAPDF = () => {
    const res = results[activeImage]
    if (!res?.executive_risk_summary) return
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const sc = screenings[activeImage] || res.plan_screening
    const si = res.sheet_info || {}
    const conf = res.estimator_confidence_score || {}

    const gradeColor = sc?.grade === 'A' ? '#2ECC71' : sc?.grade === 'B' ? '#F1C40F' : '#E8372C'
    const riskColor = r => r === 'HIGH' ? '#E8372C' : r === 'MEDIUM' ? '#F1C40F' : '#2ECC71'
    const scoreColor = g => ({ A: '#2ECC71', B: '#84cc16', C: '#F1C40F', D: '#f97316', F: '#E8372C' }[g] || '#888')
    const statusColor = s => s === 'CONFIRMED' ? '#2ECC71' : s === 'APPEARS HIGH' ? '#F1C40F' : s === 'UNVERIFIABLE' ? '#888' : '#E8372C'
    const scopeColor = s => s === 'PRESENT' ? '#2ECC71' : s === 'MISSING' ? '#E8372C' : '#888'
    const scopeIcon = s => s === 'PRESENT' ? '&#10003;' : s === 'MISSING' ? '&#10007;' : '?'

    const highRiskRows = (res.high_risk_misses || []).map(m => `
      <tr>
        <td class="center"><span class="rbadge" style="background:${riskColor(m.risk_level)}18;color:${riskColor(m.risk_level)};border-color:${riskColor(m.risk_level)}50">${m.risk_level}</span></td>
        <td class="bold">${m.item}</td>
        <td class="mono muted">${m.estimator_quantity || '—'}</td>
        <td class="mono">${m.plan_read_quantity || '—'}</td>
        <td class="small muted">${m.note || ''}</td>
      </tr>`).join('')

    const recheckRows = (res.quantity_items_to_recheck || []).map(q => `
      <tr>
        <td class="center"><span class="rbadge" style="background:${statusColor(q.qa_status)}18;color:${statusColor(q.qa_status)};border-color:${statusColor(q.qa_status)}50;font-size:6.5pt;white-space:nowrap">${q.qa_status}</span></td>
        <td>${q.item || ''}</td>
        <td class="mono muted">${q.estimator_quantity || '—'}</td>
        <td class="mono">${q.plan_read_quantity || '—'}</td>
        <td class="small muted">${q.note || ''}</td>
      </tr>`).join('')

    const scopeRows = (res.scope_gaps || []).map(s => `
      <div class="scope-row" style="border-left-color:${scopeColor(s.status)}">
        <span class="scope-icon" style="color:${scopeColor(s.status)}">${scopeIcon(s.status)}</span>
        <div>
          <div class="scope-item">${s.item}${s.risk_level && s.status !== 'PRESENT' ? ` <span class="rbadge" style="background:${riskColor(s.risk_level)}18;color:${riskColor(s.risk_level)};border-color:${riskColor(s.risk_level)}50">${s.risk_level}</span>` : ''}</div>
          <div class="scope-note">${s.note || ''}</div>
        </div>
      </div>`).join('')

    const conflictRows = (res.geotech_and_plan_conflicts || []).map(c => `
      <div class="conflict-row">
        <div class="conflict-top">
          <span class="rbadge" style="background:${riskColor(c.risk_level)}18;color:${riskColor(c.risk_level)};border-color:${riskColor(c.risk_level)}50">${c.risk_level}</span>
          <strong>${c.conflict}</strong>
        </div>
        <div class="conflict-sub"><span class="muted">Geotech:</span> ${c.geotech_finding} &nbsp;|&nbsp; <span class="muted">Takeoff:</span> ${c.estimator_response}</div>
        <div class="conflict-note">${c.note}</div>
      </div>`).join('')

    const questionRows = (res.clarification_questions || []).map(q => `
      <div class="q-row">
        <span class="rbadge" style="background:${riskColor(q.priority)}18;color:${riskColor(q.priority)};border-color:${riskColor(q.priority)}50;flex-shrink:0">${q.priority}</span>
        <div>
          <div class="q-text">${q.question}</div>
          ${q.context ? `<div class="small muted">${q.context}</div>` : ''}
        </div>
      </div>`).join('')

    const assumptionRows = (res.assumptions_needing_approval || []).map(a => `
      <div class="assume-row">
        <div class="assume-text">${a.assumption}</div>
        <div class="small"><span class="muted">Risk:</span> ${a.risk_if_wrong}</div>
        <div class="small" style="margin-top:2px"><span class="muted">Action:</span> ${a.recommended_action}</div>
      </div>`).join('')

    const bidNotes = (res.recommended_bid_notes || []).map(n => `<li>${n}</li>`).join('')

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>6 Signal QA Bid Risk Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Outfit',sans-serif; background:#fff; color:#111; font-size:10pt; line-height:1.5; }
  .page { max-width:1100px; margin:0 auto; padding:32px 40px; }
  .report-header { display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:16px; border-bottom:3px solid #0057FF; margin-bottom:20px; }
  .brand { font-family:'Bebas Neue',sans-serif; font-size:24pt; letter-spacing:3px; color:#111; line-height:1; }
  .brand span { color:#0057FF; }
  .brand-sub { font-family:'JetBrains Mono',monospace; font-size:7pt; letter-spacing:2px; color:#888; text-transform:uppercase; margin-top:2px; }
  .qa-pill { display:inline-block; background:#0057FF; color:#fff; font-family:'JetBrains Mono',monospace; font-size:7pt; letter-spacing:2px; padding:2px 8px; border-radius:3px; margin-top:6px; }
  .report-meta { text-align:right; font-size:8pt; color:#555; font-family:'JetBrains Mono',monospace; }
  .report-meta strong { color:#111; }
  .project-block { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:16px; }
  .proj-cell { background:#f5f5f5; border-left:3px solid #0057FF; padding:8px 12px; }
  .proj-label { font-size:7pt; letter-spacing:1.5px; text-transform:uppercase; color:#888; font-family:'JetBrains Mono',monospace; margin-bottom:2px; }
  .proj-val { font-size:10pt; font-weight:600; color:#111; }
  .grade-block { display:flex; align-items:center; gap:16px; padding:12px 16px; border:1px solid #ddd; border-left:4px solid ${gradeColor}; margin-bottom:16px; background:#fafafa; }
  .grade-circle { width:44px; height:44px; border-radius:50%; border:2px solid ${gradeColor}; display:flex; align-items:center; justify-content:center; font-family:'Bebas Neue',sans-serif; font-size:20pt; color:${gradeColor}; flex-shrink:0; }
  .grade-info-label { font-size:9pt; font-weight:700; color:${gradeColor}; }
  .grade-info-sub { font-size:8pt; color:#555; font-family:'JetBrains Mono',monospace; }
  .grade-rationale { font-size:9pt; color:#444; flex:1; line-height:1.5; border-left:1px solid #ddd; padding-left:16px; }
  .top-row { display:grid; grid-template-columns:1fr 200px; gap:16px; margin-bottom:20px; }
  .exec-card { background:#f0f4ff; border:1px solid #c7d9ff; padding:16px; border-left:4px solid #0057FF; }
  .exec-title { font-family:'JetBrains Mono',monospace; font-size:7pt; letter-spacing:2px; text-transform:uppercase; color:#0057FF; margin-bottom:8px; font-weight:600; }
  .exec-text { font-size:9.5pt; line-height:1.7; color:#222; }
  .score-card { background:#f9f9f9; border:1px solid #e0e0e0; padding:16px; text-align:center; display:flex; flex-direction:column; align-items:center; }
  .score-num { font-family:'Bebas Neue',sans-serif; font-size:52pt; line-height:1; color:${scoreColor(conf.grade)}; }
  .score-grade { font-family:'JetBrains Mono',monospace; font-size:9pt; color:${scoreColor(conf.grade)}; font-weight:700; letter-spacing:2px; margin-top:2px; }
  .score-lbl { font-family:'JetBrains Mono',monospace; font-size:7pt; color:#888; letter-spacing:1px; text-transform:uppercase; margin-top:2px; }
  .score-rat { font-size:8pt; color:#555; line-height:1.4; margin-top:8px; text-align:left; }
  .bid-ready { margin-top:8px; font-size:8pt; font-weight:700; padding:4px 10px; border-radius:3px; background:${conf.ready_to_bid ? '#dcfce7' : '#fee2e2'}; color:${conf.ready_to_bid ? '#16a34a' : '#dc2626'}; }
  .section { margin-bottom:24px; }
  .section-head { font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:600; letter-spacing:2px; text-transform:uppercase; color:#0057FF; padding:6px 0; border-bottom:1.5px solid #0057FF; margin-bottom:12px; }
  table { width:100%; border-collapse:collapse; font-size:8.5pt; }
  thead { background:#111; }
  th { padding:6px 10px; text-align:left; font-family:'JetBrains Mono',monospace; font-size:7pt; letter-spacing:1px; text-transform:uppercase; color:#0057FF; white-space:nowrap; }
  td { padding:6px 10px; border-bottom:1px solid #eee; vertical-align:top; }
  tr:nth-child(even) td { background:#fafafa; }
  .mono { font-family:'JetBrains Mono',monospace; }
  .muted { color:#888; }
  .bold { font-weight:700; }
  .center { text-align:center; }
  .small { font-size:7.5pt; color:#666; }
  .rbadge { display:inline-block; font-family:'JetBrains Mono',monospace; font-size:7pt; font-weight:700; padding:1px 7px; border:1px solid; border-radius:2px; letter-spacing:0.5px; }
  .scope-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .scope-row { display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border-left:3px solid #ddd; background:#fafafa; }
  .scope-icon { font-size:10pt; font-weight:700; width:16px; flex-shrink:0; font-family:'JetBrains Mono',monospace; margin-top:1px; }
  .scope-item { font-size:9pt; font-weight:600; margin-bottom:2px; }
  .scope-note { font-size:7.5pt; color:#666; line-height:1.4; }
  .conflict-row { padding:10px 0; border-bottom:1px solid #eee; }
  .conflict-row:last-child { border-bottom:none; }
  .conflict-top { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:9pt; font-weight:600; }
  .conflict-sub { font-size:8pt; color:#555; margin-bottom:4px; }
  .conflict-note { font-size:8.5pt; color:#333; padding:6px 10px; background:#f5f5f5; border-left:2px solid #ddd; line-height:1.5; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-bottom:24px; }
  .q-row { display:flex; gap:10px; align-items:flex-start; padding:8px 0; border-bottom:1px solid #eee; }
  .q-row:last-child { border-bottom:none; }
  .q-text { font-size:9pt; font-weight:600; line-height:1.4; margin-bottom:2px; }
  .assume-row { padding:8px 0; border-bottom:1px solid #eee; }
  .assume-row:last-child { border-bottom:none; }
  .assume-text { font-size:9pt; font-weight:600; margin-bottom:4px; }
  .bid-notes { list-style:none; padding:0; display:flex; flex-direction:column; gap:8px; }
  .bid-notes li { font-size:9pt; line-height:1.6; padding:8px 14px; border-left:3px solid #0057FF; background:#f0f4ff; color:#222; }
  .report-footer { margin-top:32px; padding-top:12px; border-top:1px solid #ddd; display:flex; justify-content:space-between; font-size:7.5pt; color:#999; font-family:'JetBrains Mono',monospace; }
  @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } .page { padding:16px 20px; } }
</style>
</head>
<body>
<div class="page">
  <div class="report-header">
    <div>
      <div class="brand">TAKEOFF <span>COPILOT</span></div>
      <div class="brand-sub">6 Signal // Bid Risk Analysis</div>
      <div class="qa-pill">QA Mode</div>
    </div>
    <div class="report-meta">
      <div><strong>${date}</strong></div>
      <div>takeoffcopilot.com</div>
      ${si.sheet_number ? `<div>Sheet ${si.sheet_number}</div>` : ''}
    </div>
  </div>
  <div class="project-block">
    <div class="proj-cell"><div class="proj-label">Project</div><div class="proj-val">${si.project_name || '—'}</div></div>
    <div class="proj-cell"><div class="proj-label">Sheet</div><div class="proj-val">${si.sheet_title || images[activeImage]?.name || '—'}</div></div>
    <div class="proj-cell"><div class="proj-label">Engineer</div><div class="proj-val">${si.engineer || '—'}</div></div>
  </div>
  ${sc ? `<div class="grade-block">
    <div class="grade-circle">${sc.grade}</div>
    <div><div class="grade-info-label">${sc.grade_label}</div><div class="grade-info-sub">Expected accuracy: ${sc.expected_accuracy_range}</div></div>
    <div class="grade-rationale">${sc.grade_rationale}</div>
  </div>` : ''}
  <div class="top-row">
    <div class="exec-card">
      <div class="exec-title">Executive Risk Summary</div>
      <div class="exec-text">${res.executive_risk_summary}</div>
    </div>
    <div class="score-card">
      <div class="score-num">${conf.score ?? '—'}</div>
      <div class="score-grade">Grade ${conf.grade ?? '—'}</div>
      <div class="score-lbl">Estimator Confidence</div>
      <div class="score-rat">${conf.rationale || ''}</div>
      <div class="bid-ready">${conf.ready_to_bid ? '&#10003; Ready to Bid' : '&#10007; Needs Revision'}</div>
    </div>
  </div>
  ${highRiskRows ? `<div class="section">
    <div class="section-head">High Risk Misses — ${(res.high_risk_misses || []).length} flagged</div>
    <table><thead><tr><th>Risk</th><th>Item</th><th>Estimator Had</th><th>Plan Shows</th><th>Notes</th></tr></thead>
    <tbody>${highRiskRows}</tbody></table>
  </div>` : ''}
  ${recheckRows ? `<div class="section">
    <div class="section-head">Quantity Items to Recheck — ${(res.quantity_items_to_recheck || []).length} flagged</div>
    <table><thead><tr><th>Status</th><th>Item</th><th>Estimator Had</th><th>Plan Shows</th><th>Notes</th></tr></thead>
    <tbody>${recheckRows}</tbody></table>
  </div>` : ''}
  ${scopeRows ? `<div class="section">
    <div class="section-head">Scope Gaps — ${(res.scope_gaps || []).filter(s => s.status === 'MISSING').length} missing</div>
    <div class="scope-grid">${scopeRows}</div>
  </div>` : ''}
  ${conflictRows ? `<div class="section">
    <div class="section-head">Geotech & Plan Conflicts</div>
    ${conflictRows}
  </div>` : ''}
  ${(questionRows || assumptionRows) ? `<div class="two-col">
    ${questionRows ? `<div class="section"><div class="section-head">Clarification Questions</div>${questionRows}</div>` : ''}
    ${assumptionRows ? `<div class="section"><div class="section-head">Assumptions Needing Approval</div>${assumptionRows}</div>` : ''}
  </div>` : ''}
  ${bidNotes ? `<div class="section">
    <div class="section-head">Recommended Bid Notes & Exclusions</div>
    <ul class="bid-notes">${bidNotes}</ul>
  </div>` : ''}
  <div class="report-footer">
    <span>Generated by 6 Signal Takeoff Copilot</span>
    <span>QA Bid Risk Report — AI-generated. Verify all flags before submitting bid.</span>
    <span>${date}</span>
  </div>
</div>
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank', 'width=1100,height=900')
    win.onload = () => { URL.revokeObjectURL(url); win.focus(); win.print() }
  }

  // ── Sheet triage helpers ─────────────────────────────────────
  const TRIAGE_ANALYSIS_TYPES = new Set(['utility_plan', 'plan_profile', 'storm', 'sanitary', 'water', 'details'])

  const formatClassification = (cls) => {
    const labels = {
      cover: 'Cover', sheet_index: 'Sheet Index', general_notes: 'Gen. Notes',
      demo: 'Demo', grading: 'Grading', paving: 'Paving',
      utility_plan: 'Utility Plan', plan_profile: 'Plan-Profile',
      storm: 'Storm', sanitary: 'Sanitary', water: 'Water',
      details: 'Details', erosion_control: 'Erosion Ctrl',
      landscape: 'Landscape', electrical: 'Electrical', other: 'Other',
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
      const res = await fetch('/api/start-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ project_id: projectId }),
      })
      if (!res.ok) {
        const msg = await res.text()
        throw new Error(msg.slice(0, 160) || `start-analysis failed (${res.status})`)
      }
      const { job_id } = await res.json()
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

  const result = results[activeImage]
  const isQAResult = !!(result && result.executive_risk_summary)
  const analyzedCount = Object.keys(results).length

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
      {/* ONBOARDING MODAL */}
      {showOnboarding && (
        <div className="modal-overlay">
          <div className="modal card onboarding-modal" onClick={e => e.stopPropagation()}>
            <div className="onboarding-header">
              <div className="onboarding-logo">
                <div style={{
                  width: 44, height: 44, background: 'var(--titan-red)', color: 'var(--titan-white)',
                  fontFamily: 'var(--font-display)', fontSize: '1.6rem',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  clipPath: 'polygon(0 0, 100% 0, 100% 85%, 85% 100%, 0 100%)'
                }}>T</div>
              </div>
              <h3>Welcome to Takeoff Copilot</h3>
              <p className="text-dim" style={{ fontSize: '0.82rem', marginTop: 6, lineHeight: 1.6 }}>
                AI-powered quantity takeoffs from construction plan sheets. Upload a PDF or image, get a structured takeoff in under 60 seconds.
              </p>
            </div>

            <div className="onboarding-steps">
              <div className="onboarding-step">
                <span className="onboarding-step-num">1</span>
                <div>
                  <div className="onboarding-step-title">Upload a plan sheet</div>
                  <div className="onboarding-step-desc">PDF or image. Clean single-story pad sites with labeled profiles work best (Grade A = 90–100% accuracy).</div>
                </div>
              </div>
              <div className="onboarding-step">
                <span className="onboarding-step-num">2</span>
                <div>
                  <div className="onboarding-step-title">Review the Risk Flags</div>
                  <div className="onboarding-step-desc">Every scan includes geotech warnings, commonly missed scope, and AI-inferred items to verify before pricing.</div>
                </div>
              </div>
            </div>

            <div className="onboarding-contact-section">
              <div className="onboarding-section-label titan-label" style={{ marginBottom: 12, display: 'block' }}>
                Your Contact Information
              </div>
              <div className="onboarding-contact-row">
                <div className="onboarding-contact-field">
                  <label className="titan-label" style={{ marginBottom: 5, display: 'block', fontSize: '0.6rem' }}>Full Name</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="John Smith"
                    value={onboardName}
                    onChange={e => setOnboardName(e.target.value)}
                  />
                </div>
                <div className="onboarding-contact-field">
                  <label className="titan-label" style={{ marginBottom: 5, display: 'block', fontSize: '0.6rem' }}>Company</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="Smith Utility Contractors"
                    value={onboardCompany}
                    onChange={e => setOnboardCompany(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label className="titan-label" style={{ marginBottom: 5, display: 'block', fontSize: '0.6rem' }}>Phone Number</label>
                <input
                  type="tel"
                  className="input"
                  placeholder="(555) 000-0000"
                  value={onboardPhone}
                  onChange={e => setOnboardPhone(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-primary" onClick={dismissOnboarding}>
                Get Started
              </button>
            </div>
          </div>
        </div>
      )}


      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => fileInputRef.current?.click()}>
            <Upload size={15} /> Upload Sheets
          </button>
          <input ref={fileInputRef} type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.pdf,application/pdf" multiple onChange={handleFileUpload} style={{ display: 'none' }} />
          
          {images.length > 1 && (
            <button className="btn btn-secondary" style={{ width: '100%', marginTop: 6 }} onClick={analyzeAll} disabled={processingAll || loading}>
              {processingAll ? 'Processing...' : 'Analyze All'}
            </button>
          )}
        </div>

        <div className="sidebar-sheets">
          {images.length === 0 && (
            <div className="sidebar-empty">
              <FileText size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
              <span>Upload PDF or image<br/>plan sheets to begin</span>
            </div>
          )}
          {images.map((img, i) => (
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
                    <span className="text-red" title={img.jobError}>⚠ Processing error</span>
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
              <button className="sheet-remove" onClick={(e) => { e.stopPropagation(); removeImage(i) }}>
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
          <button className="btn btn-secondary" style={{ width: 'calc(100% - 16px)', margin: '0 8px 8px', fontSize: '0.72rem' }}
            onClick={() => geotechInputRef.current?.click()} disabled={geotechLoading}>
            <Upload size={12} /> {geotechResult ? 'Replace Geotech' : 'Upload Geotech PDF'}
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
            className="btn btn-secondary"
            style={{ width: 'calc(100% - 16px)', margin: '0 8px 8px', fontSize: '0.72rem' }}
            onClick={() => specsInputRef.current?.click()}
            disabled={specsUploading}
          >
            <Upload size={12} /> {specsFileId ? 'Replace Specs' : 'Upload Specs PDF'}
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
              className="btn btn-secondary"
              style={{ width: 'calc(100% - 16px)', margin: '0 8px 8px', fontSize: '0.72rem' }}
              onClick={() => takeoffInputRef.current?.click()}
            >
              <Upload size={12} /> {uploadedTakeoffData ? 'Replace Takeoff' : 'Upload Completed Takeoff'}
            </button>
            <input
              ref={takeoffInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
              onChange={handleTakeoffUpload}
              style={{ display: 'none' }}
            />
            <div style={{ padding: '0 8px 8px', fontSize: '0.68rem', color: 'var(--titan-text-muted)' }}>
              Your completed takeoff (CSV or Excel)
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
        </div>

        {images.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Upload size={40} strokeWidth={1} />
            </div>
            <h2>Upload Your Files</h2>
            <p className="text-dim">
              Upload PDF plan sets or individual sheets, geotech analysis, and your takeoff. The AI will analyze your work for accuracy.
            </p>
            <button className="btn btn-primary btn-lg" onClick={() => fileInputRef.current?.click()}>
              <Upload size={18} /> Select Files
            </button>
          </div>
        ) : (
          <>
            {/* SHEET HEADER */}
            <div className="sheet-header">
              <div className="sheet-header-info">
                <img src={images[activeImage]?.preview} alt="" className="sheet-header-thumb" onClick={() => window.open(images[activeImage]?.preview, '_blank')} />
                <div>
                  <div className="sheet-header-name">{images[activeImage]?.name}</div>
                  <div className="sheet-header-meta">
                    Sheet {activeImage + 1} of {images.length}
                    {result && (isQAResult
                      ? ` // QA Bid Risk Report // ${result.high_risk_misses?.length || 0} risk flags`
                      : ` // ${result.items.length} items // ${result.summary?.high_confidence_count || 0} high confidence`)}
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
                        <button className="btn btn-secondary" onClick={() => exportCSV(false)}>
                          <Download size={14} /> CSV
                        </button>
                        <button className="btn btn-primary" onClick={exportPDF}>
                          <FileText size={14} /> PDF Report
                        </button>
                      </>
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
                  <div className="table-wrap">
                    <table className="titan-table">
                      <thead>
                        <tr>
                          {['#', 'Cat', 'Description', 'Unit', 'Qty', 'Conf', 'Notes'].map(h => (
                            <th key={h}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.items.map((item, i) => (
                          <tr key={i}>
                            <td className="text-muted">{item.item_no}</td>
                            <td><span className="cat-badge">{categoryIcon(item.category)} {item.category}</span></td>
                            <td style={{ maxWidth: 320 }}>{item.description}</td>
                            <td className="text-mono text-dim">{item.unit}</td>
                            <td className="text-mono" style={{ fontWeight: 600, color: 'var(--titan-white)', fontSize: '0.9rem' }}>{item.quantity}</td>
                            <td><span className={`badge ${confidenceColor(item.confidence)}`}>{item.confidence}</span></td>
                            <td className="text-dim" style={{ maxWidth: 240, fontSize: '0.75rem', lineHeight: 1.4 }}>{item.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

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
                    const lowItems = result.items.filter(it => it.confidence === 'LOW')

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
                      const inScope = result.items.some(it =>
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
              {activeTab === 'plan' && images[activeImage] && (
                <div className="plan-view animate-fade">
                  <img src={images[activeImage].preview} alt="Plan sheet" className="plan-image" />
                </div>
              )}

              {/* COMPARE TAB */}
              {activeTab === 'compare' && (
                <div className="compare-content animate-fade">
                  <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ color: 'var(--titan-red)', marginBottom: 8 }}>Paste Actual Takeoff</h4>
                    <p className="text-dim" style={{ fontSize: '0.78rem', marginBottom: 12 }}>
                      Paste the completed takeoff for this sheet. One item per line — description, unit, quantity separated by commas or tabs.
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
                          {result.items.map((item, i) => (
                            <div key={i}>[{item.confidence[0]}] {item.description}, {item.unit}, {item.quantity}</div>
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
                      ['Total Items', result.summary?.total_items || result.items.length, ''],
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
                    {Object.entries(result.items.reduce((acc, item) => { acc[item.category] = (acc[item.category] || 0) + 1; return acc }, {}))
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

        {/* PROACTIVE CHAT PANEL — QA Mode only */}
        {isQAResult && (
          <div className={`chat-panel ${chatOpen ? 'chat-open' : 'chat-collapsed'}`}>
            <button
              className="chat-panel-header"
              onClick={() => setChatOpen(o => !o)}
              aria-label={chatOpen ? 'Collapse chat' : 'Open bid clarification chat'}
            >
              <div className="chat-header-left">
                <MessageCircle size={14} />
                <span className="chat-header-title">Bid Clarification</span>
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
                    placeholder="Answer or ask a follow-up..."
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
