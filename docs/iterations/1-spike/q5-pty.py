#!/usr/bin/env python3
"""Q5: drive `dsh tui` in a pseudo-terminal (stdlib only: pty, os.fork, select, fcntl, termios).

    python3 docs/iterations/1-spike/q5-pty.py

Isolated DSH_HOME (nothing of the user's profiles is touched), TERM=xterm-256color, window 120x40 (TIOCSWINSZ),
cwd = a temp dir. Reads everything the child prints until it exits (or 25 s), prints it with escape sequences
stripped, and the exit status. The harness itself (fork/exec on a pty, winsize, select loop, readiness by a file,
clean quit by writing to the master then SIGHUP/SIGTERM fallback) is what a TUI run would use; see the report.
"""
import fcntl, os, pty, re, select, signal, struct, sys, tempfile, termios, time

work = tempfile.mkdtemp(prefix="te-spike1-q5-")
home = os.path.join(work, "home")
repo = os.path.join(work, "repo")
os.makedirs(repo)
env = {k: v for k, v in os.environ.items() if not k.startswith("DSH_") and k not in ("TERM", "COLUMNS", "LINES")}
env.update(DSH_HOME=home, TERM="xterm-256color", COLUMNS="120", LINES="40")
argv = ["dsh", "tui"]

pid, fd = pty.fork()
if pid == 0:                                    # child: the slave side is already stdin/out/err
    os.chdir(repo)
    os.execvpe("dsh", argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))   # rows, cols
buf = b""
t0 = time.time()
status = None
while time.time() - t0 < 25:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:                          # EIO: the child closed the slave
            chunk = b""
        if not chunk:
            break
        buf += chunk
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        break
if status is None:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
text = re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]", b"", buf).decode("utf8", "replace")
print("argv:", argv, "TERM=xterm-256color 120x40")
print("child output (escapes stripped, first 6 lines):")
for line in [l for l in text.replace("\r", "").split("\n") if l.strip()][:6]:
    print("  |", line[:200])
print("exit:", os.waitstatus_to_exitcode(status), f"after {time.time() - t0:.1f}s")
print("home left behind:", sorted(os.listdir(home)) if os.path.isdir(home) else "none")
