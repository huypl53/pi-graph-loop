#!/usr/bin/env python3
"""Live-refresh reviewer for .pi/swarm iteration state (stdlib-only).

Reads the file-backed swarm state (metrics / runs / memory / iterations / traces /
tasks / mailboxes / swarm-state) and renders a compact, read-only snapshot of
iteration sessions with recomputed best/improvement, per-iteration correlation
(metric delta + linked task-graph node timeline + agent conversation), memories,
recent runs, and recent trace events.

Modes:
  --once   print one snapshot and exit 0 (for logs/artifacts)
  default  watch: clear screen, refresh, sleep --interval, repeat until Ctrl-C

No third-party dependencies. No writes. Every read tolerates missing/malformed files.

See docs/swarm-iteration-demo.md ("Reviewing iteration state live") for usage.
"""
import argparse
import glob
import json
import os
import signal
import sys
import time


# --------------------------------------------------------------------------- io
def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def read_json(path):
    txt = _read_text(path)
    if txt is None:
        return None
    try:
        return json.loads(txt)
    except Exception:
        return None


def read_jsonl(path):
    """Yield parsed JSON lines, skipping blanks/malformed."""
    txt = _read_text(path)
    if not txt:
        return
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def read_jsonl_latest(path, id_field):
    """Last record per id (mirrors the extension's readJsonlLatestById)."""
    latest = {}
    order = []
    for rec in read_jsonl(path):
        rid = rec.get(id_field) if isinstance(rec, dict) else None
        if isinstance(rid, str):
            if rid not in latest:
                order.append(rid)
            latest[rid] = rec
    # preserve first-seen order
    return {rid: latest[rid] for rid in order}


def tail_jsonl(path, n):
    """Last n parsed JSON lines (best-effort; reads whole file but is bounded by file size)."""
    txt = _read_text(path)
    if not txt:
        return []
    out = []
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out[-n:] if n else out


def tail_text_lines(path, n):
    txt = _read_text(path)
    if not txt:
        return []
    return [l for l in txt.splitlines() if l.strip()][-n:]


# ---------------------------------------------------------------- data loading
def state_root(cwd):
    return os.path.join(cwd, ".pi", "swarm")


def load_runs(root):
    return read_jsonl_latest(os.path.join(root, "runs", "runs.jsonl"), "runId")


def load_memories(root):
    return read_jsonl_latest(os.path.join(root, "memory", "memory.jsonl"), "memoryId")


def load_sessions(root):
    sessions = {}
    for f in sorted(glob.glob(os.path.join(root, "iterations", "*.json"))):
        s = read_json(f)
        if isinstance(s, dict) and s.get("iterationId"):
            sessions[s["iterationId"]] = s
    return sessions


def load_contract(root, contract_id):
    return read_json(os.path.join(root, "metrics", f"{contract_id}.json"))


def load_all_contracts(root):
    out = {}
    for f in sorted(glob.glob(os.path.join(root, "metrics", "*.json"))):
        c = read_json(f)
        if isinstance(c, dict) and c.get("id"):
            out[c["id"]] = c
    return out


def load_trace_tail(root, n):
    rows = tail_jsonl(os.path.join(root, "traces", "events.jsonl"), 4000)
    keep = []
    for r in rows:
        ev = r.get("event") if isinstance(r, dict) else None
        if isinstance(ev, str) and (
            ev.startswith("metric.") or ev.startswith("run.")
            or ev.startswith("memory.") or ev.startswith("iteration.")
        ):
            keep.append(r)
    return keep[-n:] if n else keep


def load_swarm_id(root):
    st = read_json(os.path.join(root, "swarm-state.json"))
    if isinstance(st, dict):
        return st.get("swarmId")
    return None


def load_messages_by_id(root):
    """MessageRecord lifecycle keyed by id (from swarm-state.json)."""
    st = read_json(os.path.join(root, "swarm-state.json"))
    if isinstance(st, dict):
        msgs = st.get("messages") or {}
        if isinstance(msgs, dict):
            return msgs
    return {}


def load_task(root, task_id):
    return read_json(os.path.join(root, "tasks", task_id, "task.json"))


def load_task_events(root, task_id):
    return list(read_jsonl(os.path.join(root, "tasks", task_id, "events.jsonl")))


def mailbox_bodies_for(root, msg_ids, cap=4000):
    """Bounded: scan each recipient mailbox once (tail-capped) for the requested ids."""
    wanted = set(msg_ids)
    bodies = {}
    if not wanted:
        return bodies
    mbox_dir = os.path.join(root, "mailboxes")
    if not os.path.isdir(mbox_dir):
        return bodies
    # Only scan mailboxes referenced by any wanted message's `to`; resolve via state first.
    # As a fallback (state missing), scan all mailboxes tail-capped.
    scanned = set()
    try:
        names = sorted(os.listdir(mbox_dir))
    except Exception:
        names = []
    for name in names:
        if not wanted:
            break
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(mbox_dir, name)
        for rec in tail_jsonl(path, cap):
            if not isinstance(rec, dict):
                continue
            mid = rec.get("id")
            if mid in wanted and mid not in bodies:
                bodies[mid] = rec
                wanted.discard(mid)
    return bodies


# --------------------------------------------------------------- best recompute
def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def compute_best(session, runs_by_id, contract):
    """Faithful mirror of the extension's computeIterationBest."""
    pm = (contract or {}).get("primaryMetric", {}) if isinstance(contract, dict) else {}
    metric_id = pm.get("id")
    direction = pm.get("direction")
    mmc = pm.get("minimumMeaningfulChange")
    target = pm.get("target")
    warnings = []
    eff_dir = direction
    if direction == "target" and not _is_num(target):
        warnings.append("direction=target but no numeric primaryMetric.target; falling back to maximize")
        eff_dir = "maximize"

    entries = session.get("iterations", []) or []
    per_run = []
    for e in entries:
        run = runs_by_id.get(e.get("runId")) if isinstance(e, dict) else None
        raw = (run.get("metrics", {}) or {}).get(metric_id) if isinstance(run, dict) else None
        present = raw is not None
        per_run.append({
            "runId": e.get("runId"), "label": e.get("label"),
            "value": raw if present else None, "present": present,
            "taskId": (run.get("taskId") if isinstance(run, dict) else None),
            "nodeId": (run.get("nodeId") if isinstance(run, dict) else None),
        })
    num = [p for p in per_run if _is_num(p["value"])]
    missing_count = sum(1 for p in per_run if not p["present"])

    baseline_entry = entries[0] if entries else None
    baseline_run = runs_by_id.get(baseline_entry.get("runId")) if isinstance(baseline_entry, dict) else None
    baseline_val = (baseline_run.get("metrics", {}) or {}).get(metric_id) if isinstance(baseline_run, dict) else None
    baseline_run_id = baseline_entry.get("runId") if isinstance(baseline_entry, dict) else None

    best_run_id = None
    best_value = None
    improvement = None
    passing_count = None
    meaningful = False

    if eff_dir == "passfail":
        passing = [p for p in per_run if p["value"] is True]
        passing_count = len(passing)
        if passing:
            best_run_id = passing[0]["runId"]
            best_value = True
        meaningful = passing_count > 0 and baseline_val is not True
    elif num:
        if eff_dir == "minimize":
            pick = min(num, key=lambda p: p["value"])
        elif eff_dir == "target" and _is_num(target):
            pick = min(num, key=lambda p: abs(p["value"] - target))
        else:
            pick = max(num, key=lambda p: p["value"])
        best_run_id = pick["runId"]
        best_value = pick["value"]
        if _is_num(baseline_val):
            if eff_dir == "target" and _is_num(target):
                improvement = abs(baseline_val - target) - abs(pick["value"] - target)
            elif eff_dir == "minimize":
                improvement = baseline_val - pick["value"]
            else:
                improvement = pick["value"] - baseline_val
            meaningful = (abs(improvement) >= mmc) if _is_num(mmc) else (improvement > 0)
        else:
            meaningful = True

    return {
        "metricId": metric_id, "direction": direction, "target": target,
        "bestRunId": best_run_id, "bestValue": best_value,
        "baselineRunId": baseline_run_id, "baselineValue": baseline_val,
        "improvement": improvement, "passingCount": passing_count,
        "meaningful": meaningful, "missingCount": missing_count,
        "perRun": per_run, "warnings": warnings,
    }


def per_entry_deltas(session, runs_by_id, contract):
    """Per-iteration run-to-run + vs-baseline deltas, signed by direction."""
    pm = (contract or {}).get("primaryMetric", {}) if isinstance(contract, dict) else {}
    metric_id = pm.get("id")
    direction = (pm.get("direction") or "")
    entries = session.get("iterations", []) or []
    rows = []
    prev_val = None
    base_val = None
    for i, e in enumerate(entries):
        run = runs_by_id.get(e.get("runId")) if isinstance(e, dict) else None
        val = (run.get("metrics", {}) or {}).get(metric_id) if isinstance(run, dict) else None
        if i == 0:
            base_val = val if _is_num(val) else None
        d_prev = None
        d_base = None
        if _is_num(val) and _is_num(prev_val):
            d_prev = val - prev_val
        if _is_num(val) and _is_num(base_val):
            d_base = val - base_val
        rows.append({
            "index": e.get("index") if isinstance(e, dict) else (i + 1),
            "runId": e.get("runId"), "label": e.get("label"),
            "value": val, "deltaPrev": d_prev, "deltaBase": d_base,
            "taskId": (run.get("taskId") if isinstance(run, dict) else None),
            "nodeId": (run.get("nodeId") if isinstance(run, dict) else None),
        })
        if _is_num(val):
            prev_val = val
    return {"metricId": metric_id, "direction": direction, "rows": rows}


# ---------------------------------------------------------------- formatting
def trunc(s, n):
    if s is None:
        return ""
    s = str(s).replace("\n", " ").replace("\r", " ")
    s = " ".join(s.split())
    return s if len(s) <= n else s[: max(0, n - 1)] + "+"


def num(v):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def evidence_present(root, refs):
    out = []
    for r in refs or []:
        if not isinstance(r, str):
            continue
        # resolve relative to the swarm cwd (state root's parent = cwd)
        ok = os.path.exists(os.path.join(root, "..", r)) if not os.path.isabs(r) else os.path.exists(r)
        out.append((r, bool(ok)))
    return out


def fmt_msg_row(mid, rec, body, full):
    """id | from->to | subject | ack(status) | replyTo | result->resultMessageId"""
    if not isinstance(rec, dict):
        rec = {}
    frm = rec.get("from", "?")
    to = rec.get("to", "?")
    subj = body.get("subject") if isinstance(body, dict) else rec.get("subject")
    subj = trunc(subj, 28)
    status = rec.get("status", "?")
    lastack = rec.get("lastAck") or {}
    ack = trunc(lastack.get("status"), 12) if isinstance(lastack, dict) else ""
    reply = rec.get("replyTo") or ""
    result = (lastack.get("resultMessageId") if isinstance(lastack, dict) else None) or (rec.get("response") or {}).get("resultMessageId")
    line = f"  {trunc(mid,22)} | {trunc(frm,16)}->{trunc(to,16)} | {subj:<28} | {trunc(ack,12):<12} | {status:<9}"
    if reply:
        line += f" replyTo={trunc(reply,18)}"
    if result:
        line += f" result->{trunc(result,18)}"
    if full and isinstance(body, dict):
        b = trunc(body.get("body"), 200)
        if b:
            line += f"\n      body: {b}"
    return line


# ---------------------------------------------------------------- correlation
def collect_task_msg_ids(task):
    ids = []
    if not isinstance(task, dict):
        return ids
    for h in task.get("handoffs") or []:
        if isinstance(h, dict) and h.get("messageId"):
            ids.append(h["messageId"])
    for nid, node in (task.get("nodes") or {}).items():
        if isinstance(node, dict):
            for mid in node.get("messageIds") or []:
                if mid:
                    ids.append(mid)
    return ids


def node_timeline_rows(task_events, node_ids):
    want = set(filter(None, node_ids))
    rows = []
    for ev in task_events:
        if not isinstance(ev, dict):
            continue
        name = ev.get("event") or ""
        if name not in ("task.assign", "task.update", "task.message", "task.close", "task.close.notify"):
            continue
        nid = ev.get("nodeId")
        if want and nid not in want:
            continue
        if name == "task.assign":
            desc = f"assign {trunc(ev.get('assignee'),18)} msg={trunc(ev.get('messageId'),14)} {ev.get('prevStatus','')}->{ev.get('status') or ''}".strip()
        elif name == "task.update":
            desc = f"update {ev.get('prevStatus','')}->{ev.get('status') or ''} outcome={ev.get('outcome') or '-'} by={trunc(ev.get('by'),14)}"
            if ev.get("artifact"):
                desc += f" art={trunc(ev.get('artifact'),24)}"
        elif name == "task.message":
            desc = f"message {ev.get('fromNode','')}->{ev.get('toNode') or '?'} to={trunc(ev.get('to'),14)} replyExpected={ev.get('replyExpected')}"
        else:
            desc = f"{name} status={ev.get('status') or ev.get('taskStatus') or ''}"
        rows.append((ev.get("ts") or "", nid or "", desc))
    rows.sort(key=lambda r: r[0])
    return rows


def conversation_block(root, msg_ids, messages_by_id, full, limit):
    ids = [i for i in msg_ids if i]
    # de-dup preserving order
    seen = set()
    uniq = []
    for i in ids:
        if i not in seen:
            seen.add(i)
            uniq.append(i)
    uniq = uniq[:limit] if limit else uniq
    if not uniq:
        return None
    bodies = mailbox_bodies_for(root, uniq)
    lines = []
    for mid in uniq:
        rec = messages_by_id.get(mid, {})
        body = bodies.get(mid, {})
        lines.append(fmt_msg_row(mid, rec, body, full))
    return "\n".join(lines) if lines else None


# ---------------------------------------------------------------- rendering
def section(out, title):
    out.append("")
    out.append(f"== {title} ==")


def render_header(args, root, swarm_id):
    out = []
    mode = "one-shot" if args.once else f"watch {args.interval}s"
    filt = []
    if args.iteration:
        filt.append(f"--iteration {args.iteration}")
    if args.run:
        filt.append(f"--run {args.run}")
    if args.task:
        filt.append(f"--task {args.task}")
    filt_s = (" | " + " ".join(filt)) if filt else ""
    out.append(f"# swarm iteration watcher | cwd={args.cwd} | swarm={swarm_id or '-'} | mode={mode}{filt_s}")
    out.append(f"# generated={time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())} | root={root}")
    return out


def render_sessions_table(sessions):
    out = ["iterationId            contract              status   iters bestRunId            pinned  updated"]
    if not sessions:
        out.append("  (no iteration sessions)")
        return out
    for sid, s in sessions.items():
        it = s.get("iterations") or []
        out.append(
            f"{trunc(sid,22):<22} {trunc(s.get('metricContractId'),20):<20} "
            f"{trunc(s.get('status'),8):<8} {len(it):<5} {trunc(s.get('bestRunId'),20):<20} "
            f"{len(s.get('pinnedMemoryIds') or []):<6} {trunc(s.get('updatedAt'),19)}"
        )
    return out


def render_session_detail(root, s, runs_by_id, contracts):
    out = []
    cid = s.get("metricContractId")
    contract = contracts.get(cid) if cid else None
    best = compute_best(s, runs_by_id, contract)
    out.append(f"-- session {s.get('iterationId')} (contract={cid}, status={s.get('status')}, goal={trunc(s.get('goal'),40)})")
    pm = (contract or {}).get("primaryMetric", {}) if contract else {}
    out.append(f"   metric: id={pm.get('id')} dir={pm.get('direction')} type={pm.get('valueType')} mmc={pm.get('minimumMeaningfulChange')} target={pm.get('target')}")
    entries = s.get("iterations") or []
    base_id = s.get("baselineRunId") or (entries[0].get("runId") if entries else None)
    base_run = runs_by_id.get(base_id) if base_id else None
    base_val = (base_run.get("metrics", {}) or {}).get(best["metricId"]) if isinstance(base_run, dict) else None
    out.append(f"   baseline: run={trunc(base_id,22)} val={num(base_val)} verdict={(base_run or {}).get('verdict','-')} git={((base_run or {}).get('git') or {}).get('headCommit') or 'no-git'}")
    stored_best = s.get("bestRunId")
    drift = " DRIFT(stored!=recomputed)" if stored_best and best["bestRunId"] and stored_best != best["bestRunId"] else ""
    imp = num(best["improvement"]) if best["improvement"] is not None else ("passing=%s" % best["passingCount"] if best["passingCount"] is not None else "-")
    out.append(f"   best:     run={trunc(best['bestRunId'],22)} val={num(best['bestValue'])} improvement={imp} meaningful={best['meaningful']} missing={best['missingCount']}{drift}")
    last_entry = entries[-1] if entries else None
    last_run = runs_by_id.get(last_entry.get("runId")) if isinstance(last_entry, dict) else None
    last_val = (last_run.get("metrics", {}) or {}).get(best["metricId"]) if isinstance(last_run, dict) else None
    out.append(f"   last:     run={trunc((last_entry or {}).get('runId'),22)} val={num(last_val)}")
    if best["warnings"]:
        for w in best["warnings"]:
            out.append(f"   warn: {w}")
    # per-run values
    out.append("   per-run: runId                label              value present")
    for p in best["perRun"]:
        out.append(f"            {trunc(p['runId'],20):<20} {trunc(p['label'],18):<18} {num(p['value']):<6} {p['present']}")
    return out, contract, best


def render_correlation(root, s, runs_by_id, contract, args, messages_by_id):
    out = []
    deltas = per_entry_deltas(s, runs_by_id, contract)
    out.append("   -- per-iteration correlation --")
    out.append(f"   metric delta (metricId={deltas['metricId']} dir={deltas['direction']}):")
    for r in deltas["rows"]:
        out.append(
            f"      #{r['index']} run={trunc(r['runId'],20)} val={num(r['value'])} "
            f"dPrev={num(r['deltaPrev'])} dBase={num(r['deltaBase'])} {trunc(r['label'],16)}"
        )
    # collect tasks touched by this session's runs
    task_ids = []
    for r in deltas["rows"]:
        if r.get("taskId") and r["taskId"] not in task_ids:
            task_ids.append(r["taskId"])
    if args.task and args.task not in task_ids:
        task_ids = [args.task] + task_ids
    for tid in task_ids:
        task = load_task(root, tid)
        tev = load_task_events(root, tid)
        node_ids = []
        for r in deltas["rows"]:
            if r.get("taskId") == tid and r.get("nodeId") and r["nodeId"] not in node_ids:
                node_ids.append(r["nodeId"])
        out.append(f"   -- task graph {tid} (nodes touched: {', '.join(node_ids) or '-'}) --")
        # node status snapshot
        if isinstance(task, dict) and task.get("nodes"):
            out.append("      nodes: nodeId              status      outcome     assignee            ")
            for nid, node in task["nodes"].items():
                if isinstance(node, dict):
                    out.append(f"             {trunc(nid,20):<20} {trunc(node.get('status'),10):<10} {trunc(node.get('outcome'),10):<10} {trunc(node.get('assignee'),18)}")
        rows = node_timeline_rows(tev, node_ids)
        if rows:
            out.append("      timeline: ts                  nodeId              event")
            for ts, nid, desc in rows:
                out.append(f"               {trunc(ts,19):<19} {trunc(nid,20):<20} {desc}")
        msg_ids = collect_task_msg_ids(task)
        cblock = conversation_block(root, msg_ids, messages_by_id, args.messages_full, args.messages_limit)
        if cblock:
            out.append(f"      conversation ({len(msg_ids)} msg ids, showing {args.messages_limit or 'all'}):")
            out.append(cblock)
    return out


def render_memories(root, memories, s, args):
    out = []
    by_status = {"active": [], "proposed": [], "rejected": [], "expired": []}
    for mid, m in memories.items():
        st = m.get("status") if isinstance(m, dict) else None
        by_status.setdefault(st, []).append(m)
    counts = " ".join(f"{k}={len(v)}" for k, v in sorted(by_status.items()) if v)
    out.append(f"   counts: {counts or 'none'}")
    pinned = set(s.get("pinnedMemoryIds") or []) if s else set()
    active = [m for m in by_status.get("active", [])]
    scope_id = (s.get("scope") or {}).get("id") if s else None
    scope_id = scope_id or (s.get("metricContractId") if s else None)
    shown = []
    for m in active:
        mid = m.get("memoryId")
        sid = (m.get("scope") or {}).get("id")
        if (s is None) or (mid in pinned) or (scope_id and sid == scope_id):
            shown.append(m)
    if shown:
        out.append(f"   active/pinned for session ({len(shown)}):")
        for m in shown:
            ev = evidence_present(root, m.get("evidenceRefs"))
            evok = "ok" if ev and all(p for _, p in ev) else ("partial" if ev else "no-refs")
            out.append(f"      {trunc(m.get('memoryId'),22)} | {trunc(m.get('claim'),40)} | src={trunc(m.get('sourceRunId'),16)} | evidence={evok}")
    rej = by_status.get("rejected", [])[: args.runs]
    if rej:
        out.append(f"   rejected ({len(by_status.get('rejected', []))}, showing {len(rej)}):")
        for m in rej:
            out.append(f"      {trunc(m.get('memoryId'),22)} | {trunc(m.get('rejectionReason'),60)}")
    return out


def render_recent_runs(runs_by_id, contracts, args):
    out = ["runId                 status   verdict   primary contract              git        recordedAt"]
    items = list(runs_by_id.values())
    # most recent first by recordedAt
    items.sort(key=lambda r: r.get("recordedAt") or "", reverse=True)
    for r in items[: args.runs]:
        cid = r.get("metricContractId")
        pm_id = ((contracts.get(cid) or {}).get("primaryMetric") or {}).get("id") if cid else None
        pval = (r.get("metrics", {}) or {}).get(pm_id) if pm_id else None
        git = ((r.get("git") or {}).get("headCommit") or "no-git")
        out.append(
            f"{trunc(r.get('runId'),20):<20} {trunc(r.get('status'),8):<8} {trunc(r.get('verdict'),8):<8} "
            f"{num(pval):<7} {trunc(cid,20):<20} {trunc(git,9):<9} {trunc(r.get('recordedAt'),19)}"
        )
    return out


def render_events(events):
    out = ["ts                  event                  key fields"]
    for ev in reversed(events):
        keys = []
        for k in ("runId", "memoryId", "iterationId", "bestRunId", "accepted", "status", "verdict", "metricContractId"):
            if k in ev:
                keys.append(f"{k}={ev[k]}")
        out.append(f"{trunc(ev.get('ts'),19):<19} {trunc(ev.get('event'),22):<22} {trunc(' '.join(keys),50)}")
    return out


def render_run_focus(root, run_id, runs_by_id, contracts, sessions, args, messages_by_id):
    out = []
    r = runs_by_id.get(run_id)
    if not r:
        out.append(f"(run {run_id} not found in runs.jsonl)")
        return out
    cid = r.get("metricContractId")
    contract = contracts.get(cid) if cid else None
    pm_id = ((contract or {}).get("primaryMetric") or {}).get("id")
    out.append(f"-- run focus {run_id} (status={r.get('status')} verdict={r.get('verdict')} contract={cid})")
    out.append(f"   primary metric {pm_id} = {num((r.get('metrics') or {}).get(pm_id))}")
    out.append(f"   git={((r.get('git') or {}).get('headCommit')) or 'no-git'} agent={r.get('agentId')} recorded={r.get('recordedAt')}")
    ev = evidence_present(root, r.get("evidenceRefs"))
    out.append("   evidence:")
    if ev:
        for ref, ok in ev:
            out.append(f"      [{'ok' if ok else 'MISSING'}] {ref}")
    else:
        out.append("      (none)")
    tid = r.get("taskId")
    if tid:
        task = load_task(root, tid)
        tev = load_task_events(root, tid)
        out.append(f"   -- task graph {tid} (node={r.get('nodeId')}) --")
        rows = node_timeline_rows(tev, [r.get("nodeId")] if r.get("nodeId") else [])
        if rows:
            out.append("      timeline:")
            for ts, nid, desc in rows:
                out.append(f"         {trunc(ts,19)} {trunc(nid,20)} {desc}")
        cblock = conversation_block(root, collect_task_msg_ids(task), messages_by_id, args.messages_full, args.messages_limit)
        if cblock:
            out.append("      conversation:")
            out.append(cblock)
    else:
        out.append("   (no linked task graph; standalone run)")
    # which sessions include this run
    in_sessions = [sid for sid, s in sessions.items() if any((e.get("runId") == run_id) for e in (s.get("iterations") or []))]
    if in_sessions:
        out.append(f"   in sessions: {', '.join(in_sessions)}")
    return out


def render_task_focus(root, task_id, runs_by_id, memories, args, messages_by_id):
    out = []
    task = load_task(root, task_id)
    if not task:
        out.append(f"(task {task_id} not found)")
        return out
    tev = load_task_events(root, task_id)
    out.append(f"-- task focus {task_id} (status={task.get('status')} title={trunc(task.get('title'),40)})")
    if task.get("nodes"):
        out.append("   nodes: nodeId              status      outcome     assignee")
        for nid, node in task["nodes"].items():
            if isinstance(node, dict):
                out.append(f"          {trunc(nid,20):<20} {trunc(node.get('status'),10):<10} {trunc(node.get('outcome'),10):<10} {trunc(node.get('assignee'),18)}")
    rows = node_timeline_rows(tev, [])
    if rows:
        out.append("   timeline:")
        for ts, nid, desc in rows:
            out.append(f"      {trunc(ts,19)} {trunc(nid,20)} {desc}")
    cblock = conversation_block(root, collect_task_msg_ids(task), messages_by_id, args.messages_full, args.messages_limit)
    if cblock:
        out.append("   conversation:")
        out.append(cblock)
    linked_runs = [r for r in runs_by_id.values() if r.get("taskId") == task_id]
    if linked_runs:
        out.append(f"   linked runs ({len(linked_runs)}):")
        for r in linked_runs:
            out.append(f"      {trunc(r.get('runId'),22)} verdict={r.get('verdict')} recorded={trunc(r.get('recordedAt'),19)}")
    linked_mem = [m for m in memories.values() if (m.get("scope") or {}).get("id") == task_id]
    if linked_mem:
        out.append(f"   linked memories ({len(linked_mem)}):")
        for m in linked_mem:
            out.append(f"      {trunc(m.get('memoryId'),22)} status={m.get('status')} src={trunc(m.get('sourceRunId'),16)}")
    return out


# ---------------------------------------------------------- task discovery
def discover_tasks(root):
    out = []
    tdir = os.path.join(root, "tasks")
    if not os.path.isdir(tdir):
        return out
    try:
        names = sorted(os.listdir(tdir))
    except Exception:
        return out
    for d in names:
        t = read_json(os.path.join(tdir, d, "task.json"))
        if not isinstance(t, dict) or not t.get("taskId"):
            continue
        nodes = t.get("nodes") or {}
        done = sum(1 for n in nodes.values() if isinstance(n, dict) and n.get("status") in ("done", "skipped"))
        out.append({
            "id": t.get("taskId"), "status": t.get("status"), "title": t.get("title"),
            "nodeCount": len(nodes), "doneCount": done, "start": t.get("start"),
            "updatedAt": t.get("updatedAt") or t.get("createdAt") or "", "task": t,
        })
    out.sort(key=lambda r: r.get("updatedAt") or "", reverse=True)
    return out


def render_all_tasks(tasks, verbose=False):
    out = ["taskId                                status    title                                  nodes done"]
    if not tasks:
        out.append("  (no task graphs under .pi/swarm/tasks)")
        return out
    for t in tasks:
        out.append(f"{trunc(t['id'],36):<36} {trunc(t['status'],8):<8} {trunc(t['title'],36):<36} {t['nodeCount']:<5} {t['doneCount']}/{t['nodeCount']}")
        if verbose:
            for nid, node in (t.get("task", {}).get("nodes") or {}).items():
                if isinstance(node, dict):
                    art = f" art={trunc(node.get('artifact'),28)}" if node.get("artifact") else ""
                    out.append(f"      {trunc(nid,20):<20} {trunc(node.get('status'),10):<10} {trunc(node.get('outcome'),12):<12} {trunc(node.get('assignee'),18)}{art}")
    return out


# --------------------------------------------------------------- mermaid
STATUS_ICON = {
    "done": " \u2705", "failed": " \u274c", "blocked": " \u26d4", "in_progress": " \u1f535",
    "assigned": " \u25f7", "ready": " \u25f7", "pending": " \u22ef", "skipped": " \u2298",
}


def mmd_escape(s):
    if s is None:
        return ""
    return str(s).replace('"', "'").replace("\n", " ").replace("\r", " ")


def _status_class(status):
    if status == "done":
        return "done"
    if status == "failed":
        return "failed"
    if status == "blocked":
        return "blocked"
    if status in ("in_progress", "assigned"):
        return "inprogress"
    return ""


def mermaid_task_flow(task):
    """flowchart of task-graph nodes (status/outcome/role/artifact) + edges from task.json."""
    if not isinstance(task, dict):
        return "flowchart TD\n    empty[\"(no task graph)\"]"
    nodes = task.get("nodes") or {}
    edges = task.get("edges") or []
    if not nodes:
        return "flowchart TD\n    empty[\"(no nodes)\"]"
    lines = ["flowchart TD"]
    order = []
    start = task.get("start")
    if start and start in nodes:
        order.append(start)
    for nid in nodes:
        if nid not in order:
            order.append(nid)
    key = {nid: f"n{i}" for i, nid in enumerate(order)}
    for nid in order:
        n = nodes[nid] or {}
        st = n.get("status") or "?"
        icon = STATUS_ICON.get(st, "")
        parts = [nid, f"role: {n.get('role', '-')}", f"status: {st}{icon}", f"outcome: {n.get('outcome', '-')}"]
        if n.get("assignee"):
            parts.append(f"assignee: {n['assignee']}")
        if n.get("artifact"):
            parts.append(f"artifact: {n['artifact']}")
        label = "<br/>".join(mmd_escape(p) for p in parts)
        lines.append(f'    {key[nid]}["{label}"]')
    for e in edges:
        f, to = e.get("from"), e.get("to")
        if f in key and to in key:
            lbl = "rework" if e.get("rework") else e.get("when")
            if lbl:
                lines.append(f'    {key[f]} -->|{mmd_escape(lbl)}| {key[to]}')
            else:
                lines.append(f"    {key[f]} --> {key[to]}")
    lines.append("    classDef done fill:#cfe,stroke:#393,stroke-width:1px")
    lines.append("    classDef failed fill:#fcc,stroke:#933,stroke-width:1px")
    lines.append("    classDef blocked fill:#fec,stroke:#963,stroke-width:1px")
    lines.append("    classDef inprogress fill:#cef,stroke:#369,stroke-width:1px")
    for nid in order:
        cls = _status_class((nodes[nid] or {}).get("status"))
        if cls:
            lines.append(f"    class {key[nid]} {cls}")
    return "\n".join(lines)


def mermaid_task_sequence(task, root, messages_by_id, msg_limit=40):
    """sequenceDiagram of agent messages/handoffs (from->to, ack/response/result)."""
    if not isinstance(task, dict):
        return "sequenceDiagram\n    note over : (no task graph)"
    msg_ids = collect_task_msg_ids(task)
    if not msg_ids:
        return "sequenceDiagram\n    note over : (no messages)"
    bodies = mailbox_bodies_for(root, msg_ids)
    rows = []
    seen = set()
    for mid in msg_ids:
        if mid in seen:
            continue
        seen.add(mid)
        rec = messages_by_id.get(mid, {})
        if not isinstance(rec, dict):
            continue
        rows.append((mid, rec, bodies.get(mid, {})))
    rows.sort(key=lambda r: (r[1].get("createdAt") or ""))
    rows = rows[:msg_limit]
    if not rows:
        return "sequenceDiagram\n    note over : (no messages)"
    actors = {}

    def actor(a):
        a = a or "?"
        if a not in actors:
            actors[a] = f"a{len(actors)}"
        return actors[a]

    for _mid, rec, _body in rows:
        actor(rec.get("from"))
        actor(rec.get("to"))
    lines = ["sequenceDiagram", "    autonumber"]
    for a, alias in actors.items():
        lines.append(f"    participant {alias} as {mmd_escape(a)}")
    for mid, rec, body in rows:
        frm = actor(rec.get("from"))
        to = actor(rec.get("to"))
        subj = (body.get("subject") if isinstance(body, dict) else None) or rec.get("subject") or "(no subject)"
        lastack = rec.get("lastAck") or {}
        ack = lastack.get("status") or rec.get("status") or ""
        rid = lastack.get("resultMessageId")
        resp = (rec.get("response") or {}).get("status")
        note = f"ack:{ack or '-'}"
        if resp:
            note += f" resp:{resp}"
        text = f"{mmd_escape(trunc(subj, 48))}<br/>({mmd_escape(note)})"
        lines.append(f"    {frm}->>{to}: {text}")
        if rid and rid in messages_by_id:
            rrec = messages_by_id[rid] or {}
            rb = mailbox_bodies_for(root, [rid]).get(rid, {})
            rsubj = (rb.get("subject") if isinstance(rb, dict) else None) or rrec.get("subject") or "RESULT"
            rfrm = actor(rrec.get("from") or rec.get("to"))
            rto = actor(rrec.get("to") or rec.get("from"))
            lines.append(f"    {rfrm}-->>{rto}: {mmd_escape(trunc(rsubj, 48))}")
    return "\n".join(lines)


def mermaid_iteration_timeline(deltas, best):
    """flowchart timeline of per-iteration metric values + deltas; highlights best."""
    rows = deltas.get("rows") or []
    if not rows:
        return "flowchart LR\n    empty[\"(no iterations)\"]"
    lines = ["flowchart LR"]
    keys = []
    for i, r in enumerate(rows):
        k = f"i{i}"
        keys.append(k)
        parts = ["baseline" if i == 0 else f"#{r.get('index')}"]
        if r.get("label"):
            parts.append(mmd_escape(trunc(r["label"], 18)))
        parts.append(f"val {num(r.get('value'))}")
        if i > 0 and r.get("deltaPrev") is not None:
            parts.append(f"\u0394prev {num(r['deltaPrev'])}")
        if r.get("deltaBase") is not None and i > 0:
            parts.append(f"\u0394base {num(r['deltaBase'])}")
        label = "<br/>".join(str(p) for p in parts)
        lines.append(f'    {k}["{label}"]')
    for i in range(len(keys) - 1):
        lines.append(f"    {keys[i]} --> {keys[i + 1]}")
    lines.append("    classDef best fill:#ffd,stroke:#960,stroke-width:2px")
    best_id = best.get("bestRunId")
    for i, r in enumerate(rows):
        if best_id and r.get("runId") == best_id:
            lines.append(f"    class {keys[i]} best")
    hdr = f"%% direction={deltas.get('direction')} metric={deltas.get('metricId')} target={best.get('target')} improvement={num(best.get('improvement'))} meaningful={best.get('meaningful')}"
    return hdr + "\n" + "\n".join(lines)


# ------------------------------------------------------- dashboard renderers
def _md_table(header, rows):
    out = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(c).replace("|", "/").replace("\n", " ") for c in r) + " |")
    return "\n".join(out)


def select_report_tasks(args, tasks, sessions, runs_by_id):
    """which task graphs to diagram in the markdown report."""
    if args.task:
        t = next((x for x in tasks if x["id"] == args.task), None)
        return [t] if t else []
    linked = []
    for s in sessions.values():
        for e in (s.get("iterations") or []):
            run = runs_by_id.get(e.get("runId")) if isinstance(e, dict) else None
            tid = run.get("taskId") if isinstance(run, dict) else None
            if tid and tid not in linked:
                linked.append(tid)
    sel = [x for x in tasks if x["id"] in linked]
    if not sel:
        sel = list(tasks)
    return sel[: args.tasks_limit]


def render_mermaid(args, root):
    """emit fenced mermaid diagram blocks only (pipe-friendly)."""
    if not os.path.isdir(root):
        return "(no .pi/swarm state)"
    runs_by_id = load_runs(root)
    sessions = load_sessions(root)
    contracts = load_all_contracts(root)
    messages_by_id = load_messages_by_id(root)
    tasks = discover_tasks(root)
    blocks = []
    sel = select_report_tasks(args, tasks, sessions, runs_by_id)
    for t in sel:
        blocks.append(f"%% TASK FLOW: {t['id']}")
        blocks.append("```mermaid")
        blocks.append(mermaid_task_flow(t.get("task")))
        blocks.append("```")
        blocks.append(f"%% TASK SEQUENCE: {t['id']}")
        blocks.append("```mermaid")
        blocks.append(mermaid_task_sequence(t.get("task"), root, messages_by_id, args.messages_limit))
        blocks.append("```")
    for sid, s in (sessions.items() if not args.iteration else
                   ((args.iteration, sessions[args.iteration]),) if args.iteration in sessions else ()):
        cid = s.get("metricContractId")
        contract = contracts.get(cid) if cid else None
        best = compute_best(s, runs_by_id, contract)
        deltas = per_entry_deltas(s, runs_by_id, contract)
        blocks.append(f"%% ITERATION TIMELINE: {sid}")
        blocks.append("```mermaid")
        blocks.append(mermaid_iteration_timeline(deltas, best))
        blocks.append("```")
    if not blocks:
        return "(no task graphs or iteration sessions to diagram)"
    return "\n\n".join(blocks)


def render_markdown(args, root):
    """full reviewable Markdown dashboard (prose + fenced mermaid + tables)."""
    if not os.path.isdir(root):
        return f"# Swarm iteration review\n\n(no .pi/swarm state at `{root}`)\n"
    runs_by_id = load_runs(root)
    memories = load_memories(root)
    sessions = load_sessions(root)
    contracts = load_all_contracts(root)
    messages_by_id = load_messages_by_id(root)
    tasks = discover_tasks(root)
    swarm_id = load_swarm_id(root)
    out = []
    out.append(f"# Swarm iteration review")
    out.append("")
    out.append(f"- **generated**: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    out.append(f"- **swarm**: `{swarm_id or '-'}`  \u00b7  **cwd**: `{args.cwd}`")
    out.append(f"- **counts**: tasks={len(tasks)}  iterations={len(sessions)}  runs={len(runs_by_id)}  memories={len(memories)}")
    out.append("")
    # tasks table
    out.append("## Tasks")
    if tasks:
        out.append(_md_table(
            ["taskId", "status", "title", "nodes", "done"],
            [[trunc(t['id'], 36), t.get('status', '-'), trunc(t.get('title'), 40), t['nodeCount'], f"{t['doneCount']}/{t['nodeCount']}"] for t in tasks],
        ))
    else:
        out.append("_(no task graphs)_")
    out.append("")
    # iterations
    out.append("## Iteration sessions")
    if sessions:
        out.append(_md_table(
            ["iterationId", "contract", "status", "iters", "bestRunId", "updated"],
            [[trunc(sid, 24), trunc((s.get('metricContractId') or '-'), 20), s.get('status', '-'),
              len(s.get('iterations') or []), trunc(s.get('bestRunId') or '-', 20), trunc(s.get('updatedAt') or '-', 19)]
             for sid, s in sessions.items()],
        ))
        out.append("")
        for sid, s in sessions.items():
            cid = s.get("metricContractId")
            contract = contracts.get(cid) if cid else None
            best = compute_best(s, runs_by_id, contract)
            deltas = per_entry_deltas(s, runs_by_id, contract)
            out.append(f"### `{sid}` \u2014 {s.get('status', '-')} \u2014 _{trunc(s.get('goal'), 60)}_")
            pm = (contract or {}).get("primaryMetric", {}) if contract else {}
            imp = num(best['improvement']) if best['improvement'] is not None else (f"passing={best['passingCount']}" if best['passingCount'] is not None else "-")
            drift = " \u26a0\ufe0f DRIFT" if s.get("bestRunId") and best["bestRunId"] and s.get("bestRunId") != best["bestRunId"] else ""
            out.append(f"- metric `{pm.get('id')}` dir={pm.get('direction')} target={pm.get('target')} mmc={pm.get('minimumMeaningfulChange')}")
            out.append(f"- baseline run `{trunc(best.get('baselineRunId'), 22)}` = {num(best.get('baselineValue'))}")
            out.append(f"- best run `{trunc(best.get('bestRunId'), 22)}` = {num(best.get('bestValue'))} \u2014 improvement {imp}, meaningful={best.get('meaningful')}{drift}")
            out.append("")
            out.append("```mermaid")
            out.append(mermaid_iteration_timeline(deltas, best))
            out.append("```")
            out.append("")
    else:
        out.append("_(no iteration sessions)_")
        out.append("")
    # task diagrams
    sel = select_report_tasks(args, tasks, sessions, runs_by_id)
    out.append("## Task graph flows")
    if sel:
        for t in sel:
            out.append(f"### `{t['id']}` \u2014 {t.get('status', '-')} \u2014 _{trunc(t.get('title'), 60)}_")
            out.append("")
            out.append("**Nodes & flow**:")
            out.append("")
            out.append("```mermaid")
            out.append(mermaid_task_flow(t.get("task")))
            out.append("```")
            out.append("")
            out.append("**Agent conversation**:")
            out.append("")
            out.append("```mermaid")
            out.append(mermaid_task_sequence(t.get("task"), root, messages_by_id, args.messages_limit))
            out.append("```")
            out.append("")
    else:
        out.append("_(no task graphs selected)_")
        out.append("")
    # memories
    out.append("## Memories")
    if memories:
        out.append(_md_table(
            ["memoryId", "status", "claim", "sourceRunId", "scope"],
            [[trunc(m.get('memoryId'), 22), m.get('status', '-'), trunc(m.get('claim'), 40),
              trunc(m.get('sourceRunId'), 16), trunc((m.get('scope') or {}).get('id'), 16)]
             for m in memories.values()],
        ))
    else:
        out.append("_(no memories)_")
    out.append("")
    # recent runs
    out.append("## Recent runs")
    items = sorted(runs_by_id.values(), key=lambda r: r.get("recordedAt") or "", reverse=True)[: args.runs]
    if items:
        out.append(_md_table(
            ["runId", "status", "verdict", "primary", "contract", "git", "recordedAt"],
            [[trunc(r.get('runId'), 20), r.get('status', '-'), r.get('verdict', '-'),
              num((r.get('metrics') or {}).get(((contracts.get(r.get('metricContractId')) or {}).get('primaryMetric') or {}).get('id'))),
              trunc(r.get('metricContractId'), 18), trunc(((r.get('git') or {}).get('headCommit')) or 'no-git', 9),
              trunc(r.get('recordedAt'), 19)] for r in items],
        ))
    else:
        out.append("_(no runs)_")
    out.append("")
    out.append("_Generated by `scripts/swarm_iteration_watch.sh --once --format markdown`. Read-only._")
    return "\n".join(out)


def render(args, root):
    out = []
    if not os.path.isdir(root):
        out.append(f"(no .pi/swarm state at {root})")
        out.append("  Run a demo first: bash scripts/swarm_iteration_demo.sh")
        return "\n".join(out)

    runs_by_id = load_runs(root)
    memories = load_memories(root)
    sessions = load_sessions(root)
    contracts = load_all_contracts(root)
    messages_by_id = load_messages_by_id(root)
    swarm_id = load_swarm_id(root)
    tasks = discover_tasks(root)

    out += render_header(args, root, swarm_id)

    # Empty iteration state: still render runs/memories/events if present, else point to demo.
    has_any = sessions or runs_by_id or memories or tasks
    if not has_any:
        out.append("")
        out.append("(no iteration/runs/memory state under this cwd)")
        out.append("  Run a demo first: bash scripts/swarm_iteration_demo.sh  (it prints its LOG_DIR)")
        out.append("  Then: scripts/swarm_iteration_watch.sh --cwd <LOG_DIR>/cwd --once")
        # still show recent events if any
        events = load_trace_tail(root, args.events)
        if events:
            section(out, "recent trace events")
            out += render_events(events)
        out.append("")
        out.append("# filter: --iteration <id>; artifact: --once > review.txt")
        return "\n".join(out)

    # Focus modes take precedence
    if args.run:
        section(out, f"run focus: {args.run}")
        out += render_run_focus(root, args.run, runs_by_id, contracts, sessions, args, messages_by_id)
        events = load_trace_tail(root, args.events)
        section(out, "recent trace events")
        out += render_events(events)
        out.append("")
        out.append("# filter: --run <id> | --task <id> | --iteration <id>; artifact: --once > review.txt")
        return "\n".join(out)

    if args.task:
        section(out, f"task focus: {args.task}")
        out += render_task_focus(root, args.task, runs_by_id, memories, args, messages_by_id)
        events = load_trace_tail(root, args.events)
        section(out, "recent trace events")
        out += render_events(events)
        out.append("")
        out.append("# filter: --run <id> | --task <id> | --iteration <id>; artifact: --once > review.txt")
        return "\n".join(out)

    if args.all_tasks:
        section(out, f"all task graphs ({len(tasks)})")
        out += render_all_tasks(tasks, verbose=True)
        events = load_trace_tail(root, args.events)
        section(out, "recent trace events")
        out += render_events(events)
        out.append("")
        out.append("# browse: --task <id> | diagram: --format markdown --once")
        return "\n".join(out)

    if tasks:
        section(out, f"task graphs ({len(tasks)})")
        out += render_all_tasks(tasks, verbose=False)

    section(out, "sessions")
    sel = {args.iteration: sessions[args.iteration]} if args.iteration and args.iteration in sessions else sessions
    if args.iteration and args.iteration not in sessions:
        out.append(f"  (iteration {args.iteration} not found; showing all)")
        sel = sessions
    out += render_sessions_table(sel)

    section(out, "session details")
    for sid, s in sel.items():
        detail, contract, best = render_session_detail(root, s, runs_by_id, contracts)
        out += detail
        out += render_correlation(root, s, runs_by_id, contract, args, messages_by_id)
        section(out, f"memories (session {sid})")
        out += render_memories(root, memories, s, args)

    section(out, f"recent runs (last {args.runs})")
    out += render_recent_runs(runs_by_id, contracts, args)

    section(out, f"recent trace events (last {args.events})")
    events = load_trace_tail(root, args.events)
    out += render_events(events)

    out.append("")
    out.append("# filter: --iteration <id> | --run <id> | --task <id> | --messages full; artifact: --once > review.txt")
    return "\n".join(out)


# ---------------------------------------------------------------- main / watch
def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="swarm_iteration_watch",
        description="Live-refresh reviewer for .pi/swarm iteration state (read-only, stdlib-only).",
    )
    cwd_default = os.environ.get("WATCH_CWD", ".")
    p.add_argument("--cwd", default=cwd_default, help=f"swarm cwd (default {cwd_default!r}; env WATCH_CWD)")
    p.add_argument("--iteration", default=None, help="focus one iteration session id")
    p.add_argument("--run", default=None, help="focus one run id (node timeline + conversation + metric)")
    p.add_argument("--task", default=None, help="focus one task graph id (nodes + handoffs + messages)")
    p.add_argument("--messages", default="6", help="messages per focus: N or 'full' (default 6)")
    p.add_argument("--interval", type=float, default=2.0, help="refresh seconds in watch mode (default 2)")
    p.add_argument("--once", action="store_true", help="print one snapshot and exit 0")
    p.add_argument("--no-clear", action="store_true", help="watch mode: scroll instead of clearing screen")
    p.add_argument("--runs", type=int, default=10, help="recent runs to show (default 10)")
    p.add_argument("--events", type=int, default=15, help="recent trace events to show (default 15)")
    p.add_argument("--format", choices=["text", "mermaid", "markdown"], default="text",
                   help="output format (default text). markdown/mermaid are one-shot review artifacts")
    p.add_argument("--out", default=None, help="write the one-shot output to FILE instead of stdout")
    p.add_argument("--all-tasks", action="store_true", help="list every task graph with terminal node/artifact summary")
    p.add_argument("--tasks-limit", type=int, default=8, help="task graphs to diagram in markdown/mermaid (default 8)")
    return p.parse_args(argv)


def _emit(args, text):
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text if text.endswith("\n") else text + "\n")
        sys.stdout.write(f"wrote {len(text)} bytes to {args.out}\n")
        return 0
    sys.stdout.write(text + "\n")
    return 0


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    # normalize --messages
    if str(args.messages).lower() == "full":
        args.messages_full = True
        args.messages_limit = 0
    else:
        try:
            args.messages_limit = int(args.messages)
        except Exception:
            args.messages_limit = 6
        args.messages_full = False

    root = state_root(args.cwd)
    fmt = args.format

    # markdown and mermaid are review artifacts (always one-shot).
    if fmt == "markdown":
        return _emit(args, render_markdown(args, root))
    if fmt == "mermaid":
        return _emit(args, render_mermaid(args, root))

    # text: one-shot (incl. when --out is set) or watch loop.
    if args.once or args.out:
        return _emit(args, render(args, root))

    # watch mode: respond to both interactive Ctrl-C (SIGINT->KeyboardInterrupt) and `kill`/SIGTERM.
    class _StopWatch(Exception):
        pass

    def _on_term(_signum, _frame):
        raise _StopWatch()

    try:
        signal.signal(signal.SIGTERM, _on_term)
    except (ValueError, OSError):
        pass  # not in main thread / unsupported; KeyboardInterrupt still works

    # watch mode
    try:
        while True:
            snap = render(args, root)
            if args.no_clear:
                sys.stdout.write("\n" + "-" * 60 + "\n")
            else:
                sys.stdout.write("\033[2J\033[H")
            sys.stdout.write(snap + "\n")
            sys.stdout.flush()
            time.sleep(max(0.2, args.interval))
    except (KeyboardInterrupt, _StopWatch):
        sys.stdout.write("\n(stopped)\n")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
