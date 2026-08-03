#!/usr/bin/env python3
"""Static, dependency-free HTML dashboard generator for .pi/swarm state.

Reads the file-backed swarm state (metrics / runs / memory / iterations /
traces / tasks / mailboxes / swarm-state) and emits a single self-contained
HTML file (inline CSS + minimal JS, no external runtime dependencies) that
prioritizes three sections: per-iteration metric improvement, task-graph node
flow, and agent conversation. Supports completed/historical review (one-shot)
and live regeneration (--live loop + optional auto-refresh meta tag).

Data loaders are imported from the sibling swarm_iteration_watch module so the
two tools share one source of truth for the data model.

See docs/swarm-dashboard.md for usage.
"""
import argparse
import html
import json
import os
import signal
import sys
import time

# reuse the shared data model from the sibling watcher (same scripts/ dir)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swarm_iteration_watch as W  # noqa: E402


# --------------------------------------------------------------- html helpers
def esc(s):
    return html.escape("" if s is None else str(s))


def trunc_esc(s, n):
    return esc(W.trunc(s, n))


def badge(text, kind=""):
    return f'<span class="badge {kind}">{esc(text)}</span>'


STATUS_BADGE = {
    "done": ("done", "done"), "failed": ("fail", "failed"),
    "blocked": ("block", "blocked"), "in_progress": ("run", "in progress"),
    "assigned": ("run", "assigned"), "ready": ("idle", "ready"),
    "pending": ("idle", "pending"), "skipped": ("skip", "skipped"),
    "proposed": ("prop", "proposed"), "active": ("ok", "active"),
    "rejected": ("fail", "rejected"), "expired": ("idle", "expired"),
}


def status_badge(status):
    if not status:
        return badge("-", "")
    cls, label = STATUS_BADGE.get(status, ("", status))
    return badge(label, cls)


def vis_num(v):
    return W.num(v)


def table(headers, rows, caption=None, cls=""):
    cap = f"<caption>{esc(caption)}</caption>" if caption else ""
    head = "<tr>" + "".join(f"<th scope=col>{esc(h)}</th>" for h in headers) + "</tr>"
    body = ""
    for r in rows:
        body += "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>"
    return f'<div class="tablewrap"><table class="{cls}">{cap}<thead>{head}</thead><tbody>{body}</tbody></table></div>'


# --------------------------------------------------------------- sections
def render_overview(ctx, args):
    tasks, sessions = ctx["tasks"], ctx["sessions"]
    runs, memories = ctx["runs"], ctx["memories"]
    done_tasks = sum(1 for t in tasks if t.get("status") == "done")
    active_mem = sum(1 for m in memories.values() if m.get("status") == "active")
    rej_mem = sum(1 for m in memories.values() if m.get("status") == "rejected")
    cards = (
        ("Tasks", f"{len(tasks)}", f"{done_tasks} done"),
        ("Iterations", f"{len(sessions)}", ""),
        ("Runs", f"{len(runs)}", ""),
        ("Memories", f"{len(memories)}", f"{active_mem} active / {rej_mem} rejected"),
    )
    out = ['<div class="cards">']
    for label, big, sub in cards:
        out.append(f'<div class="card"><div class=big>{esc(big)}</div><div class=label>{esc(label)}</div><div class=sub>{esc(sub)}</div></div>')
    out.append("</div>")
    if tasks:
        out.append("<h3>Task graphs</h3>")
        rows = [[f'<a href="#task-{esc(t["id"])}">{trunc_esc(t["id"], 36)}</a>', status_badge(t.get("status")),
                 trunc_esc(t.get("title"), 48), f'{t["doneCount"]}/{t["nodeCount"]}']
                for t in tasks]
        out.append(table(["Task", "Status", "Title", "Nodes done"], rows, "Task graphs"))
    return "\n".join(out)


def _iter_chart_svg(deltas, best):
    rows = deltas.get("rows") or []
    nums = [r["value"] for r in rows if W._is_num(r["value"])]
    if not nums:
        return '<p class="muted">(no numeric metric values to chart)</p>'
    target = best.get("target")
    lo = min(min(nums), target if W._is_num(target) else 0, 0)
    hi = max(max(nums), target if W._is_num(target) else 0, lo + 1)
    span = (hi - lo) or 1
    n = len(rows)
    bw, gap, left, pad = 46, 14, 34, 18
    W_ = left + n * (bw + gap) + gap
    H = 150
    base_y = H - 22
    top_y = 16
    plot_h = base_y - top_y
    best_id = best.get("bestRunId")
    parts = [f'<svg class="chart" role="img" aria-label="Metric {esc(deltas.get("metricId"))} across {n} iterations: {" ".join(vis_num(r["value"]) for r in rows)}" viewBox="0 0 {W_} {H}" preserveAspectRatio="xMidYMid meet">']
    # baseline axis line
    zero_y = base_y - ((0 - lo) / span) * plot_h
    parts.append(f'<line x1={left} y1={zero_y:.1f} x2={W_-gap:.1f} y2={zero_y:.1f} class=axis />')
    if W._is_num(target):
        ty = base_y - ((target - lo) / span) * plot_h
        parts.append(f'<line x1={left} y1={ty:.1f} x2={W_-gap:.1f} y2={ty:.1f} class=target /><text x={W_-gap:.1f} y={ty-4:.1f} class=axislbl text-anchor=end>target {vis_num(target)}</text>')
    for i, r in enumerate(rows):
        x = left + i * (bw + gap) + gap
        v = r["value"]
        if W._is_num(v):
            h = max(2, (v - lo) / span * plot_h) if v >= 0 else max(2, (lo - 0) / span * plot_h * 0 + 2)
            y = base_y - ((v - lo) / span) * plot_h
            h = base_y - y
            cls = "bar best" if (best_id and r.get("runId") == best_id) else "bar"
            parts.append(f'<rect x={x:.1f} width={bw} y={y:.1f} height={max(2,h):.1f} rx=3 class="{cls}" />')
            parts.append(f'<text x={x+bw/2:.1f} y={y-4:.1f} class=val text-anchor=middle>{vis_num(v)}</text>')
        else:
            parts.append(f'<text x={x+bw/2:.1f} y={base_y-4:.1f} class=val gap text-anchor=middle>n/a</text>')
        idx = "base" if i == 0 else f"#{r.get('index')}"
        parts.append(f'<text x={x+bw/2:.1f} y={base_y+14:.1f} class=axislbl text-anchor=middle>{esc(idx)}</text>')
        dp = r.get("deltaPrev")
        if i > 0 and dp is not None:
            parts.append(f'<text x={x+bw/2:.1f} y={base_y+27:.1f} class=delta text-anchor=middle>{"+" if dp>=0 else ""}{vis_num(dp)}</text>')
    parts.append("</svg>")
    return "".join(parts)


def render_iterations(ctx, args):
    sessions = ctx["sessions"]
    contracts = ctx["contracts"]
    runs = ctx["runs"]
    out = []
    sel = sessions
    if args.iteration:
        sel = {args.iteration: sessions[args.iteration]} if args.iteration in sessions else {}
        if not sel:
            out.append(f'<p class="muted">Iteration <code>{esc(args.iteration)}</code> not found.</p>')
    if not sel:
        out.append('<p class="muted">No iteration sessions under this cwd. Run <code>bash scripts/swarm_iteration_demo.sh</code> first.</p>')
        return "\n".join(out)
    for sid, s in sel.items():
        cid = s.get("metricContractId")
        contract = contracts.get(cid) if cid else None
        best = W.compute_best(s, runs, contract)
        deltas = W.per_entry_deltas(s, runs, contract)
        pm = (contract or {}).get("primaryMetric", {}) if contract else {}
        drift = (s.get("bestRunId") and best.get("bestRunId") and s.get("bestRunId") != best.get("bestRunId"))
        imp = vis_num(best.get("improvement")) if best.get("improvement") is not None else (f"passing={best.get('passingCount')}" if best.get("passingCount") is not None else "-")
        out.append(f'<div class="card session" id="iter-{esc(sid)}">')
        out.append(f'<h3>{esc(sid)} <span class="muted">/ {esc(cid)}</span> {status_badge(s.get("status"))}</h3>')
        out.append(f'<p class="goal">{trunc_esc(s.get("goal"), 120)}</p>')
        out.append('<dl class="kv">')
        out.append(f'<dt>Metric</dt><dd><code>{esc(pm.get("id"))}</code> dir={esc(pm.get("direction"))} type={esc(pm.get("valueType"))} mmc={esc(pm.get("minimumMeaningfulChange"))} target={esc(pm.get("target"))}</dd>')
        out.append(f'<dt>Baseline</dt><dd>run <code>{trunc_esc(best.get("baselineRunId"),22)}</code> = {vis_num(best.get("baselineValue"))}</dd>')
        out.append(f'<dt>Best</dt><dd>run <code>{trunc_esc(best.get("bestRunId"),22)}</code> = {vis_num(best.get("bestValue"))} &mdash; improvement {imp}, meaningful={best.get("meaningful")}' + (' <strong class=warn>DRIFT vs stored</strong>' if drift else '') + '</dd>')
        out.append(f'<dt>Missing metric values</dt><dd>{best.get("missingCount")}</dd>')
        out.append('</dl>')
        out.append(_iter_chart_svg(deltas, best))
        # visible text summary of the chart (accessibility + at-a-glance)
        trend = "; ".join(f"#{r.get('index') if i else 'base'}={vis_num(r.get('value'))}" + (f" (\u0394{vis_num(r.get('deltaPrev'))})" if i and r.get("deltaPrev") is not None else "") for i, r in enumerate(deltas.get("rows") or []))
        out.append(f'<p class="chart-summary"><strong>Trend:</strong> {esc(trend or "n/a")}. Direction {esc(deltas.get("direction"))}; best is <code>{trunc_esc(best.get("bestRunId"),22)}</code>.</p>')
        out.append("</div>")
    return "\n".join(out)


ROLE_LANE_ORDER = ["planner", "implementer", "reviewer", "tester", "orchestrator"]


def _linear_nodes(task):
    nodes = task.get("nodes") or {}
    edges = task.get("edges") or []
    adj = {}
    for e in edges:
        adj.setdefault(e.get("from"), []).append((e.get("to"), e.get("when"), e.get("rework")))
    order, seen = [], set()
    stack = [task.get("start")] if task.get("start") else []
    while stack:
        n = stack.pop()
        if not n or n in seen or n not in nodes:
            continue
        seen.add(n)
        order.append(n)
        for nx, _w, _r in reversed(adj.get(n, [])):
            if nx not in seen:
                stack.append(nx)
    for n in nodes:
        if n not in seen:
            order.append(n)
    return order, edges


def _topo_layers(task):
    nodes = task.get("nodes") or {}
    order, edges = _linear_nodes(task)
    deps = {nid: [d for d in (node.get("dependsOn") or []) if d in nodes] for nid, node in nodes.items()}
    memo, visiting = {}, set()

    def layer(nid):
        if nid in memo:
            return memo[nid]
        if nid in visiting:
            return 0
        visiting.add(nid)
        prev = deps.get(nid) or []
        value = (max(layer(dep) for dep in prev) + 1) if prev else 0
        visiting.remove(nid)
        memo[nid] = value
        return value

    for nid in order:
        layer(nid)
    return order, edges, memo


def _node_lane_role(node):
    role = (node or {}).get("role") or "unknown"
    return role if role in ROLE_LANE_ORDER else role


def _lane_sort_key_role(role):
    if role in ROLE_LANE_ORDER:
        return (ROLE_LANE_ORDER.index(role), role)
    return (len(ROLE_LANE_ORDER), role or "unknown")


def _artifact_ref_html(root, artifact_path):
    if not artifact_path:
        return ""
    if not root:
        return f'<div class="artifact">artifact: <code>{esc(artifact_path)}</code></div>'
    path = artifact_path
    if not os.path.isabs(path):
        path = os.path.normpath(os.path.join(root, path))
    rel = os.path.relpath(path, root)
    return f'<div class="artifact">artifact: <code>{esc(rel)}</code></div>'


def _node_card_html(task_id, nid, n, compact=False, lane_label=None, layer=None):
    st = n.get("status") or "?"
    cls = STATUS_BADGE.get(st, ("", ""))[0]
    compact_bits = [esc(nid), esc(st), esc(n.get("assignee") or "-")]
    head = f'<div class="nid">{esc(nid)}</div>'
    if compact:
        head = f'<div class="nid compactline">{" &bull; ".join(compact_bits)}</div>'
    lane_meta = []
    if lane_label is not None:
        lane_meta.append(f'<div class=nlane>lane: {esc(lane_label)}</div>')
    if layer is not None:
        lane_meta.append(f'<div class=nlayer>layer: {esc(layer)}</div>')
    art = _artifact_ref_html(None, n.get("artifact")) if n.get("artifact") else ""
    extra = []
    if not compact:
        extra.extend([
            f'<div class=nrole>role: {esc(n.get("role") or "-")}</div>',
            f'<div class=nstatus>{status_badge(st)}</div>',
            f'<div class=noutcome>outcome: {esc(n.get("outcome") or "-")}</div>',
            f'<div class=nwho>assignee: {esc(n.get("assignee") or "-")}</div>',
            art,
        ])
    else:
        extra.extend([
            f'<div class=nrole>{esc(n.get("role") or "-")}</div>',
            f'<div class=nwho>{esc(n.get("assignee") or "-")}</div>',
        ])
    return (
        f'<li class="nodecard {cls}" id="node-{esc(task_id)}-{esc(nid)}">{head}'
        + "".join(lane_meta)
        + "".join(extra)
        + "</li>"
    )


def _render_lane_grid(task, task_id, args, lane_mode, compact):
    nodes = task.get("nodes") or {}
    order, edges, layers = _topo_layers(task)
    if lane_mode == "none":
        return None, order, edges, layers

    lane_map = {}
    if lane_mode == "role":
        for nid in order:
            lane = _lane_sort_key_role(_node_lane_role(nodes.get(nid)))
            lane_map.setdefault(lane, []).append(nid)
        lane_labels = {k: k[1] for k in lane_map}
        lane_title = "Role lanes"
    else:
        for nid in order:
            lane = layers.get(nid, 0)
            lane_map.setdefault(lane, []).append(nid)
        lane_labels = {k: f"Layer {k}" for k in lane_map}
        lane_title = "Branch lanes"

    parts = [f'<div class="lanegrid lanegrid-{esc(lane_mode)}" aria-label="{esc(lane_title)}">']
    for lane_key in sorted(lane_map, key=lambda x: x if isinstance(x, int) else x):
        label = lane_labels.get(lane_key, str(lane_key))
        parts.append(f'<section class="lane"><div class="lanehead">{esc(label)}</div><ol class="lanebody">')
        for nid in lane_map[lane_key]:
            parts.append(_node_card_html(task_id, nid, nodes.get(nid) or {}, compact=compact, lane_label=label, layer=layers.get(nid)))
        parts.append("</ol></section>")
    parts.append("</div>")
    extra_edges = []
    spine = {(order[i], order[i + 1]) for i in range(len(order) - 1)}
    for e in edges:
        pair = (e.get("from"), e.get("to"))
        if pair not in spine:
            label = e.get("when") or ("rework" if e.get("rework") else "branch")
            extra_edges.append(f'{esc(e.get("from"))} &rarr; <code>{esc(e.get("to"))}</code> <span class="muted">[{esc(label)}]</span>')
    if extra_edges:
        parts.append('<div class="edge-row"><strong>Branch / rework edges</strong><div class="edge-list">' + " ".join(f'<span class="edge-pill">{e}</span>' for e in extra_edges) + '</div></div>')
    return "".join(parts), order, edges, layers


def render_graphs(ctx, args):
    tasks = ctx["tasks"]
    out = []
    sel = [t for t in tasks if (not args.task or t["id"] == args.task)]
    if args.task and not sel:
        out.append(f'<p class="muted">Task <code>{esc(args.task)}</code> not found.</p>')
        return "\n".join(out)
    if not sel:
        out.append('<p class="muted">No task graphs under this cwd.</p>')
        return "\n".join(out)
    sel = sel[: args.tasks_limit]
    for t in sel:
        task = t.get("task") or {}
        nodes = task.get("nodes") or {}
        compact = bool(args.compact or len(nodes) > 10)
        lane_html, order, edges, layers = _render_lane_grid(task, t["id"], args, args.lanes, compact)
        out.append(f'<div class="card taskflow" id="task-{esc(t["id"])}">')
        out.append(f'<h3>{esc(t["id"])} {status_badge(t.get("status"))}</h3>')
        out.append(f'<p class="goal">{trunc_esc(t.get("title"), 100)}</p>')
        out.append(f'<p class="chart-summary"><strong>Layout:</strong> lanes={esc(args.lanes)}; compact={"yes" if compact else "no"}; nodes={len(nodes)}; branches={sum(1 for e in edges if (e.get("from"), e.get("to")) not in {(order[i], order[i+1]) for i in range(len(order)-1)})}</p>')
        if lane_html:
            out.append(lane_html)
        else:
            out.append('<ol class="pipeline" aria-label="Task graph nodes in flow order">')
            edge_pairs = {(e.get("from"), e.get("to")) for e in edges}
            for i, nid in enumerate(order):
                n = nodes.get(nid) or {}
                st = n.get("status") or "?"
                cls = STATUS_BADGE.get(st, ("", ""))[0]
                art = _artifact_ref_html(ctx["root"], n.get("artifact")) if n.get("artifact") else ""
                out.append(f'<li class="nodecard {cls}" id="node-{esc(t["id"])}-{esc(nid)}"><div class=nid>{esc(nid)}</div>'
                           f'<div class=nrole>{esc(n.get("role") or "-")}</div>'
                           f'<div class=nstatus>{status_badge(st)}</div>'
                           f'<div class=noutcome>outcome: {esc(n.get("outcome") or "-")}</div>'
                           f'<div class=nwho>assignee: {esc(n.get("assignee") or "-")}</div>{art}</li>')
                if i < len(order) - 1 and (nid, order[i + 1]) in edge_pairs:
                    out.append('<li class="arrow" aria-hidden=true>&rarr;</li>')
            out.append('</ol>')
        summary = " &rarr; ".join(f"{esc(nid)}({esc((nodes.get(nid) or {}).get('status') or '?')}/{esc((nodes.get(nid) or {}).get('outcome') or '-')})" for nid in order)
        out.append(f'<p class="chart-summary"><strong>Flow:</strong> {summary}</p>')
        out.append("</div>")
    return "\n".join(out)


def _gather_task_messages(task, ctx, cap):
    mids = W.collect_task_msg_ids(task)
    bodies = W.mailbox_bodies_for(ctx["root"], mids)
    rows = []
    seen = set()
    for mid in mids:
        if mid in seen:
            continue
        seen.add(mid)
        rec = ctx["messages"].get(mid, {})
        if not isinstance(rec, dict):
            continue
        body = bodies.get(mid, {}) if isinstance(bodies.get(mid, {}), dict) else {}
        rows.append((mid, rec, body))
    rows.sort(key=lambda r: (r[1].get("createdAt") or "", r[0]))
    return rows[:cap] if cap else rows


def _conversation_key(rec, body, mid):
    if isinstance(rec, dict):
        for key in ("conversationId", "conversation", "threadId"):
            if rec.get(key):
                return str(rec.get(key))
        if rec.get("replyTo"):
            return f"reply:{rec.get('replyTo')}"
    if isinstance(body, dict):
        for key in ("conversationId", "conversation", "threadId"):
            if body.get(key):
                return str(body.get(key))
    return f"msg:{mid}"


def render_conversation(ctx, args):
    tasks = ctx["tasks"]
    out = []
    sel = [t for t in tasks if (not args.task or t["id"] == args.task)][: args.tasks_limit]
    if args.task and not any(t["id"] == args.task for t in tasks):
        out.append(f'<p class="muted">Task <code>{esc(args.task)}</code> not found.</p>')
        return "\n".join(out)
    if not sel:
        out.append('<p class="muted">No task graphs with messages under this cwd.</p>')
        return "\n".join(out)
    for t in sel:
        task = t.get("task") or {}
        rows = _gather_task_messages(task, ctx, args.messages_limit)
        node_ids = list((task.get("nodes") or {}).keys())
        out.append(f'<div class="card convo" id="convo-{esc(t["id"])}">')
        if args.task and node_ids:
            chips = " ".join(f'<a class="chip" href="#node-{esc(t["id"])}-{esc(nid)}">{esc(nid)}</a>' for nid in node_ids)
            out.append(f'<div class="chipbar"><span class="muted">Node jump:</span> {chips}</div>')
        actors = set()
        grouped = {}
        for mid, rec, body in rows:
            actors.add(rec.get("from"))
            actors.add(rec.get("to"))
            convo_id = _conversation_key(rec, body, mid)
            pair = f'{rec.get("fromNode") or "?"} → {rec.get("toNode") or "?"}'
            grouped.setdefault(convo_id, {}).setdefault(pair, []).append((mid, rec, body))
        n_result = sum(1 for _m, rec, _b in rows if (rec.get("lastAck") or {}).get("resultMessageId"))
        out.append(f'<h3>Conversation &mdash; {esc(t["id"])} </h3>')
        out.append(f'<p class="chart-summary"><strong>{len(rows)}</strong> messages across {len([a for a in actors if a])} participants ({esc(", ".join(sorted(a for a in actors if a)))}); {n_result} with a result reply. Grouped by conversation, then node pair.</p>')
        if not rows:
            out.append('<p class="muted">No messages resolved for this task.</p>')
            out.append("</div>")
            continue
        for convo_id, pair_map in grouped.items():
            convo_count = sum(len(v) for v in pair_map.values())
            out.append(f'<details class="thread" open><summary><strong>{esc(convo_id)}</strong> <span class="muted">({convo_count} messages)</span></summary>')
            for pair, msgs in pair_map.items():
                out.append(f'<div class="threadgroup"><div class="threadhead">{esc(pair)}</div><ol class="messages">')
                for mid, rec, body in msgs:
                    lastack = rec.get("lastAck") or {}
                    ack = lastack.get("status") or rec.get("status") or ""
                    ackcls = STATUS_BADGE.get(ack, ("", ""))[0]
                    subj = (body.get("subject") if isinstance(body, dict) else None) or rec.get("subject") or "(no subject)"
                    resp = (rec.get("response") or {}).get("status")
                    rid = lastack.get("resultMessageId")
                    btxt = (body.get("body") if isinstance(body, dict) else None) or ""
                    body_html = f'<details><summary>body</summary><pre class="msgbody">{esc(W.trunc(btxt, 600))}</pre></details>' if btxt else ""
                    resp_html = f' <span class="badge mini">{esc(resp)}</span>' if resp else ""
                    convo_tag = f'<div class="msgmeta"><span class="chip">task {esc(t["id"])}</span><span class="chip">{esc(convo_id)}</span><span class="chip">{esc(pair)}</span></div>'
                    result_html = ""
                    if rid and rid in ctx["messages"]:
                        rrec = ctx["messages"].get(rid) or {}
                        rbody = W.mailbox_bodies_for(ctx["root"], [rid]).get(rid, {})
                        rsubj = (rbody.get("subject") if isinstance(rbody, dict) else None) or rrec.get("subject") or "RESULT"
                        result_html = f'<div class="reply">&rarr; reply <code>{trunc_esc(rid,20)}</code>: {trunc_esc(rsubj, 70)}</div>'
                    out.append(f'<li class="msg {ackcls}"><div class="msghead">'
                               f'<span class="from">{esc(rec.get("from") or "?")}</span> &rarr; <span class="to">{esc(rec.get("to") or "?")}</span>'
                               f' {badge(ack or "-", ackcls)}{resp_html}</div>'
                               f'{convo_tag}'
                               f'<div class="msgsubj">{trunc_esc(subj, 90)}</div>'
                               f'{body_html}{result_html}'
                               f'<div class="msgid muted">id: <code>{trunc_esc(mid,26)}</code></div></li>')
                out.append('</ol></div>')
            out.append('</details>')
        out.append("</div>")
    return "\n".join(out)


def render_memories(ctx, args):
    memories = ctx["memories"]
    out = ["<div class='cards small'>"]
    by = {}
    for m in memories.values():
        by.setdefault(m.get("status", "?"), []).append(m)
    for st in ("active", "proposed", "rejected", "expired"):
        out.append(f'<div class="card"><div class=big>{len(by.get(st, []))}</div><div class=label>{esc(st)}</div></div>')
    out.append("</div>")
    if not memories:
        out.append('<p class="muted">No memories under this cwd.</p>')
        return "\n".join(out)
    rows = []
    for m in memories.values():
        ev_refs = m.get("evidenceRefs") or []
        ev = []
        for r in ev_refs:
            ok = os.path.exists(os.path.join(ctx["root"], "..", r)) if not os.path.isabs(r) else os.path.exists(r)
            ev.append(f'<span class="ev {"ok" if ok else "miss"}">{"\u2713" if ok else "\u2717"} {esc(r)}</span>')
        ev_html = " ".join(ev) or '<span class="muted">none</span>'
        reason = f'<div class=muted>reason: {trunc_esc(m.get("rejectionReason"), 80)}</div>' if m.get("rejectionReason") else ""
        rows.append([f'<a href="#mem-{esc(m.get("memoryId"))}">{trunc_esc(m.get("memoryId"), 22)}</a>',
                     status_badge(m.get("status")), trunc_esc(m.get("claim"), 50),
                     trunc_esc(m.get("sourceRunId"), 16), ev_html + reason])
    out.append(table(["Memory", "Status", "Claim", "Source run", "Evidence"], rows, "Memories and evidence"))
    return "\n".join(out)


def _load_task_node(ctx, task_id, node_id):
    task = W.load_task(ctx["root"], task_id)
    if not task:
        return None, None
    node = (task.get("nodes") or {}).get(node_id)
    return task, node


def _read_artifact_text(root, artifact_path, limit=20000):
    if not artifact_path:
        return None, None
    path = artifact_path
    if not os.path.isabs(path):
        path = os.path.normpath(os.path.join(root, path))
    if not os.path.exists(path):
        return path, None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return path, f.read(limit)
    except Exception:
        return path, None


def render_inspector(ctx, args):
    out = ['<div class="inspector">']
    shown = False
    if args.run and args.run in ctx["runs"]:
        out.append(f'<section class="inspectblock"><h3>Run inspector &mdash; <code>{esc(args.run)}</code></h3>')
        out.append(f'<pre class="raw">{esc(json.dumps(ctx["runs"][args.run], indent=2, default=str))}</pre></section>')
        shown = True
    if args.task:
        t = W.load_task(ctx["root"], args.task)
        if t:
            out.append(f'<section class="inspectblock"><h3>Task inspector &mdash; <code>{esc(args.task)}</code></h3>')
            out.append(f'<pre class="raw">{esc(json.dumps(t, indent=2, default=str))}</pre></section>')
            shown = True
            if getattr(args, "node", None):
                node = (t.get("nodes") or {}).get(args.node)
                if node:
                    related = {
                        "messageIds": node.get("messageIds") or [],
                        "assignmentMessageId": node.get("assignmentMessageId"),
                        "artifacts": node.get("artifact") or node.get("artifacts") or [],
                        "gates": node.get("gates") or {},
                    }
                    out.append(f'<section class="inspectblock" id="node-inspector-{esc(args.task)}-{esc(args.node)}"><h3>Node inspector &mdash; <code>{esc(args.node)}</code></h3>')
                    out.append('<div class="kv">' + ''.join([
                        f'<dt>Status</dt><dd>{status_badge(node.get("status"))}</dd>',
                        f'<dt>Outcome</dt><dd>{esc(node.get("outcome") or "-")}</dd>',
                        f'<dt>Role</dt><dd>{esc(node.get("role") or "-")}</dd>',
                        f'<dt>Assignee</dt><dd>{esc(node.get("assignee") or "-")}</dd>',
                        f'<dt>Depends on</dt><dd>{esc(", ".join(node.get("dependsOn") or []) or "-")}</dd>',
                        f'<dt>Message IDs</dt><dd>{esc(", ".join(node.get("messageIds") or []) or "-")}</dd>',
                        f'<dt>Assignment message</dt><dd>{esc(node.get("assignmentMessageId") or "-")}</dd>',
                    ]) + '</div>')
                    out.append(f'<pre class="raw">{esc(json.dumps({"node": node, "related": related}, indent=2, default=str))}</pre></section>')
                    shown = True
                else:
                    out.append(f'<section class="inspectblock"><h3>Node inspector &mdash; <code>{esc(args.node)}</code></h3><p class="muted">Node not found in task <code>{esc(args.task)}</code>.</p></section>')
                    shown = True
    if args.iteration and args.iteration in ctx["sessions"]:
        out.append(f'<section class="inspectblock"><h3>Iteration inspector &mdash; <code>{esc(args.iteration)}</code></h3>')
        out.append(f'<pre class="raw">{esc(json.dumps(ctx["sessions"][args.iteration], indent=2, default=str))}</pre></section>')
        shown = True
    if args.message and args.message in ctx["messages"]:
        out.append(f'<section class="inspectblock"><h3>Message inspector &mdash; <code>{esc(args.message)}</code></h3>')
        body = W.mailbox_bodies_for(ctx["root"], [args.message]).get(args.message, {})
        rec = dict(ctx["messages"][args.message])
        if isinstance(body, dict):
            rec["_body"] = body.get("body")
        out.append(f'<pre class="raw">{esc(json.dumps(rec, indent=2, default=str))}</pre></section>')
        shown = True
    if getattr(args, "memory", None) and args.memory in ctx["memories"]:
        out.append(f'<section class="inspectblock" id="mem-{esc(args.memory)}"><h3>Memory inspector &mdash; <code>{esc(args.memory)}</code></h3>')
        out.append(f'<pre class="raw">{esc(json.dumps(ctx["memories"][args.memory], indent=2, default=str))}</pre></section>')
        shown = True
    if getattr(args, "artifact", None):
        path, text = _read_artifact_text(ctx["root"], args.artifact)
        out.append(f'<section class="inspectblock"><h3>Artifact inspector &mdash; <code>{esc(args.artifact)}</code></h3>')
        if path and text is not None:
            rel = os.path.relpath(path, ctx["root"]) if os.path.isabs(path) else path
            if os.path.abspath(path).startswith(os.path.abspath(os.path.join(ctx["root"], ".pi", "swarm"))):
                out.append(f'<p class="muted">Rendered from <code>{esc(rel)}</code></p>')
                out.append(f'<pre class="raw artifacttext">{esc(text)}</pre>')
            else:
                out.append(f'<p class="muted">Artifact exists outside <code>.pi/swarm</code>: <code>{esc(rel)}</code></p>')
                out.append(f'<p><a href="file://{esc(path)}">Open artifact</a></p>')
        else:
            out.append(f'<p class="muted">Artifact not found: <code>{esc(path or args.artifact)}</code></p>')
        out.append('</section>')
        shown = True
    if not shown:
        out.append('<p class="muted">No focus selected. Pass <code>--run</code>, <code>--task</code>, <code>--node</code>, <code>--iteration</code>, <code>--message</code>, <code>--memory</code>, or <code>--artifact</code> to inspect raw details here.</p>')
        summary = {"swarmId": ctx["swarm_id"], "cwd": args.cwd,
                   "counts": {"tasks": len(ctx["tasks"]), "iterations": len(ctx["sessions"]),
                              "runs": len(ctx["runs"]), "memories": len(ctx["memories"])},
                   "contracts": list(ctx["contracts"].keys()), "sessions": list(ctx["sessions"].keys())}
        out.append('<details><summary>Raw state summary</summary><pre class="raw">' + esc(json.dumps(summary, indent=2)) + '</pre></details>')
    out.append("</div>")
    return "\n".join(out)


def render_runs(ctx, args):
    items = sorted(ctx["runs"].values(), key=lambda r: r.get("recordedAt") or "", reverse=True)[: args.runs]
    if not items:
        return '<p class="muted">No runs under this cwd.</p>'
    rows = []
    for r in items:
        cid = r.get("metricContractId")
        pm_id = ((ctx["contracts"].get(cid) or {}).get("primaryMetric") or {}).get("id")
        pval = (r.get("metrics") or {}).get(pm_id) if pm_id else None
        rows.append([f'<a href="#run-{esc(r.get("runId"))}">{trunc_esc(r.get("runId"), 20)}</a>',
                     status_badge(r.get("status")), badge(r.get("verdict") or "-", ""),
                     vis_num(pval), trunc_esc(cid, 18), trunc_esc(((r.get("git") or {}).get("headCommit")) or "no-git", 9),
                     trunc_esc(r.get("recordedAt"), 19)])
    return table(["Run", "Status", "Verdict", "Primary", "Contract", "Git", "Recorded"], rows, "Recent runs")


def render_events(ctx, args):
    events = ctx["events"]
    if not events:
        return '<p class="muted">No recent metric/run/memory/iteration trace events.</p>'
    rows = []
    for ev in reversed(events):
        keys = " ".join(f"{k}={ev[k]}" for k in ("runId", "memoryId", "iterationId", "bestRunId", "accepted", "status", "verdict", "metricContractId") if k in ev)
        rows.append([trunc_esc(ev.get("ts"), 19), trunc_esc(ev.get("event"), 22), trunc_esc(keys, 60)])
    return table(["Timestamp", "Event", "Key fields"], rows, "Recent trace events")


# --------------------------------------------------------------- CSS + shell
CSS = """
:root{--bg:#0f1420;--panel:#161d2e;--panel2:#1d2638;--ink:#e8edf6;--muted:#9aa6bd;--accent:#6ea8fe;--ok:#46d18e;--warn:#f5c451;--fail:#ff6b6b;--idle:#8a93a8;--prop:#b48cff;--line:#2a3550}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{background:var(--panel2);padding:.05em .35em;border-radius:4px;font-size:.9em}
.skip{position:absolute;left:-9999px;top:0;background:var(--accent);color:#000;padding:.6rem 1rem;z-index:100;border-radius:0 0 6px 0}
.skip:focus{left:0}
.topbar{position:sticky;top:0;z-index:10;background:linear-gradient(180deg,var(--panel),rgba(22,29,46,.92));backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:.9rem 1.2rem}
.topbar h1{margin:0;font-size:1.25rem}
.topbar .sub{color:var(--muted);font-size:.82rem;margin:.15rem 0 .6rem}
.toc{display:flex;flex-wrap:wrap;gap:.35rem .8rem;font-size:.85rem}
.toc a{color:var(--muted)}
.modebar{margin:.6rem 0 0;padding:.45rem .7rem;border-radius:6px;border:1px solid var(--line);background:var(--panel2);font-size:.83rem;display:flex;flex-wrap:wrap;gap:.4rem 1.2rem}
.modebar .live{color:var(--ok);font-weight:600}
.modebar .once{color:var(--warn);font-weight:600}
main{max-width:1280px;margin:0 auto;padding:1.2rem}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem;margin-bottom:1.2rem}
section>h2{margin-top:0;font-size:1.1rem;border-bottom:1px solid var(--line);padding-bottom:.4rem}
h3{font-size:.98rem;margin:.2rem 0 .5rem}
.goal,.muted{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem;margin:.4rem 0 .9rem}
.cards.small{grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}
.card{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.8rem}
.card .big{font-size:1.5rem;font-weight:700}
.card .label{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.card .sub{color:var(--muted);font-size:.75rem;margin-top:.15rem}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.15rem .8rem;margin:.4rem 0;font-size:.86rem}
.kv dt{color:var(--muted)}
.badge{display:inline-block;padding:.05em .5em;border-radius:10px;font-size:.72rem;font-weight:600;border:1px solid transparent;white-space:nowrap}
.badge.done{background:rgba(70,209,142,.16);color:var(--ok);border-color:rgba(70,209,142,.4)}
.badge.fail,.badge.failed{background:rgba(255,107,107,.16);color:var(--fail);border-color:rgba(255,107,107,.4)}
.badge.block,.badge.blocked{background:rgba(245,196,81,.16);color:var(--warn);border-color:rgba(245,196,81,.4)}
.badge.run{background:rgba(110,168,254,.16);color:var(--accent);border-color:rgba(110,168,254,.4)}
.badge.idle,.badge.pending,.badge.ready,.badge.expired,.badge.skip,.badge.skipped{background:rgba(138,147,168,.16);color:var(--idle);border-color:rgba(138,147,168,.4)}
.badge.prop,.badge.proposed{background:rgba(180,140,255,.16);color:var(--prop);border-color:rgba(180,140,255,.4)}
.badge.ok,.badge.active{background:rgba(70,209,142,.16);color:var(--ok);border-color:rgba(70,209,142,.4)}
.badge.mini{padding:.05em .4em;font-size:.66rem}
.warn{color:var(--warn)}
.tablewrap{overflow-x:auto;margin:.4rem 0}
table{border-collapse:collapse;width:100%;font-size:.84rem}
caption{caption-side:top;text-align:left;color:var(--muted);padding:.2rem 0 .5rem;font-size:.8rem}
th,td{text-align:left;padding:.4rem .55rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}
tr:hover td{background:rgba(110,168,254,.05)}
.chart{width:100%;height:auto;max-height:230px;display:block;background:var(--panel2);border-radius:6px;margin:.4rem 0}
.chart .axis{stroke:var(--line);stroke-width:1}
.chart .target{stroke:var(--warn);stroke-width:1;stroke-dasharray:4 3}
.chart .bar{fill:var(--accent)}
.chart .bar.best{fill:var(--warn)}
.chart .val{fill:var(--ink);font-size:9px}
.chart .val.gap{fill:var(--idle)}
.chart .axislbl{fill:var(--muted);font-size:8.5px}
.chart .delta{fill:var(--ok);font-size:8px}
.chart-summary{font-size:.82rem;color:var(--ink);background:var(--panel2);border-radius:6px;padding:.4rem .6rem;margin:.3rem 0}
.lanegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:.75rem;margin:.5rem 0}
.lane{background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.lanehead{background:rgba(110,168,254,.08);padding:.45rem .6rem;font-weight:700;font-size:.82rem;border-bottom:1px solid var(--line)}
.lanebody{list-style:none;padding:.55rem;margin:0;display:flex;flex-direction:column;gap:.45rem}
.lanegrid-branch .nodecard{min-width:unset;max-width:none}
.nodecard{background:var(--panel2);border:1px solid var(--line);border-left:4px solid var(--idle);border-radius:7px;padding:.5rem .6rem;min-width:130px;max-width:100%;font-size:.8rem}
.nodecard.done{border-left-color:var(--ok)}
.nodecard.fail,.nodecard.failed{border-left-color:var(--fail)}
.nodecard.block,.nodecard.blocked{border-left-color:var(--warn)}
.nodecard.run{border-left-color:var(--accent)}
.nodecard .nid{font-weight:600;word-break:break-word}
.nodecard .compactline{font-weight:700}
.nodecard .nrole,.nodecard .noutcome,.nodecard .nwho,.nodecard .nstatus,.nodecard .nlane,.nodecard .nlayer{color:var(--muted);font-size:.74rem;margin-top:.1rem}
.nodecard .artifact{margin-top:.2rem;font-size:.72rem;color:var(--accent)}
.edge-row{margin:.6rem 0 0;padding:.55rem .6rem;background:var(--panel2);border:1px solid var(--line);border-radius:8px;font-size:.78rem}
.edge-list{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.35rem}
.edge-pill{display:inline-block;padding:.2rem .45rem;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.pipeline{list-style:none;display:flex;flex-wrap:wrap;align-items:stretch;gap:.3rem;padding:0;margin:.4rem 0}
.arrow{align-self:center;color:var(--muted);font-size:1.1rem;padding:0 .15rem}
.messages{list-style:none;padding:0;margin:.4rem 0}
.thread{background:var(--panel2);border:1px solid var(--line);border-radius:8px;margin:.5rem 0;padding:.5rem .55rem}
.thread>summary{cursor:pointer}
.threadgroup{margin-top:.45rem}
.threadhead{color:var(--muted);font-size:.78rem;margin-bottom:.2rem}
.chipbar{display:flex;flex-wrap:wrap;gap:.35rem;margin:.35rem 0 .6rem}
.chip{display:inline-flex;align-items:center;gap:.25rem;padding:.15rem .45rem;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.03);font-size:.72rem;color:var(--ink)}
.msg{background:var(--panel2);border:1px solid var(--line);border-left:4px solid var(--idle);border-radius:6px;padding:.5rem .65rem;margin-bottom:.45rem}
.msg.done{border-left-color:var(--ok)}
.msg.fail,.msg.failed{border-left-color:var(--fail)}
.msg.run{border-left-color:var(--accent)}
.msg.block,.msg.blocked{border-left-color:var(--warn)}
.msghead{font-size:.8rem}
.msghead .from{color:var(--accent);font-weight:600}
.msghead .to{color:var(--prop);font-weight:600}
.msgmeta{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.2rem}
.msgsubj{font-size:.86rem;margin:.15rem 0}
.msgbody{white-space:pre-wrap;font-size:.74rem;max-height:160px;overflow:auto;margin:.3rem 0 0}
.reply{font-size:.76rem;color:var(--ok);margin-top:.2rem}
.msgid{font-size:.68rem;margin-top:.2rem}
.ev{font-size:.72rem;margin-right:.4rem}
.ev.ok{color:var(--ok)}
.ev.miss{color:var(--fail)}
.inspector{display:flex;flex-direction:column;gap:.6rem}
.inspectblock{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.7rem}
.inspector pre.raw,pre.msgbody,.artifacttext{background:#0b1018;border:1px solid var(--line);border-radius:6px;padding:.6rem;overflow:auto;font-size:.72rem;color:#cfe;white-space:pre-wrap}
details>summary{cursor:pointer;color:var(--accent);font-size:.82rem}
footer{color:var(--muted);font-size:.78rem;text-align:center;padding:1rem}
.totop{position:fixed;right:1rem;bottom:1rem;background:var(--accent);color:#000;padding:.4rem .7rem;border-radius:6px;font-size:.8rem}
body.compact .nodecard{padding:.4rem .5rem}
body.compact .nodecard .nrole,body.compact .nodecard .noutcome,body.compact .nodecard .nwho,body.compact .nodecard .nstatus,body.compact .nodecard .artifact{display:none}
@media(max-width:900px){main{padding:1rem .7rem}.cards{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}.lanegrid{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}}
@media(max-width:600px){.topbar{padding:.7rem .8rem}.toc{font-size:.78rem}.nodecard{min-width:100%;max-width:100%}.pipeline{flex-direction:column}.arrow{transform:rotate(90deg);align-self:flex-start}.lanegrid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
"""


def build_html(args, root, generated_at):
    ctx = {
        "root": root,
        "runs": W.load_runs(root),
        "memories": W.load_memories(root),
        "sessions": W.load_sessions(root),
        "contracts": W.load_all_contracts(root),
        "messages": W.load_messages_by_id(root),
        "swarm_id": W.load_swarm_id(root),
        "tasks": W.discover_tasks(root),
        "events": W.load_trace_tail(root, args.events),
    }
    mode = "live" if args.live else "once"
    mode_html = f'<span class="live">\u25cf LIVE</span> regenerating every {args.interval}s' if args.live else '<span class="once">ONE-SHOT</span> historical/completed review'
    meta_refresh = f'<meta http-equiv="refresh" content="{int(max(1,args.interval))}">' if args.live else ""
    focus = []
    if args.iteration: focus.append(f"iteration={args.iteration}")
    if args.task: focus.append(f"task={args.task}")
    if args.node: focus.append(f"node={args.node}")
    if args.run: focus.append(f"run={args.run}")
    if args.message: focus.append(f"message={args.message}")
    if args.memory: focus.append(f"memory={args.memory}")
    if args.artifact: focus.append(f"artifact={args.artifact}")
    focus_s = (" &middot; focus: " + ", ".join(focus)) if focus else ""
    lane_s = f" &middot; lanes={args.lanes}"
    compact_s = " &middot; compact" if args.compact else ""

    toc = [
        ("#overview", "Overview"), ("#iterations", "Metric improvement"),
        ("#graphs", "Node flow"), ("#conversation", "Conversation"),
        ("#memories", "Memories"), ("#inspector", "Inspector"),
        ("#runs", "Runs"), ("#events", "Events"),
    ]
    toc_html = " ".join(f'<a href="{h}">{esc(t)}</a>' for h, t in toc)

    parts = []
    parts.append("<!doctype html>")
    parts.append(f'<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">{meta_refresh}')
    parts.append(f'<title>Swarm dashboard \u2014 {esc(ctx["swarm_id"] or args.cwd)}</title>')
    parts.append(f"<style>{CSS}</style></head><body class=\"{'compact' if args.compact else ''}\">")
    parts.append('<a class="skip" href="#main">Skip to content</a>')
    parts.append('<header class="topbar">')
    parts.append('<h1>Swarm dashboard</h1>')
    parts.append(f'<div class="sub">swarm <code>{esc(ctx["swarm_id"] or "-")}</code> &middot; cwd <code>{esc(args.cwd)}</code>{lane_s}{compact_s}{focus_s}</div>')
    parts.append(f'<nav class="toc" aria-label="Sections">{toc_html}</nav>')
    parts.append(f'<div class="modebar" role="status" aria-live="polite">Mode: {mode_html} &middot; generated <time>{esc(generated_at)}</time></div>')
    parts.append('</header>')
    parts.append('<main id="main">')
    parts.append('<section id="overview"><h2>Overview</h2>' + render_overview(ctx, args) + '</section>')
    parts.append('<section id="iterations"><h2>Per-iteration metric improvement</h2>' + render_iterations(ctx, args) + '</section>')
    parts.append('<section id="graphs"><h2>Task graph node flow</h2>' + render_graphs(ctx, args) + '</section>')
    parts.append('<section id="conversation"><h2>Agent conversation</h2>' + render_conversation(ctx, args) + '</section>')
    parts.append('<section id="memories"><h2>Memory &amp; evidence</h2>' + render_memories(ctx, args) + '</section>')
    parts.append('<section id="inspector"><h2>Inspector / raw details</h2>' + render_inspector(ctx, args) + '</section>')
    parts.append('<section id="runs"><h2>Recent runs</h2>' + render_runs(ctx, args) + '</section>')
    parts.append('<section id="events"><h2>Recent trace events</h2>' + render_events(ctx, args) + '</section>')
    parts.append('</main>')
    parts.append('<footer>Generated by <code>scripts/swarm_dashboard.sh</code> \u2014 static, dependency-free, read-only.</footer>')
    parts.append('<a class="totop" href="#main">Top</a>')
    parts.append("</body></html>")
    return "\n".join(parts)


# --------------------------------------------------------------- main
def parse_args(argv):
    p = argparse.ArgumentParser(prog="swarm_dashboard", description="Static HTML dashboard for .pi/swarm state (dependency-free).")
    cwd_default = os.environ.get("WATCH_CWD", ".")
    p.add_argument("--cwd", default=cwd_default, help=f"swarm cwd (default {cwd_default!r}; env WATCH_CWD)")
    p.add_argument("--out", default=None, help="write HTML to FILE (default: stdout for --once; swarm-dashboard.html for --live)")
    p.add_argument("--once", action="store_true", help="generate once and exit (default when --live not given)")
    p.add_argument("--live", action="store_true", help="regenerate the dashboard in a loop every --interval seconds")
    p.add_argument("--interval", type=float, default=3.0, help="live regeneration interval seconds (default 3)")
    p.add_argument("--lanes", choices=("role", "branch", "none"), default="role", help="task graph lane mode (default role)")
    p.add_argument("--compact", action="store_true", help="collapse node cards to compact chips")
    p.add_argument("--iteration", default=None, help="focus one iteration session id")
    p.add_argument("--task", default=None, help="focus one task graph id")
    p.add_argument("--node", default=None, help="focus one task node id (requires --task)")
    p.add_argument("--run", default=None, help="focus one run id (inspector)")
    p.add_argument("--message", default=None, help="focus one message id (inspector)")
    p.add_argument("--memory", default=None, help="focus one memory id (inspector)")
    p.add_argument("--artifact", default=None, help="focus one artifact path (inspector)")
    p.add_argument("--messages", default="20", help="messages per task in the conversation view: N (default 20)")
    p.add_argument("--tasks-limit", type=int, default=6, help="task graphs to show in flow/conversation (default 6)")
    p.add_argument("--runs", type=int, default=10, help="recent runs to show (default 10)")
    p.add_argument("--events", type=int, default=15, help="recent trace events to show (default 15)")
    return p.parse_args(argv)


def _generate_once(args, root, out_path, generated_at):
    html_doc = build_html(args, root, generated_at)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html_doc + "\n")
        return f"wrote {len(html_doc)} bytes to {out_path}\n"
    return html_doc + "\n"


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        args.messages_limit = int(args.messages)
    except Exception:
        args.messages_limit = 20
    root = W.state_root(args.cwd)
    generated_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

    if args.live:
        out_path = args.out or "swarm-dashboard.html"
        print(f"[swarm_dashboard] LIVE: regenerating {out_path} every {args.interval}s (Ctrl-C to stop)", file=sys.stderr)

        class _Stop(Exception):
            pass

        def _on_term(_s, _f):
            raise _Stop()

        try:
            signal.signal(signal.SIGTERM, _on_term)
        except (ValueError, OSError):
            pass
        try:
            while True:
                msg = _generate_once(args, root, out_path, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()))
                sys.stderr.write(f"[swarm_dashboard] {msg.strip()} @ {time.strftime('%H:%M:%S')}\n")
                sys.stderr.flush()
                time.sleep(max(0.2, args.interval))
        except (KeyboardInterrupt, _Stop):
            sys.stderr.write("\n[swarm_dashboard] stopped\n")
            return 0
        return 0

    # once
    out_path = args.out
    sys.stdout.write(_generate_once(args, root, out_path, generated_at))
    return 0


if __name__ == "__main__":
    sys.exit(main())
