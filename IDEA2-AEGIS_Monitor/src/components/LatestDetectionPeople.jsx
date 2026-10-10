// Event metadata only: never project persisted people into current-frame
// geometry or reuse a matched name for an Unknown result.
export default function LatestDetectionPeople({ people = [] }) {
  if (!people.length) return null
  return <section className="latest-detection-people" aria-label="Latest detection metadata">
    <p className="sub">Latest detection metadata</p>
    <ul>
      {people.map((person, index) => <li key={index}>
        <span>{person.k === 'unk' ? 'Unknown' : person.name || 'Authorized'}</span>
        {Number.isFinite(person.conf) && person.conf >= 0 && person.conf <= 100 &&
          <span className="mono">{person.conf}%</span>}
      </li>)}
    </ul>
  </section>
}
