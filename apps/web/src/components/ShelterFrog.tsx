import { useId, type SVGProps } from 'react';
import { cn } from '@/lib/utils';

type ShelterFrogProps = Omit<SVGProps<SVGSVGElement>, 'title'> & {
  title?: string;
};

export function ShelterFrog({ className, title, ...props }: ShelterFrogProps) {
  const generatedId = useId().replace(/:/g, '');
  const maskId = `shelter-frog-mask-${generatedId}`;
  const titleId = `shelter-frog-title-${generatedId}`;

  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn('size-6', className)}
      role={title ? 'img' : undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title && <title id={titleId}>{title}</title>}
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="3" y="3" width="26" height="27">
          <rect x="3" y="3" width="26" height="27" fill="white" />
          <circle cx="10" cy="9.5" r="1.35" fill="black" />
          <circle cx="22" cy="9.5" r="1.35" fill="black" />
          <path d="M11.5 19.2c1.25 1.05 2.75 1.58 4.5 1.58s3.25-.53 4.5-1.58" stroke="black" strokeWidth="1.7" strokeLinecap="round" />
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${maskId})`}>
        <circle cx="10" cy="9.5" r="4.4" />
        <circle cx="22" cy="9.5" r="4.4" />
        <path d="M5.25 14.9c0-4.25 3.45-7.7 7.7-7.7h6.1c4.25 0 7.7 3.45 7.7 7.7v3.25c0 5.15-4.18 9.33-9.33 9.33h-2.84c-5.15 0-9.33-4.18-9.33-9.33V14.9Z" />
      </g>
    </svg>
  );
}

