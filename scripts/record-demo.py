#!/usr/bin/env python3
"""Record a click-through video of Meander (the "recorded test" for every change).

Starts a throwaway instance (no keys, its own empty data folder, its own build
folder, so it never touches your data or another dev server), drives it
in Chromium with Playwright, records the screen, and prints the video path.

    python3 scripts/record-demo.py steps.json [--out demo.mp4] [--port 3007] [--phone]

An .mp4 out (plays on Mac/iPhone) needs ffmpeg with libx264: on PATH or in $FFMPEG.

steps.json is a list of steps, run in order:
    {"caption": "Opening Settings"}            on-screen caption for the viewer
    {"goto": "/stats"}                         path on the app
    {"click": "[data-testid=settings-entry]"}  any Playwright selector (text=..., role=..., css)
    {"fill": ["textarea", "hello"]}            type into a field
    {"press": "Enter"}
    {"wait": 1500}                             milliseconds
    {"expect": "text=Dictation"}               fail the run unless this becomes visible
    {"shot": "settings"}                       also save <out-dir>/settings.png
Exit code is non-zero if any step fails, so a recording doubles as a test.
"""
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

CAPTION_JS = """(text) => {
  let el = document.getElementById('__demo_caption');
  if (!el) {
    el = document.createElement('div');
    el.id = '__demo_caption';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
      'background:rgba(20,24,24,.92);color:#fff;font:600 18px/1.3 system-ui,sans-serif;padding:10px 18px;' +
      'border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;max-width:80vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = text;
}"""


def port_free(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_up(url, server, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        if server.poll() is not None:
            sys.exit(f"app exited before starting (code {server.returncode})")
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return
        except Exception:
            pass
        time.sleep(1)
    sys.exit(f"app did not start at {url}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("steps")
    ap.add_argument("--out", default="demo.mp4")
    ap.add_argument("--port", type=int, default=3007)
    ap.add_argument("--phone", action="store_true", help="record at iPhone size")
    a = ap.parse_args()
    steps = json.loads(Path(a.steps).read_text())
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    base = f"http://localhost:{a.port}"

    if not port_free(a.port):
        sys.exit(f"port {a.port} is already in use; pick another with --port")
    data = Path(tempfile.mkdtemp(prefix="meander-demo-"))
    # next dev rewrites these for a custom build folder; undo only its edits after.
    touched = {f: ((ROOT / f).read_bytes() if (ROOT / f).exists() else None) for f in ("tsconfig.json", "next-env.d.ts")}
    signal.signal(signal.SIGTERM, lambda *_: sys.exit("stopped"))  # so cleanup below still runs
    server = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        env={
            **os.environ,
            "PORT": str(a.port),
            "LH_DIST_DIR": ".next-demo",
            "LH_DATA_DIR": str(data),
            "LH_AUTH_FILE": str(data / "auth.json"),
            "LH_IGNORE_ENV_KEYS": "1",
        },
    )
    video_dir = Path(tempfile.mkdtemp(prefix=".video-", dir=out.parent))
    failed = None
    try:
        wait_up(base, server)
        size = {"width": 390, "height": 844} if a.phone else {"width": 1280, "height": 800}
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport=size, record_video_dir=str(video_dir), record_video_size=size)
            # Hide the Next.js dev badge: it sits over the sidebar's bottom row.
            ctx.add_init_script("""document.addEventListener('DOMContentLoaded', () => {
              const st = document.createElement('style');
              st.textContent = 'nextjs-portal{display:none!important}';
              document.head.appendChild(st);
            });""")
            page = ctx.new_page()
            try:
                page.goto(base, wait_until="networkidle")
            except Exception as e:
                failed = f"opening the app failed: {(str(e).splitlines() or [repr(e)])[0]}"
                steps = []
            for i, s in enumerate(steps):
                try:
                    if "caption" in s:
                        page.evaluate(CAPTION_JS, s["caption"])
                        page.wait_for_timeout(1200)
                    elif "goto" in s:
                        page.goto(base + s["goto"], wait_until="networkidle")
                    elif "click" in s:
                        page.click(s["click"], timeout=15000)
                        page.wait_for_timeout(700)
                    elif "fill" in s:
                        page.fill(s["fill"][0], s["fill"][1], timeout=15000)
                    elif "press" in s:
                        page.keyboard.press(s["press"])
                    elif "wait" in s:
                        page.wait_for_timeout(int(s["wait"]))
                    elif "expect" in s:
                        page.wait_for_selector(s["expect"], state="visible", timeout=15000)
                    elif "shot" in s:
                        page.screenshot(path=str(out.parent / f"{s['shot']}.png"))
                    else:
                        raise ValueError(f"unknown step: {json.dumps(s)}")
                except Exception as e:  # keep recording the failure state, then report
                    failed = f"step {i + 1} {json.dumps(s)} failed: {(str(e).splitlines() or [repr(e)])[0]}"
                    try:
                        page.evaluate(CAPTION_JS, "FAILED: " + failed)
                        page.wait_for_timeout(2500)
                    except Exception:
                        pass
                    break
            page.wait_for_timeout(1000)
            video = page.video.path()
            ctx.close()
            browser.close()
        if out.suffix == ".mp4":
            ffmpeg = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
            if not ffmpeg:
                sys.exit("an .mp4 needs ffmpeg (set $FFMPEG); or use --out x.webm")
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", video, "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "23", str(out)], check=True)
        else:
            os.replace(video, out)
    finally:
        # Stop the server first, so nothing rewrites files after we restore them.
        for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
            try:
                os.killpg(server.pid, sig)
                server.wait(wait)
                break
            except ProcessLookupError:
                break
            except subprocess.TimeoutExpired:
                continue
        shutil.rmtree(video_dir, ignore_errors=True)
        shutil.rmtree(data, ignore_errors=True)
        for f, before in touched.items():
            path = ROOT / f
            now = path.read_bytes() if path.exists() else None
            if now == before or (now is not None and b".next-demo" not in now and before is not None):
                continue  # untouched, or changed by someone else: leave it
            if before is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(before)
    print(out)
    if failed:
        sys.exit(failed)


if __name__ == "__main__":
    main()
