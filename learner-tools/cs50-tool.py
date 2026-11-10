#!/usr/bin/env python3
"""Meander tool: drive the CS50 problem-set grader (check50 / style50).

stdin: one cs50 subcommand line, e.g. "start mario-less", "check mario-less".

Subcommands
    list                 the problems of the course + which are set up locally
    start <problem>      create the problem's folder (starter files) and print its task
    task <problem>       print the problem's task (README)
    check <problem>      grade the learner's work with check50 --local ([ok]/[FAIL] per check)
    style <problem>      run style50 on the problem's source file
    submit-info <problem>  print the submit50 command (the learner submits; nothing is auto-submitted)
    doctor               report what is missing (check50 / style50 / libcs50 / compiler)
    setup                install the missing pieces (no sudo, user-local)

Academic honesty: this tool NEVER submits. `submit-info` only prints the
command the learner runs himself.

The tool is deliberately dumb: it reads the course catalogue the app writes
into the workspace root, creates folders, and shells out to check50/style50.
Everything else (the plan, the lessons, the hints) belongs to the tutor.
"""
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys

ALLOWED = {"list", "start", "task", "check", "style", "submit-info", "doctor", "setup"}

HOME = pathlib.Path(os.path.expanduser("~"))
ENV_FILE = HOME / ".config" / "meander" / "cs50" / "env"
SHIM_DIR = HOME / ".local" / "share" / "meander" / "cs50" / "bin"


def workspace_root() -> pathlib.Path:
    """Where the problem folders live (the app's setting; ~/cs50 by default)."""
    raw = os.environ.get("LH_WORKSPACE_ROOT", "").strip()
    root = pathlib.Path(os.path.expanduser(raw)) if raw else HOME / "cs50"
    return root


def load_env() -> dict:
    """The toolchain environment: the user's shell plus the app's env file.

    The env file (written by setup-cs50.sh) carries LIBRARY_PATH /
    C_INCLUDE_PATH / LD_LIBRARY_PATH for libcs50 and the PATH entries for
    check50/style50 — the app's compile step reads the same file, so the
    in-app build and the grader agree.
    """
    env = dict(os.environ)
    if ENV_FILE.exists():
        try:
            for line in ENV_FILE.read_text().splitlines():
                line = line.strip()
                if line.startswith("export "):
                    line = line[len("export "):]
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                value = os.path.expandvars(os.path.expanduser(value))
                if key == "PATH":
                    # PATH entries are PREPENDED, never a replacement: the
                    # learner's own PATH must survive the toolchain's.
                    existing = env.get("PATH", "")
                    env[key] = f"{value}:{existing}" if existing else value
                else:
                    env[key] = value
        except OSError:
            pass
    # check50 compiles with a hardcoded `clang`; on a box without clang the
    # shim (setup-cs50.sh) points it at gcc.
    env["PATH"] = f"{SHIM_DIR}:{env.get('PATH', '')}"
    return env


def catalogue() -> dict:
    """The course catalogue the app writes into the workspace root."""
    path = workspace_root() / "catalogue.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def problems() -> list:
    items = catalogue().get("problems")
    return items if isinstance(items, list) else []


def find_problem(name: str):
    """Resolve a problem reference: a catalogue id, a slug, or a folder path."""
    key = name.strip().strip("/")
    if not key:
        return None
    flat = re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")
    for problem in problems():
        pid = str(problem.get("id", ""))
        slug = str(problem.get("slug", ""))
        if key in (pid, slug) or flat == re.sub(r"[^a-z0-9]+", "-", pid.lower()).strip("-"):
            return problem
        if flat and flat in re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-"):
            return problem
    path = pathlib.Path(os.path.expanduser(name))
    if path.is_dir():
        return {"id": path.name, "title": path.name, "folder": path.name, "path": str(path)}
    return None


def problem_dir(problem: dict) -> pathlib.Path:
    if problem.get("path"):
        return pathlib.Path(problem["path"])
    folder = problem.get("folder") or problem.get("id")
    return workspace_root() / str(folder)


def problem_files(problem: dict) -> dict:
    files = problem.get("files")
    return files if isinstance(files, dict) else {}


def read_task(problem: dict) -> str:
    readme = problem.get("readme")
    if isinstance(readme, str) and readme.strip():
        return readme
    path = problem_dir(problem) / "README.md"
    try:
        return path.read_text()
    except OSError:
        return ""


def run(cmd: list, cwd=None, timeout=600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=load_env(), timeout=timeout)


def cmd_list() -> int:
    items = problems()
    if not items:
        print(f"no problems in the catalogue ({workspace_root() / 'catalogue.json'})")
        print("open the course in Meander and set it up once, then try again")
        return 0
    for problem in items:
        directory = problem_dir(problem)
        state = "set up" if directory.exists() else "not started"
        print(f"[{state}] {problem.get('id')}: {problem.get('title')} ({problem.get('slug', '')})")
    return 0


def cmd_start(name: str) -> int:
    problem = find_problem(name)
    if not problem:
        print(f"unknown problem: {name}")
        print(f"known: {', '.join(str(p.get('id')) for p in problems())}")
        return 1
    directory = problem_dir(problem)
    directory.mkdir(parents=True, exist_ok=True)
    written = []
    for filename, content in problem_files(problem).items():
        target = directory / filename
        if target.exists():
            continue  # never overwrite the learner's work
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content if isinstance(content, str) else str(content))
        written.append(filename)
    print(f"ready: {directory}")
    if written:
        print(f"created: {', '.join(written)}")
    else:
        print("(the folder already had the files — nothing overwritten)")
    task = read_task(problem)
    if task:
        print("")
        print(task)
    return 0


def cmd_task(name: str) -> int:
    problem = find_problem(name)
    if not problem:
        print(f"unknown problem: {name}")
        return 1
    task = read_task(problem)
    if not task:
        print(f"no task text for {name} — open it in Meander once to fetch the spec")
        return 1
    print(task)
    return 0


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


def format_check_results(data: dict) -> str:
    """check50's JSON results as [ok]/[FAIL] lines — what the tutor reads.

    A failure carries its cause (the grader's own words about what went
    wrong), which is what the coach needs: the failing check's name
    alone never says WHY it failed."""
    results = data.get("results")
    lines = []
    passed = 0
    for check in results if isinstance(results, list) else []:
        if not isinstance(check, dict):
            continue
        ok = bool(check.get("passed"))
        passed += 1 if ok else 0
        description = str(check.get("description") or check.get("name") or "?").strip()
        lines.append(f"[{'ok' if ok else 'FAIL'}] {description}")
        if not ok:
            cause = check.get("cause")
            if isinstance(cause, dict):
                # check50's cause carries the grader's own words
                # ("rationale"), sometimes with a "help" hint.
                parts = [str(cause[key]).strip() for key in ("rationale", "message", "help") if cause.get(key)]
                cause = " — ".join(parts) if parts else json.dumps(cause)
            if cause:
                lines.append(f"        {str(cause).strip()}")
    total = len(results) if isinstance(results, list) else 0
    lines.append(f"{passed}/{total} checks passed")
    return "\n".join(lines)


def cmd_check(name: str) -> int:
    problem = find_problem(name)
    if not problem:
        print(f"unknown problem: {name}")
        return 1
    directory = problem_dir(problem)
    if not directory.exists():
        print(f"not started: {directory} does not exist — run 'start {name}' first")
        return 1
    slug = str(problem.get("slug", ""))
    if not slug:
        print(f"no check50 slug recorded for {name} — open it in Meander once to fetch the spec")
        return 1
    if not shutil_which("check50"):
        print("check50 is not installed. Run the 'setup' subcommand (no sudo needed), then try again.")
        return 1
    # check50's runner uses multiprocessing; Python 3.14's default start
    # method (forkserver) breaks its worker handoff, so force 'fork'.
    # The JSON output is the machine-readable one: the plain output is a
    # picture of a smiley, which no coach can read.
    code = (
        "import multiprocessing,sys,runpy;"
        "multiprocessing.set_start_method('fork',force=True);"
        f"sys.argv=['check50','--local',{slug!r},'-o','json'];"
        "runpy.run_module('check50',run_name='__main__')"
    )
    result = run(["python3", "-c", code], cwd=str(directory))
    try:
        data = json.loads((result.stdout or "").strip())
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("results"), list):
        print(format_check_results(data))
        return 0 if all(check.get("passed") for check in data["results"]) else 1
    # No JSON (an older check50, or a crash): the plain output still says
    # something useful.
    output = strip_ansi((result.stdout or "") + (result.stderr or ""))
    print(output.strip() or "(check50 produced no output)")
    return result.returncode


def cmd_style(name: str) -> int:
    problem = find_problem(name)
    if not problem:
        print(f"unknown problem: {name}")
        return 1
    directory = problem_dir(problem)
    if not directory.exists():
        print(f"not started: {directory} does not exist — run 'start {name}' first")
        return 1
    if not shutil_which("style50"):
        print("style50 is not installed. Run the 'setup' subcommand (no sudo needed), then try again.")
        return 1
    source = str(problem.get("file") or "")
    if not source:
        candidates = sorted(p.name for p in directory.iterdir() if p.suffix in (".c", ".py", ".sql"))
        source = candidates[0] if candidates else ""
    if not source:
        print(f"no source file to style in {directory}")
        return 1
    result = run(["style50", source], cwd=str(directory))
    print(((result.stdout or "") + (result.stderr or "")).strip() or "(style50 produced no output)")
    return result.returncode


def cmd_submit_info(name: str) -> int:
    problem = find_problem(name)
    if not problem:
        print(f"unknown problem: {name}")
        return 1
    slug = str(problem.get("slug", ""))
    if not slug:
        print(f"no submit slug recorded for {name}")
        return 1
    print(f"submit it yourself, from the problem folder:")
    print(f"    submit50 {slug}")
    print("(this tool never submits for you — the submission is yours)")
    return 0


def shutil_which(name: str) -> str:
    for entry in load_env().get("PATH", "").split(os.pathsep):
        candidate = pathlib.Path(entry) / name
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return ""


def cmd_doctor() -> int:
    env = load_env()
    print(f"workspace: {workspace_root()}")
    print(f"check50:   {shutil_which('check50') or 'MISSING'}")
    print(f"style50:   {shutil_which('style50') or 'MISSING'}")
    print(f"compiler:  {shutil_which('cc') or shutil_which('gcc') or 'MISSING'}")
    header = pathlib.Path(HOME / ".local" / "include" / "cs50.h")
    print(f"libcs50:   {header if header.exists() else 'MISSING'}")
    print(f"clang shim:{(SHIM_DIR / 'clang')} {'' if (SHIM_DIR / 'clang').exists() else 'MISSING'}")
    print(f"LIBRARY_PATH={env.get('LIBRARY_PATH', '')}")
    if not shutil_which("check50") or not header.exists():
        print("")
        print("run the 'setup' subcommand to install what is missing (no sudo)")
    return 0


def cmd_setup() -> int:
    script = pathlib.Path(__file__).resolve().parent / "setup-cs50.sh"
    if not script.exists():
        print(f"the setup script is missing: {script}")
        return 1
    print(f"running {script} (no sudo; everything lands in your home directory)")
    result = subprocess.run(["bash", str(script)], capture_output=True, text=True, env=load_env())
    print((result.stdout or "") + (result.stderr or ""))
    return result.returncode


def main() -> int:
    args = shlex.split(sys.stdin.read().strip() or "list")
    if args and args[0] == "cs50":
        args = args[1:]
    if not args or args[0] not in ALLOWED:
        sys.exit(f"allowed: {' '.join(sorted(ALLOWED))}")
    command, rest = args[0], args[1:]
    if command in ("list", "doctor", "setup"):
        return cmd_list() if command == "list" else (cmd_doctor() if command == "doctor" else cmd_setup())
    if not rest:
        sys.exit(f"{command} needs a problem: {command} <problem>")
    name = rest[0]
    if command == "start":
        return cmd_start(name)
    if command == "task":
        return cmd_task(name)
    if command == "check":
        return cmd_check(name)
    if command == "style":
        return cmd_style(name)
    if command == "submit-info":
        return cmd_submit_info(name)
    sys.exit(f"allowed: {' '.join(sorted(ALLOWED))}")


if __name__ == "__main__":
    sys.exit(main())
