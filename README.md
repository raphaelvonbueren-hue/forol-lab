# FOROL research lab

Browserbasierte Baukostenanalyse für die Kantone TG, SG, AI, AR.  
Gebaut für Standalone-Deployment auf Vercel — integrierbar in FOROL Futur.

---

## 🚀 Deploy auf Vercel (5 Minuten)

### Option A — Vercel CLI

```bash
# 1. Repo klonen / Ordner auf eigenen Rechner kopieren
cd forol-research-lab

# 2. Vercel CLI installieren (einmalig)
npm i -g vercel

# 3. Deployen
vercel

# Folge den Prompts:
#   - Set up and deploy? → Y
#   - Which scope? → dein Vercel-Account
#   - Link to existing project? → N  
#   - Project name? → forol-research-lab
#   - Directory? → ./
#   - Override settings? → N
```

Nach ca. 30 Sekunden erhältst du eine URL wie `https://forol-research-lab.vercel.app`.

### Option B — GitHub + Vercel Dashboard

```bash
# 1. GitHub Repository erstellen
git init
git add .
git commit -m "FOROL research lab v4.0"
git remote add origin https://github.com/DEIN-ORG/forol-research-lab.git
git push -u origin main

# 2. Vercel Dashboard öffnen
#    → New Project → Import Git Repository → forol-research-lab
#    → Framework: Other
#    → Output Directory: public
#    → Deploy
```

---

## ⚙️ Environment Variables

Im Vercel Dashboard unter **Settings → Environment Variables** setzen:

| Variable | Beschreibung | Beispiel |
|----------|-------------|---------|
| `FOROL_FUTUR_API_URL` | Import-Endpoint von FOROL Futur | `https://rechnungen.forol.ch/api/import/kostenvoranschlag` |
| `FOROL_FUTUR_API_KEY` | API-Key für FOROL Futur (optional bis Phase 2) | `sk-forol-...` |

> **Ohne** `FOROL_FUTUR_API_URL` funktioniert die App vollständig — der Export-Button zeigt dann den validierten Payload an statt ihn weiterzuleiten.

---

## 📁 Projektstruktur

```
forol-research-lab/
├── public/
│   └── index.html          ← Komplette Single-Page-App (2500+ Zeilen)
├── api/
│   ├── export.js           ← POST /api/export  → validiert + leitet an FOROL Futur weiter
│   ├── pdf.js              ← POST /api/pdf     → PDF-Endpoint (Phase 2: server-side)
│   └── ping.js             ← GET  /api/ping    → Health check
├── vercel.json             ← Routing + CORS Headers
├── .env.example            ← Environment Variables Template
├── .gitignore
└── README.md
```

---

## 🔌 API-Endpoints

Alle Endpoints sind öffentlich erreichbar (keine Auth für Phase 1).

### `GET /api/ping`
Health check.
```json
{ "status": "ok", "app": "forol-research-lab", "version": "4.0" }
```

### `POST /api/export`
Nimmt einen BKP-Payload entgegen, validiert ihn und leitet ihn an FOROL Futur weiter (wenn `FOROL_FUTUR_API_URL` gesetzt).

**Request Body:** → Siehe Integrationsanleitung (FOROL-Integrationsanleitung.md)

**Response (ohne FOROL Futur):**
```json
{
  "status":      "ok",
  "referenceId": "RL-LX8K2Z",
  "payload":     { ... },
  "message":     "Payload validiert. FOROL_FUTUR_API_URL noch nicht konfiguriert."
}
```

**Response (mit FOROL Futur):**
```json
{
  "status":      "forwarded",
  "referenceId": "RL-LX8K2Z",
  "futur":       { "id": "PRJ-2025-001", "url": "https://rechnungen.forol.ch/..." },
  "message":     "Erfolgreich an FOROL Futur übertragen"
}
```

---

## 🔗 Integration in FOROL Futur (Einbettung)

### Als iFrame einbetten

```html
<!-- In FOROL Futur Seite einbinden -->
<iframe
  src="https://forol-research-lab.vercel.app"
  width="100%"
  height="900px"
  style="border: none; border-radius: 8px;"
  allow="clipboard-write"
  title="FOROL research lab"
></iframe>
```

### Als Link öffnen

```html
<a href="https://forol-research-lab.vercel.app" target="_blank">
  🔬 Baukostenanalyse öffnen
</a>
```

### postMessage-Kommunikation (Phase 2)

Wenn die App als iFrame läuft, kann sie nach erfolgreichem Export eine Nachricht an FOROL Futur senden:

```javascript
// In FOROL Futur — auf Nachrichten vom research lab hören
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://forol-research-lab.vercel.app') return;
  if (event.data?.type === 'FOROL_EXPORT_SUCCESS') {
    const { referenceId, projectName, total } = event.data;
    // Projekt in FOROL Futur öffnen oder aktualisieren
    console.log('Export empfangen:', referenceId, projectName, total);
  }
});
```

---

## 🛠 Custom Domain

```bash
# Custom Domain hinzufügen
vercel domains add research.forol.ch

# Oder im Vercel Dashboard:
# Settings → Domains → Add → research.forol.ch
```

DNS-Eintrag beim Domain-Provider:
```
CNAME  research  cname.vercel-dns.com
```

---

## Features der App

- **PLZ-Suche** mit 349 Gemeinden (TG, SG, AI, AR)
- **KI-Plananalyse** via Claude Vision API (PDF/PNG Upload)
- **BKP-Kalkulation** mit 50+ Positionen (4-stellig nach CRB)
- **Wohnüberbauungen** — mehrere Gebäude auf einer Parzelle
- **Erdmassen-Kalkulator** mit SVG-Querschnitt
- **Ausnützungsberechnung** nach Zonenvorschriften
- **Eigene Preisdatenbank** via CSV-Import
- **PDF-Export** (mehrseitig, professionell)
- **FOROL Futur Export** via `/api/export`

---

*FOROL research lab v4.0 · forol-research-lab.vercel.app*
