# Learner tools

Tools the app ships for the learner, installed into the data dir
(`~/.config/LearnHarness/data/tools/`) on first run. Each tool is a JSON
manifest (the agent sees it as `cli_<name>`) plus the program it runs —
the same shape as the learner's own tools, so a user-installed tool and a
shipped one are indistinguishable to the agent.

| tool | manifest | program | what it does |
|---|---|---|---|
| `course` | `course.json` | `course-tool.py` | grades a course's problem sets — any course, not just CS50 |
| `cs50` | `cs50.json` | `cs50-tool.py` | an alias of `course`, kept for compatibility |

Both manifests are `default: true`, so every session can call the grader.
`cs50-tool.py` is a one-line shim over `course-tool.py`; the old name
keeps working (the app's `cli_cs50` tool, and any script that ran it).

## course

The course's problem sets. The grader is the COURSE's own — `check50
--local` for the CS50 family, the course's autograder or test suite for
everything else, and an honest "no autograder" when the course ships none.
Whatever it is, it prints one `[ok]` / `[FAIL]` line per requirement, and
the tutor coaches from those lines.

```
list                 the problems of the course and which are set up locally
start <problem>      create the problem's folder (starter files) and print its task
task <problem>       print the problem's task
check <problem>      grade the learner's work ([ok]/[FAIL] per requirement)
style <problem>      run style50 on the problem's source file (CS50 courses)
submit-info <problem>  print the submit50 command — the learner submits himself
doctor               report the toolchain per language
setup                install the CS50 toolchain — no sudo, everything in $HOME
```

`check` dispatches on the problem's grader, which the app writes into the
catalogue: `check50` (the CS50 family), `autograder` (`python3 ok --local`
— the CS61A client and the like), `tests` (`pytest`, `npm test`,
`make test`, `cargo test`, `go test`), or `ai-rubric` / `none` (the
course ships no autograder — the tool says so instead of pretending).

The grader runs WHERE the course's code lives: a course that hands its lab
out in a subfolder (`lab01/`) grades inside that subfolder, not beside it.
It also runs with the course's own environment — the `.env` file a lab
ships (`PYTHONPATH=.grader`, which is how CS61A's vendored pytest becomes
importable) is read and applied to the run. The catalogue carries both
(`graderCommand`, `graderWorkDir`), so the tool and the app's Check button
always run the same command in the same place.

### doctor

`doctor` reports the toolchain per language, so a missing compiler is
reported instead of guessed at:

```
gcc / g++      C and C++
clang          what check50 compiles with (a shim stands in for gcc)
python3 / pytest   Python, and the test runner
node / npm     JavaScript and TypeScript
sqlite3        SQL
go             Go
rustc          Rust
git            the starter repositories
libcs50        the CS50 library (CS50 courses only)
check50 / style50  the CS50 graders
```

### Setup (no sudo)

`setup-cs50.sh` installs the whole CS50 toolchain into the user's home:

- `check50` + `style50` via `pip install --user`;
- `libcs50` built from <https://github.com/cs50/libcs50> into `~/.local`
  (header, static and shared library);
- a `clang` → `gcc` shim in `~/.local/share/meander/cs50/bin`, because
  `check50` compiles with a hardcoded `clang` and many boxes only ship gcc;
- the environment file `~/.config/meander/cs50/env`
  (`LIBRARY_PATH`, `C_INCLUDE_PATH`, `LD_LIBRARY_PATH`, `PATH`), which both
  the app's compile step and `course-tool.py` read — so the in-app build
  and the grader always agree.

Nothing is installed system-wide and no password is ever requested.

### Academic honesty

The tool never submits. `submit-info` only prints the `submit50` command
for the learner to run himself.
