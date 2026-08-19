/** The generated Daimon OS application mark, shared by product and marketing UI. */
export function DaimonMark({
  size = 16,
  className,
  "aria-hidden": ariaHidden = true,
}: {
  size?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return (
    <img
      src="/icon-192.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden={ariaHidden}
      draggable={false}
    />
  );
}
