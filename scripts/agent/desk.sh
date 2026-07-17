#!/usr/bin/env bash
# The question desk launcher (F80/F91) — open a SECOND terminal to interview Matt.
#
# The main terminal keeps building. When agents have left open questions and Matt is not in
# the web UI answering them, this pops a NEW terminal running a Claude Code side-chat whose
# whole job is to ask him those questions, one at a time, and keep nudging him to open the
# graph view of the fact in question. Answers land in knowledge.answers.jsonl, exactly as the
# UI writes them, so the build session's agents resume without knowing which channel replied.
#
#   npm run desk           open the side-chat IF there are open questions (quiet otherwise)
#   npm run desk -- --force  open it regardless (even with an empty queue)
#   npm run desk -- --plain  skip Claude Code, just run the scripted interview in the terminal
#
# Honest about what it needs: a terminal emulator (or tmux), and for the conversational
# version, the `claude` CLI on PATH. Falls back gracefully and tells you the command to run
# by hand if it cannot open a window itself.
set -euo pipefail
cd "$(dirname "$0")/../.."

FORCE=0; PLAIN=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --plain) PLAIN=1 ;;
  esac
done

COUNT="$(npm run --silent interview -- --count 2>/dev/null || echo 0)"
if [ "$FORCE" -ne 1 ] && [ "${COUNT:-0}" = "0" ]; then
  echo "  ✓ No open questions — the desk stays closed. (npm run desk -- --force to open anyway.)"
  exit 0
fi
echo "  📋 $COUNT open question(s). Opening the side-chat…"

# The command the new terminal runs. Prefer a conversational Claude Code session; fall back to
# the scripted interview when --plain is set or `claude` is missing.
read -r -d '' SEED <<'PROMPT' || true
You are the Reckons.AI QUESTION DESK — a short-lived side chat whose only job is to help Matt
answer the questions his build agents have left in the graph. Do this:
1. Run `npm run interview -- --json` to load the OPEN questions.
2. Ask Matt ONE question at a time, in plain language. For each, give him the `uiLink` and
   SUGGEST he open the graph in the web UI to look at the fact in question before deciding —
   he sees more in the graph than in this chat.
3. When he answers, record it with:
     npm run interview -- --answer --subject <s> --predicate <p> --object "<his answer>"
   Use the subject/predicate from the JSON verbatim. NEVER guess or fill an answer for him —
   an unanswered question is fine; a wrong fact in the graph is not.
4. When the queue is empty, tell him the desk is clear and stop.
Keep it brief and friendly. He may already be answering some in the UI — re-run the JSON if he
says he handled one there.
PROMPT

if [ "$PLAIN" -eq 1 ] || ! command -v claude >/dev/null 2>&1; then
  INNER='npm run interview'
  [ "$PLAIN" -ne 1 ] && echo "  (no 'claude' CLI found — opening the scripted interview instead)"
else
  # Escape single quotes for safe embedding in the terminal command string.
  ESC_SEED=${SEED//\'/\'\\\'\'}
  INNER="claude '$ESC_SEED'"
fi

REPO="$(pwd)"
LAUNCH="cd '$REPO' && $INNER; exec bash"

open_in() {
  case "$1" in
    tmux)             tmux new-window -n reckons-desk "bash -lc \"$LAUNCH\"" ;;
    gnome-terminal)   gnome-terminal --title="Reckons question desk" -- bash -lc "$LAUNCH" ;;
    konsole)          konsole --new-tab -p tabtitle="Reckons desk" -e bash -lc "$LAUNCH" ;;
    xfce4-terminal)   xfce4-terminal --title="Reckons desk" -e "bash -lc \"$LAUNCH\"" ;;
    x-terminal-emulator) x-terminal-emulator -e bash -lc "$LAUNCH" ;;
    xterm)            xterm -T "Reckons desk" -e bash -lc "$LAUNCH" ;;
    *) return 1 ;;
  esac
}

# tmux first (Matt runs the Ubuntu server headless a lot), then a real emulator.
CANDIDATES=()
[ -n "${TMUX:-}" ] && CANDIDATES+=(tmux)
[ -n "${TERMINAL:-}" ] && CANDIDATES+=("$TERMINAL")
CANDIDATES+=(gnome-terminal konsole xfce4-terminal x-terminal-emulator xterm)

for term in "${CANDIDATES[@]}"; do
  if [ "$term" = tmux ] || command -v "$term" >/dev/null 2>&1; then
    if open_in "$term" 2>/dev/null; then
      echo "  ✓ Side-chat opened in: $term"
      exit 0
    fi
  fi
done

echo "  ⚠ Couldn't open a terminal window automatically. Run the desk yourself with:"
echo
echo "      $INNER"
echo
exit 0
