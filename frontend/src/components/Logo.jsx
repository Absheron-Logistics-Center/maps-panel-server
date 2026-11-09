import LogoSvg from '../header-logo.svg';

export function LogoMark({ size = 44 }) {
  return (
    <div className="logo-mark" style={{ width: size, height: size }} aria-hidden />
  );
}

export function LogoFull({ size = 'normal' }) {
  return (
    <div className="logo-row">
      <img 
        src={LogoSvg} 
        alt="Abşeron Logistika Mərkəzi" 
        className="logo-full"
        style={{ maxWidth: size === 'large' ? '600px' : '280px' }}
      />
    </div>
  );
}