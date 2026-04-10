import { useState, useRef, useCallback } from 'react'
import { Upload, FileText, Download, RotateCcw, X, ChevronRight, BarChart3, Eye, GitCompare, Layers } from 'lucide-react'
import { SYSTEM_PROMPT, SCREENING_PROMPT } from '../utils/prompts'
import './Dashboard.css'

export default function Dashboard() {
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
  const [screeningSheet, setScreeningSheet] = useState(null) // idx of sheet currently being screened
  const [apiKey, setApiKey] = useState(localStorage.getItem('tc_api_key') || '')
  const [showKeyInput, setShowKeyInput] = useState(!localStorage.getItem('tc_api_key'))
  const fileInputRef = useRef(null)

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

  const exportCSV = (allSheets = false) => {
    const headers = allSheets 
      ? ['Sheet', 'Item No', 'Category', 'Description', 'Unit', 'Quantity', 'Confidence', 'Notes']
      : ['Item No', 'Category', 'Description', 'Unit', 'Quantity', 'Confidence', 'Notes']
    
    const rows = []
    const entries = allSheets ? Object.entries(results) : [[activeImage, results[activeImage]]]
    
    entries.forEach(([idx, result]) => {
      if (!result) return
      result.items.forEach(item => {
        const row = allSheets ? [images[idx]?.name || `Sheet ${+idx + 1}`] : []
        row.push(item.item_no, item.category, `"${item.description.replace(/"/g, '""')}"`, item.unit, item.quantity, item.confidence, `"${(item.notes || '').replace(/"/g, '""')}"`)
        rows.push(row)
      })
    })

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `takeoff_${allSheets ? 'all_sheets' : images[activeImage]?.name || 'sheet'}_${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
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
      {/* API KEY MODAL */}
      {showKeyInput && (
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
    </div>
  )
}
