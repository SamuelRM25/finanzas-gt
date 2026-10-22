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
  tarjetas: '3ee575263b0e4e72a40757690bc846e2',
  suscripciones: '89b7a512-0037-4398-a4e0-ae82c1ed6ac3',
  // Data source IDs (para queries y properties)
  dataSourceMov: '3f5e0d97deba814ebf1b000bc7a38d76',
  dataSourcePres: '3f5e0d97deba8152b5d3000b53c4e437',
  dataSourceMetas: '3f5e0d97deba8125b910000bd21f101e',
  dataSourcePrest: '3f5e0d97deba81c589af000b847016bf',
  dataSourceVisa: '3f6e0d97deba81b18396000be7473244',
  dataSourceTarjetas: '512162cf5fda449ab49be3af66596efa',
  dataSourceSuscripciones: '9f24468d-0529-46e5-a534-53a860561038',
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
  [IDS.dataSourceSuscripciones]: ['Frecuencia', 'Estado'],
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

const MAX_QUERY_PAGES = 100; // tope de seguridad: 100 paginas x 100 = 10,000 filas

async function queryDatabase(dataSourceId, filter = null, sorts = [], pageSize = 100) {
  const results = [];
  let cursor = null;

  for (let page = 0; page < MAX_QUERY_PAGES; page++) {
    const body = { page_size: pageSize };
    if (filter && Object.keys(filter).length > 0) body.filter = filter;
    if (sorts && sorts.length > 0) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const r = await notionFetch(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Notion ${r.status}: ${text}`);
    }

    const data = await r.json();
    results.push(...(data.results || []));

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return {
    object: 'list',
    results,
    next_cursor: null,
    has_more: false,
  };
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
app.get('/api/upcoming-payments', checkAuth, async (req, res) => {
  // Devuelve los pagos de los próximos N días (default 7)
  const days = Number(req.query.days) || 7;
  const now = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const result = [];

  try {
    // Préstamos
    const presResult = await queryDatabase(IDS.dataSourcePrest, {}, [], 100);
    for (const p of (presResult.results || [])) {
      const pProps = p.properties;
      const pag = getNumber(pProps, 'Cuotas pagadas');
      const total = getNumber(pProps, 'Cuotas totales');
      if (pag >= total) continue;
      const cuota = getNumber(pProps, 'Cuota mensual');
      const nombre = getTitle(pProps, 'Prestamo');
      const inicio = getDate(pProps, 'Fecha inicio');
      if (!inicio) continue;
      // Calcular próxima cuota
      const inicioDate = new Date(inicio);
      const mesesDesdeInicio = (now.getFullYear() - inicioDate.getFullYear()) * 12 + (now.getMonth() - inicioDate.getMonth());
      let proximaCuotaNum = pag + 1;
      let proximaFecha = new Date(inicioDate);
      proximaFecha.setMonth(inicioDate.getMonth() + pag);
      if (proximaFecha < now) {
        proximaFecha = new Date(now.getFullYear(), now.getMonth(), inicioDate.getDate());
        if (proximaFecha < now) {
          proximaFecha.setMonth(proximaFecha.getMonth() + 1);
        }
      }
      const daysUntil = Math.ceil((proximaFecha - now) / (1000 * 60 * 60 * 24));
      if (daysUntil <= days) {
        result.push({
          id: p.id,
          type: 'prestamo',
          name: nombre,
          cuota: proximaCuotaNum,
          total: total,
          monto: cuota,
          fecha: proximaFecha.toISOString().split('T')[0],
          daysUntil,
        });
      }
    }
  } catch (e) { console.error('Error cargando prestamos:', e.message); }

  try {
    // Visacuotas agrupadas por TC (mostrar fecha_pago de la TC, no individual)
    const visResult = await queryDatabase(IDS.dataSourceVisa, {}, [], 100);
    const tarjetas = await loadTarjetas();
    const tcByName = {};
    for (const t of tarjetas) tcByName[t.name] = t;

    // Agrupar visacuotas activas por TC
    const porTc = {};
    for (const v of (visResult.results || [])) {
      const vProps = v.properties;
      const pag = getNumber(vProps, 'Cuotas pagadas');
      const total = getNumber(vProps, 'Cuotas totales');
      if (pag >= total) continue;
      const cuota = getNumber(vProps, 'Cuota mensual') || 0;
      const tarjeta = getText(vProps, 'Tarjeta');
      if (!tarjeta) continue; // sin TC asignada, no se puede calcular fecha
      if (!porTc[tarjeta]) porTc[tarjeta] = { monto: 0, count: 0, items: [] };
      porTc[tarjeta].monto += cuota;
      porTc[tarjeta].count += 1;
      porTc[tarjeta].items.push({ id: v.id, cuota, pag, total });
    }

    for (const [tcName, grupo] of Object.entries(porTc)) {
      const tc = tcByName[tcName];
      if (!tc || !tc.fechaPago) continue;
      // Calcular próxima fecha de pago >= hoy
      let proximaFecha = new Date(tc.fechaPago + 'T00:00:00');
      // Si la fecha de pago ya pasó este mes, sumar 1 mes
      if (proximaFecha < now) {
        proximaFecha = new Date(proximaFecha.getFullYear(), proximaFecha.getMonth() + 1, proximaFecha.getDate());
      }
      const daysUntil = Math.ceil((proximaFecha - now) / (1000 * 60 * 60 * 24));
      if (daysUntil <= days) {
        result.push({
          id: 'tc:' + tcName,
          type: 'tarjeta',
          name: tcName,
          monto: grupo.monto,
          fecha: proximaFecha.toISOString().split('T')[0],
          daysUntil,
          tarjeta: { name: tcName, fechaPago: tc.fechaPago, fechaCorte: tc.fechaCorte, saldoActual: tc.saldoActual },
          visacuotasCount: grupo.count,
        });
      }
    }
  } catch (e) { console.error('Error cargando visacuotas:', e.message); }

  result.sort((a, b) => a.daysUntil - b.daysUntil);
  res.json({ payments: result });
});

function getNumber(props, key) {
  const v = props[key];
  if (!v) return 0;
  if (v.type === 'number') return v.number || 0;
  if (v.type === 'formula' && v.formula?.type === 'number') return v.formula.number || 0;
  return 0;
}
function getTitle(props, key) {
  const v = props[key];
  if (!v || v.type !== 'title') return '';
  return (v.title || []).map(r => r.plain_text || r.text?.content || '').join('');
}
function getDate(props, key) {
  const v = props[key];
  if (!v || v.type !== 'date') return null;
  return v.date?.start || null;
}
function getText(props, key) {
  const v = props[key];
  if (!v || v.type !== 'rich_text') return '';
  return (v.rich_text || []).map(r => r.plain_text || r.text?.content || '').join('');
}

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

    // Pago de TC: UN SOLO cargo en la cuenta origen.
    // Las visacuotas vinculadas solo avanzan su contador (sin movimientos extra),
    // y la deuda de la TC (Saldo actual) se reduce. No se crea movimiento en la TC
    // para no duplicar el cobro.
    let pagoTcResumen = null;
    if (tipo === 'Pago de tarjeta' && cuentaDestino) {
      try {
        // Buscar visacuotas con Tarjeta = nombre de la TC
        const visQuery = await queryDatabase(IDS.dataSourceVisa, {
          property: 'Tarjeta',
          rich_text: { contains: cuentaDestino },
        });
        const visacuotas = visQuery.results || [];
        const avanzadas = [];
        for (const v of visacuotas) {
          const vId = v.id;
          const vProps = v.properties;
          const vNombre = vProps['Nombre']?.title?.[0]?.text?.content || vProps['Nombre']?.title?.[0]?.plain_text || '?';
          const vTotal = vProps['Cuotas totales']?.number || 0;
          const vPagadas = vProps['Cuotas pagadas']?.number || 0;
          if (vPagadas < vTotal) {
            const nuevasPagadas = vPagadas + 1;
            const patchProps = { 'Cuotas pagadas': { number: nuevasPagadas } };
            if (nuevasPagadas >= vTotal) {
              patchProps.Estado = { select: { name: 'Pagada' } };
            }
            // Solo avanzar contador, SIN crear movimientos por visacuota
            // (el unico movimiento financiero es el base en la cuenta origen).
            await updatePage(vId, patchProps);
            avanzadas.push(`${vNombre} (${nuevasPagadas}/${vTotal})`);
          }
        }
        // Reducir la deuda de la TC (Saldo actual)
        let nuevoSaldoTc = null;
        try {
          const tarjetas = await loadTarjetas();
          const tc = (tarjetas || []).find(t => t.name === cuentaDestino);
          if (tc) {
            nuevoSaldoTc = Math.max(0, (Number(tc.saldoActual) || 0) - Math.abs(Number(monto) || 0));
            await updatePage(tc.id, { 'Saldo actual': { number: nuevoSaldoTc } });
          }
        } catch (e) {
          console.error('Error actualizando saldo de TC:', e.message);
        }
        pagoTcResumen = {
          visacuotasAvanzadas: avanzadas.length,
          detalle: avanzadas,
          nuevoSaldoTc,
        };
      } catch (e) {
        console.error('Error actualizando visacuotas:', e.message);
      }
    }

    res.json({ ok: true, id: movimiento.id, pagoTc: pagoTcResumen });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: actualizar campos de una página por ID
async function updatePage(pageId, properties) {
  const r = await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion ${r.status}: ${text}`);
  }
  return r.json();
}

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

app.patch('/api/presupuestos/:id', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, montoPagado, categoria, limiteMensual, fechaLimite, notas } = req.body || {};
    const props = {};
    if (estado !== undefined) props.Estado = { select: { name: estado } };
    if (montoPagado !== undefined) props['Monto pagado'] = { number: Number(montoPagado) };
    if (categoria !== undefined) props.Categoria = { title: [{ text: { content: categoria } }] };
    if (limiteMensual !== undefined) props['Limite mensual'] = { number: Number(limiteMensual) };
    if (fechaLimite !== undefined) props['Fecha limite'] = { date: { start: fechaLimite } };
    if (notas !== undefined) props.Notas = { rich_text: [{ text: { content: notas } }] };

    const page = await updatePage(id, props);
    res.json({ ok: true, id: page.id });
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

app.patch('/api/metas/:id', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, montoObjetivo, fechaObjetivo, estrategia, cuotaSugerida, notas, ahorrado, aporte } = req.body || {};
    const props = {};
    if (estado !== undefined) props.Estado = { select: { name: estado } };
    if (montoObjetivo !== undefined) props['Monto objetivo'] = { number: Number(montoObjetivo) };
    if (fechaObjetivo !== undefined) props['Fecha objetivo'] = fechaObjetivo ? { date: { start: fechaObjetivo } } : { date: null };
    if (estrategia !== undefined) props.Estrategia = { select: { name: estrategia } };
    if (cuotaSugerida !== undefined) props['Cuota sugerida'] = { number: Number(cuotaSugerida) };
    if (notas !== undefined) props.Notas = { rich_text: [{ text: { content: notas } }] };
    if (ahorrado !== undefined) props.Ahorrado = { number: Number(ahorrado) };
    // aporte: amount to add to current Ahorrado
    if (aporte !== undefined) {
      const current = await getMetaAhorrado(id);
      props.Ahorrado = { number: current + Number(aporte) };
    }

    const page = await updatePage(id, props);
    res.json({ ok: true, id: page.id, nuevoAhorrado: props.Ahorrado?.number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getMetaAhorrado(id) {
  try {
    const r = await notionFetch(`/pages/${id}`);
    if (!r.ok) return 0;
    const p = await r.json();
    return p.properties?.Ahorrado?.number || 0;
  } catch { return 0; }
}

// ============================================
// SUSCRIPCIONES
// ============================================
function suscripcionProps(p = {}) {
  return {
    suscripcion: p['Suscripcion']?.title?.[0]?.plain_text || p['Suscripcion']?.title?.[0]?.text?.content || '?',
    monto: p['Monto']?.number || 0,
    frecuencia: p['Frecuencia']?.select?.name || 'Mensual',
    diaCobro: p['Dia de cobro']?.number || null,
    cuenta: p['Cuenta']?.rich_text?.[0]?.plain_text || p['Cuenta']?.rich_text?.[0]?.text?.content || '',
    estado: p['Estado']?.select?.name || 'Activa',
    ultimoPago: p['Ultimo pago']?.date?.start || null,
    notas: p['Notas']?.rich_text?.[0]?.plain_text || '',
  };
}

function buildSuscripcionProps(body = {}) {
  const { suscripcion, monto, frecuencia, diaCobro, cuenta, estado, notas, ultimoPago } = body;
  const props = {};
  if (suscripcion !== undefined) props['Suscripcion'] = { title: [{ text: { content: suscripcion } }] };
  if (monto !== undefined) props['Monto'] = { number: Number(monto) };
  if (frecuencia !== undefined) props['Frecuencia'] = { select: { name: frecuencia } };
  if (diaCobro !== undefined)
    props['Dia de cobro'] = (diaCobro === null || diaCobro === '') ? { number: null } : { number: Number(diaCobro) };
  if (cuenta !== undefined) props['Cuenta'] = { rich_text: cuenta ? [{ text: { content: cuenta } }] : [] };
  if (estado !== undefined) props['Estado'] = { select: { name: estado } };
  if (notas !== undefined) props['Notas'] = { rich_text: notas ? [{ text: { content: notas } }] : [] };
  if (ultimoPago !== undefined) props['Ultimo pago'] = ultimoPago ? { date: { start: ultimoPago } } : { date: null };
  return props;
}

app.get('/api/suscripciones', checkAuth, async (req, res) => {
  try {
    const data = await queryDatabase(IDS.dataSourceSuscripciones, {}, [], 100);
    res.json({
      ...data,
      results: (data.results || []).map(p => ({ id: p.id, ...suscripcionProps(p.properties), archived: p.archived, created_time: p.created_time })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/suscripciones', checkAuth, async (req, res) => {
  try {
    const { suscripcion, monto } = req.body || {};
    if (!suscripcion || !monto) return res.status(400).json({ error: 'suscripcion y monto requeridos' });
    const page = await createPage(IDS.suscripciones, buildSuscripcionProps({
      suscripcion, monto, ...req.body,
      frecuencia: req.body.frecuencia || 'Mensual',
      estado: req.body.estado || 'Activa',
    }));
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/suscripciones/:id', checkAuth, async (req, res) => {
  try {
    const page = await updatePage(req.params.id, buildSuscripcionProps(req.body || {}));
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/suscripciones/:id', checkAuth, async (req, res) => {
  try {
    const r = await notionFetch(`/pages/${req.params.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ in_trash: true }),
    });
    if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pagar una suscripción: crea el gasto en la cuenta asignada y registra el último pago
app.post('/api/suscripciones/:id/pagar', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { monto, fecha, nota } = req.body || {};

    const r = await notionFetch(`/pages/${id}`);
    if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`);
    const sub = suscripcionProps((await r.json()).properties);

    const cuenta = req.body.cuenta || sub.cuenta;
    if (!cuenta) return res.status(400).json({ error: 'La suscripción no tiene cuenta asignada' });
    const montoFinal = Number(monto || sub.monto);
    if (!montoFinal) return res.status(400).json({ error: 'Monto inválido' });
    const fechaFinal = fecha || new Date().toISOString().split('T')[0];

    const movimiento = await createPage(IDS.movimientos, {
      Nombre: { title: [{ text: { content: `Gasto - ${cuenta} - Q${montoFinal}` } }] },
      Fecha: { date: { start: fechaFinal } },
      Tipo: { select: { name: 'Gasto' } },
      Monto: { number: montoFinal },
      Categoria: { select: { name: 'Suscripciones' } },
      Cuenta: { select: { name: cuenta } },
      Moneda: { select: { name: 'GTQ' } },
      Nota: { rich_text: [{ text: { content: nota || `Suscripción: ${sub.suscripcion}` } }] },
    });

    await updatePage(id, { 'Ultimo pago': { date: { start: fechaFinal } } });

    res.json({ ok: true, id: movimiento.id, movimientoId: movimiento.id, fecha: fechaFinal });
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
    let r = Number(tasaInteres) || 0;
    if (tipoTasa === 'Anual') r = r / 12 / 100;
    else r = r / 100;
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

    // Auto-pagos: si fechaInicio es anterior a hoy, calcular cuántas cuotas deberían estar pagadas
    let cuotasPagadasAuto = 0;
    if (fechaInicio) {
      const inicio = new Date(fechaInicio);
      const hoy = new Date();
      const mesesTranscurridos = Math.max(0, (hoy.getFullYear() - inicio.getFullYear()) * 12 + (hoy.getMonth() - inicio.getMonth()));
      cuotasPagadasAuto = Math.min(n, mesesTranscurridos);
    }

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
      'Cuotas pagadas': { number: cuotasPagadasAuto },
      'Cuota mensual': { number: Math.round(cuota * 100) / 100 },
      'Total a pagar': { number: Math.round(totalPagar * 100) / 100 },
      'Total interes': { number: Math.round(totalInteres * 100) / 100 },
      Estado: { select: { name: estado || (cuotasPagadasAuto >= n ? 'Pagado' : 'En curso') } },
      Nota: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
    });
    res.json({ ok: true, id: page.id, cuota, totalPagar, totalInteres, cuotasPagadasAuto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/prestamos/:id', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, cuotasPagadas, contraparte, notas } = req.body || {};
    const props = {};
    if (estado !== undefined) props.Estado = { select: { name: estado } };
    if (cuotasPagadas !== undefined) props['Cuotas pagadas'] = { number: Number(cuotasPagadas) };
    if (contraparte !== undefined) props.Contraparte = { rich_text: [{ text: { content: contraparte } }] };
    if (notas !== undefined) props.Nota = { rich_text: [{ text: { content: notas } }] };

    const page = await updatePage(id, props);
    res.json({ ok: true, id: page.id });
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
    const { nombre, establecimiento, fechaCompra, montoTotal, cuotasTotales, tasaMensual, tasaAnual, tipoCuota, estado, notas, tarjeta } = req.body || {};
    if (!nombre || !montoTotal || !cuotasTotales) return res.status(400).json({ error: 'nombre, montoTotal y cuotasTotales requeridos' });

    // Si dio tasa anual, calcular mensual
    let tasaMens = Number(tasaMensual) || 0;
    if (tasaAnual && !tasaMensual) {
      tasaMens = Number(tasaAnual) / 12 / 100;
    } else if (tasaMensual) {
      tasaMens = Number(tasaMensual) / 100;
    }

    // Auto-pagos: si fechaCompra es anterior a hoy
    let cuotasPagadasAuto = 0;
    if (fechaCompra) {
      const inicio = new Date(fechaCompra);
      const hoy = new Date();
      const mesesTranscurridos = Math.max(0, (hoy.getFullYear() - inicio.getFullYear()) * 12 + (hoy.getMonth() - inicio.getMonth()));
      cuotasPagadasAuto = Math.min(Number(cuotasTotales), mesesTranscurridos);
    }

    const props = {
      Nombre: { title: [{ text: { content: nombre } }] },
      Establecimiento: establecimiento ? { rich_text: [{ text: { content: establecimiento } }] } : undefined,
      'Fecha compra': fechaCompra ? { date: { start: fechaCompra } } : undefined,
      'Monto total': { number: Number(montoTotal) },
      'Cuotas totales': { number: Number(cuotasTotales) },
      'Cuotas pagadas': { number: cuotasPagadasAuto },
      'Tasa mensual': { number: tasaMens },
      'Tasa anual': { number: Number(tasaAnual) || 0 },
      'Tipo cuota': { select: { name: tipoCuota || (tasaMens > 0 ? 'Con interes' : 'Sin interes') } },
      Estado: { select: { name: estado || (cuotasPagadasAuto >= Number(cuotasTotales) ? 'Pagada' : 'Activa') } },
      Notas: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
      Tarjeta: tarjeta ? { rich_text: [{ text: { content: tarjeta } }] } : undefined,
    };

    const page = await createPage(IDS.visacuotas, props);
    res.json({ ok: true, id: page.id, cuotasPagadasAuto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/visacuotas/:id', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, cuotasPagadas, establecimiento, notas, tarjeta } = req.body || {};
    const props = {};
    if (estado !== undefined) props.Estado = { select: { name: estado } };
    if (cuotasPagadas !== undefined) props['Cuotas pagadas'] = { number: Number(cuotasPagadas) };
    if (establecimiento !== undefined) props.Establecimiento = { rich_text: [{ text: { content: establecimiento } }] };
    if (notas !== undefined) props.Notas = { rich_text: [{ text: { content: notas } }] };
    if (tarjeta !== undefined) props.Tarjeta = { rich_text: [{ text: { content: tarjeta } }] };

    const page = await updatePage(id, props);
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// TARJETAS DE CRÉDITO
// ============================================
async function loadTarjetas() {
  try {
    const r = await notionFetch(`/data_sources/${IDS.dataSourceTarjetas}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 50 }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || []).map(p => ({
      id: p.id,
      name: p.properties?.Name?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.text?.content || '',
      banco: p.properties?.Banco?.rich_text?.[0]?.plain_text || p.properties?.Banco?.rich_text?.[0]?.text?.content || '',
      fechaPago: p.properties?.['Fecha pago']?.date?.start || null,
      fechaCorte: p.properties?.['Fecha corte']?.date?.start || null,
      saldoActual: p.properties?.['Saldo actual']?.number || 0,
      limite: p.properties?.['Límite de crédito']?.number || 0,
      notas: p.properties?.Notas?.rich_text?.[0]?.plain_text || '',
    }));
  } catch (e) { return []; }
}

app.get('/api/tarjetas', checkAuth, async (req, res) => {
  try {
    const tarjetas = await loadTarjetas();
    res.json({ results: tarjetas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tarjetas', checkAuth, async (req, res) => {
  try {
    const { name, banco, fechaPago, fechaCorte, saldoActual, limite, notas } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const props = {
      Name: { title: [{ text: { content: name } }] },
      Banco: banco ? { rich_text: [{ text: { content: banco } }] } : undefined,
      'Fecha pago': fechaPago ? { date: { start: fechaPago } } : undefined,
      'Fecha corte': fechaCorte ? { date: { start: fechaCorte } } : undefined,
      'Saldo actual': { number: Number(saldoActual) || 0 },
      'Límite de crédito': { number: Number(limite) || 0 },
      Notas: notas ? { rich_text: [{ text: { content: notas } }] } : undefined,
    };
    const r = await notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { data_source_id: IDS.dataSourceTarjetas },
        properties: props,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Notion ${r.status}: ${text}`);
    }
    const page = await r.json();
    res.json({ ok: true, id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/tarjetas/:id', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, banco, fechaPago, fechaCorte, saldoActual, limite, notas } = req.body || {};
    const props = {};
    if (name !== undefined) props.Name = { title: [{ text: { content: name } }] };
    if (banco !== undefined) props.Banco = { rich_text: [{ text: { content: banco } }] };
    if (fechaPago !== undefined) props['Fecha pago'] = fechaPago ? { date: { start: fechaPago } } : { date: null };
    if (fechaCorte !== undefined) props['Fecha corte'] = fechaCorte ? { date: { start: fechaCorte } } : { date: null };
    if (saldoActual !== undefined) props['Saldo actual'] = { number: Number(saldoActual) || 0 };
    if (limite !== undefined) props['Límite de crédito'] = { number: Number(limite) || 0 };
    if (notas !== undefined) props.Notas = { rich_text: [{ text: { content: notas } }] };
    await updatePage(id, props);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tarjetas/:id', checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const r = await notionFetch(`/pages/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Notion ${r.status}: ${text}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// BACKUP (#39)
// ============================================
app.get('/api/backup/export', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      databases: {},
    };
    // Exportar todas las DBs
    const dbs = [
      ['movimientos', IDS.dataSourceMov],
      ['presupuestos', IDS.dataSourcePres],
      ['metas', IDS.dataSourceMetas],
      ['prestamos', IDS.dataSourcePrest],
      ['visacuotas', IDS.dataSourceVisa],
      ['tarjetas', IDS.dataSourceTarjetas],
      ['suscripciones', IDS.dataSourceSuscripciones],
    ];
    for (const [name, dsId] of dbs) {
      try {
        const r = await queryDatabase(dsId, {}, [], 200);
        data.databases[name] = r.results || [];
      } catch (e) {
        data.databases[name] = { error: e.message };
      }
    }
    const fileName = 'mifinanza-backup-' + new Date().toISOString().split('T')[0] + '.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/import', checkAuth, async (req, res) => {
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN not set' });
  try {
    const { data, dryRun } = req.body || {};
    if (!data || !data.databases) return res.status(400).json({ error: 'data.databases requerido' });
    let created = 0, errors = 0;
    // Solo importamos presupuestos y metas (los movimientos/visacuotas/prestamos/tarjetas son más complejos de duplicar)
    if (data.databases.presupuestos && Array.isArray(data.databases.presupuestos)) {
      for (const item of data.databases.presupuestos) {
        try {
          const props = item.properties || {};
          const concepto = props.Concepto?.title?.[0]?.text?.content || props.Concepto?.title?.[0]?.plain_text || 'Sin nombre';
          if (dryRun) { created++; continue; }
          await createPage(IDS.presupuestos, {
            Concepto: { title: [{ text: { content: concepto } }] },
            Limite: { number: props.Limite?.number || 0 },
            Estado: props.Estado ? { select: { name: props.Estado.select?.name || 'Pendiente' } } : undefined,
            Fecha: props.Fecha?.date ? { date: { start: props.Fecha.date.start } } : undefined,
            Notas: props.Notas?.rich_text?.[0] ? { rich_text: [{ text: { content: props.Notas.rich_text[0].plain_text || '' } }] } : undefined,
          });
          created++;
        } catch (e) { errors++; }
      }
    }
    res.json({ ok: true, created, errors, message: dryRun ? 'Dry run' : (created + ' presupuestos importados, ' + errors + ' errores') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/auto', async (req, res) => {
  // Endpoint para que un servicio externo (cron-job.org, etc.) llame cada semana
  // Requiere header Authorization con APP_PASSWORD
  const auth = req.headers['authorization'];
  if (auth !== 'Bearer ' + (process.env.APP_PASSWORD || '')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    // Por ahora solo logueamos - en el futuro podría enviar a Drive/Dropbox/S3
    const r = await fetch(`http://localhost:${PORT}/api/backup/export`, {
      headers: { 'Authorization': 'Bearer ' + (process.env.APP_PASSWORD || '') },
    });
    const data = await r.json();
    const fileName = 'mifinanza-auto-backup-' + new Date().toISOString().split('T')[0] + '.json';
    // Enviar por Telegram si está configurado
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const summary = '<b>Backup automático semanal</b>\n\n' +
        Object.keys(data.databases || {}).map(k => '• ' + k + ': ' + (Array.isArray(data.databases[k]) ? data.databases[k].length : 0)).join('\n');
      await sendTelegramMessage(summary);
    }
    res.json({ ok: true, fileName, message: 'Backup automático realizado' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// TELEGRAM & SHORTCUTS (#40)
// ============================================
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: 'TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await r.json();
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.get('/api/integrations/status', checkAuth, async (req, res) => {
  const hasToken = !!process.env.TELEGRAM_BOT_TOKEN;
  const hasChat = !!process.env.TELEGRAM_CHAT_ID;
  res.json({
    telegram: { configured: hasToken && hasChat, hasToken, hasChat },
    webhookUrl: `${req.protocol}://${req.get('host')}/api/telegram/webhook`,
    shortcuts: [
      { command: 'gasté Q50 almuerzo', desc: 'Registra gasto de Q50 en categoría "Comida"' },
      { command: 'gasté $20 en uber', desc: 'Registra gasto de $20 USD' },
      { command: 'ingreso Q5000 sueldo', desc: 'Registra ingreso de Q5000' },
      { command: 'saldo', desc: 'Muestra el balance actual' },
      { command: 'próximos', desc: 'Muestra los pagos próximos (7 días)' },
      { command: 'hoy', desc: 'Resumen de gastos/ingresos del día' },
      { command: 'mes', desc: 'Resumen del mes' },
    ],
  });
});

app.post('/api/telegram/test', checkAuth, async (req, res) => {
  const result = await sendTelegramMessage('<b>Test MiFinanza</b>\n\nSi ves este mensaje, Telegram está configurado correctamente.');
  res.json(result);
});

app.post('/api/integrations/telegram', checkAuth, async (req, res) => {
  const { botToken, chatId } = req.body || {};
  if (!botToken || !chatId) return res.status(400).json({ error: 'botToken y chatId requeridos' });
  // Solo validar (no guardar en env en runtime, eso requiere redeploy)
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'Test MiFinanza — Telegram configurado' }),
    });
    const data = await r.json();
    if (data.ok) {
      res.json({ ok: true, message: 'Configuración válida. Agrega TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID a las variables de entorno de Render para activar permanentemente.' });
    } else {
      res.status(400).json({ error: data.description || 'Error de Telegram' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Webhook de Telegram (sin auth — Telegram lo llama directamente)
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;
    const message = update?.message;
    if (!message || !message.text) return res.json({ ok: true });
    const text = message.text.trim();
    const chatId = message.chat.id;
    const respuesta = await procesarComando(text);
    // Responder al chat
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: respuesta, parse_mode: 'HTML' }),
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

async function procesarComando(text) {
  const lower = text.toLowerCase().trim();
  // /start
  if (lower === '/start' || lower === 'hola') {
    return '<b>MiFinanza Bot</b>\n\nComandos disponibles:\n• <code>gasté Q50 almuerzo</code>\n• <code>ingreso Q5000</code>\n• <code>saldo</code>\n• <code>próximos</code>\n• <code>hoy</code> / <code>mes</code>';
  }
  // saldo
  if (lower === 'saldo' || lower === '/saldo') {
    const data = await queryDatabase(IDS.dataSourceMov, {}, [], 200);
    const movimientos = data.results || [];
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    let ingresos = 0, gastos = 0;
    for (const m of movimientos) {
      const fecha = m.properties?.Fecha?.date?.start;
      if (!fecha) continue;
      const d = new Date(fecha);
      if (d.getFullYear() !== year || d.getMonth() !== month) continue;
      const tipo = m.properties?.Tipo?.select?.name?.toLowerCase() || '';
      const monto = m.properties?.Monto?.number || 0;
      if (tipo.includes('ingreso')) ingresos += monto;
      else if (tipo.includes('gasto') || tipo.includes('compra') || tipo.includes('pago')) gastos += monto;
    }
    const balance = ingresos - gastos;
    return `<b>Balance ${['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][month]}</b>\n\n↑ Ingresos: Q${ingresos.toFixed(2)}\n↓ Gastos: Q${gastos.toFixed(2)}\n\n<b>${balance >= 0 ? '[OK]' : '[!]'} Balance: Q${balance.toFixed(2)}</b>`;
  }
  // próximos
  if (lower === 'próximos' || lower === '/proximos' || lower === 'próximo') {
    try {
      const r = await fetch(`${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}/api/upcoming-payments?days=7`, {
        headers: { 'Authorization': `Bearer ${process.env.APP_PASSWORD}` },
      });
      const data = await r.json();
      const pagos = data.payments || [];
      if (pagos.length === 0) return '[OK] Sin pagos próximos en los siguientes 7 días';
      return '<b>Pagos próximos:</b>\n\n' + pagos.map(p => {
        const f = new Date(p.fecha).toLocaleDateString('es-GT', { day: 'numeric', month: 'short' });
        return `• ${f} — ${p.name} (Q${p.monto.toFixed(2)})`;
      }).join('\n');
    } catch { return 'Error al consultar próximos pagos'; }
  }
  // hoy
  if (lower === 'hoy' || lower === '/hoy') {
    const data = await queryDatabase(IDS.dataSourceMov, {}, [], 100);
    const today = new Date().toISOString().split('T')[0];
    const movs = (data.results || []).filter(m => m.properties?.Fecha?.date?.start === today);
    if (movs.length === 0) return 'Sin movimientos hoy';
    return `<b>Hoy (${movs.length} movimientos):</b>\n\n` + movs.map(m => {
      const nombre = m.properties?.Nombre?.title?.[0]?.text?.content || '?';
      const tipo = m.properties?.Tipo?.select?.name || '?';
      const monto = m.properties?.Monto?.number || 0;
      const icon = tipo.toLowerCase().includes('gasto') ? '↓' : '↑';
      return `${icon} ${nombre}: Q${monto.toFixed(2)}`;
    }).join('\n');
  }
  // mes
  if (lower === 'mes' || lower === '/mes') {
    return await procesarComando('saldo');
  }
  // gasto: "gasté Q50 almuerzo" o "gaste 50 en almuerzo"
  const gastoMatch = lower.match(/(?:gast[eé]|gasto)\s+(?:Q|\$|GTQ|USD)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:en\s+)?(.+)?/i);
  if (gastoMatch) {
    const monto = parseFloat(gastoMatch[1].replace(/,/g, ''));
    const desc = (gastoMatch[2] || '').trim();
    if (monto > 0) {
      // Detectar USD
      const moneda = lower.includes('$') || lower.includes('usd') ? 'USD' : 'GTQ';
      // Categoría simple
      let categoria = 'Otros';
      if (/comida|almuerzo|cena|desayuno|restaurante|cafe/i.test(desc)) categoria = 'Comida';
      else if (/uber|taxi|gasolina|transporte/i.test(desc)) categoria = 'Transporte';
      else if (/supermercado|tienda|compra/i.test(desc)) categoria = 'Compras';
      // Crear movimiento vía Notion
      try {
        await createPage(IDS.movimientos, {
          Nombre: { title: [{ text: { content: 'Gasto (Telegram) - ' + desc } }] },
          Fecha: { date: { start: new Date().toISOString().split('T')[0] } },
          Tipo: { select: { name: 'Gasto diario' } },
          Monto: { number: monto },
          Categoria: { select: { name: categoria } },
          Cuenta: { select: { name: 'Efectivo' } },
          Moneda: { select: { name: moneda } },
          Nota: { rich_text: [{ text: { content: 'Registrado desde Telegram: ' + desc } }] },
        });
        const sym = moneda === 'USD' ? '$' : 'Q';
        return `[OK] Gasto registrado: ${sym}${monto.toFixed(2)} en ${desc}\nCategoría: ${categoria}`;
      } catch (e) { return '[ERR] Error al registrar: ' + e.message; }
    }
  }
  // ingreso: "ingreso Q5000" o "+Q5000 sueldo"
  const ingresoMatch = lower.match(/(?:ingreso|cobré|cobre|recib[ií])\s+(?:Q|\$|GTQ|USD)?\s*([\d,]+(?:\.\d{1,2})?)\s*(.+)?/i) || lower.match(/^\+\s*(?:Q|\$|GTQ|USD)?\s*([\d,]+(?:\.\d{1,2})?)\s*(.+)?/);
  if (ingresoMatch) {
    const monto = parseFloat(ingresoMatch[1].replace(/,/g, ''));
    const desc = (ingresoMatch[2] || '').trim();
    if (monto > 0) {
      const moneda = lower.includes('$') || lower.includes('usd') ? 'USD' : 'GTQ';
      let tipo = 'Ingreso';
      if (/sueldo|salario|nomina/i.test(desc)) tipo = 'Sueldo';
      try {
        await createPage(IDS.movimientos, {
          Nombre: { title: [{ text: { content: 'Ingreso (Telegram) - ' + desc } }] },
          Fecha: { date: { start: new Date().toISOString().split('T')[0] } },
          Tipo: { select: { name: tipo } },
          Monto: { number: monto },
          Categoria: { select: { name: tipo === 'Sueldo' ? 'Sueldo' : 'Otros ingresos' } },
          Cuenta: { select: { name: 'Efectivo' } },
          Moneda: { select: { name: moneda } },
          Nota: { rich_text: [{ text: { content: 'Registrado desde Telegram: ' + desc } }] },
        });
        const sym = moneda === 'USD' ? '$' : 'Q';
        return `[OK] Ingreso registrado: ${sym}${monto.toFixed(2)} — ${desc}`;
      } catch (e) { return '[ERR] Error al registrar: ' + e.message; }
    }
  }
  return '❓ No entendí. Prueba: <code>gasté Q50 almuerzo</code>, <code>saldo</code>, <code>próximos</code>';
}

// Atajo POST desde la app web
app.post('/api/shortcuts/ejecutar', checkAuth, async (req, res) => {
  const { comando } = req.body || {};
  if (!comando) return res.status(400).json({ error: 'comando requerido' });
  const result = await procesarComando(comando);
  res.json({ ok: true, respuesta: result });
});

// Notificaciones automáticas (llamar desde cron o manualmente)
app.post('/api/cron/notifications', async (req, res) => {
  try {
    // Reusar lógica de upcoming-payments
    const days = Number(req.query.days) || 3;
    const fakeReq = { query: { days } };
    const fakeRes = {
      json: (data) => data,
      status: () => fakeRes,
    };
    // Llamar internamente no es trivial; replicamos lógica simple
    const now = new Date();
    const result = [];

    const presResult = await queryDatabase(IDS.dataSourcePrest, {}, [], 100);
    for (const p of (presResult.results || [])) {
      const pProps = p.properties;
      const pag = getNumber(pProps, 'Cuotas pagadas');
      const total = getNumber(pProps, 'Cuotas totales');
      if (pag >= total) continue;
      const cuota = getNumber(pProps, 'Cuota mensual');
      const nombre = getTitle(pProps, 'Prestamo');
      const inicio = getDate(pProps, 'Fecha inicio');
      if (!inicio) continue;
      const inicioDate = new Date(inicio);
      let proximaFecha = new Date(inicioDate);
      proximaFecha.setMonth(inicioDate.getMonth() + pag);
      if (proximaFecha < now) {
        proximaFecha = new Date(now.getFullYear(), now.getMonth(), inicioDate.getDate());
        if (proximaFecha < now) proximaFecha.setMonth(proximaFecha.getMonth() + 1);
      }
      const daysUntil = Math.ceil((proximaFecha - now) / (1000 * 60 * 60 * 24));
      if (daysUntil <= days) {
        result.push({ id: p.id, type: 'prestamo', name: nombre, monto: cuota, fecha: proximaFecha, daysUntil });
      }
    }

    const tarjetas = await loadTarjetas();
    const tcByName = {};
    for (const t of tarjetas) tcByName[t.name] = t;
    const visResult = await queryDatabase(IDS.dataSourceVisa, {}, [], 100);
    const porTc = {};
    for (const v of (visResult.results || [])) {
      const vProps = v.properties;
      const pag = getNumber(vProps, 'Cuotas pagadas');
      const total = getNumber(vProps, 'Cuotas totales');
      if (pag >= total) continue;
      const cuota = getNumber(vProps, 'Cuota mensual') || 0;
      const tarjeta = getText(vProps, 'Tarjeta');
      if (!tarjeta) continue;
      if (!porTc[tarjeta]) porTc[tarjeta] = { monto: 0, count: 0 };
      porTc[tarjeta].monto += cuota;
      porTc[tarjeta].count += 1;
    }
    for (const [tcName, grupo] of Object.entries(porTc)) {
      const tc = tcByName[tcName];
      if (!tc || !tc.fechaPago) continue;
      let proximaFecha = new Date(tc.fechaPago + 'T00:00:00');
      if (proximaFecha < now) {
        proximaFecha = new Date(proximaFecha.getFullYear(), proximaFecha.getMonth() + 1, proximaFecha.getDate());
      }
      const daysUntil = Math.ceil((proximaFecha - now) / (1000 * 60 * 60 * 24));
      if (daysUntil <= days) {
        result.push({ id: 'tc:' + tcName, type: 'tarjeta', name: tcName, monto: grupo.monto, fecha: proximaFecha, daysUntil });
      }
    }

    if (result.length === 0) {
      return res.json({ ok: true, sent: false, reason: 'Sin pagos próximos' });
    }

    const lines = ['<b>Pagos próximos (' + days + ' días):</b>', ''];
    for (const p of result.sort((a, b) => a.daysUntil - b.daysUntil)) {
      const f = p.fecha.toLocaleDateString('es-GT', { day: 'numeric', month: 'short' });
      const urgency = p.daysUntil === 0 ? 'HOY' : (p.daysUntil === 1 ? 'MAÑANA' : 'en ' + p.daysUntil + 'd');
      const icon = p.type === 'prestamo' ? '[B]' : '[C]';
      lines.push(icon + ' ' + urgency + ' · ' + f + '\n   ' + p.name + ' — Q' + p.monto.toFixed(2));
    }
    const text = lines.join('\n');
    const telegramResult = await sendTelegramMessage(text);
    res.json({ ok: true, sent: telegramResult.ok, count: result.length, telegramResult });
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
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'favicon.svg'));
});

app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'favicon.svg'));
});

// Static files
app.use(express.static(path.join(__dirname)));
// Service worker: servir con cache-control no-store para que se actualice
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MiFinanza on port ${PORT}`);
  console.log(`   TOKEN: ${NOTION_TOKEN ? 'OK' : 'MISSING'}`);
  console.log(`   PASSWORD: ${APP_PASSWORD ? 'set' : 'open'}`);
});