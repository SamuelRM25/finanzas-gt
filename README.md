# 💰 Finanzas GT

App web moderna para gestionar tus finanzas personales, conectada a Notion como base de datos. Diseño profesional con motion graphics.

## ✨ Diseño

- **Estética "Modern Jade"** — fondo oscuro cálido con acentos en jade, coral y oro
- **Tipografía editorial** — Instrument Serif para números, Inter para body
- **Motion graphics**:
  - Contadores animados (count-up)
  - Stagger fade-in al cargar
  - Hover lifts sutiles
  - Gráficos animados
  - Toast notifications
  - Transiciones suaves
- **Patrón geométrico sutil** inspirado en textiles mayas
- **100% responsive**

## 🚀 Deploy a Render (gratis)

### 1. Conecta el repo a Render

1. Ve a https://render.com → **New +** → **Web Service**
2. Conecta tu GitHub: `SamuelRM25/finanzas-gt`
3. Configura:
   - **Name**: `finanzas-gt`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free

### 2. Variables de entorno

En **Environment**, agrega:

| Key | Value |
|-----|-------|
| `NOTION_TOKEN` | `ntn_TU_TOKEN_AQUI` |
| `DATABASE_ID` | `3f5e0d97deba815db317c75dba96970a` |
| `DATA_SOURCE_ID` | `3f5e0d97deba814ebf1b000bc7a38d76` |
| `APP_PASSWORD` | tu-contraseña-segura |

### 3. Deploy

Click **Create Web Service**. Render construye y deploya automáticamente.

Tu app estará en `https://finanzas-gt.onrender.com` (o el subdominio que elijas).

> ⚠️ **Nota sobre el plan Free**: el servicio se duerme tras 15 min de inactividad. La primera carga puede tardar 30-50 segundos en "despertarlo".

## 🔐 Uso

1. Abre la URL de tu app
2. Te pedirá la contraseña (la que pusiste en `APP_PASSWORD`)
3. La app la recordará durante la sesión
4. ¡Listo!

## 📱 Instalar como app en iPhone

1. Abre la URL en Safari
2. Compartir → Añadir a pantalla de inicio
3. Tendrás un icono que abre la app directo

## 🧪 Probar localmente

```bash
cd ~/finanzas-gt
npm install
NOTION_TOKEN=ntn_... APP_PASSWORD=test123 node server.js
```

Abre http://localhost:10000 (puerto que muestre la consola).

## 🛠️ Estructura

```
finanzas-gt/
├── index.html          ← la app completa
├── server.js           ← Express server + API routes
├── package.json        ← dependencias
├── render.yaml         ← config para Render
├── .env.example        ← template de variables
└── README.md           ← esta guía
```

## 🔄 Actualizar opciones de Tipo / Categoría / Cuenta

1. Ve a Notion → base `Movimientos` → editar propiedades
2. En la app, las opciones se cargan dinámicamente al abrir
3. Para refrescar: cerrar y abrir la app, o hacer redeploy en Render

## 🔒 Seguridad

- **Auth por contraseña** (configurable vía `APP_PASSWORD`)
- **Token de Notion solo en el servidor** (nunca expuesto al cliente)
- **HTTPS automático** vía Render
- **Solo tú tienes la URL y la contraseña**

## 💡 Personalizar

### Cambiar colores
Edita `index.html`, en `:root`:
- `--jade` — verde principal (ingresos)
- `--coral` — rojo (gastos)
- `--gold` — dorado (destacados)

### Cambiar contraseña
Render Dashboard → Environment → cambia `APP_PASSWORD` → redeploy automático.