type Props = {
  label: string;
  title: string;
  description: string;
  labelColor?: string;
  titleColor?: string;
  borderColor?: string;
};

export default function GhostCard({
  label,
  title,
  description,
  labelColor,
  titleColor,
  borderColor,
}: Props) {
  return (
    <article className="ghost-card" style={borderColor ? { borderColor } : undefined}>
      <p className="ghost-card-label" style={labelColor ? { color: labelColor } : undefined}>
        {label}
      </p>
      <h3 className="ghost-card-title" style={titleColor ? { color: titleColor } : undefined}>
        {title}
      </h3>
      <p className="ghost-card-description">{description}</p>
    </article>
  );
}
