#!/usr/bin/env bash
set -euo pipefail

EXTENSION="/Users/kl/.pi/agent/extensions/workflow-designer.ts"
WORKFLOW_DIR="/Users/kl/.pi/workflows"

PI_OFFLINE=1 pi --no-extensions -e "$EXTENSION" --list-models >/tmp/workflow-extension-load.out

python3 - <<'PY'
import json
from pathlib import Path
root = Path('/Users/kl/.pi/workflows')
for path in root.glob('*.workflow.json'):
    data = json.loads(path.read_text())
    assert isinstance(data.get('nodes'), list), f'{path}: nodes must be a list'
    assert isinstance(data.get('edges'), list), f'{path}: edges must be a list'
    ids = [n.get('id') for n in data['nodes']]
    assert all(isinstance(i, str) and i for i in ids), f'{path}: node ids must be non-empty strings'
    assert len(ids) == len(set(ids)), f'{path}: duplicate node ids'
    idset = set(ids)
    for edge in data['edges']:
        assert edge.get('from') in idset, f'{path}: unknown edge source {edge}'
        assert edge.get('to') in idset, f'{path}: unknown edge target {edge}'
print('workflow smoke test passed')
PY
