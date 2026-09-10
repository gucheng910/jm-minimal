interface IconProps { size?: number; color?: string; className?: string }
function Svg({ size = 22, color = "currentColor", className, children }: IconProps & { children: React.ReactNode }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
export function HomeIcon(p: IconProps) { return <Svg {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9 21v-6h6v6" /></Svg>; }
export function GridIcon(p: IconProps) { return <Svg {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></Svg>; }
export function SearchIcon(p: IconProps) { return <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-4.3-4.3" /></Svg>; }
export function UserIcon(p: IconProps) { return <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></Svg>; }
export function CheckInIcon(p: IconProps) { return <Svg {...p}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="m8 12 2.5 2.5L16 9" /><path d="M8 3v3M16 3v3" /></Svg>; }
export function StarIcon(p: IconProps) { return <Svg {...p}><path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9L6.6 19.7l1.1-6-4.5-4.3 6.1-.8L12 3Z" /></Svg>; }
export function SourceIcon(p: IconProps) { return <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></Svg>; }
export function CloseIcon(p: IconProps) { return <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>; }
export function DownloadIcon(p: IconProps) { return <Svg {...p}><path d="M12 3v10" /><path d="m7 9 5 5 5-5" /><path d="M4 17v1.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V17" /></Svg>; }
export function MenuIcon(p: IconProps) { return <Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>; }
export function BookIcon(p: IconProps) { return <Svg {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></Svg>; }
export function ClockIcon(p: IconProps) { return <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>; }
export function MoonIcon(p: IconProps) { return <Svg {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></Svg>; }
export function SunIcon(p: IconProps) { return <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>; }
export function LightningIcon(p: IconProps) { return <Svg {...p}><path d="M13 2L3 14h7l-1 8 10-10h-7l1-8Z" /></Svg>; }
export function CheckIcon(p: IconProps) { return <Svg {...p}><path d="m5 13 4 4 10-10" /></Svg>; }
export function HeartIcon({ filled, ...p }: IconProps & { filled?: boolean }) {
  return <Svg {...p}><path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7C19 15.6 12 20 12 20z" fill={filled ? "currentColor" : "none"} /></Svg>;
}