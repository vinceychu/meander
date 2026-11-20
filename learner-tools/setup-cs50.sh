#!/usr/bin/env bash
# Install the CS50 toolchain WITHOUT sudo (2026-11-09).
#
#   check50 / style50   the graders (pip, --user)
#   libcs50             the C library the problems include (built from source into ~/.local)
#   a clang -> gcc shim check50 needs, because it compiles with a hardcoded "clang"
#
# Everything lands in the user's home directory; nothing is installed system-wide
# and no password is ever requested. Re-running is safe: every step is skipped
# when it is already in place.
set -u

PREFIX="${HOME}/.local"
SHIM_DIR="${HOME}/.local/share/meander/cs50/bin"
ENV_DIR="${HOME}/.config/meander/cs50"
ENV_FILE="${ENV_DIR}/env"
BUILD_DIR="${HOME}/.cache/meander/libcs50"

say() { printf '%s\n' "$*"; }

# ── 1. the graders ─────────────────────────────────────────────────────────
if command -v check50 >/dev/null 2>&1; then
	say "check50: already installed ($(check50 --version 2>&1 | head -1))"
else
	say "check50: installing (pip --user)…"
	if ! python3 -m pip install --user check50 style50; then
		say "retrying with --break-system-packages (PEP 668)…"
		python3 -m pip install --user --break-system-packages check50 style50 || {
			say "could not install check50/style50 — install them by hand:"
			say "    python3 -m pip install --user --break-system-packages check50 style50"
			exit 1
		}
	fi
fi

# The pip user bin dir is not always on PATH (it is on most systems).
case ":${PATH}:" in
	*":${PREFIX}/bin:"*) ;;
	*) export PATH="${PREFIX}/bin:${PATH}" ;;
esac

# ── 2. libcs50 ─────────────────────────────────────────────────────────────
if [ -f "${PREFIX}/include/cs50.h" ] && [ -f "${PREFIX}/lib/libcs50.so" ]; then
	say "libcs50: already installed"
else
	say "libcs50: building from source into ${PREFIX}…"
	mkdir -p "${BUILD_DIR}"
	if [ ! -d "${BUILD_DIR}/libcs50/.git" ]; then
		git clone --depth 1 https://github.com/cs50/libcs50.git "${BUILD_DIR}/libcs50" || {
			say "could not clone libcs50 — clone it by hand and run this script again:"
			say "    git clone https://github.com/cs50/libcs50.git"
			exit 1
		}
	fi
	(
		cd "${BUILD_DIR}/libcs50" || exit 1
		make clean >/dev/null 2>&1
		# The upstream Makefile has no install target; build with the same
		# flags it uses and copy the artifacts into the prefix by hand.
		make || exit 1
		SO=$(ls lib/libcs50.so.* 2>/dev/null | head -1)
		if [ -n "${SO}" ]; then
			mkdir -p "${PREFIX}/lib" "${PREFIX}/include" "${PREFIX}/src"
			cp -f lib/libcs50.a "${PREFIX}/lib/" 2>/dev/null
			cp -f lib/libcs50.so* "${PREFIX}/lib/" 2>/dev/null
			# The soname symlink upstream's Makefile never installs.
			SONAME=$(basename "${SO}" | sed -E 's/\.so\..*/.so/')
			Maj=$(basename "${SO}" | sed -E 's/.*\.so\.([0-9]+).*/\1/')
			ln -sf "$(basename "${SO}")" "${PREFIX}/lib/libcs50.so.${Maj}" 2>/dev/null
			ln -sf "$(basename "${SO}")" "${PREFIX}/lib/${SONAME}" 2>/dev/null
		fi
		cp -f include/cs50.h "${PREFIX}/include/" 2>/dev/null
		cp -rf src "${PREFIX}/" 2>/dev/null
	) || {
		say "libcs50: the build failed — see the output above"
		exit 1
	}
	say "libcs50: installed into ${PREFIX}"
fi

# ── 3. the clang shim check50 needs ────────────────────────────────────────
mkdir -p "${SHIM_DIR}"
if ! command -v clang >/dev/null 2>&1; then
	if command -v gcc >/dev/null 2>&1; then
		cat > "${SHIM_DIR}/clang" <<'SHIM'
#!/bin/sh
# check50 compiles with a hardcoded "clang"; on this box gcc is the compiler.
exec gcc "$@"
SHIM
		chmod +x "${SHIM_DIR}/clang"
		say "clang shim: created (clang -> gcc)"
	else
		say "clang shim: skipped (no gcc either — install gcc, then run this again)"
	fi
else
	say "clang shim: not needed (clang is installed)"
fi

# ── 4. the env file the app and the tool both read ─────────────────────────
mkdir -p "${ENV_DIR}"
cat > "${ENV_FILE}" <<EOF
# Written by setup-cs50.sh — the CS50 toolchain's environment.
# Read by the Meander server (its compile/run step) and by cs50-tool.py.
# Only the compiler's search paths live here: the PATH entries for the
# graders and the clang shim are prepended by the readers themselves, so
# the learner's own PATH is never clobbered here.
LIBRARY_PATH="${PREFIX}/lib"
C_INCLUDE_PATH="${PREFIX}/include"
LD_LIBRARY_PATH="${PREFIX}/lib"
EOF
say "env file: ${ENV_FILE}"

say ""
say "done. check: check50 --version && style50 --version"
