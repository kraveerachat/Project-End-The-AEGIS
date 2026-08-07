import React from 'react'

export function HatchDefs() { return null }
export function SkeletonLoader() { return <div>Loading</div> }
export function AegisLockup() { return <div>AEGIS Drive_LC</div> }

export function Sidebar({ t }) {
  return <aside><nav aria-label={t('productName')}>Sidebar</nav></aside>
}

export function TopBar() { return <header>Top bar</header> }
export function GlobalSearch() { return <div>Search</div> }
export function Login() { return <div>Login</div> }

export function Dashboard() { return <section>Dashboard screen</section> }
export function Files() { return <section>Files screen</section> }
export function Vault() { return <section>Vault screen</section> }
export function Uploads() { return <section>Uploads screen</section> }
export function Shares() { return <section>Shares screen</section> }
export function FileHistory() { return <section>File history screen</section> }
export function Storage() { return <section>Storage screen</section> }
export function Audit() { return <section>Audit screen</section> }
export function Access() { return <section>Access screen</section> }
export function Settings() { return <section>Settings screen</section> }

export function Field({ id, label, children }) {
  return <div><label htmlFor={id}>{label}</label>{children}</div>
}

export function PillInput(props) { return <input {...props} /> }

export function Btn({ children, ...props }) { return <button {...props}>{children}</button> }

export function SparkleButton({ children, ...props }) { return <button {...props}>{children}</button> }

export function ThemeToggle() { return <button type="button">Theme</button> }
export function Segmented() { return <div>Language</div> }
