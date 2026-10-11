"""Agrega las relaciones faltantes en Movimientos."""
import os, json, urllib.request, urllib.error

NOTION_VERSION = "2022-06-28"
DB_MOV = "3f5e0d97deba815db317c75dba96970a"
DB_PRES = "3f5e0d97deba819d8d50d88f6eb72cb2"
DB_METAS = "3f5e0d97deba8167a56affcb6ed1dc7b"
DB_PREST = "3f5e0d97deba8106a007d9b0bdbd0bdb"
DB_VIS = "3f6e0d97deba81b0acdbdc68104dd09a"

def api(method, path, token, body=None):
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(
        f"https://api.notion.com/v1{path}",
        data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  [ERROR {e.code}] {e.read().decode()[:200]}", file=__import__("sys").stderr)
        return None


def add_rel(token, db_id, name, target_db, label):
    print(f"  {label}.{name}...", end=" ")
    r = api("PATCH", f"/databases/{db_id}", token, {
        "properties": {name: {"relation": {"database_id": target_db, "type": "dual_property", "dual_property": {}}}}
    })
    print("OK" if r else "FAIL")


def main():
    token = os.environ["NOTION_TOKEN"]
    print("Agregando relaciones en Movimientos...")
    add_rel(token, DB_MOV, "Visacuota", DB_VIS, "Mov")
    add_rel(token, DB_MOV, "Presupuesto", DB_PRES, "Mov")
    add_rel(token, DB_MOV, "Meta", DB_METAS, "Mov")
    add_rel(token, DB_MOV, "Prestamo", DB_PREST, "Mov")
    print("\nListo.")


if __name__ == "__main__":
    main()