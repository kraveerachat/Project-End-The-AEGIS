import { pathToFileURL } from 'node:url'
import bcrypt from 'bcryptjs'


const MAX_PASSWORD_BYTES = 1024


async function readPassword(input) {
  const chunks = []
  let size = 0
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_PASSWORD_BYTES + 2) throw new Error('invalid password input')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (!raw || Buffer.byteLength(raw) > MAX_PASSWORD_BYTES || /[\r\n]/.test(raw)) {
    throw new Error('invalid password input')
  }
  return raw
}


export async function hashPasswordFromStdin({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  try {
    const password = await readPassword(input)
    const hash = await bcrypt.hash(password, 12)
    output.write(`${hash}\n`)
    return 0
  } catch {
    errorOutput.write('Password input is invalid.\n')
    return 2
  }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await hashPasswordFromStdin()
}
