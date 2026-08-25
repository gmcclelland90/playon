import { renderSVG } from "uqr";

export function TotpQr({ value }: { value: string }) {
  return (
    <div
      className="totp-qr"
      role="img"
      aria-label="Authenticator QR code"
      dangerouslySetInnerHTML={{ __html: renderSVG(value) }}
    />
  );
}
