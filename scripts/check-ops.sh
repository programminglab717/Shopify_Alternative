#!/bin/sh
# Checks Hatti's alerts and dashboards (ADR-725): the Prometheus rules parse and their unit tests
# pass, and every query of every Grafana dashboard in ops/grafana parses as PromQL. Uses the
# promtool named by PROMTOOL, or Prometheus's own image's.
set -eu
cd "$(dirname "$0")/.."

if [ -n "${PROMTOOL:-}" ]; then
  promtool() { "$PROMTOOL" "$@"; }
else
  promtool() {
    docker run --rm -v "$PWD:/work:ro" -v "${TMPDIR:-/tmp}:/scratch" -w /work \
      --entrypoint promtool prom/prometheus:v3.5.0 "$@"
  }
fi

promtool check rules ops/prometheus/hatti.rules.yml
promtool test rules ops/prometheus/hatti.rules.test.yml

# Each dashboard query as a recording rule, Grafana's variables given values, for promtool to
# parse: a rule file in JSON is YAML.
queries=$(mktemp "${TMPDIR:-/tmp}/dashboards.XXXXXX")
trap 'rm -f "$queries"' EXIT
# mktemp's file is its owner's alone; Prometheus's image reads it as nobody.
chmod 644 "$queries"
python3 - "$queries" ops/grafana/*.json <<'PY'
import json, sys
out, paths = sys.argv[1], sys.argv[2:]
rules = []
for path in paths:
    dashboard = json.load(open(path, encoding="utf-8"))
    ids = [panel["id"] for panel in dashboard["panels"]]
    assert len(ids) == len(set(ids)), f"{path}: panel ids repeat"
    for panel in dashboard["panels"]:
        for target in panel.get("targets", []):
            assert panel["datasource"]["uid"] == "${datasource}", f"{path}: {panel['title']}"
            expr = target["expr"].replace("$__rate_interval", "5m").replace("$__range", "1h")
            rules.append({"record": f"dashboard:query_{len(rules)}", "expr": expr})
json.dump({"groups": [{"name": "dashboards", "rules": rules}]}, open(out, "w"))
print(f"{len(rules)} dashboard queries from {len(paths)} dashboards")
PY
if [ -n "${PROMTOOL:-}" ]; then
  promtool check rules "$queries"
else
  promtool check rules "/scratch/$(basename "$queries")"
fi
