# FOROL Research Lab — Deployment Guide

**Vollständige Anleitung für selbstständiges Deployment**

---

## Übersicht

FOROL Research Lab ist eine Single-Page-App (Vanilla JS) für Baukostenplanung in den Kantonen TG, SG, AI und AR. Die App läuft als statische Website auf Vercel mit Serverless API-Endpoints für KI-Funktionen.

**Tech Stack:**
- Frontend: Vanilla HTML/CSS/JS (eine einzige `public/index.html`)
- Backend: Vercel Serverless Functions (Node.js ESM)
- KI: Anthropic Claude API (Plan-Analyse, LV-Import)
- Karten: Swisstopo WMTS + Leaflet.js
- Daten: Swisstopo / geodienste.ch REST APIs
- Speicher: Browser localStorage (kein Datenbankserver)

---

## Repository

```
https://github.com/raphaelvonbueren-hue/forol-lab
```

**Struktur:**
```
forol-research-lab/
├── public/
│   └── index.html          # Gesamte Frontend-App (~5000 Zeilen)
├── api/
│   ├── analyze-plan.js     # KI Bauplan-Analyse (Claude Vision)
│   ├── lv-import.js        # KI Leistungsverzeichnis-Import
│   ├── geoportal.js        # Swisstopo + geodienste.ch Proxy
│   ├── export.js           # BKP-Export Endpoint
│   ├── pdf.js              # PDF-Generierung Endpoint
│   └── ping.js             # Health Check
├── package.json            # { "type": "module" }
└── vercel.json             # Routing + CORS Headers
```

---

## Deployment auf Vercel (empfohlen)

### Voraussetzungen
- [Vercel Account](https://vercel.com) (kostenloser Hobby-Plan reicht)
- [Anthropic API Key](https://console.anthropic.com/settings/keys) für KI-Funktionen
- Git (GitHub/GitLab/Bitbucket Account)

### Schritt 1 — Repository forken oder klonen

```bash
# Option A: Fork auf GitHub (empfohlen)
# → github.com/raphaelvonbueren-hue/forol-lab → "Fork"

# Option B: Clone + eigenes Repo
git clone https://github.com/raphaelvonbueren-hue/forol-lab.git
cd forol-research-lab
git remote set-url origin https://github.com/DEIN-USERNAME/forol-lab.git
git push -u origin main
```

### Schritt 2 — Vercel Projekt erstellen

1. [vercel.com/new](https://vercel.com/new) öffnen
2. GitHub-Repo auswählen (`forol-lab`)
3. Framework Preset: **Other**
4. Root Directory: `./` (Standard)
5. Build & Output Settings:
   - Build Command: *(leer lassen)*
   - Output Directory: `public`
6. **"Deploy"** klicken

Vercel erkennt `vercel.json` automatisch und konfiguriert alles korrekt.

### Schritt 3 — Environment Variables setzen

In Vercel → Project → Settings → Environment Variables:

| Variable | Wert | Pflicht |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | **Ja** (für KI-Funktionen) |

So erhältst du den Key:
1. [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. "Create Key" → Namen vergeben → Key kopieren
3. In Vercel einfügen → "Save"

**Wichtig nach dem Setzen:** Einmal manuell Redeploy triggern damit der Key aktiv wird:
→ Vercel → Deployments → neuestes Deployment → "..." → "Redeploy"

### Schritt 4 — Domain (optional)

Vercel vergibt automatisch eine URL (`forol-lab-xxx.vercel.app`).

Eigene Domain:
- Vercel → Project → Settings → Domains → Domain eintragen
- DNS: CNAME auf `cname.vercel-dns.com` setzen

---

## Deployment alternativ: Netlify / eigener Server

### Netlify

```toml
# netlify.toml
[build]
  publish = "public"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200
```

**Hinweis:** Die API-Endpoints müssen für Netlify Functions umgeschrieben werden (andere Handler-Signatur). Vercel ist deutlich einfacher für dieses Projekt.

### Eigener Server (nginx + Node)

```bash
# Dependencies installieren
npm install

# API-Server starten (benötigt Anpassung für Express)
# Die api/*.js Dateien sind Vercel-spezifisch und müssen für Express adaptiert werden

# Frontend servieren
nginx -c nginx.conf  # public/ als static root
```

Für einen eigenen Server empfehlen wir, die API-Endpoints mit [Express.js](https://expressjs.com) zu wrappen — die Business-Logik bleibt identisch, nur der Handler-Export ändert sich.

---

## KI-Funktionen im Detail

### Plan-Analyse (`/api/analyze-plan`)

Nimmt einen Bauplan als PDF oder Bild (base64), gibt strukturiertes JSON zurück:
- Plan-Typ (Grundriss, Schnitt, Fassade)
- Gebäudedimensionen
- Raumaufstellung mit Flächen
- Fenster- und Türenanzahl

**Verwendetes Modell:** `claude-sonnet-4-6`
**Max. Dateigrösse:** 20 MB

### LV-Import (`/api/lv-import`)

Nimmt ein oder mehrere Leistungsverzeichnisse als PDF, extrahiert Einheitspreise:
- Positionsnummer, BKP-Gruppe
- Bezeichnung, Einheit, Einheitspreis CHF

**Verwendetes Modell:** `claude-sonnet-4-6`
**Max. Dateigrösse:** 20 MB pro Datei

### Modell wechseln

In `api/analyze-plan.js` und `api/lv-import.js`:
```js
// Günstiger (ca. 25× billiger):
model: 'claude-haiku-4-5-20251001'

// Standard (empfohlen):
model: 'claude-sonnet-4-6'

// Beste Qualität:
model: 'claude-opus-4-6'
```

---

## Externe APIs (kostenlos, keine Keys nötig)

Die App nutzt folgende öffentliche Schweizer Geodaten-APIs — **keine Registrierung oder API-Keys erforderlich:**

| API | Verwendung |
|---|---|
| `api3.geo.admin.ch` | Adresssuche, Höhendaten, Parzellen-Identify |
| `geodienste.ch` | Parzellendaten, KBS (Kataster belasteter Standorte) |
| `wmts.geo.admin.ch` | Kartenbilder (Orthofoto, Vermessung) |
| `tile.openstreetmap.org` | Fallback-Karte |

---

## Lokale Entwicklung

```bash
# Repository klonen
git clone https://github.com/raphaelvonbueren-hue/forol-lab.git
cd forol-research-lab

# Vercel CLI installieren
npm install -g vercel

# Projekt mit Vercel verknüpfen (einmalig)
vercel link

# Umgebungsvariablen lokal laden
vercel env pull .env.local

# Lokalen Dev-Server starten
vercel dev
# → http://localhost:3000
```

Ohne Vercel CLI — nur Frontend (ohne KI-Funktionen):
```bash
# Beliebigen Static-Server starten
npx serve public
# → http://localhost:3000
```

---

## Automatische Deployments (CI/CD)

Nach der Vercel-Verknüpfung mit GitHub wird bei jedem `git push` auf `main` automatisch deployed.

```bash
# Änderungen pushen → automatisches Deployment
git add .
git commit -m "Änderung"
git push origin main
# → Vercel deployt in ~60 Sekunden
```

---

## Häufige Probleme

### „API Fehler 401" beim LV-Import / Plan-Analyse
→ `ANTHROPIC_API_KEY` ist nicht gesetzt oder abgelaufen. In Vercel Environment Variables prüfen und Redeploy durchführen.

### „Credit balance too low"
→ Anthropic-Konto aufladen: [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing)

### Karte zeigt grau
→ Swisstopo-Tiles laden asynchron. Browser-Cache leeren (Ctrl+Shift+R) und kurz warten.

### Parzelle nicht gefunden
→ Die App unterstützt TG, SG, AI, AR. Andere Kantone sind nicht eingebunden.

### „Warning: Node.js functions are compiled from ESM to CommonJS"
→ Harmlose Warnung. Behoben durch `"type": "module"` in `package.json` (bereits gesetzt).

---

## Anpassungen für eigenes Branding

Alle Anpassungen in `public/index.html`:

```js
// Zeile ~1: Projekttitel
<title>FOROL research lab</title>

// Farben (CSS Variablen, ca. Zeile 50):
--red: #c62828;    /* Hauptfarbe */
--dk: #1a1a1a;     /* Text dunkel */

// Regionen (Kantone, ca. Zeile 850):
// BKP-Regionsfaktoren für TG, SG, AI, AR
```

---

## Support & Kontakt

- **GitHub:** [raphaelvonbueren-hue/forol-lab](https://github.com/raphaelvonbueren-hue/forol-lab)
- **Live-Demo:** [forol-lab.vercel.app](https://forol-lab.vercel.app)
- **Anthropic Docs:** [docs.anthropic.com](https://docs.anthropic.com)
- **Vercel Docs:** [vercel.com/docs](https://vercel.com/docs)

---

*Stand: April 2026 — FOROL Research Lab v4.0*
