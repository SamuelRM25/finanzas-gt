"""
Actualiza todas las bases: agrega campos faltantes y crea Visacuotas.
"""
import os
import json
import urllib.request
import urllib.error

NOTION_VERSION = "2022-06-28"
DB_MOV = "3f5e0d97deba815db317c75dba96970a"
DS_MOV = "3f5e0d97deba814ebf1b000bc7a38d76"
PAGE_FINANZAS = "3f5e0d97deba803f999bdb528abbbef9"
DB_PRES = "3f5e0d97deba819d8d50d88f6eb72cb2"
DB_METAS = "3f5e0d97deba8167a56affcb6ed1dc7b"
DB_PREST = "3f5e0d97deba8106a007d9b0bdbd0bdb"


def api(method, path, token, body=None):
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(
        f"https://api.notion.com/v1{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  [ERROR {e.code}] {e.read().decode()[:300]}", file=__import__("sys").stderr)
        return None


def add_prop(token, db_id, name, config, label):
    print(f"  {label}.{name}...", end=" ")
    r = api("PATCH", f"/databases/{db_id}", token, {"properties": {name: config}})
    print("OK" if r else "FAIL")
    return r is not None


def main():
    token = os.environ["NOTION_TOKEN"]

    # =========================================
    # 1. MOVIMIENTOS - agregar Moneda, Visacuota, Presupuesto
    # =========================================
    print("\n[Movimientos] Agregando campos...")
    add_prop(token, DB_MOV, "Moneda", {"select": {"options": [
        {"name": "GTQ", "color": "green"},
        {"name": "USD", "color": "blue"},
    ]}}, "Mov")
    add_prop(token, DB_MOV, "Visacuota", {"relation": {"database_id": "PLACEHOLDER_VISACUOTAS"}}, "Mov")
    add_prop(token, DB_MOV, "Presupuesto", {"relation": {"database_id": DB_PRES}}, "Mov")
    add_prop(token, DB_MOV, "Meta", {"relation": {"database_id": DB_METAS}}, "Mov")
    add_prop(token, DB_MOV, "Prestamo", {"relation": {"database_id": DB_PREST}}, "Mov")

    # =========================================
    # 2. METAS - agregar Estrategia, Cuota sugerida, Notas
    # =========================================
    print("\n[Metas] Agregando campos...")
    add_prop(token, DB_METAS, "Estrategia", {"select": {"options": [
        {"name": "Cuota fija", "color": "blue"},
        {"name": "% de ingreso", "color": "purple"},
        {"name": "Excedente", "color": "green"},
        {"name": "Manual", "color": "default"},
    ]}}, "Metas")
    add_prop(token, DB_METAS, "Cuota sugerida", {"number": {"format": "number"}}, "Metas")
    add_prop(token, DB_METAS, "Notas", {"rich_text": {}}, "Metas")

    # =========================================
    # 3. PRESTAMOS - mejorar campos y agregar calculados
    # =========================================
    print("\n[Prestamos] Agregando campos...")
    add_prop(token, DB_PREST, "Tipo tasa", {"select": {"options": [
        {"name": "Mensual", "color": "blue"},
        {"name": "Anual", "color": "purple"},
    ]}}, "Prest")
    add_prop(token, DB_PREST, "Cuota mensual", {"number": {"format": "number"}}, "Prest")
    add_prop(token, DB_PREST, "Total a pagar", {"number": {"format": "number"}}, "Prest")
    add_prop(token, DB_PREST, "Total interes", {"number": {"format": "number"}}, "Prest")

    # =========================================
    # 4. PRESUPUESTOS - agregar Estado, Pagado, Movimientos relacionados
    # =========================================
    print("\n[Presupuestos] Agregando campos...")
    add_prop(token, DB_PRES, "Estado", {"select": {"options": [
        {"name": "Pendiente", "color": "yellow"},
        {"name": "Pagado", "color": "green"},
        {"name": "Vencido", "color": "red"},
    ]}}, "Pres")
    add_prop(token, DB_PRES, "Monto pagado", {"number": {"format": "number"}}, "Pres")
    add_prop(token, DB_PRES, "Fecha limite", {"date": {}}, "Pres")
    add_prop(token, DB_PRES, "Movimientos relacionados", {"relation": {"database_id": DB_MOV, "dual_property": {}}}, "Pres")

    # =========================================
    # 5. Crear nueva DB: Visacuotas
    # =========================================
    print("\n[Visacuotas] Creando base de datos...")
    visacuotas_schema = {
        "Nombre": {"title": {}},
        "Establecimiento": {"rich_text": {}},
        "Fecha compra": {"date": {}},
        "Cuotas totales": {"number": {"format": "number"}},
        "Cuotas pagadas": {"number": {"format": "number"}},
        "Tasa mensual": {"number": {"format": "percent"}},
        "Tasa anual": {"number": {"format": "percent"}},
        "Cuota mensual": {"formula": {"expression": "if(prop(\"Tasa mensual\") > 0, prop(\"Monto total\") * (prop(\"Tasa mensual\") * pow(1 + prop(\"Tasa mensual\"), prop(\"Cuotas totales\")) / (pow(1 + prop(\"Tasa mensual\"), prop(\"Cuotas totales\") - 1)), prop(\"Monto total\") / prop(\"Cuotas totales\"))"}},
        "Total a pagar": {"formula": {"expression": "prop(\"Cuota mensual\") * prop(\"Cuotas totales\")"}},
        "Total interes": {"formula": {"expression": "prop(\"Total a pagar\") - prop(\"Monto total\")"}},
        "Saldo pendiente": {"formula": {"expression": "prop(\"Monto total\") - (prop(\"Cuota mensual\") * prop(\"Cuotas pagadas\"))"}},
        "Estado": {"select": {"options": [
            {"name": "Activa", "color": "blue"},
            {"name": "Pagada", "color": "green"},
            {"name": "Vencida", "color": "red"},
        ]}},
        "Notas": {"rich_text": {}},
        "Pagos": {"relation": {"database_id": DB_MOV, "dual_property": {}}},
    }
    # Primero sin formulas
    visacuotas_base = {k: v for k, v in visacuotas_schema.items() if v.get("type") != "formula" and "formula" not in v}
    # Some Notion API versions don't accept formula key directly
    visacuotas_clean = {}
    for k, v in visacuotas_schema.items():
        if "formula" in v:
            continue
        visacuotas_clean[k] = v
    r = api("POST", "/databases", token, {
        "parent": {"type": "page_id", "page_id": PAGE_FINANZAS},
        "title": [{"type": "text", "text": {"content": "Visacuotas"}}],
        "properties": visacuotas_clean,
    })
    if r:
        vis_id = r["id"].replace("-", "")
        print(f"  Visacuotas creada: {vis_id}")
        # Agregar formulas via PATCH
        for fname, fcfg in [("Cuota mensual", visacuotas_schema["Cuota mensual"]["formula"]),
                            ("Total a pagar", visacuotas_schema["Total a pagar"]["formula"]),
                            ("Total interes", visacuotas_schema["Total interes"]["formula"]),
                            ("Saldo pendiente", visacuotas_schema["Saldo pendiente"]["formula"])]:
            api("PATCH", f"/databases/{r['id']}", token,
                {"properties": {fname: {"formula": fcfg}}})
            print(f"  Formula {fname} agregada")
    else:
        vis_id = None
        print("  FAIL creando Visacuotas")

    # Actualizar relacion Visacuota en Movimientos
    if vis_id:
        print("\n[Actualizando relacion Visacuota en Movimientos]")
        add_prop(token, DB_MOV, "Visacuota", {"relation": {"database_id": vis_id, "dual_property": {}}}, "Mov")
        # Agregar relacion inversa en Visacuotas hacia Prestamos (si útil)
        add_prop(token, vis_id, "Tipo cuota", {"select": {"options": [
            {"name": "Con interes", "color": "orange"},
            {"name": "Sin interes", "color": "green"},
        ]}}, "Vis")

    print("\n[OK] Todas las bases actualizadas")


if __name__ == "__main__":
    main()