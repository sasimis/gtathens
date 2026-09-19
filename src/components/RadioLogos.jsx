import React from 'react'

export const RadioOffLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#2d3748" />
    <path d="M12 15h5l5-5v20l-5-5h-5v-10z" fill="#a0aec0" />
    <path d="M26 14l8 12M34 14l-8 12" stroke="#e53e3e" strokeWidth="3" strokeLinecap="round" />
  </svg>
)

export const EraSportLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#0052cc" />
    <circle cx="20" cy="20" r="14" fill="#003d99" stroke="#36b37e" strokeWidth="2" />
    <text x="20" y="18" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="900" fontFamily="sans-serif">ERA</text>
    <text x="20" y="27" textAnchor="middle" fill="#36b37e" fontSize="8" fontWeight="900" fontFamily="sans-serif">SPORT</text>
  </svg>
)

export const EraDefteroLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#172b4d" />
    <rect x="3" y="3" width="34" height="34" rx="6" stroke="#ffab00" strokeWidth="1.5" />
    <text x="20" y="17" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="900" fontFamily="sans-serif">ΕΡΤ</text>
    <text x="20" y="27" textAnchor="middle" fill="#ffab00" fontSize="8" fontWeight="800" fontFamily="sans-serif">ΔΕΥΤΕΡΟ</text>
  </svg>
)

export const EraKosmosLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#253858" />
    <circle cx="20" cy="20" r="14" fill="#6554c0" />
    <text x="20" y="23" textAnchor="middle" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="sans-serif">KOSMOS</text>
  </svg>
)

export const Music892Logo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#091e42" />
    <path d="M4 12h32v16H4z" fill="#ff5630" rx="4" />
    <text x="20" y="23" textAnchor="middle" fill="#ffab00" fontSize="9" fontWeight="900" fontFamily="impact, sans-serif">MUSIC 89.2</text>
  </svg>
)

export const Menta88Logo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#006644" />
    <circle cx="20" cy="20" r="13" stroke="#36b37e" strokeWidth="2" />
    <text x="20" y="19" textAnchor="middle" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="sans-serif">MENTA</text>
    <text x="20" y="27" textAnchor="middle" fill="#79f2c0" fontSize="8" fontWeight="900" fontFamily="sans-serif">88 FM</text>
  </svg>
)

export const Metropolis955Logo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#0747a6" />
    <text x="20" y="18" textAnchor="middle" fill="#ffab00" fontSize="7" fontWeight="900" fontFamily="impact, sans-serif">METROPOLIS</text>
    <text x="20" y="29" textAnchor="middle" fill="#ffffff" fontSize="10" fontWeight="900" fontFamily="impact, sans-serif">95.5</text>
  </svg>
)

export const AthensRockLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#111111" stroke="#ff5630" strokeWidth="1.5" />
    <text x="20" y="18" textAnchor="middle" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="impact, sans-serif">ATHENS</text>
    <text x="20" y="28" textAnchor="middle" fill="#ff5630" fontSize="9" fontWeight="900" fontFamily="impact, sans-serif">ROCK</text>
  </svg>
)

export const KosmosJazzLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#403294" />
    <text x="20" y="18" textAnchor="middle" fill="#6554c0" fontSize="7" fontWeight="900" fontFamily="sans-serif">KOSMOS</text>
    <text x="20" y="29" textAnchor="middle" fill="#ffab00" fontSize="11" fontWeight="900" fontFamily="sans-serif">JAZZ</text>
  </svg>
)

export const Focus1036Logo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#ff8b00" />
    <text x="20" y="18" textAnchor="middle" fill="#172b4d" fontSize="9" fontWeight="900" fontFamily="impact, sans-serif">FOCUS</text>
    <text x="20" y="28" textAnchor="middle" fill="#ffffff" fontSize="8" fontWeight="900" fontFamily="impact, sans-serif">103.6 FM</text>
  </svg>
)

export const EraProtoLogo = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#de350b" />
    <text x="20" y="18" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="900" fontFamily="sans-serif">ΕΡΤ</text>
    <text x="20" y="27" textAnchor="middle" fill="#ffab00" fontSize="8" fontWeight="900" fontFamily="sans-serif">ΠΡΩΤΟ</text>
  </svg>
)

export const STATION_LOGOS = {
  'off': RadioOffLogo,
  'era-sport': EraSportLogo,
  'era-deftero': EraDefteroLogo,
  'era-kosmos': EraKosmosLogo,
  'music892': Music892Logo,
  'menta88': Menta88Logo,
  'metropolis955': Metropolis955Logo,
  'athensrock969': AthensRockLogo,
  'kosmosjazz': KosmosJazzLogo,
  'focus1036': Focus1036Logo,
  'era-proto': EraProtoLogo,
}

export const StationLogo = ({ id, size = 32 }) => {
  const Component = STATION_LOGOS[id] || RadioOffLogo
  return <Component size={size} />
}
