// Server para Render
// - Sirve la app estática (index.html)
// - Expone /api/options y /api/movements con proxy a Notion
// - Auth simple por Bearer token

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const DATABASE_ID = process.env.DATABASE_ID || '3f5e0d97deba815db317c75dba96970a';
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID || '3f5e0d97deba814ebf1b000bc7a38d76';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Auth check (skip for / and /static)
function checkAuth(req, res, next) {
  if (!APP_PASSWORD) return next(); // sin password = abierto (solo dev)
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${APP_PASSWORD}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Proxy a Notion
async function notionFetch(path, options = {}) {
  const url = `${NOTION_API}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return response;
}

// API: GET /api/options
app.get('/api/options', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const r = await notionFetch(`/databases/${DATABASE_ID}`);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    const db = await r.json();
    const props = db.properties || {};
    const names = (field) => {
      const sel = props[field]?.select;
      return sel ? sel.options.map((o) => o.name) : [];
    };
    return res.json({
      tipos: names('Tipo'),
      categorias: names('Categoria'),
      cuentas: names('Cuenta'),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// API: GET /api/movements - lista del mes actual
app.get('/api/movements', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const start = `${y}-${m}-01`;
    const nm = new Date(y, now.getMonth() + 1, 1);
    const end = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}-01`;

    const r = await notionFetch(`/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Fecha', date: { on_or_after: start } },
            { property: 'Fecha', date: { before: end } },
          ],
        },
        sorts: [{ property: 'Fecha', direction: 'descending' }],
        page_size: 100,
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }

    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// API: POST /api/movements - crea nuevo movimiento
app.post('/api/movements', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const { tipo, cuenta, monto, categoria, nota, fecha, cuentaDestino } = req.body || {};

    if (!tipo || !cuenta || !monto) {
      return res.status(400).json({ error: 'tipo, cuenta y monto son requeridos' });
    }

    const fechaFinal = fecha || new Date().toISOString().split('T')[0];
    const categoriaFinal = categoria || 'Otro';
    const notaFinal = nota || '';

    async function crear(props) {
      const r = await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: DATABASE_ID },
          properties: props,
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`Notion ${r.status}: ${text}`);
      }
      return r.json();
    }

    const baseProps = {
      Nombre: { title: [{ text: { content: `${tipo} - ${cuenta} - Q${Math.abs(monto)}` }}] },
      Fecha: { date: { start: fechaFinal } },
      Tipo: { select: { name: tipo } },
      Monto: { number: Math.abs(monto) },
      Categoria: { select: { name: categoriaFinal } },
      Cuenta: { select: { name: cuenta } },
      Nota: { rich_text: [{ text: { content: notaFinal } }] },
    };

    const movimiento = await crear(baseProps);

    // Si es transferencia, crear el segundo movimiento
    if (tipo === 'Transferencia' && cuentaDestino) {
      await crear({
        ...baseProps,
        Nombre: { title: [{ text: { content: `Transferencia - ${cuentaDestino} - Q${Math.abs(monto)}` }}] },
        Tipo: { select: { name: 'Ingreso' } },
        Cuenta: { select: { name: cuentaDestino } },
        Nota: { rich_text: [{ text: { content: `Recibido de ${cuenta}: ${notaFinal}` } }] },
      });
    }

    return res.json({ ok: true, id: movimiento.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Favicon (SVG con emoji 💰)
app.get('/favicon.ico', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">💰</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Static files
app.use(express.static(path.join(__dirname)));

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`💰 Finanzas GT running on port ${PORT}`);
  console.log(`   NOTION_TOKEN: ${NOTION_TOKEN ? 'OK' : 'MISSING'}`);
  console.log(`   APP_PASSWORD: ${APP_PASSWORD ? 'set' : 'NOT SET (open access)'}`);
});