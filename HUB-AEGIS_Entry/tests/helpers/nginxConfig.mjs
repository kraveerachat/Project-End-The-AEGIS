import assert from 'node:assert/strict'

/**
 * Parse the subset of nginx syntax used by the AEGIS edge configurations.
 *
 * Quoted strings, comments, directive terminators, and nested blocks are
 * understood. Malformed braces or unterminated strings fail closed instead of
 * leaving tests to guess where a location ends.
 */
export function parseNginx(source) {
  let index = 0

  function parseBlock(nested) {
    const node = { directives: [], blocks: [] }
    let token = ''

    while (index < source.length) {
      const char = source[index]

      if (char === '"' || char === "'") {
        let end = index + 1
        while (end < source.length && source[end] !== char) {
          if (source[end] === '\\') end += 1
          end += 1
        }
        assert.ok(end < source.length, `unterminated ${char} string near offset ${index}`)
        token += source.slice(index, end + 1)
        index = end + 1
        continue
      }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1
        continue
      }
      if (char === ';') {
        const directive = token.trim().replace(/\s+/g, ' ')
        if (directive) node.directives.push(directive)
        token = ''
        index += 1
        continue
      }
      if (char === '{') {
        index += 1
        const child = parseBlock(true)
        node.blocks.push({ header: token.trim().replace(/\s+/g, ' '), ...child })
        token = ''
        continue
      }
      if (char === '}') {
        index += 1
        assert.ok(nested, 'unbalanced closing brace in nginx config')
        return node
      }
      token += char
      index += 1
    }

    assert.equal(nested, false, 'unbalanced opening brace in nginx config')
    return node
  }

  return parseBlock(false)
}
