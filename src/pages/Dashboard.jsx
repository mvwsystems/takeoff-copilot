import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, FileText, Download, RotateCcw, X, ChevronRight, BarChart3, Eye, GitCompare, Layers, ExternalLink } from 'lucide-react'
import { SYSTEM_PROMPT, SCREENING_PROMPT, GEOTECH_PROMPT } from '../utils/prompts'
import { supabase } from '../utils/supabase'
import { useAuth } from '../utils/AuthContext'
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
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfProgress, setPdfProgress] = useState('')
  const [screenings, setScreenings] = useState({})
  const [screeningSheet, setScreeningSheet] = useState(null)
  const [geotechResult, setGeotechResult] = useState(null)
  const [geotechLoading, setGeotechLoading] = useState(false)
  const [geotechError, setGeotechError] = useState(null)
  const [geotechFileName, setGeotechFileName] = useState(null)
  const [apiKey, setApiKey] = useState(localStorage.getItem('tc_api_key') || '')
  const [showKeyInput, setShowKeyInput] = useState(!localStorage.getItem('tc_api_key'))
  // Show onboarding only if neither the "completed" flag nor an existing API key is present
  const [showOnboarding, setShowOnboarding] = useState(
    !localStorage.getItem('tc_onboarded') && !localStorage.getItem('tc_api_key')
  )
  const [onboardKey, setOnboardKey] = useState('')
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
  const fileInputRef = useRef(null)
  const geotechInputRef = useRef(null)

  // If user already has a Supabase profile from a prior session, skip onboarding
  useEffect(() => {
    if (!user || !showOnboarding) return
    supabase.from('profiles').select('id').eq('id', user.id).maybeSingle().then(({ data }) => {
      if (data) {
        localStorage.setItem('tc_onboarded', '1')
        setShowOnboarding(false)
      }
    }).catch(() => {}) // table may not exist yet — fail silently
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

  const dismissOnboarding = (keyValue) => {
    const key = keyValue || onboardKey
    if (key.trim()) {
      setApiKey(key.trim())
      localStorage.setItem('tc_api_key', key.trim())
    }
    localStorage.setItem('tc_onboarded', '1')
    setShowOnboarding(false)

    // Save contact info to Supabase if the user filled it in
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

  const saveApiKey = (key) => {
    setApiKey(key)
    localStorage.setItem('tc_api_key', key)
    setShowKeyInput(false)
  }

  const loadPdfJs = useCallback(async () => {
    if (window.pdfjsLib) return window.pdfjsLib
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
        resolve(window.pdfjsLib)
      }
      script.onerror = reject
      document.head.appendChild(script)
    })
  }, [])

  const convertPdfToImages = useCallback(async (file) => {
    setPdfLoading(true)
    setPdfProgress(`Loading ${file.name}...`)
    try {
      const pdfjsLib = await loadPdfJs()
      const arrayBuffer = await file.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const totalPages = pdf.numPages
      
      for (let i = 1; i <= totalPages; i++) {
        setPdfProgress(`Converting ${file.name}: ${i}/${totalPages}`)
        const page = await pdf.getPage(i)
        const scale = 1.5
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvasContext: ctx, viewport }).promise
        
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88)
        const base64 = dataUrl.split(',')[1]
        setImages(prev => [...prev, {
          name: `${file.name} — Page ${i}`,
          base64,
          mediaType: 'image/jpeg',
          preview: dataUrl,
        }])
      }
      setPdfProgress(`Done — ${totalPages} pages`)
    } catch (err) {
      setError(`PDF conversion failed: ${err.message}`)
    } finally {
      setPdfLoading(false)
      setTimeout(() => setPdfProgress(''), 3000)
    }
  }, [loadPdfJs])

  const handleFileUpload = useCallback((e) => {
    const files = Array.from(e.target.files)
    files.forEach(file => {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        convertPdfToImages(file)
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
    })
    e.target.value = ''
  }, [convertPdfToImages])

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
    let base64Data = img.base64
    let mType = img.mediaType

    if (base64Data.length > 5 * 1024 * 1024) {
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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', source: { type: 'base64', media_type: mType, data: base64Data } }
          ]
        }]
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

  const callApiMulti = async (imgArray, prompt, maxTokens = 4096) => {
    const imageBlocks = imgArray.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
    }))

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...imageBlocks
          ]
        }]
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

  const pdfToImages = async (file, maxPages = 10) => {
    const pdfjsLib = await loadPdfJs()
    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    const totalPages = Math.min(pdf.numPages, maxPages)
    const imgs = []
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      imgs.push({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', preview: dataUrl })
    }
    return imgs
  }

  const processGeotech = async (file) => {
    if (!apiKey) { setShowKeyInput(true); return }
    setGeotechLoading(true)
    setGeotechError(null)
    setGeotechFileName(file.name)
    setGeotechResult(null)
    try {
      const pages = await pdfToImages(file, 12)
      const result = await callApiMulti(
        pages,
        GEOTECH_PROMPT + '\n\nExtract all geotechnical data from these report pages. Respond ONLY with the JSON object, no other text.',
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
    if (!img || !apiKey) {
      if (!apiKey) setShowKeyInput(true)
      return
    }
    setScreeningSheet(idx)
    setError(null)

    try {
      const parsed = await callApi(img, SCREENING_PROMPT + '\n\nGrade this construction plan sheet. Respond ONLY with the JSON object, no other text.', 512)
      const screening = parsed.plan_screening || parsed
      setScreenings(prev => ({ ...prev, [idx]: screening }))

      if (screening.grade !== 'C') {
        await analyzeSheet(idx, true)
      }
    } catch (err) {
      console.error('Screening error:', err)
      setError(`Screening failed for sheet ${idx + 1}: ${err.message}`)
    } finally {
      setScreeningSheet(null)
    }
  }

  const analyzeSheet = async (idx, skipApiKeyCheck = false) => {
    const img = images[idx]
    if (!img || (!apiKey && !skipApiKeyCheck)) {
      if (!apiKey) setShowKeyInput(true)
      return
    }
    setLoading(true)
    setLoadingSheet(idx)
    setError(null)

    try {
      const parsed = await callApi(
        img,
        SYSTEM_PROMPT + '\n\n---\n\nAnalyze this construction plan sheet and produce a complete quantity takeoff. Extract every identifiable item. Be thorough but honest about confidence levels. Respond ONLY with the JSON object, no other text.'
      )
      setResults(prev => ({ ...prev, [idx]: parsed }))
      setActiveImage(idx)
      setActiveTab('takeoff')

      // Fire-and-forget: log the completed job to Supabase for beta tracking
      if (user) {
        const rm = parsed?.risk_and_misses || {}
        const riskCount = (rm.geotech_concerns?.length || 0) +
                          (rm.missed_items?.length || 0) +
                          (rm.bid_risk_items?.length || 0)
        supabase.from('jobs').insert({
          user_id: user.id,
          plan_filename: images[idx]?.name || null,
          geotech_filename: geotechFileName || null,
          screening_grade: screenings[idx]?.grade || null,
          screening_rationale: screenings[idx]?.rationale || null,
          line_item_count: parsed?.takeoff?.length || 0,
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
<title>Titan AI Takeoff Report</title>
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
    <span>Generated by Titan AI Takeoff Copilot</span>
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

  const result = results[activeImage]
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
                  <div className="onboarding-step-title">Enter your Anthropic API key</div>
                  <div className="onboarding-step-desc">The AI analysis runs on your key — no markup, no middleman. Your key is stored locally in your browser only.</div>
                </div>
              </div>
              <div className="onboarding-step">
                <span className="onboarding-step-num">2</span>
                <div>
                  <div className="onboarding-step-title">Upload a plan sheet</div>
                  <div className="onboarding-step-desc">PDF or image. Clean single-story pad sites with labeled profiles work best (Grade A = 90–100% accuracy).</div>
                </div>
              </div>
              <div className="onboarding-step">
                <span className="onboarding-step-num">3</span>
                <div>
                  <div className="onboarding-step-title">Review the Risk Flags</div>
                  <div className="onboarding-step-desc">Every takeoff includes geotech warnings, commonly missed scope, and AI-inferred items to verify before pricing.</div>
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

            <div className="onboarding-key-section">
              <label className="titan-label" style={{ marginBottom: 6, display: 'block' }}>
                Anthropic API Key
              </label>
              <input
                type="password"
                className="input"
                placeholder="sk-ant-..."
                value={onboardKey}
                onChange={e => setOnboardKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && onboardKey.trim() && dismissOnboarding()}
              />
              <a
                href="https://console.anthropic.com"
                target="_blank"
                rel="noopener noreferrer"
                className="onboarding-key-link"
              >
                <ExternalLink size={11} /> Get your key at console.anthropic.com
              </a>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-ghost" onClick={() => dismissOnboarding('')}>
                Skip for now
              </button>
              <button
                className="btn btn-primary"
                onClick={() => dismissOnboarding()}
                disabled={!onboardKey.trim()}
              >
                Save &amp; Get Started
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API KEY MODAL */}
      {showKeyInput && !showOnboarding && (
        <div className="modal-overlay" onClick={() => apiKey && setShowKeyInput(false)}>
          <div className="modal card" onClick={e => e.stopPropagation()}>
            <h3>API Configuration</h3>
            <p className="text-dim" style={{ fontSize: '0.82rem', margin: '12px 0 16px' }}>
              Enter your Anthropic API key to enable plan analysis. Your key is stored locally and never sent to our servers.
            </p>
            <input
              type="password"
              className="input"
              placeholder="sk-ant-..."
              defaultValue={apiKey}
              onKeyDown={(e) => e.key === 'Enter' && saveApiKey(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              {apiKey && <button className="btn btn-ghost" onClick={() => setShowKeyInput(false)}>Cancel</button>}
              <button className="btn btn-primary" onClick={(e) => {
                const input = e.target.closest('.modal').querySelector('input')
                saveApiKey(input.value)
              }}>Save Key</button>
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
          
          {pdfLoading && (
            <div className="pdf-progress">{pdfProgress}</div>
          )}
          
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
                  {results[i] ? (
                    <span className="text-green">✓ {results[i].items.length} items</span>
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
              <div className="geotech-empty">
                <FileText size={18} style={{ opacity: 0.25, marginBottom: 6 }} />
                <span>Upload a geotech PDF to flag soil risks</span>
              </div>
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
          <button className="btn btn-ghost" style={{ width: '100%', fontSize: '0.7rem' }} onClick={() => setShowKeyInput(true)}>
            ⚙ API Settings
          </button>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main-content">
        {images.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Upload size={40} strokeWidth={1} />
            </div>
            <h2>Upload Plan Sheets</h2>
            <p className="text-dim">
              Upload PDF plan sets or individual sheet images. The AI will extract pipe types, fittings, 
              structures, and quantities into a structured takeoff table.
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
                    {result && ` // ${result.items.length} items // ${result.summary?.high_confidence_count || 0} high confidence`}
                  </div>
                </div>
              </div>
              <div className="sheet-header-actions">
                {!results[activeImage] && screenings[activeImage]?.grade !== 'C' && (
                  <button
                    className="btn btn-primary"
                    onClick={() => screenings[activeImage] ? analyzeSheet(activeImage) : screenSheet(activeImage)}
                    disabled={loading || screeningSheet === activeImage}
                  >
                    {screeningSheet === activeImage ? 'Screening...' : loadingSheet === activeImage ? 'Analyzing...' : 'Analyze Sheet'}
                  </button>
                )}
                {results[activeImage] && (
                  <>
                    <button className="btn btn-ghost" onClick={() => {
                      const r = { ...results }; delete r[activeImage]; setResults(r)
                      const s = { ...screenings }; delete s[activeImage]; setScreenings(s)
                    }}>
                      <RotateCcw size={14} /> Re-analyze
                    </button>
                    <button className="btn btn-secondary" onClick={() => exportCSV(false)}>
                      <Download size={14} /> CSV
                    </button>
                    <button className="btn btn-primary" onClick={exportPDF}>
                      <FileText size={14} /> PDF Report
                    </button>
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
              {[
                ['takeoff', 'Takeoff', Layers],
                ['plan', 'Plan View', Eye],
                ['compare', 'Compare', GitCompare],
                ['summary', 'Summary', BarChart3]
              ].map(([key, label, Icon]) => (
                <button key={key} className={`tab ${activeTab === key ? 'active' : ''}`} onClick={() => setActiveTab(key)}>
                  <Icon size={14} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* TAB CONTENT */}
            <div className="tab-content">
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
              {activeTab === 'takeoff' && !result && loadingSheet !== activeImage && screeningSheet !== activeImage && screenings[activeImage]?.grade !== 'C' && (
                <div className="loading-state">
                  <ChevronRight size={32} style={{ opacity: 0.2 }} />
                  <p>Click "Analyze Sheet" to run the AI takeoff</p>
                </div>
              )}
              {activeTab === 'summary' && !result && (
                <div className="loading-state"><p className="text-muted">Analyze a sheet to see the summary</p></div>
              )}
            </div>
          </>
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
