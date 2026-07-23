/**
 * Form-guide legend, ported verbatim from the prototype: a colored/shaped marker
 * per tier over its Spanish label. Markers key off the same tokens as the pills.
 */
export default function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="ld champ" />
        Campeón
      </span>
      <span>
        <i className="ld podio" />
        Podio
      </span>
      <span>
        <i className="ld final" />
        Mesa final
      </span>
      <span>
        <i className="ld out" />
        Fuera
      </span>
    </div>
  )
}
