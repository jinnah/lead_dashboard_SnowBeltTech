export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <span className="brand">
      <span className="brand__mark" aria-hidden="true" />
      <span>
        SnowBeltTech
        {subtitle ? <span className="brand__sub"> · {subtitle}</span> : null}
      </span>
    </span>
  );
}
