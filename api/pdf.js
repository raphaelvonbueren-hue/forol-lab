// POST /api/pdf
// Accepts a BKP payload, generates a PDF server-side and returns it as binary.
// Uses @vercel/og or a lightweight approach with pdfkit.
// For now: returns a pre-formatted JSON that the client can use with jsPDF.
// Phase 2: swap to server-side pdfkit for fully server-rendered PDFs.

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Source');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = req.body;
  if (!body?.project) {
    return res.status(400).json({ error: 'payload missing' });
  }

  // Return structured data the client uses to render PDF with jsPDF
  // Phase 2: generate real PDF bytes with pdfkit and return as application/pdf
  res.status(200).json({
    status:    'ok',
    renderMode: 'client',   // client uses jsPDF; server rendering in Phase 2
    filename:  `FOROL_KV_${(body.project.name||'Projekt').replace(/\s+/g,'_')}_${new Date().toISOString().split('T')[0]}.pdf`,
    message:   'Client-side PDF rendering aktiv. Server-PDF in Phase 2 verfügbar.'
  });
}
