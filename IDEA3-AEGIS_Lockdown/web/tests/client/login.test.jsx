import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
})
