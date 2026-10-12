import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from '../../src/pages/LoginPage.jsx'

describe('administrator login gate', () => {
  it('submits bounded credentials without exposing the password after submission', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined)
    render(<LoginPage onLogin={onLogin} />)

    fireEvent.change(screen.getByLabelText('ชื่อผู้ดูแลระบบ'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ Security Center' }))

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ username: 'admin', password: 'secret-pass' }))
  })

  it('shows a uniform safe failure message from the application boundary', async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error('เข้าสู่ระบบไม่สำเร็จ'))
    render(<LoginPage onLogin={onLogin} />)

    fireEvent.change(screen.getByLabelText('ชื่อผู้ดูแลระบบ'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ Security Center' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('เข้าสู่ระบบไม่สำเร็จ')
    expect(screen.queryByText(/stack|exception|401/i)).not.toBeInTheDocument()
  })

  it('renders the IDEA1-style split vault card with IDEA3 branding', () => {
    render(<LoginPage onLogin={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1, name: 'AEGIS' })).toBeInTheDocument()
    expect(screen.getByText('IDEA3 · SECURITY CENTER')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'เข้าสู่ Security Center' })).toBeInTheDocument()
    expect(screen.queryByText(/หลักฐานชัดเจน/)).not.toBeInTheDocument()
    expect(document.querySelector('.vault-card .vault-brand-panel')).not.toBeNull()
    expect(document.querySelector('.vault-card .vault-form-panel')).not.toBeNull()
  })
})

function mockReducedMotion(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function fill(username = 'admin', password = 'secret-pass') {
  fireEvent.change(screen.getByLabelText('ชื่อผู้ดูแลระบบ'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: password } })
}

describe('vault login behaviour', () => {
  afterEach(() => { delete window.matchMedia })

  it('reveals and hides the password with an accessible pressed state', () => {
    render(<LoginPage onLogin={vi.fn()} />)
    const input = screen.getByLabelText('รหัสผ่าน')
    const toggle = screen.getByRole('button', { name: 'แสดงรหัสผ่าน' })
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.click(toggle)
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'ซ่อนรหัสผ่าน' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'ซ่อนรหัสผ่าน' }))
    expect(input).toHaveAttribute('type', 'password')
  })

  it('shows a checking state while authenticating, then a success state, and clears the password', async () => {
    mockReducedMotion(true)
    let resolveLogin
    const onLogin = vi.fn(() => new Promise((resolve) => { resolveLogin = resolve }))
    const onLoginComplete = vi.fn()
    render(<LoginPage onLogin={onLogin} onLoginComplete={onLoginComplete} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ Security Center' }))

    const busyButton = await screen.findByRole('button', { name: 'กำลังตรวจสอบ…' })
    expect(busyButton).toBeDisabled()
    expect(screen.getByLabelText('ชื่อผู้ดูแลระบบ')).toBeDisabled()
    expect(document.querySelector('[data-security-field]')).toHaveAttribute('data-phase', 'checking')
    expect(document.querySelector('[data-layer-id="3"]')).toHaveAttribute('data-layer-status', 'checking')
    // a second submit while busy must not call the server twice
    fireEvent.submit(busyButton.closest('form'))
    expect(onLogin).toHaveBeenCalledTimes(1)

    await act(async () => { resolveLogin() })
    await waitFor(() => expect(onLoginComplete).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-security-field]')).toHaveAttribute('data-phase', 'success')
    expect(screen.getByLabelText('รหัสผ่าน')).toHaveValue('')
  })

  it('reports failure through role=alert, keeps the password, and returns focus to retry', async () => {
    mockReducedMotion(true)
    const onLogin = vi.fn().mockRejectedValue(new Error('เข้าสู่ระบบไม่สำเร็จ'))
    render(<LoginPage onLogin={onLogin} onLoginComplete={vi.fn()} />)
    fill('admin', 'wrong')
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ Security Center' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('เข้าสู่ระบบไม่สำเร็จ')
    expect(document.querySelector('[data-security-field]')).toHaveAttribute('data-phase', 'error')
    expect(document.querySelector('[data-layer-id="3"]')).toHaveAttribute('data-layer-status', 'fail')
    expect(screen.getByLabelText('รหัสผ่าน')).toHaveAttribute('aria-describedby', 'login-error')
    await waitFor(() => expect(screen.getByLabelText('รหัสผ่าน')).toHaveFocus())
  })

  it('keeps the IDEA3 auth contract: exactly one {username, password} payload and no remember field', async () => {
    mockReducedMotion(true)
    const onLogin = vi.fn().mockResolvedValue(undefined)
    render(<LoginPage onLogin={onLogin} onLoginComplete={vi.fn()} />)
    fill('  admin  ', 'secret-pass')
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ Security Center' }))

    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1))
    const [payload, ...extra] = onLogin.mock.calls[0]
    expect(extra).toHaveLength(0)
    expect(Object.keys(payload).sort()).toEqual(['password', 'username'])
    expect(payload).toEqual({ username: 'admin', password: 'secret-pass' })
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/remember|จดจำ/i)
  })

  it('exposes every motion group and keeps inputs usable in full-motion mode', () => {
    mockReducedMotion(false)
    render(<LoginPage onLogin={vi.fn()} onThemeChange={vi.fn()} />)
    const groups = [...document.querySelectorAll('[data-login-motion]')].map((node) => node.getAttribute('data-login-motion'))
    for (const group of ['controls', 'mark', 'wordmark', 'tagline', 'title', 'subtitle', 'username', 'password', 'submit', 'layers']) {
      expect(groups).toContain(group)
    }
    expect(document.querySelector('[data-security-field]')).toHaveAttribute('data-motion', 'full')
    expect(screen.getByLabelText('ชื่อผู้ดูแลระบบ')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('ชื่อผู้ดูแลระบบ'), { target: { value: 'x' } })
    expect(screen.getByLabelText('ชื่อผู้ดูแลระบบ')).toHaveValue('x')
  })

  it('renders everything immediately visible, with no animation state, under reduced motion', () => {
    mockReducedMotion(true)
    render(<LoginPage onLogin={vi.fn()} onThemeChange={vi.fn()} />)
    expect(document.querySelector('[data-security-field]')).toHaveAttribute('data-motion', 'reduced')
    for (const node of document.querySelectorAll('[data-login-motion]')) {
      expect(node.style.opacity).not.toBe('0')
      expect(node.style.transform || '').not.toMatch(/translate/)
    }
    expect(screen.getByLabelText('ชื่อผู้ดูแลระบบ')).toBeEnabled()
    expect(screen.getByLabelText('รหัสผ่าน')).toBeEnabled()
  })

  it('does not present architecture rows as runtime-verified evidence before authentication', () => {
    render(<LoginPage onLogin={vi.fn()} />)
    const rows = within(screen.getByRole('list', { name: 'สถาปัตยกรรมความปลอดภัย' })).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.getAttribute('data-layer-status'))).toEqual(['info', 'info', 'info', 'idle'])
    expect(rows[0]).toHaveTextContent('ADMIN RBAC')
    expect(rows[1]).toHaveTextContent('CSRF PROTECTION')
    expect(rows[2]).toHaveTextContent('SECURE SESSION')
    expect(rows[3]).toHaveTextContent('SERVER-OWNED AUTH')
    const copy = rows.map((row) => row.textContent).join(' ')
    expect(copy).not.toMatch(/verified|healthy|ปกติ|ตรวจสอบแล้ว|hardware|relay|MQTT|ESP32|contained/i)
  })

  it('reuses the App theme through props and invents no language selector', () => {
    const onThemeChange = vi.fn()
    const { rerender } = render(<LoginPage onLogin={vi.fn()} theme="dark" onThemeChange={onThemeChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'ใช้ธีมสว่าง' }))
    expect(onThemeChange).toHaveBeenCalledWith('light')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    rerender(<LoginPage onLogin={vi.fn()} theme="light" onThemeChange={onThemeChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'ใช้ธีมมืด' }))
    expect(onThemeChange).toHaveBeenLastCalledWith('dark')
    rerender(<LoginPage onLogin={vi.fn()} theme="dark" />)
    expect(screen.queryByRole('button', { name: /ธีม/ })).not.toBeInTheDocument()
  })

  it('uses the theme-aware IDEA background and mark assets that already ship with IDEA3', () => {
    const { container, rerender } = render(<LoginPage onLogin={vi.fn()} theme="dark" />)
    expect(container.querySelector('.vault-gate-bg').getAttribute('style')).toMatch(/BG_AEGIS02\.png/)
    expect(container.querySelector('img.vault-mark').getAttribute('src')).toMatch(/aegis-mark-light-ink\.png$/)
    rerender(<LoginPage onLogin={vi.fn()} theme="light" />)
    expect(container.querySelector('.vault-gate-bg').getAttribute('style')).toMatch(/BG_AEGIS01\.png/)
  })
})
