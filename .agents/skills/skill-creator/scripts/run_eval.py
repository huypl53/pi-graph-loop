#!/usr/bin/env python3
"""Run trigger evaluation for a skill description (pi-native).

Tests whether a skill's description causes the pi agent to trigger — i.e. to
`read` the skill's SKILL.md — for a set of queries. Each query runs in an
isolated pi invocation: `pi --no-skills --skill <temp-skill>` loads ONLY the
candidate skill (description in the available-skills list, body on demand),
and we detect triggering by a `read` tool event on that SKILL.md.

Outputs results as JSON.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.utils import parse_skill_md


def find_project_root() -> Path:
    """Return cwd. Kept for API compatibility with run_loop.py (pi mode does
    not inject anything into the project tree, unlike the old Claude path)."""
    return Path.cwd()


def _env_provider(provider: str | None) -> str | None:
    return provider or os.environ.get("PI_PROVIDER")


def _env_model(model: str | None) -> str | None:
    return model or os.environ.get("PI_MODEL")


def _write_temp_skill(skill_name: str, skill_description: str) -> tuple[Path, Path]:
    """Create an isolated temp skill dir whose SKILL.md carries the candidate
    description. The body is a placeholder — triggering depends only on the
    description pi lists in available-skills, not the body."""
    tmp = Path(tempfile.mkdtemp(prefix=f"pitrigger_{skill_name}_"))
    sdir = tmp / skill_name
    sdir.mkdir()
    skill_md = sdir / "SKILL.md"
    indented = "\n".join("  " + line for line in skill_description.split("\n"))
    skill_md.write_text(
        f"---\n"
        f"name: {skill_name}\n"
        f"description: >-\n{indented}\n"
        f"---\n\n"
        f"# {skill_name}\n\n"
        f"(Skill body — loaded on demand when triggered.)\n"
    )
    return tmp, skill_md


def _path_matches_skill(p: str, skill_md: Path, tmp: Path) -> bool:
    """True if read-target path `p` is this query's SKILL.md."""
    if not p:
        return False
    try:
        if os.path.exists(p) and os.path.samefile(p, skill_md):
            return True
    except (OSError, ValueError):
        pass
    # Fallback: same temp dir + ends with SKILL.md
    return p.endswith("SKILL.md") and tmp.name in p


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str | None = None,
    model: str | None = None,
    provider: str | None = None,
) -> bool:
    """Run one query through pi and report whether the agent read the SKILL.md.

    Isolation: `--no-skills` disables all skill discovery; `--skill <dir>`
    re-adds only the candidate skill. The agent sees only this skill's
    description in available-skills and decides whether to `read` it.
    """
    tmp, skill_md = _write_temp_skill(skill_name, skill_description)
    cmd = [
        "pi",
        "--no-extensions",
        "--no-skills",
        "--skill", str(tmp / skill_name),
    ]
    prov = _env_provider(provider)
    mdl = _env_model(model)
    if prov:
        cmd += ["--provider", prov]
    if mdl:
        cmd += ["--model", mdl]
    cmd += ["--mode", "json", "-p", query]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=dict(os.environ),
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    triggered = False
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "tool_execution_start" and ev.get("toolName") == "read":
            args = ev.get("args") or {}
            if _path_matches_skill(str(args.get("path", "")), skill_md, tmp):
                triggered = True
                break
    return triggered


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path | None = None,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    provider: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root) if project_root else None,
                    model,
                    provider,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description (pi)")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=60, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="pi model id (default: $PI_MODEL)")
    parser.add_argument("--provider", default=None, help="pi provider (default: $PI_PROVIDER)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description[:80]}...", file=sys.stderr)
        print(f"Provider={_env_provider(args.provider)} Model={_env_model(args.model)}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
        provider=args.provider,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
