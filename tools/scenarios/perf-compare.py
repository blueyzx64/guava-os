#!/usr/bin/env python3
"""perf-compare.py STOCK_LOG GUAVA_LOG [GUAVA_SUMMARY]: PASS/FAIL per perf metric (B11).

Reads the STARTUP / IDLE / PERF / JITTER lines of two harness runs of perf-suite.sh (stock GNOME
login, Guava login) and holds Guava to thresholds relative to the stock baseline, because the
harness renders on llvmpipe where absolute frame times mean little. Thresholds: README.md.
"""
import json
import re
import sys


def parse(path):
    text = open(path, errors='replace').read()
    out = {'startup': None, 'idle': {}, 'perf': {}, 'jitter': {}, 'info': {}}
    m = re.search(r'^STARTUP (\{.*\})\s*$', text, re.M)
    if m:
        out['startup'] = json.loads(m.group(1))
    for kind, key in (('IDLE', 'idle'), ('PERF', 'perf'), ('JITTER', 'jitter')):
        for m in re.finditer(rf'^{kind} (\S+) (.*)$', text, re.M):
            out[key][m.group(1)] = {k: float(v) for k, v in re.findall(r'(\w+)=([\d.]+)', m.group(2))}
    for m in re.finditer(r'^INFO (.*)$', text, re.M):
        out['info'].update(re.findall(r'([\w-]+)=(\S+)', m.group(1)))
    return out


def main():
    s, g = parse(sys.argv[1]), parse(sys.argv[2])
    rows = []

    def check(name, got, limit, ok=None):
        if got is None or limit is None:
            rows.append(('FAIL', name, 'missing data'))
            return
        passed = got <= limit if ok is None else ok
        rows.append(('PASS' if passed else 'FAIL', name, f'guava={got:g} limit={limit:g}'))

    ss, gs = s['startup'] or {}, g['startup'] or {}
    if ss and gs:
        check('login.ready_ms', gs.get('ready'), ss.get('startupComplete', 0) + 600)
        check('login.stall_total_ms', gs.get('stallTotalMs'), ss.get('stallTotalMs', 0) * 1.5 + 300)
        check('login.max_stall_ms', gs.get('maxStall'), ss.get('maxStall', 0) + 250)
        moves = sum(c['moves'] + c['hides'] for k, c in gs.get('chrome', {}).items())
        detail = ','.join(f"{k}:{c['moves']}m{c['hides']}h" for k, c in gs.get('chrome', {}).items() if c['moves'] + c['hides'])
        check('login.chrome_jumps' + (f' ({detail})' if detail else ''), moves, 0)
        check('login.workarea_changes', gs['workarea']['changes'], ss['workarea']['changes'])
        ov = [e.split('@')[0] for e in gs.get('overview', [])]
        check('login.overview_flash (' + ' '.join(ov) + ')', int('hiding' in ov), 0)
    else:
        rows.append(('FAIL', 'login', 'no STARTUP line'))

    for label in ('idle', 'idle-after'):
        a, b = s['idle'].get(label), g['idle'].get(label)
        if not (a and b):
            rows.append(('FAIL', label, 'missing data'))
            continue
        check(f'{label}.paints', b['paints'], a['paints'])
        check(f'{label}.wakeups_per_s', b['wakeups_per_s'], a['wakeups_per_s'] * 1.2 + 5)
        check(f'{label}.cpu_ms', b['cpu_ms'], a['cpu_ms'] + 100)

    for name in ('overview', 'menu', 'drag', 'overview-load', 'menu-load', 'drag-load'):
        a, b = s['perf'].get(name), g['perf'].get(name)
        if not (a and b):
            rows.append(('FAIL', name, 'missing data'))
            continue
        factor, slack = (1.5, 10) if name.endswith('-load') else (1.3, 5)
        check(f'{name}.p95_ms (stock {a["p95"]:g})', b['p95'], a['p95'] * factor + slack)
        check(f'{name}.max_stall_ms', b['maxStall'], a['maxStall'] * factor + 100)
    for name in ('drag', 'drag-load'):
        a, b = s['jitter'].get(name), g['jitter'].get(name)
        if a and b:
            bad = lambda j: j['jumps'] + j['reversals'] + j['flickers']
            check(f'{name}.jumps+reversals+flickers', bad(b), bad(a))
    a, b = s['perf'].get('burst'), g['perf'].get('burst')
    if a and b:
        check('burst.max_stall_ms', b['maxStall'], a['maxStall'] * 1.5 + 100)
        check('burst.stalls50', b['stalls50'], a['stalls50'] * 1.5 + 3)
    else:
        rows.append(('FAIL', 'burst', 'missing data'))
    if len(sys.argv) > 3:
        m = re.search(r'Guava errors: (\d+)', open(sys.argv[3]).read())
        check('guava_errors', int(m.group(1)) if m else None, 0)

    print('== perf summary (Guava vs stock GNOME, same suite run)')
    for r in rows:
        print(f'{r[0]} {r[1]}  {r[2]}')
    print(f"INFO degraded-under-load={g['info'].get('degraded-under-load', '?')}")
    if ss and gs:
        print(f"INFO login stock: complete={ss.get('startupComplete')} stalls={ss.get('stallTotalMs')}ms | "
              f"guava: ready={gs.get('ready')} stalls={gs.get('stallTotalMs')}ms features={(gs.get('features') or {}).get('slowest')}")
    fails = sum(r[0] == 'FAIL' for r in rows)
    print(f'== {len(rows) - fails} PASS, {fails} FAIL')
    return 1 if fails else 0


sys.exit(main())
