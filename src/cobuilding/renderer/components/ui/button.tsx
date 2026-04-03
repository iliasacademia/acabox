import React from 'react';
import { Slot } from 'radix-ui';

type ButtonVariant =
  | 'default'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'link';
type ButtonSize =
  | 'default'
  | 'xs'
  | 'sm'
  | 'lg'
  | 'icon'
  | 'icon-xs'
  | 'icon-sm'
  | 'icon-lg';

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'button';
  const sizeClass = size === 'default' ? 'btn--default-size' : `btn--${size}`;

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={`btn btn--${variant} ${sizeClass}${className ? ` ${className}` : ''}`}
      {...props}
    />
  );
}

export { Button };
export type { ButtonVariant, ButtonSize };
