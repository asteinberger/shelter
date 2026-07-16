import type { ImgHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type ShelterFrogProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'height' | 'src' | 'width'> & {
  title?: string;
};

export function ShelterFrog({ className, title, ...props }: ShelterFrogProps) {
  return (
    <img
      src="/brand/shelter-icon-64.png"
      width="64"
      height="64"
      alt={title ?? ''}
      className={cn('size-6', className)}
      aria-hidden={title ? undefined : true}
      draggable={false}
      {...props}
    />
  );
}
