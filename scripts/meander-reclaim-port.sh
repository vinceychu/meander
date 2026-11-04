#!/usr/bin/env bash
# ExecStartPre for meander.service: free the port from an ORPHANED Meander
# server before starting.
#
# When the app is killed hard (OOM killer, SIGKILL), its Next.js child
# ("next-server") can survive, get re-parented to systemd, and keep
# answering on the port. Serve mode then sees "a Meander server already
# answers" and exits, so the service never runs the new version and
# updates never land. A next-server whose parent is still a live Meander
# app is left alone.
port="${1:-8710}"
for pid in $(ss -Hltnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
	comm=$(cat "/proc/$pid/comm" 2>/dev/null) || continue
	case "$comm" in next-server*) ;; *) continue ;; esac
	ppid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null) || continue
	pcmd=$(tr '\0' ' ' < "/proc/$ppid/cmdline" 2>/dev/null)
	case "$pcmd" in *LearnHarness*|*Meander*|*learnharness*|*meander*) continue ;; esac
	echo "meander-reclaim-port: killing orphaned next-server $pid on :$port (parent $ppid: ${pcmd:-gone})"
	kill "$pid" 2>/dev/null
	for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
	kill -9 "$pid" 2>/dev/null || true
done
exit 0
