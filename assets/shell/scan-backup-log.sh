#!/bin/sh
# scan-backup-log.sh -- extract backup / restore evidence from DM instance logs.
#
# WHY THIS SCRIPT EXISTS
#   The DSH plugin dsh-plugin-dm-recovery-readiness talks to DM over JDBC only.
#   It has no SSH, so it cannot read these logs itself and cannot run dmrman.
#   Copy this script to the database host and run it there as the DM owner
#   (usually dmdba). Its output is the missing half of the plugin's report.
#
# WHY IT MATCHES ONLY STRUCTURED MARKERS
#   Matching "BACKUP" as a bare substring is unsafe on DM logs. Measured facts:
#     - routine internal traffic contains BMML_CFG_NON_BACKUP and RESTORE_METAS,
#       neither of which is a user backup;
#     - every statement an operator runs is logged at [CMD] level, including
#       read-only probes, so a naive match finds the auditor's own queries.
#   Both failure modes were actually hit while building this tool. So this
#   script anchors on the exact phrases DM emits, and separates user activity
#   from routine internal work using the thread id.
#
# THE KEY MARKER
#   "N corrupted pages during backup"
#   A FULL backup reads EVERY page of EVERY data file, so that line looks like a
#   whole-database page-integrity verdict.
#
#   MEASURED CORRECTION (2026-10-13, see DESIGN section 46):
#   it is NOT sufficient. We zeroed one 32KB data page of a user table and then
#   took a full backup: the backup SUCCEEDED and the log said "0 corrupted pages
#   during backup", while reading that very page aborted the whole instance with
#     [EID:48] Server page check error! page:(4, 0, 73000)
#   So section 2 alone can report "clean" on a database that is not clean.
#
#   The reliable ONLINE evidence is the instance log (section 6): when DM reads a
#   bad page it aborts, and the abort plus the page coordinates land in
#   dm_DMSERVER_*.log. That is why section 6 exists.
#   The authoritative offline check is DM's own dmdbchk (requires the instance
#   DOWN -- the plugin must not stop a database, so it can only recommend it).
#
# TID FILTER
#   User sessions log "TID<nonzero>" (e.g. TID0117906217).
#   Routine internal events log "TID0000000000".
#   Excluding the all-zero id removes the internal noise reliably.
#
# NOTE ON ERROR / FATAL
#   Do NOT look for corruption by log level. On the reference environment all 12
#   ERROR/FATAL lines were startup ASM connect retries to localhost:7536.

set -u

LOGDIR="${1:-/home/dmdba/dmdbms/log}"

if [ ! -d "$LOGDIR" ]; then
  echo "ERROR: no such log directory: $LOGDIR" >&2
  exit 2
fi

FILES=$(find "$LOGDIR" -maxdepth 1 -type f -name 'dm_*.log' 2>/dev/null | sort)

if [ -z "$FILES" ]; then
  echo "ERROR: no dm_*.log files under $LOGDIR" >&2
  exit 3
fi

echo "scan-backup-log  logdir=$LOGDIR"
echo "files:"
echo "$FILES" | sed 's/^/  /'
echo ""

# --------------------------------------------------------------- 1. user ops
echo "=== 1. user-initiated backup / restore statements ==="
echo "    filter: [CMD] level AND nonzero TID AND statement starts with backup|restore"
n=0
for f in $FILES; do
  out=$(grep -aE '\[CMD\].*TID[0-9]*[1-9][0-9]*[[:space:]]+(backup|restore)' "$f" 2>/dev/null)
  if [ -n "$out" ]; then
    n=$((n + 1))
    echo "  -- $f"
    echo "$out" | cut -c1-200 | sed 's/^/     /'
  fi
done
if [ "$n" -eq 0 ]; then
  echo "  (none found)"
fi
echo ""

# ------------------------------------------------- 2. the decisive page verdict
echo "=== 2. whole-database page verdict (from the backup log) ==="
echo '    "N corrupted pages during backup" -- 0 means the backup read every page'
echo '    without its own counter tripping. NOTE (measured): this counter does NOT'
echo '    catch every kind of damage -- a zeroed data page produced "0 corrupted'
echo '    pages" while the instance aborted on read. See section 6.'
v=0
for f in $FILES; do
  out=$(grep -anE '[0-9]+ corrupted pages during backup' "$f" 2>/dev/null)
  if [ -n "$out" ]; then
    v=$((v + 1))
    echo "  -- $f"
    echo "$out" | grep -aoE '[0-9]+ corrupted pages during backup' | sed 's/^/     /'
  fi
done
if [ "$v" -eq 0 ]; then
  echo "  (none found)"
  echo "  Either no FULL backup was ever taken, or the log has rotated past it."
fi
echo ""

# ------------------------------------------------------- 3. per-event grouping
echo "=== 3. per backup event, grouped by TID (session / thread id) ==="
echo "    TID is the correlation key: all lines of one backup share it."
any=0
for f in $FILES; do
  tids=$(grep -aE 'BACKUP DATABASE \[' "$f" 2>/dev/null | grep -aoE 'TID[0-9]+' | sort -u)
  if [ -z "$tids" ]; then
    continue
  fi
  echo "  -- $f"
  for t in $tids; do
    case "$t" in
      TID0000000000) continue ;;
    esac
    any=1
    stmt=$(grep -aE "$t .*(backup database|BACKUP DATABASE \[)" "$f" 2>/dev/null \
             | head -1 | sed 's/.*TID[0-9]*[[:space:]]*//' | cut -c1-100)
    dbf=$(grep -acE "$t .*\[BACKUP_DBF\] for DBF" "$f" 2>/dev/null)
    corr=$(grep -aE "$t .*[0-9]+ corrupted pages during backup" "$f" 2>/dev/null \
             | grep -aoE '[0-9]+ corrupted pages during backup' | tail -1)
    fin=$(grep -aE "$t .*CMD END\.CODE" "$f" 2>/dev/null | tail -1 | sed 's/.*\(CMD END\.CODE.*\)/\1/')
    echo "     $t"
    echo "       start      : ${stmt:-(not found)}"
    echo "       dbf reads  : $dbf"
    echo "       page check : ${corr:-(no verdict line)}"
    echo "       result     : ${fin:-(no end line)}"
  done
done
if [ "$any" -eq 0 ]; then
  echo "  (no user backup event found)"
fi
echo ""

# --------------------------------------------------------- 4. destinations
echo "=== 4. backup destination directories seen ==="
# sed, not grep -oE '\[.*\]': that pattern is greedy and starts at the first '['
# on the line (the [INFO] tag), so it prints the whole line instead of the path.
grep -ahE 'searching in these directories:' $FILES 2>/dev/null \
  | sed -n 's/.*searching in these directories:[[:space:]]*//p' | sort -u | sed 's/^/  /'
echo ""

# --------------------------------------------------------- 5. restore attempts
echo "=== 5. restore statements (user-initiated only) ==="
r=0
for f in $FILES; do
  out=$(grep -aE '\[CMD\].*TID[0-9]*[1-9][0-9]*[[:space:]]+(restore|recover)' "$f" 2>/dev/null)
  if [ -n "$out" ]; then
    r=$((r + 1))
    echo "  -- $f"
    echo "$out" | cut -c1-200 | sed 's/^/     /'
  fi
done
if [ "$r" -eq 0 ]; then
  echo "  (none found)"
fi
echo ""

# ------------------------------------------- 6. page check errors (instance log)
# The reliable ONLINE evidence of real page damage. Measured (DESIGN section 46):
# reading a bad page makes DM abort the whole instance, and NOTHING is written to
# V$ERROR_PAGE -- the only trace is these two lines in dm_DMSERVER_*.log.
# Section 2 (the backup counter) reported 0 for the very same page.
echo "=== 6. page check errors in the instance log (PAGE_CHECK) ==="
echo "    anchors: [EID:48]Server page check error / SHUTDOWN ABORT / dm_sys_halt"
p=0
for f in $FILES; do
  case "$f" in
    *dm_DMSERVER_*) : ;;
    *) continue ;;
  esac
  out=$(grep -ahE '\[EID:48\]|SHUTDOWN ABORT|dm_sys_halt' "$f" 2>/dev/null)
  if [ -n "$out" ]; then
    p=$((p + 1))
    echo "  -- $f"
    echo "$out" | grep -aoE '\[EID:[0-9]+\]?[A-Za-z ]*page check error! page:\([0-9]+, *[0-9]+, *[0-9]+\)|SHUTDOWN ABORT|dm_sys_halt' | sed 's/^/     /'
  fi
done
if [ "$p" -eq 0 ]; then
  echo "  (none found)"
  echo "  No page-check failure recorded in the instance log -- this says the"
  echo "  instance never aborted on a bad page SINCE THE LOG BEGAN. dm_DMSERVER"
  echo "  logs rotate, so an old event may be outside the window."
fi
echo ""
echo "done."
