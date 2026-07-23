/**
 * Lightweight placeholder for tab screens not yet built (Fechas / En Vivo /
 * Perfil / Admin). Later slices replace the corresponding route component with
 * the real screen. Uses the shared section-head + card primitives so the
 * placeholder still reads as part of the themed app.
 */
type ScreenPlaceholderProps = {
  overline: string
  title: string
  note: string
}

export default function ScreenPlaceholder({
  overline,
  title,
  note,
}: ScreenPlaceholderProps) {
  return (
    <>
      <div className="section-head">
        <div>
          <span className="overline">{overline}</span>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="rule" />
      <div className="pad">
        <div className="card">
          <p>{note}</p>
        </div>
      </div>
    </>
  )
}
