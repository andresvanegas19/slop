"""Show a RawTree table's columns and row count (read-only).

Usage: python3 show_columns.py [table]    (default: slop_human)
"""
import json
import os
import sys
import urllib.error
import urllib.request

from smoke_test import RAWTREE_BASE, TABLE, load_env

load_env()
table = sys.argv[1] if len(sys.argv) > 1 else TABLE
req = urllib.request.Request("{}/tables/{}".format(RAWTREE_BASE, table),
                             headers={"Authorization": "Bearer " + os.environ["RAWTREE_API_KEY"]})
try:
    t = json.load(urllib.request.urlopen(req, timeout=30))["table"]
except urllib.error.HTTPError as e:
    sys.exit("{}: HTTP {} (table doesn't exist until the first insert)".format(table, e.code))

print("{}  rows={}  created={}".format(t["name"], t["total_rows"], t["created_at"]))
for c in t["columns"]:
    print("  " + c["name"])
