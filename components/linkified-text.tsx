/**
 * Renders text with URLs converted to clickable anchor tags.
 * Safe — no dangerouslySetInnerHTML, splits on URL pattern only.
 */

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

export function LinkifiedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const parts = text.split(URL_REGEX);

  return (
    <span className={className}>
      {parts.map((part, i) =>
        URL_REGEX.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pine-600 underline underline-offset-2 hover:text-pine-500 break-all"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}
