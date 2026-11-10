# Learner tools

Tools the app ships for the learner, installed into the data dir
(`~/.config/LearnHarness/data/tools/`) on first run. Each tool is a JSON
manifest (the agent sees it as `cli_<name>`) plus the program it runs —
the same shape as the learner's own tools, so a user-installed tool and a
shipped one are indistinguishable to the agent.

| tool | manifest | program | what it does |
|---|---|---|---|
| `cs50` | `cs50.json` | `cs50-tool.py` | grades CS50 problem sets with `check50` / `style50` |

## cs50

The CS50x problem sets. The grader (`check50 --local <slug>`) is what the
tutor coaches from: it prints one `[ok]` / `[FAIL]` line per requirement.

```
list                 the problems of the course and which are set up locally
start <problem>      create the problem's folder (starter files) and print its task
task <problem>       print the problem's task
check <problem>      grade the learner's work ([ok]/[FAIL] per requirement)
style <problem>      run style50 on the problem's source file
submit-info <problem>  print the submit50 command — the learner submits himself
doctor               report what is missing (check50 / style50 / libcs50 / compiler)
setup                install what is missing — no sudo, everything in $HOME
```

### Setup (no sudo)

`setup-cs50.sh` installs the whole toolchain into the user's home:

- `check50` + `style50` via `pip install --user`;
- `libcs50` built from <https://github.com/cs50/libcs50> into `~/.local`
  (header, static and shared library);
- a `clang` → `gcc` shim in `~/.local/share/meander/cs50/bin`, because
  `check50` compiles with a hardcoded `clang` and many boxes only ship gcc;
- the environment file `~/.config/meander/cs50/env`
  (`LIBRARY_PATH`, `C_INCLUDE_PATH`, `LD_LIBRARY_PATH`, `PATH`), which both
  the app's compile step and `cs50-tool.py` read — so the in-app build and
  the grader always agree.

Nothing is installed system-wide and no password is ever requested.

### Academic honesty

The tool never submits. `submit-info` only prints the `submit50` command
for the learner to run himself.
