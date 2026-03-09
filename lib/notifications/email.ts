/**
 * Email notification service via Resend.
 * Sends registration-opens alerts for saved camps.
 */

import { Resend } from "resend";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    _resend = new Resend(key);
  }
  return _resend;
}

const FROM = process.env.RESEND_FROM_EMAIL ?? "CampScout <notifications@campscout.app>";

export interface RegistrationAlert {
  to: string;
  campName: string;
  campSlug: string;
  registrationDate: string; // ISO date string
  websiteUrl: string;
}

export async function sendRegistrationAlert(alert: RegistrationAlert) {
  const resend = getResend();

  const formattedDate = new Date(alert.registrationDate).toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const campUrl = `https://camp.fit/camps/${alert.campSlug}`;

  const { error } = await resend.emails.send({
    from: FROM,
    to: alert.to,
    subject: `🏕️ Registration opens soon: ${alert.campName}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #FDFBF7; margin: 0; padding: 0; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #fff; border-radius: 16px; padding: 32px; border: 1px solid #E8E0D4; }
    .logo { font-size: 20px; font-weight: 800; color: #3B1F0E; margin-bottom: 24px; }
    .logo span { color: #C45C3A; }
    h2 { font-size: 22px; font-weight: 700; color: #3B1F0E; margin: 0 0 8px; }
    p { font-size: 15px; color: #8C7B68; line-height: 1.6; margin: 0 0 16px; }
    .highlight { background: #FEF9EE; border: 1px solid #F5D78E; border-radius: 10px; padding: 14px 16px; margin: 16px 0; }
    .highlight strong { color: #B45309; font-size: 14px; }
    .btn { display: inline-block; background: #2D6A4F; color: #fff; padding: 13px 24px; border-radius: 100px; text-decoration: none; font-weight: 600; font-size: 15px; margin-top: 8px; }
    .footer { font-size: 12px; color: #B8A89A; text-align: center; margin-top: 24px; }
    a { color: #2D6A4F; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="logo">Camp<span>Scout</span></div>
      <h2>Registration opening soon!</h2>
      <p>A camp you saved is opening registration. Don't miss your spot:</p>
      <div class="highlight">
        <strong>🏕️ ${alert.campName}</strong><br/>
        <strong>📅 Registration opens: ${formattedDate}</strong>
      </div>
      <p>Act fast — popular camps fill up within hours of opening.</p>
      <a href="${campUrl}" class="btn">View Camp Details →</a>
      ${alert.websiteUrl ? `<p style="margin-top:16px;font-size:13px;">Or go directly to <a href="${alert.websiteUrl}">the camp's registration page</a>.</p>` : ""}
    </div>
    <div class="footer">
      <p>You're receiving this because you saved this camp on CampScout.<br/>
      <a href="https://camp.fit/dashboard">Manage your saved camps</a></p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

export interface NewCampAlert {
  to: string;
  camps: { name: string; slug: string; category: string; neighborhood: string }[];
}

export async function sendNewCampDigest(alert: NewCampAlert) {
  const resend = getResend();
  if (alert.camps.length === 0) return;

  const campItems = alert.camps
    .slice(0, 5)
    .map(
      (c) =>
        `<li style="margin-bottom:12px;"><a href="https://camp.fit/camps/${c.slug}" style="color:#2D6A4F;font-weight:600;">${c.name}</a> <span style="color:#8C7B68;font-size:13px;">· ${c.category} · ${c.neighborhood}</span></li>`
    )
    .join("");

  await resend.emails.send({
    from: FROM,
    to: alert.to,
    subject: `🆕 ${alert.camps.length} new camps added to CampScout`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #FDFBF7; margin: 0; padding: 0; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
    .card { background: #fff; border-radius: 16px; padding: 32px; border: 1px solid #E8E0D4; }
    .logo { font-size: 20px; font-weight: 800; color: #3B1F0E; margin-bottom: 24px; }
    .logo span { color: #C45C3A; }
    h2 { font-size: 22px; font-weight: 700; color: #3B1F0E; margin: 0 0 16px; }
    ul { padding-left: 0; list-style: none; margin: 0 0 20px; }
    .btn { display: inline-block; background: #2D6A4F; color: #fff; padding: 13px 24px; border-radius: 100px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .footer { font-size: 12px; color: #B8A89A; text-align: center; margin-top: 24px; }
    a { color: #2D6A4F; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="logo">Camp<span>Scout</span></div>
      <h2>New camps just added</h2>
      <ul>${campItems}</ul>
      <a href="https://camp.fit" class="btn">Browse All Camps →</a>
    </div>
    <div class="footer">
      <a href="https://camp.fit/dashboard">Manage notifications</a>
    </div>
  </div>
</body>
</html>
    `.trim(),
  });
}
