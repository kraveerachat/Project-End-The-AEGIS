import React from 'react'

export function DataTable({ columns, rows = [], emptyLabel = 'ไม่มีข้อมูล', rowKey = 'id' }) {
  if (rows.length === 0) {
    return <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>{emptyLabel}</p></div>
  }

  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row[rowKey] ?? index}>
              {columns.map((column) => <td key={column.key} data-label={column.label}>{column.render ? column.render(row[column.key], row) : row[column.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
