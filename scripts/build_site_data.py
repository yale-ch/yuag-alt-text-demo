"""Turn a chai run of workflow/workflow-alt-text-yuag.json into the viewer's data.

The workflow writes one CHAI-TEA RESULT row per object to a JSON-Lines file: the alt-text as
``value``, the manifest URL as ``input``, and the model call's tokens, duration and cost in
``metadata``. This joins those rows to the object list (for titles) and to each object's IIIF
manifest (department, classification, medium, image), and writes ``docs/data/runs/<id>.json`` plus
its entry in ``docs/data/runs.json``. Objects with no row are kept as errors, so the site shows
what the run missed.

    python scripts/build_site_data.py RUN.jsonl OBJECTS.csv --id 20261028-full-6432 \
        --label "Full run — 6,432 objects" --model gemini-3.1-flash-lite

Manifests are cached in ``.cache/manifests`` (stdlib only; no chai needed to build the site).
"""

import argparse
import csv
import json
import pathlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
CACHE = ROOT / ".cache" / "manifests"
OBJECT_PAGE = "https://artgallery.yale.edu/collections/objects/{}"


def manifest(url):
    """The manifest at *url*, from the cache when it has it."""
    path = CACHE / (url.rstrip("/").rsplit("/", 1)[-1] + ".json")
    if path.exists():
        return json.loads(path.read_text())
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as fh:
        data = json.load(fh)
    path.write_text(json.dumps(data))
    return data


def metadata(mf, label):
    """The value of the manifest metadata entry called *label*, joined into one string."""
    for entry in mf.get("metadata") or []:
        if label in (entry.get("label") or {}).get("en", []):
            return "; ".join((entry.get("value") or {}).get("en", [])) or None
    return None


def first_image(mf):
    """The first canvas's image URL and label."""
    for canvas in mf.get("items") or []:
        for page in canvas.get("items") or []:
            for anno in page.get("items") or []:
                body = anno.get("body") or {}
                if anno.get("motivation") == "painting" and body.get("type") == "Image":
                    label = "; ".join((canvas.get("label") or {}).get("en", []))
                    return body.get("id"), label
    return None, ""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("run", help="the run's JSON-Lines file (results/alt_text_yuag/run.jsonl)")
    ap.add_argument("objects", help="the CSV the run read (objectid,title,manifest)")
    ap.add_argument("--id", required=True, help="run id, also the data file's name")
    ap.add_argument("--label", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--description", default="")
    ap.add_argument("--date", default=date.today().isoformat())
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    rows = {}
    with open(args.run) as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("process_id") == "describe":
                rows[row["input"].rstrip("/")] = row
    with open(args.objects, newline="") as fh:
        objects = list(csv.DictReader(fh))

    CACHE.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(args.workers) as pool:
        manifests = list(pool.map(lambda o: _safe(manifest, o["manifest"]), objects))

    out = []
    for obj, mf in zip(objects, manifests):
        url = obj["manifest"].rstrip("/")
        row = rows.get(url)
        md = (row or {}).get("metadata") or {}
        if isinstance(md, str):
            md = json.loads(md)
        image_url, canvas_label = first_image(mf or {})
        ok = bool(row and row.get("was_successful") and row.get("value"))
        out.append(
            {
                "obj_id": str(obj["objectid"]),
                "title": obj.get("title") or (metadata(mf or {}, "Title")),
                "manifest_url": url,
                "object_url": OBJECT_PAGE.format(obj["objectid"]),
                "department": metadata(mf or {}, "Department"),
                "classification": metadata(mf or {}, "Classification"),
                "medium": metadata(mf or {}, "Medium"),
                "image_url": image_url,
                "canvas_label": canvas_label,
                "alt_text": row.get("value") if ok else "",
                "status": "ok" if ok else "error",
                "cost": md.get("cost"),
                "tokens_total": (md.get("token_usage") or {}).get("total"),
                "duration_s": round(md["duration"], 2) if md.get("duration") is not None else None,
                "error": "" if ok else ("no image in the manifest" if mf and not image_url else
                                        "manifest unavailable" if not mf else "no alt-text produced"),
            }
        )

    runs_dir = DOCS / "data" / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / f"{args.id}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))

    index_path = DOCS / "data" / "runs.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    index.setdefault("collection", {"name": "Yale University Art Gallery", "abbr": "YUAG"})
    ok = [r for r in out if r["status"] == "ok"]
    entry = {
        "id": args.id,
        "label": args.label,
        "date": args.date,
        "model": args.model,
        "count": len(out),
        "described": len(ok),
        "cost_usd": round(sum(r["cost"] or 0 for r in ok), 4),
        "tokens": sum(r["tokens_total"] or 0 for r in ok),
        "file": f"data/runs/{args.id}.json",
        "description": args.description,
    }
    index["runs"] = [entry] + [r for r in index.get("runs", []) if r["id"] != args.id]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(ok)}/{len(out)} described, ${entry['cost_usd']}, {entry['tokens']} tokens")


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as exc:  # a missing manifest is an error row, not a failed build
        print(f"warning: {a[0]}: {exc}")
        return None


if __name__ == "__main__":
    main()
