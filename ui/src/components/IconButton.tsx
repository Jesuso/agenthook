import { forwardRef } from "react";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  /** Required: an icon-only button's only name — used for both `aria-label` and the `title` tooltip. */
  label: string;
};

/** A square, icon-only button. */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton({ label, className = "", type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${className}`}
      {...rest}
    />
  );
});
