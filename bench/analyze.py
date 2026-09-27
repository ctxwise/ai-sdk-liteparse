"""Scores every candidate with olmOCR's own test classes, replays the OCR -> vision routing at every threshold from
the saved outputs (no new model calls), picks a threshold per OCR engine, and draws the README charts.

  docker run --rm --entrypoint python -v ./bench:/bench -v ./docs:/docs olmocr-score /bench/analyze.py

Threshold rule: the cheapest threshold (fewest pages to the vision model) whose routed score is within
TOLERANCE points of the best routed score - past that point, more vision spend buys no measurable quality.
"""

import glob
import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from olmocr.bench.tests import load_tests

DATA = "/bench/data/sample"
RESULTS = "/bench/results"
CHARTS = "/docs/images"
OCR_ENGINES = ["tesseract", "rapidocr"]
VISION = "vision"
TOLERANCE = 1.0  # points of pass rate
SETS = {"old_scans": "Old scans", "long_tiny_text": "Long tiny text"}
COLORS = {"tesseract": "#2a6fdb", "rapidocr": "#e07b39", "vision": "#3a9d5d"}
LABELS = {"tesseract": "Tesseract", "rapidocr": "RapidOCR", "vision": "Vision model only"}

tests_by_pdf = {}
for f in sorted(glob.glob(f"{DATA}/*.jsonl")):
    for t in load_tests(f):
        tests_by_pdf.setdefault(t.pdf, []).append(t)


def load(name):
    """per page: set, tests passed, tests, OCR confidence (None = native text, no OCR), ms, tokens"""
    path = f"{RESULTS}/{name}.json"
    if not os.path.exists(path):
        return None
    data = json.load(open(path))
    pages = {}
    for r in data["rows"]:
        pdf = f"{r['set']}/{r['pdf']}"
        md = open(f"{DATA}/{name}/{os.path.splitext(pdf)[0]}_pg1_repeat1.md", encoding="utf-8").read()
        results = [t.run(md)[0] for t in tests_by_pdf.get(pdf, [])]
        pages[pdf] = {
            "set": r["set"],
            "passed": sum(results),
            "tests": len(results),
            "confidence": min(r["confidences"]) if r["confidences"] else None,
            "ms": r["ms"],
            "tokens": r.get("tokens", {"input": 0, "output": 0}),
        }
    return {"summary": data["summary"], "pages": pages}


def score(pages, pick=lambda pdf, p: p):
    """olmOCR's headline number: pass rate per set (per test), averaged over sets"""
    per_set = {}
    for pdf, p in pages.items():
        q = pick(pdf, p)
        s = per_set.setdefault(p["set"], [0, 0])
        s[0] += q["passed"]
        s[1] += q["tests"]
    by_set = {s: 100 * a / b for s, (a, b) in per_set.items() if b}
    return sum(by_set.values()) / len(by_set), by_set


runs = {n: load(n) for n in OCR_ENGINES + [VISION]}
runs = {n: r for n, r in runs.items() if r}
report = {"engines": {}}
for name, r in runs.items():
    overall, by_set = score(r["pages"])
    report["engines"][name] = {"score": overall, "by_set": by_set, **r["summary"]}

# ---- threshold sweep: page -> OCR text if its confidence >= t, else the vision model's text
vision = runs.get(VISION)
thresholds = [round(0.5 + 0.01 * i, 2) for i in range(51)]
sweeps = {}
if vision:
    for name in OCR_ENGINES:
        if name not in runs:
            continue
        pages = runs[name]["pages"]
        ocrd = [p for p in pages.values() if p["confidence"] is not None]
        rows = []
        for t in thresholds:
            routed = lambda pdf, p: vision["pages"][pdf] if p["confidence"] is not None and p["confidence"] < t else p
            to_vision = sum(1 for p in ocrd if p["confidence"] < t)
            rows.append({"t": t, "score": score(pages, routed)[0], "to_vision": 100 * to_vision / len(pages)})
        best = max(r["score"] for r in rows)
        chosen = min((r for r in rows if r["score"] >= best - TOLERANCE), key=lambda r: (r["to_vision"], r["t"]))
        sweeps[name] = rows
        report["engines"][name]["threshold"] = chosen
report["tolerance"] = TOLERANCE
json.dump(report, open(f"{RESULTS}/report.json", "w"), indent=2)
print(json.dumps(report, indent=2))

# ---- charts
os.makedirs(CHARTS, exist_ok=True)
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "figure.dpi": 150})

# 1. quality per set
fig, ax = plt.subplots(figsize=(7, 3.6))
names = list(runs)
width = 0.8 / len(names)
for i, n in enumerate(names):
    vals = [report["engines"][n]["by_set"].get(s, 0) for s in SETS]
    bars = ax.bar([j + i * width for j in range(len(SETS))], vals, width, label=LABELS[n], color=COLORS[n])
    ax.bar_label(bars, fmt="%.0f%%", fontsize=8, padding=2)
ax.set_xticks([j + width * (len(names) - 1) / 2 for j in range(len(SETS))], list(SETS.values()))
ax.set_ylabel("olmOCR-bench tests passed")
ax.set_ylim(0, 100)
ax.legend(frameon=False, ncols=3, loc="upper left")
ax.set_title("Accuracy by engine (same 60 pages, official checks)", loc="left")
fig.tight_layout()
fig.savefig(f"{CHARTS}/quality.png")

# 2. confidence vs correctness
fig, ax = plt.subplots(figsize=(7, 3.6))
for n in OCR_ENGINES:
    if n not in runs:
        continue
    pts = [(p["confidence"], 100 * p["passed"] / p["tests"]) for p in runs[n]["pages"].values() if p["confidence"] is not None and p["tests"]]
    ax.scatter(*zip(*pts), s=22, alpha=0.75, label=LABELS[n], color=COLORS[n])
ax.set_xlabel("OCR confidence of the page (engine's own estimate)")
ax.set_ylabel("tests passed on the page")
ax.set_ylim(-5, 105)
ax.legend(frameon=False)
ax.set_title("High confidence is not the same as correct", loc="left")
fig.tight_layout()
fig.savefig(f"{CHARTS}/confidence.png")

# 3. threshold: quality vs share of pages sent to the vision model
if sweeps:
    fig, ax = plt.subplots(figsize=(7, 3.8))
    for n, rows in sweeps.items():
        ax.plot([r["to_vision"] for r in rows], [r["score"] for r in rows], "-", color=COLORS[n], label=LABELS[n])
        c = report["engines"][n]["threshold"]
        ax.scatter([c["to_vision"]], [c["score"]], s=70, color=COLORS[n], zorder=3, edgecolor="white")
        ax.annotate(f"minConfidence {c['t']:.2f}", (c["to_vision"], c["score"]), textcoords="offset points", xytext=(8, -12), fontsize=8, color=COLORS[n])
    ax.axhline(report["engines"][VISION]["score"], ls="--", color=COLORS[VISION], lw=1, label=LABELS[VISION])
    ax.set_xlabel("pages sent to the vision model (%)")
    ax.set_ylabel("olmOCR-bench score")
    ax.legend(frameon=False, loc="lower right")
    ax.set_title("Choosing minConfidence: quality vs vision spend", loc="left")
    fig.tight_layout()
    fig.savefig(f"{CHARTS}/threshold.png")

# 4. speed
fig, ax = plt.subplots(figsize=(7, 3.2))
for i, n in enumerate(names):
    s = report["engines"][n]
    ax.barh([i], [s["p95ms"] / 1000], color=COLORS[n], alpha=0.35)
    ax.barh([i], [s["p50ms"] / 1000], color=COLORS[n])
    ax.text(s["p95ms"] / 1000, i, f"  p50 {s['p50ms'] / 1000:.1f}s · p95 {s['p95ms'] / 1000:.1f}s", va="center", fontsize=8)
ax.set_yticks(range(len(names)), [LABELS[n] for n in names])
ax.set_xlabel("seconds per page")
ax.set_title("Speed per page (dark: median, light: p95)", loc="left")
fig.tight_layout()
fig.savefig(f"{CHARTS}/speed.png")
print("charts written")
