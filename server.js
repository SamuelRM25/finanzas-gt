// Server para Render
// Sirve la app + API completa (movimientos, presupuestos, metas, préstamos, visacuotas, simuladores)

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

const IDS = {
  // Database IDs (para crear pages)
  movimientos: '3f5e0d97deba815db317c75dba96970a',
  presupuestos: '3f5e0d97deba819d8d50d88f6eb72cb2',
  metas: '3f5e0d97deba8167a56affcb6ed1dc7b',
  prestamos: '3f5e0d97deba8106a007d9b0bdbd0bdb',
  visacuotas: '3f6e0d97deba81b0acdbdc68104dd09a',
  // Data source IDs (para queries y properties)
  dataSourceMov: '3f5e0d97deba814ebf1b000bc7a38d76',
  dataSourcePres: '3f5e0d97deba8152b5d3000b53c4e437',
  dataSourceMetas: '3f5e0d97deba8125b910000bd21f101e',
  dataSourcePrest: '3f5e0d97deba81c589af000b847016bf',
  dataSourceVisa: '3f6e0d97deba81b18396000be7473244',
};
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';

// Para /api/options: mapeo campo -> data source ID
const SELECT_FIELDS = {
  [IDS.dataSourceMov]: ['Tipo', 'Categoria', 'Cuenta', 'Moneda'],
  [IDS.dataSourcePres]: ['Estado'],
  [IDS.dataSourceMetas]: ['Estado', 'Estrategia'],
  [IDS.dataSourcePrest]: ['Tipo', 'Estado', 'Tipo tasa'],
  [IDS.dataSourceVisa]: ['Estado', 'Tipo cuota'],
};

// Para /api/options (POST): mapeo field -> data source ID
const FIELD_TO_DATA_SOURCE = {
  'Tipo': IDS.dataSourceMov,
  'Categoria': IDS.dataSourceMov,
  'Cuenta': IDS.dataSourceMov,
  'Moneda': IDS.dataSourceMov,
  'Estrategia': IDS.dataSourceMetas,
  'Tipo tasa': IDS.dataSourcePrest,
};

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function checkAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${APP_PASSWORD}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

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

async function queryDatabase(databaseId, filter = {}, sorts = [], pageSize = 100) {
  const r = await notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter, sorts, page_size: pageSize }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion ${r.status}: ${text}`);
  }
  return r.json();
}

async function createPage(databaseId, properties) {
  const r = await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion ${r.status}: ${text}`);
  }
  return r.json();
}

async function getDatabaseSchema(databaseId) {
  // Try data source first (new API), then database
  const dsResp = await notionFetch(`/data_sources/${databaseId}`);
  if (dsResp.ok) return (await dsResp.json()).properties || {};
  const dbResp = await notionFetch(`/databases/${databaseId}`);
  if (!dbResp.ok) throw new Error(`Notion ${dbResp.status}: ${await dbResp.text()}`);
  return (await dbResp.json()).properties || {};
}

// ============================================
// OPTIONS
// ============================================
app.get('/api/options', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const result = {};
    for (const [dsId, fields] of Object.entries(SELECT_FIELDS)) {
      result[dsId] = {};
      try {
        const props = await getDatabaseSchema(dsId);
        for (const field of fields) {
          const sel = props[field]?.select;
          result[dsId][field] = sel ? sel.options.map(o => o.name) : [];
        }
      } catch (e) {
        console.error(`Error loading options for ${dsId}:`, e.message);
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/options', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const { field, name } = req.body || {};
    if (!field || !name) return res.status(400).json({ error: 'field y name requeridos' });

    const dsId = FIELD_TO_DATA_SOURCE[field];
    if (!dsId) return res.status(400).json({ error: `Field no soportado: ${field}` });

    // Get current options
    const props = await getDatabaseSchema(dsId);
    const current = props[field]?.select?.options || [];
    if (current.find(o => o.name === name)) {
      return res.json({ ok: true, alreadyExists: true });
    }

    const newOptions = [...current, { name }];
    const r = await notionFetch(`/data_sources/${dsId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: { [field]: { select: { options: newOptions } } }
      }),
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: await r.text() });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// MOVIMIENTOS
// ============================================
app.get('/api/movements', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const { month } = req.query;
    let start, end;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      start = `${y}-${String(m).padStart(2, '0')}-01`;
      const nm = new Date(y, m, 1);
      end = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}-01`;
    } else {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      start = `${y}-${m}-01`;
      const nm = new Date(y, now.getMonth() + 1, 1);
      end = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}-01`;
    }
    const data = await queryDatabase(
      IDS.dataSourceMov,
      { and: [
        { property: 'Fecha', date: { on_or_after: start } },
        { property: 'Fecha', date: { before: end } },
      ]},
      [{ property: 'Fecha', direction: 'descending' }],
      200
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/movements', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const { tipo, cuenta, monto, categoria, nota, fecha, cuentaDestino, moneda, visacuotaId, presupuestoId, metaId, prestamoId } = req.body || {};
    if (!tipo || !cuenta || !monto) return res.status(400).json({ error: 'tipo, cuenta y monto requeridos' });

    const fechaFinal = fecha || new Date().toISOString().split('T')[0];
    const categoriaFinal = categoria || 'Otro';
    const notaFinal = nota || '';
    const monedaFinal = moneda || 'GTQ';

    const baseProps = {
      Nombre: { title: [{ text: { content: `${tipo} - ${cuenta} - ${monedaFinal === 'USD' ? '$' : 'Q'}${Math.abs(monto)}` }}] },
      Fecha: { date: { start: fechaFinal } },
      Tipo: { select: { name: tipo } },
      Monto: { number: Math.abs(monto) },
      Categoria: { select: { name: categoriaFinal } },
      Cuenta: { select: { name: cuenta } },
      Moneda: { select: { name: monedaFinal } },
      Nota: { rich_text: [{ text: { content: notaFinal } }] },
    };
    if (visacuotaId) baseProps.Visacuota = { relation: [{ id: visacuotaId }] };
    if (presupuestoId) baseProps.Presupuesto = { relation: [{ id: presupuestoId }] };
    if (metaId) baseProps.Meta = { relation: [{ id: metaId }] };
    if (prestamoId) baseProps.Prestamo = { relation: [{ id: prestamoId }] };

    const movimiento = await createPage(IDS.movimientos, baseProps);

    // Transferencia: crear el segundo movimiento (entrada en destino)
    if (tipo === 'Transferencia' && cuentaDestino) {
      await createPage(IDS.movimientos, {
        ...baseProps,
        Nombre: { title: [{ text: { content: `Transferencia - ${cuentaDestino} - ${monedaFinal === 'USD' ? '$' : 'Q'}${Math.abs(monto)}` }}] },
        Tipo: { select: { name: 'Ingreso' } },
        Cuenta: { select: { name: cuentaDestino } },
        Nota: { rich_text: [{ text: { content: `Recibido de ${cuenta}: ${notaFinal}` } }] },
      });
    }

    // Pago de TC: crear movimiento positivo en TC (reduce deuda)
    if (tipo === 'Pago de tarjeta' && cuentaDestino) {
      await createPage(IDS.movimientos, {
        ...baseProps,
        Nombre: { title: [{ text: { content: `Pago TC - ${cuentaDestino} - ${monedaFinal === 'USD' ? '$' : 'Q'}${Math.abs(monto)}` }}] },
        Tipo: { select: { name: 'Pago de tarjeta' } },
        Cuenta: { select: { name: cuentaDestino } },
        Nota: { rich_text: [{ text: { content: `Pagado desde ${cuenta}: ${notaFinal}` } }] },
      });
    }

    res.json({ ok: true, id: movimiento.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// PRESUPUESTOS
// ============================================
app.get('/api/presupuestos', checkAuth, async (req, res) => {
  try {
    const data = await queryDatabase(IDS.dataSourcePres, {}, [], 50);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/presupuestos', checkAuth, async (req, res) => {
  try {
    const { categoria, limiteMensual, mes, fechaLimite, estado, notas } = req.body || {};
    if (!categoria || !limiteMensual) return res.status(400).json({ error: 'categoria y limiteMensual requeridos' });

    const page = await createPage(IDS.presupuestos, {
      Categoria: { title: [{ text: { content: categoria } }] },
      'Limite mensual': { number: Number(limiteMensual) },
      Mes: { date: { start: mes || new Date().toISOString().slice(0, 10) } },
      'Fecha limite': fechaLimite ? { date: { start: fechaLimite } } : undefined,
      Estado: { select: { name: estado || 'Pendiente' } },
      Notas: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
    });
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// METAS
// ============================================
app.get('/api/metas', checkAuth, async (req, res) => {
  try {
    const data = await queryDatabase(IDS.dataSourceMetas, {}, [], 50);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/metas', checkAuth, async (req, res) => {
  try {
    const { meta, montoObjetivo, fechaObjetivo, estrategia, cuotaSugerida, notas, estado } = req.body || {};
    if (!meta || !montoObjetivo) return res.status(400).json({ error: 'meta y montoObjetivo requeridos' });

    const page = await createPage(IDS.metas, {
      Meta: { title: [{ text: { content: meta } }] },
      'Monto objetivo': { number: Number(montoObjetivo) },
      'Fecha objetivo': fechaObjetivo ? { date: { start: fechaObjetivo } } : undefined,
      Estrategia: estrategia ? { select: { name: estrategia } } : undefined,
      'Cuota sugerida': cuotaSugerida ? { number: Number(cuotaSugerida) } : undefined,
      Notas: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
      Estado: { select: { name: estado || 'Activa' } },
    });
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// PRESTAMOS
// ============================================
app.get('/api/prestamos', checkAuth, async (req, res) => {
  try {
    const data = await queryDatabase(IDS.dataSourcePrest, {}, [], 50);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prestamos', checkAuth, async (req, res) => {
  try {
    const { prestamo, tipo, contraparte, montoTotal, tasaInteres, tipoTasa, fechaInicio, fechaVencimiento, cuotasTotales, estado, notas } = req.body || {};
    if (!prestamo || !montoTotal || !cuotasTotales) return res.status(400).json({ error: 'prestamo, montoTotal y cuotasTotales requeridos' });

    // Calcular cuota mensual
    const r = tasaInteres || 0;
    const n = Number(cuotasTotales);
    const P = Number(montoTotal);
    let cuota = 0;
    if (r > 0) {
      cuota = P * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    } else {
      cuota = P / n;
    }
    const totalPagar = cuota * n;
    const totalInteres = totalPagar - P;

    const page = await createPage(IDS.prestamos, {
      Prestamo: { title: [{ text: { content: prestamo } }] },
      Tipo: { select: { name: tipo || 'Me prestaron' } },
      Contraparte: contraparte ? { rich_text: [{ text: { content: contraparte } }] } : undefined,
      'Monto total': { number: P },
      'Tasa de interes': { number: Number(tasaInteres) || 0 },
      'Tipo tasa': { select: { name: tipoTasa || 'Mensual' } },
      'Fecha inicio': fechaInicio ? { date: { start: fechaInicio } } : undefined,
      'Fecha vencimiento': fechaVencimiento ? { date: { start: fechaVencimiento } } : undefined,
      'Cuotas totales': { number: n },
      'Cuotas pagadas': { number: 0 },
      'Cuota mensual': { number: Math.round(cuota * 100) / 100 },
      'Total a pagar': { number: Math.round(totalPagar * 100) / 100 },
      'Total interes': { number: Math.round(totalInteres * 100) / 100 },
      Estado: { select: { name: estado || 'En curso' } },
      Nota: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
    });
    res.json({ ok: true, id: page.id, cuota, totalPagar, totalInteres });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// VISACUOTAS
// ============================================
app.get('/api/visacuotas', checkAuth, async (req, res) => {
  try {
    const data = await queryDatabase(IDS.dataSourceVisa, {}, [], 50);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/visacuotas', checkAuth, async (req, res) => {
  try {
    const { nombre, establecimiento, fechaCompra, montoTotal, cuotasTotales, tasaMensual, tasaAnual, tipoCuota, estado, notas } = req.body || {};
    if (!nombre || !montoTotal || !cuotasTotales) return res.status(400).json({ error: 'nombre, montoTotal y cuotasTotales requeridos' });

    // Si dio tasa anual, calcular mensual
    let tasaMens = Number(tasaMensual) || 0;
    if (tasaAnual && !tasaMensual) {
      tasaMens = Number(tasaAnual) / 12 / 100;
    } else if (tasaMensual) {
      tasaMens = Number(tasaMensual) / 100;
    }

    const page = await createPage(IDS.visacuotas, {
      Nombre: { title: [{ text: { content: nombre } }] },
      Establecimiento: establecimiento ? { rich_text: [{ text: { content: establecimiento } }] } : undefined,
      'Fecha compra': fechaCompra ? { date: { start: fechaCompra } } : undefined,
      'Monto total': { number: Number(montoTotal) },
      'Cuotas totales': { number: Number(cuotasTotales) },
      'Cuotas pagadas': { number: 0 },
      'Tasa mensual': { number: tasaMens },
      'Tasa anual': { number: Number(tasaAnual) || 0 },
      'Tipo cuota': { select: { name: tipoCuota || (tasaMens > 0 ? 'Con interes' : 'Sin interes') } },
      Estado: { select: { name: estado || 'Activa' } },
      Notas: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
    });
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SIMULADORES
// ============================================
app.post('/api/calc/loan', (req, res) => {
  // Calculadora de préstamo (cliente y servidor)
  const { monto, tasa, plazo, tipoTasa = 'Mensual' } = req.body || {};
  if (!monto || !plazo) return res.status(400).json({ error: 'monto y plazo requeridos' });

  const P = Number(monto);
  const n = Number(plazo);
  let r = Number(tasa) || 0;
  if (tipoTasa === 'Anual') r = r / 12 / 100;
  else r = r / 100;

  let cuota = 0;
  if (r > 0) {
    cuota = P * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  } else {
    cuota = P / n;
  }
  const totalPagar = cuota * n;
  const totalInteres = totalPagar - P;

  // Tabla de amortización (primeros 12 meses)
  let saldo = P;
  const amortizacion = [];
  for (let i = 1; i <= Math.min(n, 12); i++) {
    const interes = saldo * r;
    const capital = cuota - interes;
    saldo -= capital;
    amortizacion.push({ mes: i, cuota, interes, capital, saldo: Math.max(0, saldo) });
  }

  res.json({
    cuotaMensual: Math.round(cuota * 100) / 100,
    totalPagar: Math.round(totalPagar * 100) / 100,
    totalInteres: Math.round(totalInteres * 100) / 100,
    amortizacion,
  });
});

app.post('/api/calc/savings', (req, res) => {
  const { objetivo, meses, aporteMensual, tasaAnual = 0 } = req.body || {};
  if (!objetivo) return res.status(400).json({ error: 'objetivo requerido' });

  const meta = Number(objetivo);
  const r = (Number(tasaAnual) || 0) / 100 / 12;

  if (aporteMensual) {
    // Con aporte mensual, calcular meses para llegar a la meta
    const A = Number(aporteMensual);
    let mesesCalc = 0;
    let saldo = 0;
    while (saldo < meta && mesesCalc < 600) {
      saldo = saldo * (1 + r) + A;
      mesesCalc++;
    }
    const totalAportado = A * mesesCalc;
    const intereses = saldo - totalAportado;

    res.json({
      meses: mesesCalc,
      anos: Math.round(mesesCalc / 12 * 10) / 10,
      totalAportado: Math.round(totalAportado * 100) / 100,
      intereses: Math.round(intereses * 100) / 100,
    });
  } else if (meses) {
    // Con meses, calcular aporte mensual
    const n = Number(meses);
    let A;
    if (r > 0) {
      A = meta * r / (Math.pow(1 + r, n) - 1);
    } else {
      A = meta / n;
    }
    res.json({
      aporteMensual: Math.round(A * 100) / 100,
      totalAportado: Math.round(A * n * 100) / 100,
      meses: n,
    });
  } else {
    res.status(400).json({ error: 'aporteMensual o meses requerido' });
  }
});

app.post('/api/calc/installment', (req, res) => {
  const { monto, cuotas, tasaMensual = 0, tasaAnual = 0 } = req.body || {};
  if (!monto || !cuotas) return res.status(400).json({ error: 'monto y cuotas requeridos' });

  const P = Number(monto);
  const n = Number(cuotas);
  let r = Number(tasaMensual) || 0;
  if (tasaAnual && !tasaMensual) r = Number(tasaAnual) / 12 / 100;
  else if (tasaMensual) r = Number(tasaMensual) / 100;
  // Si no se especifica tasa, asumir 0 (caso típico de visacuotas en GT)
  if (!tasaMensual && !tasaAnual) r = 0;

  let cuota = 0;
  if (r > 0) {
    cuota = P * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  } else {
    cuota = P / n;
  }
  const totalPagar = cuota * n;
  const totalInteres = totalPagar - P;
  res.json({
    cuotaMensual: Math.round(cuota * 100) / 100,
    totalPagar: Math.round(totalPagar * 100) / 100,
    totalInteres: Math.round(totalInteres * 100) / 100,
    conInteres: r > 0,
  });
});

// ============================================
// HEALTH
// ============================================
app.get('/health', (req, res) => res.json({ ok: true }));

// ============================================
// FAVICON
// ============================================
app.get('/favicon.ico', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">💰</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Static files
app.use(express.static(path.join(__dirname)));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`💰 Finanzas GT on port ${PORT}`);
  console.log(`   TOKEN: ${NOTION_TOKEN ? 'OK' : 'MISSING'}`);
  console.log(`   PASSWORD: ${APP_PASSWORD ? 'set' : 'open'}`);
});