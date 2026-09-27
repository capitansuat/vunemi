/**
 * Vunemi's mark: the mochi from the app icon, without the tile behind it.
 * The body takes the current text colour, so `text-ember` colours it. Below
 * about 16px a face turns to noise, so small uses can leave it off.
 */
export function Mochi({ size = 16, face = true, className = "" }: { size?: number; face?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="212 234 600 600" aria-hidden="true" className={className}>
      <path d="M512 346C528 296 572 268 610 258C602 300 580 330 512 346Z" fill="#ffc24d" />
      <path
        d="M226 700C226 474 356 340 512 340C668 340 798 474 798 700C798 768 748 806 684 806H340C276 806 226 768 226 700Z"
        fill="currentColor"
      />
      {face && (
        <>
          <circle cx="430" cy="592" r="40" fill="#2a1d16" />
          <circle cx="594" cy="592" r="40" fill="#2a1d16" />
          <path d="M482 650Q512 678 542 650" fill="none" stroke="#2a1d16" strokeWidth="22" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
