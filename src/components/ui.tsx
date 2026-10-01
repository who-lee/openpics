import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'ghost' | 'solid' | 'accent' | 'danger'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children?: ReactNode
}

const VARIANT: Record<Variant, string> = {
  ghost: 'text-ink-2 hover:text-ink hover:bg-hover border border-transparent',
  solid: 'bg-raised text-ink border border-line hover:border-line-strong hover:bg-hover',
  accent: 'bg-accent text-white border border-transparent hover:brightness-110',
  danger: 'text-accent-text border border-transparent hover:bg-accent-soft'
}

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2 gap-1.5 text-[12px]',
  md: 'h-8 px-3 gap-2 text-[13px]'
}

/**
 * One control shape for the whole app. The tactile press is a 1px push rather
 * than a scale, so a row of buttons does not shimmer when hovered as a group.
 */
export function Button({ variant = 'ghost', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'inline-flex select-none items-center justify-center rounded-[6px] font-medium',
        'transition-[background-color,color,border-color,filter,transform] duration-150',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
        VARIANT[variant],
        SIZE[size],
        className
      )}
    />
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: Size
}

export function IconButton({ label, active = false, size = 'md', className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      {...rest}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-[6px]',
        'transition-[background-color,color,border-color,transform] duration-150 active:translate-y-px',
        'disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        active
          ? 'bg-accent-soft text-accent-text'
          : 'text-ink-2 hover:bg-hover hover:text-ink',
        className
      )}
    />
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
  label: string
}

export function Segmented<T extends string>({ value, options, onChange, label }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5 rounded-[6px] bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title ?? option.label}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={clsx(
            'rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors duration-150',
            option.value === value
              ? 'bg-base text-ink shadow-[0_1px_2px_rgba(0,0,0,0.25)]'
              : 'text-ink-3 hover:text-ink'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}

export function Toggle({ checked, onChange, label, hint }: ToggleProps) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-ink-2 select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-[18px] w-[32px] rounded-full border transition-colors duration-150',
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised'
        )}
      >
        <span
          className={clsx(
            'absolute top-[2px] h-[12px] w-[12px] rounded-full bg-ink transition-[left] duration-150',
            checked ? 'left-[17px]' : 'left-[2px]'
          )}
        />
      </button>
      <span>
        {label}
        {hint ? <span className="ml-1 text-ink-3">{hint}</span> : null}
      </span>
    </label>
  )
}