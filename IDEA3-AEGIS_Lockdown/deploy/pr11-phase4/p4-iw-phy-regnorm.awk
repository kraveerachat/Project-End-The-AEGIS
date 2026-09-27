# AEGIS IDEA3 PR11 Phase 4 — regulatory-insensitive `iw phy` normalizer (V3 preservation model).
#
# Live attempt 2 (2026-09-27) proved `wifi.phy.sha256` changes when the target phy regulatory state moves 00 -> TH, because `iw phy` annotates
# each FREQUENCY line with regulatory state ("(22.0 dBm)" -> "(disabled)", "No IR", "Radar detection", "DFS state", "Passive scan",
# "Indoor only"). Nothing else in `iw phy` (capabilities, bitrates, supported commands, interface modes, combinations, hardware identity)
# depends on the regulatory domain. This filter removes ONLY the regulatory annotations of the frequency entries so a digest of its output
# is regulatory-insensitive while every capability/mode/command/identity difference still changes it.
#
#   mode=norm (default)  prints the normalized text
#   mode=ch6             prints YES | NO | MISSING: whether channel 6 exists and carries no restriction annotation (read-only fact)
#
# Frequency block: after a `Frequencies:` line, entries are `* <MHz> MHz [<ch>] (<annotation>)` at one indent; deeper-indented lines are that
# entry's attribute lines. Both are reduced to `* <MHz> MHz [<ch>]`; the first line at a shallower indent ends the block untouched.
function indent(s) { match(s, /^[ \t]*/); return RLENGTH }
BEGIN { if (mode == "") mode = "norm"; in_freq = 0; star = -1; ch6seen = 0; ch6bad = 0; cur6 = 0 }
{
  line = $0
  if (line ~ /^[ \t]*Frequencies:[ \t]*$/) { in_freq = 1; star = -1; cur6 = 0; if (mode == "norm") print line; next }
  if (in_freq) {
    if (line ~ /^[ \t]*\* [0-9.]+ MHz \[[0-9]+\]/) {
      if (star < 0) star = indent(line)
      if (indent(line) == star) {
        head = line; sub(/[ \t]*\(.*$/, "", head)     # drop the trailing "(...)" regulatory annotation
        if (mode == "norm") print head
        cur6 = (head ~ /\[6\]$/)
        if (cur6) { ch6seen = 1; if (tolower(line) ~ /(disabled|no ir|no-ir|radar detection|passive scan|indoor only)/) ch6bad = 1 }
        next
      }
    }
    if (star >= 0 && indent(line) > star) {          # attribute lines of the current entry
      if (cur6 && tolower(line) ~ /(no ir|no-ir|radar detection|passive scan|indoor only|dfs state: (usable|unavailable)|disabled)/) ch6bad = 1
      next
    }
    in_freq = 0                                      # first shallower line ends the frequency block
  }
  if (mode == "norm") print line
}
END { if (mode == "ch6") print (!ch6seen ? "MISSING" : (ch6bad ? "NO" : "YES")) }
