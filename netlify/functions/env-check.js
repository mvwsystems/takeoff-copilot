// Temporary diagnostic: reports which env vars the FUNCTIONS runtime can see.
// Returns booleans only — never values. Safe to leave deployed; remove after debugging.

exports.handler = async () => {
  let mupdfOk = false
  let mupdfErr = null
  try {
    const mupdf = await import('mupdf')
    mupdfOk = typeof mupdf.Document?.openDocument === 'function'
  } catch (e) {
    mupdfErr = e.message
  }

  let supabaseOk = false
  let supabaseErr = null
  try {
    const { createClient } = require('@supabase/supabase-js')
    supabaseOk = typeof createClient === 'function'
  } catch (e) {
    supabaseErr = e.message
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      node: process.version,
      env: {
        VITE_SUPABASE_URL: !!process.env.VITE_SUPABASE_URL,
        VITE_SUPABASE_ANON_KEY: !!process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        URL: !!process.env.URL,
      },
      modules: {
        supabase_js: supabaseOk, supabase_err: supabaseErr,
        mupdf: mupdfOk, mupdf_err: mupdfErr,
      },
    }),
  }
}
