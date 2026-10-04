// D-1 Phase J replica: extract the exact runbook V6 command blocks and re-target ONLY their authority tokens
// (Compose project/dir/env-file, governed runtime dir, container names, Phase-J placeholders) at the disposable
// replica. Command logic, order, assertions and fail-closed checks are byte-for-byte V6.
//   node v6-blocks.mjs <v6.md> <expected-sha256> <out-dir>
// Reads replica values from the environment (D1REP_*, S2_*/S3_*); writes session-*.sh and substitutions.txt.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [, , V6, EXPECTED, OUT] = process.argv
const raw = fs.readFileSync(V6)
const got = crypto.createHash('sha256').update(raw).digest('hex')
if (got !== EXPECTED) { console.error(`STOP: V6 sha256 ${got} != ${EXPECTED}`); process.exit(1) }
const lines = raw.toString('utf8').replace(/\r\n/g, '\n').split('\n')

/** first ```bash block after the heading line that starts with `heading` */
function block(heading) {
  const h = lines.findIndex((l) => l.startsWith(heading))
  if (h < 0) throw new Error(`heading not found: ${heading}`)
  const start = lines.findIndex((l, i) => i > h && l.trim() === '```bash')
  const end = lines.findIndex((l, i) => i > start && l.trim() === '```')
  if (start < 0 || end < 0) throw new Error(`no bash block after ${heading}`)
  return { heading, from: start + 2, to: end, text: lines.slice(start + 1, end).join('\n') }
}

const B = {
  common: block('### Docker Authority & Governed Environment'),
  s22: block('### S2.2 '), s23: block('### S2.3 '), s24: block('### S2.4 '), s25: block('### S2.5 '),
  s27: block('### S2.7 '), s28: block('### S2.8 '),
  s31: block('### S3.1 '), s32: block('### S3.2 '), s33: block('### S3.3 '), s34: block('### S3.4 '), s35: block('### S3.5 '), s36: block('### S3.6 '),
  s37: block('### S3.7 '),
}

const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v }
const q = (s) => s.replace(/"/g, '\\"')
const SUBS = [
  ['--project-directory /opt/aegis/runtime --env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod', '--project-directory "$D1REP_DIR_W" --env-file "$D1REP_ENV_FILE" --project-name aegis-d1rep'],
  ['RT=/opt/aegis/runtime/preview-d1', 'RT="$D1REP_RT"'],
  ['= "/opt/aegis/runtime"', '= "$D1REP_DIR_W"'],
  ['Working dir is not /opt/aegis/runtime', 'Working dir is not the replica project dir'],
  ['= "aegis-prod"', '= "aegis-d1rep"'],
  ['aegis-prod-drive-1', 'aegis-d1rep-drive-1'],
  ['aegis-prod-postgres-1', 'aegis-d1rep-postgres-1'],
  ...['S2_SHA', 'S2_IMAGE', 'S2_OVERLAY', 'S2_OVERLAY_SHA256', 'IMAGE_ARCHIVE', 'IMAGE_ARCHIVE_SHA256', 'S3_OVERLAY', 'S3_OVERLAY_SHA256']
    .map((k) => [`${k}="<PENDING_PHASE_J_DEPLOY_PR>"`, `${k}="${q(need(`D1REP_${k}`))}"`]),
]
const FORBIDDEN = [/\/opt\/aegis/, /aegis-prod-drive-1/, /aegis-prod-postgres-1/, /="<PENDING_PHASE_J_DEPLOY_PR>"/, /--project-name aegis-prod\b/, /192\.168\./, /Project-End-The-AEGIS\/\.env/]

// Platform shims (Git Bash on Windows): no sudo on the replica; Docker Desktop may report a bind-mount Source
// as its VM path /run/desktop/mnt/host/<drive>/... — map it to the host path (/<drive>/...) for host file ops;
// GNU sha256sum escapes backslash paths ("\hash  C:\\x") which V6's `awk '{print $1}'` would misread — undo
// the escape so output matches Linux.
const PRELUDE = `# --- replica prelude (not V6) ---
sudo() { local a=() x; for x in "$@"; do a+=("\${x/#\\/run\\/desktop\\/mnt\\/host\\//\\/}"); done; "\${a[@]}"; }
sha256sum() { case " $* " in *" -c "*) command sha256sum "$@" ;; *) command sha256sum "$@" | sed -E 's/^\\\\//; s/\\\\\\\\/\\\\/g' ;; esac; }
# --- end prelude ---
`
const report = []
function retarget(name, keys) {
  let text = keys.map((k) => `# ===== V6 ${B[k].heading.trim()} (V6 lines ${B[k].from}-${B[k].to}) =====\n${B[k].text}`).join('\n\n')
  for (const [from, to] of SUBS) {
    const n = text.split(from).length - 1
    if (n) { text = text.split(from).join(to); report.push(`${name}\t${n}x\t${from}\t=>\t${to}`) }
  }
  for (const re of FORBIDDEN) if (re.test(text)) throw new Error(`${name}: Production token remains: ${re}`)
  fs.writeFileSync(path.join(OUT, `session-${name}.sh`), `#!/usr/bin/env bash\n${PRELUDE}\n${text}\n`)
}

retarget('s2', ['common', 's22', 's23', 's24', 's25'])
retarget('s3', ['common', 's31', 's32', 's33', 's34', 's35', 's36'])
retarget('case-e', ['common', 's37'])
retarget('case-c', ['common', 's27'])
retarget('case-d', ['common', 's28'])
fs.writeFileSync(path.join(OUT, 'substitutions.txt'), `V6_SHA256=${got}\n${report.join('\n')}\n`)
for (const [k, b] of Object.entries(B)) {
  fs.writeFileSync(path.join(OUT, `v6-block-${k}.sh`), b.text + '\n')
}
console.log(`V6_BLOCKS_EXTRACTED=${Object.keys(B).length} SESSIONS=5 SUBSTITUTIONS=${report.length}`)
