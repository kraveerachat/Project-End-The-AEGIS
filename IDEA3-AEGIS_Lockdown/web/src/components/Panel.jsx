import React from 'react'

export function Panel({ title, description, action, className = '', children }) {
  return (
    <section className={`panel ${className}`.trim()}>
      {(title || action) && (
        <header className="panel__header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {action && <div className="panel__action">{action}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  )
}
