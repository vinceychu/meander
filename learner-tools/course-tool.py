#!/usr/bin/env python3
"""Meander tool: drive a course's problem-set grader.

stdin: one course subcommand line, e.g. "start mario-less", "check mario-less".

Subcommands
    list                 the problems of the course + which are set up locally
    start <problem>      create the problem's folder (starter files) and print its task
    task <problem>       print the problem's task (README)
    check <problem>      grade the learner's work ([ok]/[FAIL] per check)
    style <problem>      run style50 on the problem's source file (CS50 courses)
    submit-info <problem>  print the submit50 command (the learner submits; nothing is auto-submitted)
    doctor               report the toolchain, per language
    setup                install the missing pieces (no sudo, user-local)

The grader depends on the COURSE: a CS50 problem is graded with check50, a
course that ships its own autograder (the `ok` client) or its own test
suite (pytest / npm test / make test / cargo test / go test) is graded with
that, and a problem with no grader at all is reported as such — the tutor
reviews it inside Meander.

THE SANDBOX: the course's OWN code — its test suite, its `ok` client —
runs inside the same sandbox the app's Check button uses (the plan in
core/cli-tools.ts): the filesystem is read-only except the problem's own
folder, and there is no network. A course's `.env` may only set the import
paths a vendored test suite needs (PYTHONPATH, NODE_PATH) — never PATH,
never LD_PRELOAD: a course's files are DATA, and data does not get to
change how the grader runs. The learner's own check50 is NOT run this way:
it fetches its checks over the network, and it is the learner's own
installed tool.

Academic honesty: this tool NEVER submits. `submit-info` only prints the
command the learner runs himself.

The tool is deliberately dumb: it reads the course catalogue the app writes
into the workspace root, creates folders, and shells out to the course's
own grader. Everything else (the plan, the lessons, the hints) belongs to
the tutor.
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

# The variables a course's own `.env` may set: the import paths a vendored
# test suite needs, and nothing else. Same allowlist as the app's
# (src/server/toolchain.ts).
COURSE_ENV_ALLOWLIST = {"NODE_PATH", "PYTHONPATH"}


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
    """Every problem of every course on disk (the catalogue's flat list is
    the fallback, for a catalogue written before the app taught it courses)."""
    data = catalogue()
    courses = data.get("courses")
    if isinstance(courses, list) and courses:
        out = []
        for course in courses:
            if not isinstance(course, dict):
                continue
            items = course.get("problems")
            if not isinstance(items, list):
                continue
            for problem in items:
                if isinstance(problem, dict):
                    entry = dict(problem)
                    entry.setdefault("courseId", course.get("courseId", ""))
                    entry.setdefault("courseTitle", course.get("courseTitle", ""))
                    out.append(entry)
        return out
    items = data.get("problems")
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


def grader_of(problem: dict) -> str:
    """How this problem is graded (the catalogue says; the shape implies)."""
    stated = str(problem.get("grader", "")).strip()
    if stated:
        return stated
    if problem.get("slug"):
        return "check50"
    if problem.get("graderCommand"):
        return "tests"
    return "none"


def run(cmd: list, cwd=None, timeout=600, env=None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env or load_env(), timeout=timeout)


def read_env_file(folder: pathlib.Path) -> dict:
    """The variables a course's own `.env` file may set.

    CS61A's lab sets `PYTHONPATH=.grader` so the pytest it vendors is
    importable — without it the course's own test suite cannot even start.

    Only the ALLOWLISTED keys are read: a course's `.env` is data the
    course shipped, and data must not be able to change how the grader
    runs (no PATH, no LD_PRELOAD, no LD_LIBRARY_PATH)."""
    out = {}
    try:
        text = (folder / ".env").read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key in COURSE_ENV_ALLOWLIST:
            out[key] = value
    return out


def sandbox_plan(platform: str, command: str, args: list, writable: list, cwd: str):
    """The confinement the app's Check button uses (core/cli-tools.ts).

    The course's OWN code runs inside it: the filesystem is read-only
    except the problem's folder, and there is no network. Returns the argv
    to run, or None when this platform has no sandbox (the caller then
    refuses to run — a sandbox that is missing is reported, never
    bypassed)."""
    if platform == "linux":
        argv = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]
        for directory in writable:
            argv += ["--bind", directory, directory]
        argv += ["--unshare-all", "--die-with-parent", "--new-session", "--chdir", cwd, "--", command, *args]
        return argv
    if platform == "darwin":
        subs = " ".join(f'(subpath {json.dumps(d)})' for d in [*writable, "/private/tmp", "/private/var/folders"])
        profile = (
            "(version 1)"
            "(allow default)"
            "(deny network*)"
            "(deny file-write*)"
            f'(allow file-write* {subs} (literal "/dev/null") (literal "/dev/tty"))'
        )
        return ["/usr/bin/sandbox-exec", "-p", profile, command, *args]
    return None


def cmd_list() -> int:
    items = problems()
    if not items:
        print(f"no problems in the catalogue ({workspace_root() / 'catalogue.json'})")
        print("open the course in Meander and set it up once, then try again")
        return 0
    for problem in items:
        directory = problem_dir(problem)
        state = "set up" if directory.exists() else "not started"
        course = problem.get("courseTitle") or problem.get("courseId") or ""
        course_part = f" [{course}]" if course else ""
        print(
            f"[{state}] {problem.get('id')}: {problem.get('title')} "
            f"({problem.get('slug', '')}){course_part} — graded by {grader_of(problem)}"
        )
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


def pytest_failure_details(output: str) -> dict:
    """The "E   assert ..." lines pytest prints under FAILURES, by test name.

    The per-test line says THAT a test failed; the "E   ..." line says WHY.
    The coach needs the second one."""
    details = {}
    lines = output.split("\n")
    start = next((i for i, line in enumerate(lines) if re.search(r"=+\s*FAILURES\s*=+", line)), -1)
    if start < 0:
        return details
    name = ""
    block = []

    def flush():
        if not name:
            return
        causes = [line.strip() for line in block if re.match(r"^\s*E\s+\S", line)]
        if causes:
            details[name] = " ".join(causes)

    for line in lines[start + 1:]:
        if re.search(r"={3,}.*={3,}", line) and not re.match(r"^\s*E\s", line):
            flush()
            break
        header = re.match(r"^_{2,}\s*(.+?)\s*_{2,}$", line.strip())
        if header:
            flush()
            name = header.group(1).strip()
            block = []
            continue
        block.append(line)
    flush()
    return details


def parse_test_output(output: str) -> list:
    """A test runner's output as (ok, name, cause) triples.

    The runners disagree about everything except the shape of a failure, so
    the patterns are matched one by one: pytest's PASSED/FAILED, cargo's
    "test x ... ok", go's "--- PASS:", the TAP lines node's test runner
    prints, and the check marks jest and vitest print."""
    checks = []
    details = pytest_failure_details(output)
    for raw in output.split("\n"):
        text = raw.strip()
        if not text:
            continue
        # pytest prints these in CAPS; a lowercase "passed" is its summary
        # line, not a test.
        match = re.match(r"^(.+?)\s+(PASSED|FAILED|ERROR|XFAIL|XPASS)\b", text)
        if match:
            ok = match.group(2) in ("PASSED", "XPASS")
            name = match.group(1).strip()
            cause = details.get(name.split("::")[-1]) or text
            checks.append((ok, name, "" if ok else cause))
            continue
        match = re.match(r"^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\b", text, re.IGNORECASE)
        if match:
            ok = match.group(2).lower() == "ok"
            checks.append((ok, match.group(1).strip(), "" if ok else text))
            continue
        match = re.match(r"^---\s+(PASS|FAIL|SKIP):\s*(.+?)(?:\s+\([^)]*\))?$", text, re.IGNORECASE)
        if match:
            ok = match.group(1).upper() == "PASS"
            checks.append((ok, match.group(2).strip(), "" if ok else text))
            continue
        match = re.match(r"^(not )?ok\b\s*(\d+)?\s*(?:[-–]\s*)?(.*)$", text, re.IGNORECASE)
        if match:
            ok = not match.group(1)
            name = (match.group(3) or "").strip() or f"check {match.group(2) or len(checks) + 1}"
            checks.append((ok, name, "" if ok else text))
            continue
        match = re.match(r"^(✓|✔|√)\s+(.+)$", text)
        if match:
            checks.append((True, match.group(2).strip(), ""))
            continue
        match = re.match(r"^(✕|✗|×|✘)\s+(.+)$", text)
        if match:
            checks.append((False, match.group(2).strip(), text))
            continue
    return checks


def format_test_output(output: str, exit_code: int) -> str:
    """A test runner's output as [ok]/[FAIL] lines."""
    checks = parse_test_output(output)
    lines = []
    for ok, name, cause in checks:
        lines.append(f"[{'ok' if ok else 'FAIL'}] {name}")
        if not ok and cause and cause != name:
            lines.append(f"        {cause}")
    passed = sum(1 for ok, _, _ in checks if ok)
    if not checks:
        # No per-test lines: the run itself is the one check.
        lines.append("[ok] the course's own checks" if exit_code == 0 else "[FAIL] the course's own checks")
        passed = 1 if exit_code == 0 else 0
        total = 1
    else:
        total = len(checks)
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
    kind = grader_of(problem)

    if kind == "check50":
        slug = str(problem.get("slug", ""))
        if not slug:
            print("no check50 slug recorded for this problem — open it in Meander once to fetch the spec")
            return 1
        if not shutil_which("check50"):
            print("check50 is not installed. Run the 'setup' subcommand (no sudo needed), then try again.")
            return 1
        # check50's runner uses multiprocessing; Python 3.14's default start
        # method (forkserver) breaks its worker handoff, so force 'fork'.
        # The JSON output is the machine-readable one: the plain output is a
        # picture of a smiley, which no coach can read.
        # check50 is NOT sandboxed: it fetches its checks over the network,
        # and it is the learner's own installed tool (Harvard's), not code
        # a course handed out.
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

    if kind in ("autograder", "tests"):
        command = str(problem.get("graderCommand", "")).strip()
        if not command:
            print(f"no grader command recorded for {name} — open it in Meander once to fetch the spec")
            return 1
        argv = shlex.split(command)
        if not argv:
            print(f"no grader command recorded for {name}")
            return 1
        if not shutil_which(argv[0]):
            print(f"{argv[0]} is not installed on this machine — the doctor subcommand says what is missing")
            return 1
        # The grader runs where the course's code lives (a course that hands
        # its lab out in a subfolder grades inside it), with the course's own
        # environment (its `.env` sets the PYTHONPATH its vendored pytest
        # needs — and nothing else, see the allowlist).
        work_dir = directory
        sub = str(problem.get("graderWorkDir", "")).strip().strip("/")
        if sub and (directory / sub).is_dir():
            work_dir = directory / sub
        env = load_env()
        env.update(read_env_file(work_dir))
        # The course's OWN code runs inside the SAME sandbox the app's Check
        # button uses (core/cli-tools.ts `sandboxedCommand`): no network, and
        # the filesystem read-only except the problem's own folder.
        plan = sandbox_plan(sys.platform, argv[0], argv[1:], [str(directory)], str(work_dir))
        if plan is None:
            print(f"not run: no sandbox is available on {sys.platform} — the course's own code runs sandboxed.")
            return 1
        try:
            result = run(plan, cwd=str(work_dir), env=env)
        except (FileNotFoundError, NotADirectoryError):
            print(
                "not run: the sandbox launcher is missing — install bubblewrap on Linux "
                "(or run the problem in VS Code instead)."
            )
            return 1
        output = strip_ansi((result.stdout or "") + (result.stderr or ""))
        print(format_test_output(output, result.returncode))
        return 0 if result.returncode == 0 else 1

    if kind == "ai-rubric":
        print("this problem has no autograder — it is reviewed against the assignment's rubric")
        print("in Meander (press Check, or ask the tutor to grade it)")
        print("AI-reviewed, not an official autograder")
        return 1

    print("this problem has no autograder — the course ships none for it")
    print("read the spec and answer in the chat")
    return 1


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
    """The toolchain, per language — what each course's problems need."""
    env = load_env()
    print(f"workspace: {workspace_root()}")
    print("")
    print("CS50 (check50 / style50 / libcs50):")
    print(f"  check50:   {shutil_which('check50') or 'MISSING'}")
    print(f"  style50:   {shutil_which('style50') or 'MISSING'}")
    header = pathlib.Path(HOME / ".local" / "include" / "cs50.h")
    print(f"  libcs50:   {header if header.exists() else 'MISSING'}")
    print(f"  clang shim:{(SHIM_DIR / 'clang')} {'' if (SHIM_DIR / 'clang').exists() else 'MISSING'}")
    print("")
    print("languages:")
    print(f"  gcc:       {shutil_which('gcc') or shutil_which('cc') or 'MISSING'}")
    print(f"  g++:       {shutil_which('g++') or 'MISSING'}")
    print(f"  clang:     {shutil_which('clang') or 'MISSING'}")
    print(f"  python3:   {shutil_which('python3') or 'MISSING'}")
    print(f"  pytest:    {shutil_which('pytest') or 'MISSING (pip install --user pytest)'}")
    print(f"  node:      {shutil_which('node') or 'MISSING'}")
    print(f"  npm:       {shutil_which('npm') or 'MISSING'}")
    print(f"  sqlite3:   {shutil_which('sqlite3') or 'MISSING'}")
    print(f"  go:        {shutil_which('go') or 'MISSING'}")
    print(f"  rustc:     {shutil_which('rustc') or 'MISSING'}")
    print(f"  git:       {shutil_which('git') or 'MISSING'}")
    print("")
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
    if args and args[0] in ("cs50", "course"):
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
