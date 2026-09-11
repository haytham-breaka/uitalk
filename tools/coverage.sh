#!/usr/bin/env bash
# Every suite that needs no bridge, no agent and no tokens, measured together.
# The agent-driven probes (fake-page, probe-context, probe-tabs, probe-variations)
# run the bridge as a subprocess, so they cost tokens and contribute no coverage —
# they are exercised by hand, not here.
set -e
cd "$(dirname "$0")/.."
rm -rf .cov && mkdir -p .cov

for suite in dom-check ui-check raster-check capture-check probe-ws server-check mcp-check agent-check; do
  printf '%-14s' "$suite"
  if NODE_V8_COVERAGE=.cov node "tools/$suite.mjs" > /tmp/uitalk-cov-$suite.out 2>&1; then
    echo "$(grep -c '^  ok' /tmp/uitalk-cov-$suite.out) ok"
  else
    echo "FAILED"; tail -20 /tmp/uitalk-cov-$suite.out; exit 1
  fi
done

npx c8 report --temp-directory=.cov --all \
  --include='client/**' --include='server/**' \
  --reporter=text --reporter=json-summary \
  --check-coverage --lines 85
