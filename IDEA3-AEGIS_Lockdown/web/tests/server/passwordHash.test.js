import { Readable, Writable } from 'node:stream'
import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { hashPasswordFromStdin } from '../../server/passwordHash.js'


function captureStream() {
  let text = ''
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString()
        callback()
      },
    }),
    text: () => text,
  }
}


describe('password hash helper', () => {
  it('reads a password from stdin and writes only a cost-12 bcrypt hash', async () => {
    const password = 'correct horse battery staple'
    const output = captureStream()
    const errorOutput = captureStream()

    const result = await hashPasswordFromStdin({
      input: Readable.from([`${password}\n`]),
      output: output.stream,
      errorOutput: errorOutput.stream,
    })

    const hash = output.text().trim()
    expect(result).toBe(0)
    expect(hash).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/)
    expect(bcrypt.compareSync(password, hash)).toBe(true)
    expect(output.text()).not.toContain(password)
    expect(errorOutput.text()).toBe('')
  })

  it.each([
    ['empty input', '\n'],
    ['an oversized input', `${'s'.repeat(1025)}\n`],
  ])('fails without echoing %s', async (_case, passwordInput) => {
    const output = captureStream()
    const errorOutput = captureStream()

    const result = await hashPasswordFromStdin({
      input: Readable.from([passwordInput]),
      output: output.stream,
      errorOutput: errorOutput.stream,
    })

    expect(result).toBe(2)
    expect(output.text()).toBe('')
    expect(errorOutput.text()).toBe('Password input is invalid.\n')
    if (passwordInput.trim()) expect(errorOutput.text()).not.toContain(passwordInput.trim())
  })
})
