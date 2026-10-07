import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Лінійні іконки дизайну «Плексі» (24×24, обведення 2). Декоративні: підпис дає текст поруч або accessibilityLabel кнопки. */
export type IconName =
  | 'home' | 'file' | 'user' | 'more' | 'chevron' | 'back' | 'key' | 'grid' | 'upload' | 'download' | 'alert' | 'check'
  | 'stop' | 'tick' | 'plus' | 'pencil' | 'doctor' | 'lock' | 'shield' | 'logout' | 'eye' | 'fingerprint' | 'list'
  | 'trash';

function Glyph({ name, color }: { name: IconName; color: string }) {
  switch (name) {
    case 'home':
      return <><Path d="M3.5 10.2 12 3.5l8.5 6.7" /><Path d="M5.5 8.8V19a1.5 1.5 0 0 0 1.5 1.5h3.5V15h3v5.5H17a1.5 1.5 0 0 0 1.5-1.5V8.8" /></>;
    case 'file':
      return <><Path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" /><Path d="M13.5 3.5v5h5" /><Path d="M9 13h6" /><Path d="M9 16.5h4" /></>;
    case 'user':
      return <><Circle cx="12" cy="8" r="4" /><Path d="M4.5 20.5c.8-3.8 3.9-6 7.5-6s6.7 2.2 7.5 6" /></>;
    case 'more':
      return <><Circle cx="5.5" cy="12" r="1.6" fill={color} stroke="none" /><Circle cx="12" cy="12" r="1.6" fill={color} stroke="none" /><Circle cx="18.5" cy="12" r="1.6" fill={color} stroke="none" /></>;
    case 'chevron':
      return <Path d="m9.5 6 6 6-6 6" />;
    case 'back':
      return <Path d="m14.5 6-6 6 6 6" />;
    case 'key':
      return <><Circle cx="8" cy="15.5" r="4" /><Path d="m10.9 12.6 8.6-8.6" /><Path d="m16.5 7 2.5 2.5" /><Path d="m14 9.5 2 2" /></>;
    case 'grid':
      return <><Rect x="4" y="4" width="6.5" height="6.5" rx="1.75" /><Rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75" /><Rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75" /><Rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75" /></>;
    case 'upload':
      return <><Path d="M12 15V4.5" /><Path d="m7.5 9 4.5-4.5L16.5 9" /><Path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" /></>;
    case 'download':
      return <><Path d="M12 4.5V15" /><Path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><Path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" /></>;
    case 'alert':
      return <><Circle cx="12" cy="12" r="8.5" /><Path d="M12 7.75v5" /><Path d="M12 16.25h.01" /></>;
    case 'check':
      return <><Circle cx="12" cy="12" r="8.5" /><Path d="m8.5 12.2 2.4 2.4 4.6-4.8" /></>;
    case 'stop':
      return <><Circle cx="12" cy="12" r="8.5" /><Path d="m9.5 9.5 5 5" /><Path d="m14.5 9.5-5 5" /></>;
    case 'tick':
      return <Path d="m5.5 12.5 4.2 4.2 8.8-9.2" />;
    case 'plus':
      return <><Path d="M12 5.5v13" /><Path d="M5.5 12h13" /></>;
    case 'pencil':
      return <><Path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10z" /><Path d="m13.5 8.5 3 3" /></>;
    case 'doctor':
      return <><Path d="M6 3.5H5A1.5 1.5 0 0 0 3.5 5v3.5a4.5 4.5 0 0 0 9 0V5A1.5 1.5 0 0 0 11 3.5h-1" /><Path d="M8 13v1.5a5 5 0 0 0 10 0V13" /><Circle cx="18" cy="11" r="2" /></>;
    case 'lock':
      return <><Rect x="5" y="10.5" width="14" height="10" rx="2.5" /><Path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>;
    case 'shield':
      return <><Path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.9 7 9 4.1-1.1 7-4.7 7-9V6.2z" /><Path d="m9 12 2.2 2.2L15.3 10" /></>;
    case 'logout':
      return <><Path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" /><Path d="M10 16.5 5.5 12 10 7.5" /><Path d="M5.5 12h10" /></>;
    case 'eye':
      return <><Path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><Circle cx="12" cy="12" r="2.75" /></>;
    case 'fingerprint':
      return <><Path d="M7 17.5c.9-1.7 1.4-3.5 1.4-5.5a3.6 3.6 0 0 1 7.2 0c0 1.2-.1 2.4-.3 3.5" /><Path d="M12 12c0 3-.8 5.8-2.3 8" /><Path d="M4.6 15.5c.6-1.1.9-2.3.9-3.5a6.5 6.5 0 0 1 11.6-4" /><Path d="M18.4 11c.1.5.1 1 .1 1.5 0 2.7-.5 5.3-1.5 7.6" /></>;
    case 'list':
      return <><Path d="M9 6.5h10.5" /><Path d="M9 12h10.5" /><Path d="M9 17.5h10.5" /><Circle cx="5" cy="6.5" r="1" /><Circle cx="5" cy="12" r="1" /><Circle cx="5" cy="17.5" r="1" /></>;
    case 'trash':
      return <><Path d="M4.5 6.5h15" /><Path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" /><Path d="M6.5 6.5l.9 12.6A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.6" /><Path d="M10 10.5v6" /><Path d="M14 10.5v6" /></>;
    default:
      return null;
  }
}

export function Icon({ name, color, size = 24, strokeWidth = 2 }: { name: IconName; color: string; size?: number; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
         strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Glyph name={name} color={color} />
    </Svg>
  );
}
