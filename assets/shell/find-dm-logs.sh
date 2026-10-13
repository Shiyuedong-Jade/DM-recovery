#!/bin/sh
# ============================================================================
#  DM log discovery -- find every log that may carry bad-page information.
# ============================================================================
#
#  Why this script exists:
#    Page-corruption evidence can live in several places, not just the
#    instance log. The ASM/CSS layer and the OS kernel log often see a bad
#    block BEFORE the database does.
#
#  Requirement: MUST NOT assume any fixed install path.
#    Real deployments use /opt/dm8, /dm8, /home/dmdba/dmdbms, or several
#    installations side by side. So discovery is derived from the RUNNING
#    PROCESSES first (their paths are the truth), then from common
#    locations as a fallback only.
#
#  ASCII-ONLY ON PURPOSE.
#    This script is shipped to unknown hosts over unknown transports.
#    Non-ASCII comments were observed to be mangled in transit (double
#    encoding) and the corruption merged lines, breaking the parser.
#    Keep this file pure ASCII so the transport cannot damage it.
#
#  Output: one line per file, pipe-separated:
#    <category>|<path>|<bytes>|<mtime_epoch>|<readable Y/N>
#
#  Read-only: never modifies, moves or deletes anything.
# ============================================================================

set -u

EXTRA_ROOTS=""
SCAN_SYSTEM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --root)      EXTRA_ROOTS="$EXTRA_ROOTS $2"; shift 2 ;;
    --no-system) SCAN_SYSTEM=0; shift ;;
    *)           shift ;;
  esac
done

emit() {
  # $1=category $2=path
  [ -f "$2" ] || return 0
  # Canonicalize FIRST. Candidate roots come from several sources and often
  # reach the same file by different spellings (e.g. ".../bin/../log/x.log"
  # vs ".../log/x.log"). sort -u compares strings, not files, so without
  # this every log would be listed two or three times and then scanned
  # that many times.
  real=$(readlink -f "$2" 2>/dev/null)
  [ -n "$real" ] || real="$2"
  size=$(stat -c %s "$real" 2>/dev/null || echo 0)
  mtime=$(stat -c %Y "$real" 2>/dev/null || echo 0)
  if [ -r "$real" ]; then can=Y; else can=N; fi
  printf '%s|%s|%s|%s|%s\n' "$1" "$real" "$size" "$mtime" "$can"
}

# ---- A. Derive install/config dirs from running processes ----------------
# The most trustworthy source: a config may have been edited, but the paths
# the live processes are actually using cannot lie.
proc_roots() {
  for p in $(ls -1 /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    # Guard: the process may exit between listing /proc and reading it.
    [ -r "/proc/$p/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
    case "$cmd" in
      *dmserver*|*dmap*|*dmasmsvr*|*dmwatcher*|*dmcss*)
        for tok in $cmd; do
          case "$tok" in
            *.ini) dirname "$tok" 2>/dev/null ;;
          esac
        done
        cwd=$(readlink "/proc/$p/cwd" 2>/dev/null)
        [ -n "$cwd" ] && printf '%s\n' "$cwd"
        ;;
    esac
  done
}

# ---- B. Common locations (existence check only, never assumed) ------------
common_roots() {
  for c in /home/*/dmdbms /opt/dm* /dm8 /dmdbms /usr/local/dm* /home/*/dm*; do
    [ -d "$c" ] && printf '%s\n' "$c"
  done
}

# Expand a candidate dir into likely log roots (the dir itself, ancestors,
# and any sibling "log" directory).
expand_roots() {
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    printf '%s\n' "$d" "$d/log" "$d/../log" "$d/../../log" "$d/../../.."
  done
}

# ---- C. Collect candidate log files under one root -----------------------
# Name patterns come from observed real deployments plus DM naming conventions.
# Rotation/compression variants (*.log.N, *.log.gz) are covered because real
# environments rotate aggressively.
collect_from() {
  root="$1"
  [ -d "$root" ] || return 0
  find "$root" -maxdepth 1 -type f \( \
       -name 'dm_*.log' -o -name 'dm_*.log.*' -o -name 'dm*.trc' \
    -o -name 'dmsql_*' -o -name 'dmwatcher*' -o -name 'dmarch*' \
    -o -name 'dmasm_trace_*' -o -name 'dmrww*' \) 2>/dev/null | while read -r f; do
    b=$(basename "$f")
    case "$b" in
      dm_ASM0*|dmasm_trace_*|dm_dmasm*) cat=asm ;;
      dm_CSS0*)                          cat=css ;;
      dm_BAKRES*|*bakres*)               cat=backup ;;
      dmwatcher*|dmarch*|dmrww*)         cat=watch ;;
      dmsql_*|*.trc)                     cat=sqltrace ;;
      dm_dmap*)                          cat=dmap ;;
      dm_*.log*)                         cat=instance ;;
      *)                                 cat=other ;;
    esac
    emit "$cat" "$f"
  done
}

# ---- Main ----------------------------------------------------------------
{
  # A. caller-specified roots win (real envs need manual additions)
  for r in $EXTRA_ROOTS; do
    if [ -d "$r" ]; then collect_from "$r"; else emit "specified-dir-missing" "$r"; fi
  done

  # B. process-derived + common locations
  { proc_roots; common_roots; } | sort -u | expand_roots | sort -u | while IFS= read -r r; do
    [ -d "$r" ] && collect_from "$r"
  done

  # C. OS-level logs: a bad block is usually a STORAGE problem first
  if [ "$SCAN_SYSTEM" = "1" ]; then
    for s in /var/log/messages /var/log/syslog /var/log/kern.log /var/log/dmesg; do
      emit "system" "$s"
    done
    command -v journalctl >/dev/null 2>&1 && printf 'system-journal|journalctl|0|0|Y\n'
  fi
} | sort -u
