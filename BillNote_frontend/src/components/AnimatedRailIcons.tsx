interface AnimatedNotebookIconProps {
  open: boolean
  size?: number
}

export function AnimatedNotebookIcon({ open, size = 17 }: AnimatedNotebookIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`animated-notebook-icon ${open ? 'is-open' : ''}`}
    >
      {/* Closed notebook state: bound cover with subtle spine and title mark */}
      <g className="notebook-closed-layer">
        <rect x="5" y="3.5" width="14" height="17" rx="2.2" />
        <path d="M8.5 3.5v17" />
        <path d="M11.5 8.5h4.5" />
        <path d="M11.5 12h3.2" />
      </g>

      {/* Open notebook state: left and right pages unfold symmetrically from the center spine */}
      <g className="notebook-open-layer">
        <path className="notebook-page-left" d="M12 6.5c-1.8-1.5-4.3-2-7.5-2a1.5 1.5 0 0 0-1.5 1.5v11.5A1.5 1.5 0 0 0 4.5 19c3.2 0 5.7.5 7.5 2" />
        <path className="notebook-page-right" d="M12 6.5c1.8-1.5 4.3-2 7.5-2A1.5 1.5 0 0 1 21 6v11.5a1.5 1.5 0 0 1-1.5 1.5c-3.2 0-5.7.5-7.5 2" />
        <path className="notebook-spine" d="M12 6.5V21" />
      </g>
    </svg>
  )
}

interface AnimatedFilterSlidersIconProps {
  open: boolean
  className?: string
}

export function AnimatedFilterSlidersIcon({ open, className }: AnimatedFilterSlidersIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`animated-sliders-icon ${open ? 'is-open' : ''} ${className ?? ''}`}
    >
      <line x1="3.5" y1="6" x2="20.5" y2="6" />
      <line x1="3.5" y1="12" x2="20.5" y2="12" />
      <line x1="3.5" y1="18" x2="20.5" y2="18" />
      <circle className="slider-knob slider-knob--top" cx="9" cy="6" r="2.2" fill="currentColor" stroke="none" />
      <circle className="slider-knob slider-knob--mid" cx="15.5" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle className="slider-knob slider-knob--bot" cx="10.5" cy="18" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}
