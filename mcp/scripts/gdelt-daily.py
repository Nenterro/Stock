#!/usr/bin/env python3
"""
GDELT 1.0 daily event files -> daily aggregates per country, for the blind
news-indicator backtest (the indicators are built from these later).

One day at a time: download the zip (~15 MB), aggregate, delete, so the
~60 GB archive never sits on disk. Resumable: days already in the output
are skipped. Output: one JSON line per day in OUT (default
~/stock-backtest/gdelt/daily.jsonl).

Per day and per key, where a key is an event location (loc:PK, FIPS codes)
or an actor's country (act:PAK, CAMEO codes):
  n        event count             q1..q4   counts by QuadClass (verbal/material
  m        sum of mentions                  cooperation, verbal/material conflict)
  r01..r20 counts by CAMEO root     tone     mention-weighted average tone
  gs       mention-weighted Goldstein scale
plus "world" totals, because GDELT's source coverage grows over time and
indicators must be relative to it.

GDELT publishes day D's file on D+1, so a monthly indicator built from these
is known the day after the month ends: no look-ahead.

Usage: python3 gdelt-daily.py [START YYYYMMDD] [END YYYYMMDD]
"""
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from datetime import date, timedelta

OUT = os.environ.get("GDELT_OUT", os.path.expanduser("~/stock-backtest/gdelt/daily.jsonl"))
BASE = "https://data.gdeltproject.org/events/{}.export.CSV.zip"

# Locations (FIPS 10-4, ActionGeo_CountryCode) and actors (CAMEO country codes).
LOCATIONS = {"PK", "IN", "AF", "IR", "CH", "US", "SA", "AE", "IS", "RS", "UP", "IZ", "YM", "QA", "TU", "BG", "KS"}
ACTORS = {"PAK", "IND", "AFG", "IRN", "CHN", "USA", "SAU", "ARE", "ISR", "RUS", "UKR", "IRQ", "YEM", "QAT", "TUR"}

# Column indices (0-based) in the GDELT 1.0 event export.
ACT1, ACT2 = 7, 17
ROOT, QUAD, GOLD, MENT, TONE, GEO = 28, 29, 30, 31, 34, 51


def blank():
    return {"n": 0, "m": 0, "q": [0, 0, 0, 0], "r": [0] * 20, "tw": 0.0, "gw": 0.0}


def add(acc, root, quad, gold, ment, tone):
    acc["n"] += 1
    acc["m"] += ment
    if 1 <= quad <= 4:
        acc["q"][quad - 1] += 1
    if 1 <= root <= 20:
        acc["r"][root - 1] += 1
    acc["tw"] += tone * ment
    acc["gw"] += gold * ment


def finish(acc):
    m = acc["m"] or 1
    return {"n": acc["n"], "m": acc["m"], "q": acc["q"], "r": acc["r"], "tone": round(acc["tw"] / m, 4), "gs": round(acc["gw"] / m, 4)}


def process(day):
    url = BASE.format(day)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "stock-tracker-backtest"}), timeout=180) as r:
                blob = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(10 * (attempt + 1))
        except Exception:
            time.sleep(10 * (attempt + 1))
    else:
        raise RuntimeError(f"download failed: {day}")
    z = zipfile.ZipFile(io.BytesIO(blob))
    keys = {"world": blank()}
    with z.open(z.namelist()[0]) as f:
        for raw in io.TextIOWrapper(f, encoding="utf-8", errors="replace"):
            c = raw.rstrip("\n").split("\t")
            if len(c) < 52:
                continue
            try:
                root = int(c[ROOT][:2]) if c[ROOT][:2].isdigit() else 0
                quad = int(c[QUAD] or 0)
                gold = float(c[GOLD] or 0)
                ment = int(c[MENT] or 1)
                tone = float(c[TONE] or 0)
            except ValueError:
                continue
            add(keys["world"], root, quad, gold, ment, tone)
            targets = set()
            if c[GEO] in LOCATIONS:
                targets.add("loc:" + c[GEO])
            for a in (c[ACT1], c[ACT2]):
                if a in ACTORS:
                    targets.add("act:" + a)
            for t in targets:
                add(keys.setdefault(t, blank()), root, quad, gold, ment, tone)
    return {"date": day, **{k: finish(v) for k, v in keys.items()}}


def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "20130401"
    end = sys.argv[2] if len(sys.argv) > 2 else (date.today() - timedelta(days=1)).strftime("%Y%m%d")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    done = set()
    if os.path.exists(OUT):
        with open(OUT) as f:
            for line in f:
                try:
                    done.add(json.loads(line)["date"])
                except Exception:
                    pass
    d = date(int(start[:4]), int(start[4:6]), int(start[6:]))
    last = date(int(end[:4]), int(end[4:6]), int(end[6:]))
    n = 0
    while d <= last:
        day = d.strftime("%Y%m%d")
        if day not in done:
            t = time.time()
            rec = process(day)
            if rec is not None:
                with open(OUT, "a") as f:
                    f.write(json.dumps(rec, separators=(",", ":")) + "\n")
            n += 1
            print(f"{day} {'ok' if rec else 'missing'} {time.time() - t:.1f}s", flush=True)
        d += timedelta(days=1)
    print(f"done: {n} days processed")


if __name__ == "__main__":
    main()
