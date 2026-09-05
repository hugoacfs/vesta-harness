#!/usr/bin/env python3
"""vesta-attach-sessions — put migrated sessions into the dsh-chat workspace group.

The sidebar groups sessions by the workspace account in
$DSH_HOME/storages/workspace.json (sessionIds, newest first); anything else lands
under "Ungrouped". Run with the harness STOPPED (the controller owns the file):

  systemctl --user stop vesta-harness && python3 vesta-attach-sessions.py && systemctl --user start vesta-harness

Attaches every session in the dsh-chat store whose header cwd is the workspace
path, skipping forks, keeping a .bak copy of the account file.
"""
import json, os, sys, time, shutil
path = os.path.expanduser('~/.vesta-harness/storages/workspace.json')
live = os.path.expanduser('~/.vesta-harness/sessions/--home-hugo-workspace-dsh-chat--')
d = json.load(open(path))
ws = d['tables']['workspaces']['437fb67b-1429-40a0-b3cd-b463e51b2fcd']
have = set(ws['sessionIds'])
# every session dir in the dsh-chat store that is not yet attached, newest created first
cands = []
for name in os.listdir(live):
    if not name.startswith('session-') or name in have:
        continue
    zst = os.path.join(live, name, 'session.v2.jsonl.zstd')
    if not os.path.exists(zst):
        continue
    first = os.popen(f'zstd -dc -- {zst} | head -1').read()
    try:
        h = json.loads(first)
    except Exception:
        continue
    if h.get('cwd') != ws['path'] or h.get('parentSession'):
        continue
    cands.append((h['createdAt'], name))
cands.sort(reverse=True)
ids = [n for _, n in cands]
shutil.copy(path, path + '.bak-20260905')
ws['sessionIds'] = ws['sessionIds'] + ids
ws['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(d, f)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print('attached', len(ids), 'sessions; total now', len(ws['sessionIds']))
