# Takeoff Copilot // Titan AI

AI-powered plan analysis for utility contractors. Upload construction plan sheets, get structured takeoffs in minutes.

## Stack

- **React 18** + **Vite** — Fast dev and build
- **React Router** — Client-side routing
- **pdf.js** — Client-side PDF to image conversion
- **Claude API** (Anthropic) — Vision-based plan analysis
- **Netlify** — Deploy target

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

## Deploy to Netlify

1. Push to GitHub
2. Connect repo in Netlify
3. Build command: `npm run build`
4. Publish directory: `dist`
5. The `netlify.toml` handles SPA routing automatically

## API Key

The app requires an Anthropic API key for plan analysis. Users enter their key in the dashboard — it's stored in localStorage and sent directly to the Anthropic API. No backend required for the analysis engine.

## Project Structure

```
takeoff-copilot/
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   ├── Navbar.jsx
│   │   └── Navbar.css
│   ├── pages/
│   │   ├── LandingPage.jsx / .css
│   │   ├── Dashboard.jsx / .css
│   │   └── LoginPage.jsx / .css
│   ├── styles/
│   │   └── global.css          # Titan AI Design System
│   ├── utils/
│   │   └── prompts.js          # AI system prompt
│   ├── App.jsx
│   └── main.jsx
├── index.html
├── vite.config.js
├── netlify.toml
├── package.json
└── README.md
```

## Design System

**Titan AI** — Construction tech aesthetic.

- **Colors:** Black (#0A0A0A), Off-white (#F5F5F0), Titan Red (#E8372C)
- **Fonts:** Bebas Neue (display), Outfit (body), JetBrains Mono (data/mono)
- **Motifs:** "//" separators, angled ticker-tape accents, military precision

## Roadmap

- [ ] Authentication (Supabase)
- [ ] Project management (save/organize takeoffs by job)
- [ ] Multi-sheet aggregate takeoff
- [ ] Supplier RFQ automation
- [ ] Historical accuracy tracking
- [ ] Geotechnical report analysis integration

---

Built by **Titan AI** — Construction AI Operations
